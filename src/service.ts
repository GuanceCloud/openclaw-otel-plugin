import type {
  DiagnosticEventPayload,
  OpenClawPluginService,
} from "openclaw/plugin-sdk";
import { onDiagnosticEvent } from "openclaw/plugin-sdk";
import type { OtelPluginConfig } from "./config.js";
import { createDiagnosticEventHandler } from "./diagnostic-event-handler.js";
import { startOtelBootstrap } from "./otel-bootstrap.js";
import {
  createSessionSnapshotStore,
  resolveRuntimeMetadata,
} from "./session-store.js";
import type {
  ActiveRootSpan,
  ActiveRunSpan,
  CompletedTrajectoryRun,
  RuntimeLike,
  SessionSnapshotStore,
} from "./service-types.js";
import {
  addEvent,
  buildGenAiClientTokenMetricAttrs,
  buildGenAiClientModelMetricAttrs,
  buildGenAiWorkflowMetricAttrs,
  buildRunScopeAttrs,
  buildTranscriptReplayEvent,
  clipPreview,
  createRunState,
  durationMsToSeconds,
  endSpanSafely,
  eventTime,
  isHeartbeatSessionSnapshot,
  loadSnapshotForEvent,
  MIN_VISIBLE_CHILD_MS,
  MIN_VISIBLE_MODEL_MS,
  normalizeReasoningPreview,
  normalizeFinalStatus,
  normalizeUserInputPreview,
  parseSessionKey,
  redactSensitiveText,
  readReplayFinalizationState,
  rememberRunId,
  resolveReplayFinalizationStateFile,
  resolveTranscriptReplayFreshness,
  resolveTranscriptReplayPlan,
  resolveIngressLifecycleWindows,
  resolveRequestClassification,
  resolveSessionMetricTotals,
  resolveSpanWindow,
  resolveUsageTokenTotals,
  sessionIdentity,
  shouldFallbackRunBoundEventToActiveRequest,
  stripAgentSummaryModelUsageAttrs,
  stringAttrs,
  traceAttrs,
  writeReplayFinalizationState,
} from "./service-utils.js";
import { createToolSpanManager } from "./tool-span-manager.js";
import {
  normalizeTerminalSpanAttrs,
  resolveOtelUrl,
} from "./trace-runtime.js";
export function createOtelPluginService(
  config: OtelPluginConfig,
  runtime?: RuntimeLike,
): OpenClawPluginService {
  let sdk: any = null;
  let sessionStore: SessionSnapshotStore | null = null;
  let unsubscribeDiagnostic: (() => void) | null = null;
  let unsubscribeAgent: (() => void) | null = null;
  let unsubscribeTranscript: (() => void) | null = null;
  let sessionMetricsInterval: ReturnType<typeof setInterval> | null = null;
  const activeRoots = new Map<string, ActiveRootSpan>();
  const activeRuns = new Map<string, ActiveRunSpan>();
  const activeRequestKeyBySession = new Map<string, string>();
  const requestHistoryBySession = new Map<string, Array<{
    requestKey: string;
    requestSeq: number;
    startedAt: number;
    messageId?: string;
    closedAt?: number;
  }>>();
  const reportedSessionMetrics = new Map<string, {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    traceCount: number;
  }>();
  const replayWatermarkBySession = new Map<string, string>();
  const replayTrajectorySourceSeqBySession = new Map<string, number>();
  const pendingTrajectoryReplayRunIdsBySession = new Map<string, Set<string>>();
  let requestSequence = 0;
  let recentSessionSweepAt = 0;
  const sessionMetricTokenState = new Map<string, {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    modelProvider?: string;
    modelName?: string;
    active: boolean;
    dirty: boolean;
  }>();

  return {
    id: "openclaw-otel-plugin",
    async start(ctx) {
      if (!config.enabled) {
        ctx.logger.info("[otel-plugin] disabled");
        return;
      }

      sessionStore = createSessionSnapshotStore(ctx.stateDir);
      const runtimeMetadata = resolveRuntimeMetadata(ctx.stateDir);
      const {
        sdk: otelSdk,
        context,
        trace,
        tracer,
        SpanKind,
        SpanStatusCode,
        SeverityNumber,
        diagnosticsLogger,
        instruments,
      } = await startOtelBootstrap(config, runtimeMetadata, ctx.logger);
      sdk = otelSdk;
      sessionStore.refreshSessionsIndex();
      const replayFinalizationStateFile = resolveReplayFinalizationStateFile(ctx.stateDir);
      const persistedReplayFinalizationBySession = readReplayFinalizationState(replayFinalizationStateFile);
      for (const [sessionKey, value] of persistedReplayFinalizationBySession.entries()) {
        if (value.watermark) {
          replayWatermarkBySession.set(sessionKey, value.watermark);
        }
        if (typeof value.trajectorySourceSeq === "number") {
          replayTrajectorySourceSeqBySession.set(sessionKey, value.trajectorySourceSeq);
        }
        if (value.pendingRunIds?.length) {
          pendingTrajectoryReplayRunIdsBySession.set(sessionKey, new Set(value.pendingRunIds));
        }
      }
      recentSessionSweepAt = Date.now() - config.flushIntervalMs;

      const loadSessionSnapshot = (sessionKey: string | undefined) =>
        sessionStore?.loadSessionSnapshot(sessionKey);

      const buildReplayWatermark = (
        snapshot: ReturnType<typeof loadSessionSnapshot>,
      ): string | undefined => {
        if (!snapshot) {
          return undefined;
        }
        return [
          snapshot.sessionId ?? "",
          snapshot.lastUserTs ?? "",
          snapshot.lastAssistantTs ?? "",
          snapshot.lastRunAssistantTurns?.length ?? 0,
          snapshot.lastRunToolCalls?.length ?? 0,
          snapshot.lastAssistantText?.length ?? 0,
          snapshot.lastAssistantThinking?.length ?? 0,
        ].join("|");
      };

      const hasReplayWatermark = (
        sessionKey: string | undefined,
        snapshot: ReturnType<typeof loadSessionSnapshot>,
      ) => {
        if (!sessionKey) {
          return false;
        }
        const watermark = buildReplayWatermark(snapshot);
        if (!watermark) {
          return false;
        }
        return replayWatermarkBySession.get(sessionKey) === watermark;
      };

      const markReplayWatermark = (
        sessionKey: string | undefined,
        snapshot: ReturnType<typeof loadSessionSnapshot>,
      ) => {
        if (!sessionKey) {
          return;
        }
        const watermark = buildReplayWatermark(snapshot);
        if (!watermark) {
          return;
        }
        replayWatermarkBySession.set(sessionKey, watermark);
        if (snapshot?.runCompleted === true) {
          if (snapshot.runId) {
            const pendingRunIds = pendingTrajectoryReplayRunIdsBySession.get(sessionKey) ?? new Set<string>();
            pendingRunIds.add(snapshot.runId);
            pendingTrajectoryReplayRunIdsBySession.set(sessionKey, pendingRunIds);
          }
          const current = persistedReplayFinalizationBySession.get(sessionKey) ?? {};
          current.watermark = watermark;
          current.pendingRunIds = Array.from(
            pendingTrajectoryReplayRunIdsBySession.get(sessionKey) ?? [],
          ).slice(-16);
          current.updatedAt = Date.now();
          persistedReplayFinalizationBySession.set(sessionKey, current);
          writeReplayFinalizationState(replayFinalizationStateFile, persistedReplayFinalizationBySession);
          markTrajectoryReplayPositionForRun(sessionKey, snapshot.runId);
        }
      };

      const markTrajectoryReplaySourceSeq = (
        sessionKey: string | undefined,
        trajectorySourceSeq: number | undefined,
      ) => {
        if (!sessionKey || typeof trajectorySourceSeq !== "number" || !Number.isFinite(trajectorySourceSeq)) {
          return;
        }
        const currentValue = replayTrajectorySourceSeqBySession.get(sessionKey) ?? -1;
        if (trajectorySourceSeq <= currentValue) {
          return;
        }
        replayTrajectorySourceSeqBySession.set(sessionKey, trajectorySourceSeq);
        const persisted = persistedReplayFinalizationBySession.get(sessionKey) ?? {};
        persisted.trajectorySourceSeq = trajectorySourceSeq;
        persisted.updatedAt = Date.now();
        persistedReplayFinalizationBySession.set(sessionKey, persisted);
        writeReplayFinalizationState(replayFinalizationStateFile, persistedReplayFinalizationBySession);
      };

      const persistPendingTrajectoryReplayRunIds = (sessionKey: string | undefined) => {
        if (!sessionKey) {
          return;
        }
        const pendingRunIds = pendingTrajectoryReplayRunIdsBySession.get(sessionKey);
        const persisted = persistedReplayFinalizationBySession.get(sessionKey) ?? {};
        persisted.pendingRunIds = pendingRunIds?.size ? Array.from(pendingRunIds).slice(-16) : undefined;
        persisted.updatedAt = Date.now();
        persistedReplayFinalizationBySession.set(sessionKey, persisted);
        writeReplayFinalizationState(replayFinalizationStateFile, persistedReplayFinalizationBySession);
      };

      const rememberPendingTrajectoryReplayRunId = (
        sessionKey: string | undefined,
        runId: string | undefined,
      ) => {
        if (!sessionKey || !runId) {
          return;
        }
        const pendingRunIds = pendingTrajectoryReplayRunIdsBySession.get(sessionKey) ?? new Set<string>();
        if (pendingRunIds.has(runId)) {
          return;
        }
        pendingRunIds.add(runId);
        pendingTrajectoryReplayRunIdsBySession.set(sessionKey, pendingRunIds);
        persistPendingTrajectoryReplayRunIds(sessionKey);
      };

      const forgetPendingTrajectoryReplayRunId = (
        sessionKey: string | undefined,
        runId: string | undefined,
      ) => {
        if (!sessionKey || !runId) {
          return;
        }
        const pendingRunIds = pendingTrajectoryReplayRunIdsBySession.get(sessionKey);
        if (!pendingRunIds?.delete(runId)) {
          return;
        }
        if (pendingRunIds.size === 0) {
          pendingTrajectoryReplayRunIdsBySession.delete(sessionKey);
        }
        persistPendingTrajectoryReplayRunIds(sessionKey);
      };

      const markTrajectoryReplayPositionForRun = (
        sessionKey: string | undefined,
        runId: string | undefined,
      ) => {
        if (!sessionKey || !runId) {
          return;
        }
        const runState = sessionStore?.loadSessionRunState(sessionKey, runId);
        if (runState?.runCompleted !== true) {
          return;
        }
        if (typeof runState?.terminalSourceSeq !== "number" || !Number.isFinite(runState.terminalSourceSeq)) {
          return;
        }
        markTrajectoryReplaySourceSeq(sessionKey, runState.terminalSourceSeq);
        forgetPendingTrajectoryReplayRunId(sessionKey, runId);
      };

      const markReplayFinalization = (
        sessionKey: string | undefined,
        snapshot: ReturnType<typeof loadSessionSnapshot>,
      ) => {
        if (snapshot?.runCompleted !== true) {
          return;
        }
        markReplayWatermark(sessionKey, snapshot);
        markTrajectoryReplayPositionForRun(sessionKey, snapshot.runId);
      };

      const enrichWithTranscript = (
        sessionKey: string | undefined,
        attrs: Record<string, string | number | boolean | undefined>,
      ) => {
        const suppressSessionInputPreview = attrs.__suppress_session_input_preview === true;
        const suppressSessionOutputPreview = attrs.__suppress_session_output_preview === true;
        const suppressSessionOutputSummary = attrs.__suppress_session_output_summary === true;
        const suppressSessionModel = attrs.__suppress_session_model === true;
        const minSnapshotUserTs = typeof attrs.__min_snapshot_user_ts === "number"
          ? attrs.__min_snapshot_user_ts
          : undefined;
        const nextAttrs = {
          ...attrs,
        };
        delete nextAttrs.__suppress_session_input_preview;
        delete nextAttrs.__suppress_session_output_preview;
        delete nextAttrs.__suppress_session_output_summary;
        delete nextAttrs.__suppress_session_model;
        delete nextAttrs.__min_snapshot_user_ts;
        const snapshot = loadSessionSnapshot(sessionKey);
        const requestClassification = resolveRequestClassification({
          lastUserText: snapshot?.lastUserText,
          lastAssistantText: snapshot?.lastAssistantText,
          inputPreview:
            typeof nextAttrs["openclaw.input.preview"] === "string"
              ? nextAttrs["openclaw.input.preview"]
              : typeof nextAttrs.input_preview === "string"
                ? nextAttrs.input_preview
                : undefined,
          outputPreview:
            typeof nextAttrs["openclaw.output.preview"] === "string"
              ? nextAttrs["openclaw.output.preview"]
              : typeof nextAttrs.output_preview === "string"
                ? nextAttrs.output_preview
                : undefined,
        });
        const staleSnapshotForCurrentRequest = Boolean(
          snapshot
          && minSnapshotUserTs !== undefined
          && (
            typeof snapshot.lastUserTs !== "number"
            || snapshot.lastUserTs < minSnapshotUserTs
          ),
        );
        if (!snapshot || staleSnapshotForCurrentRequest) {
          return {
            ...nextAttrs,
            request_type: nextAttrs.request_type ?? requestClassification.requestType,
            request_category: nextAttrs.request_category ?? requestClassification.requestCategory,
            is_internal_request: nextAttrs.is_internal_request ?? requestClassification.isInternalRequest,
          };
        }
        const resolvedSessionId = snapshot.sessionId
          ?? (typeof nextAttrs.session_id === "string" ? nextAttrs.session_id : undefined)
          ?? (typeof nextAttrs["openclaw.sessionId"] === "string" ? nextAttrs["openclaw.sessionId"] : undefined);
        return {
          ...nextAttrs,
          request_type: nextAttrs.request_type ?? requestClassification.requestType,
          request_category: nextAttrs.request_category ?? requestClassification.requestCategory,
          is_internal_request: nextAttrs.is_internal_request ?? requestClassification.isInternalRequest,
          session_id: resolvedSessionId,
          "openclaw.sessionId": resolvedSessionId,
          "openclaw.session.file": snapshot.sessionFile,
          "openclaw.session.createdAt": snapshot.createdAt,
          "openclaw.session.updatedAt": snapshot.updatedAt,
          "openclaw.session.chatType": snapshot.chatType,
          "openclaw.session.lastChannel": snapshot.lastChannel,
          "openclaw.session.origin.provider": snapshot.originProvider,
          "openclaw.session.origin.surface": snapshot.originSurface,
          "openclaw.session.cwd": snapshot.sessionCwd,
          "openclaw.input.preview":
            nextAttrs["openclaw.input.preview"] ??
            (suppressSessionInputPreview ? undefined : normalizeUserInputPreview(snapshot.lastUserText)),
          "openclaw.output.preview":
            nextAttrs["openclaw.output.preview"] ??
            (suppressSessionOutputPreview ? undefined : clipPreview(snapshot.lastAssistantText)),
          output_summary:
            nextAttrs.output_summary ??
            (suppressSessionOutputSummary ? undefined : normalizeReasoningPreview(snapshot.lastAssistantThinking)),
          output_text_length:
            nextAttrs.output_text_length ??
            (suppressSessionOutputSummary ? undefined : snapshot.lastAssistantThinking?.length),
          "openclaw.provider": nextAttrs["openclaw.provider"] ?? snapshot.lastProvider,
          ...(suppressSessionModel
            ? {}
            : { "openclaw.model": nextAttrs["openclaw.model"] ?? snapshot.lastModel }),
        };
      };

      const buildAgentSummaryTraceAttrs = (
        sessionKey: string | undefined,
        attrs: Record<string, string | number | boolean | undefined>,
      ) => traceAttrs(enrichWithTranscript(sessionKey, {
        __suppress_session_model: true,
        ...stripAgentSummaryModelUsageAttrs(attrs),
      }));

      const eventTimestamp = (evt: { ts?: number }): Date =>
        typeof evt.ts === "number" ? eventTime(evt.ts) : new Date();

      const resolveSessionKey = (evt: { sessionKey?: string; sessionId?: string }) => {
        if (typeof evt.sessionKey === "string" && evt.sessionKey.trim()) {
          return evt.sessionKey.trim();
        }
        if (typeof evt.sessionId === "string" && evt.sessionId.trim()) {
          return sessionStore?.resolveSessionKeyById(evt.sessionId.trim()) ?? evt.sessionId.trim();
        }
        return sessionIdentity(evt);
      };

      const resolveRunId = (evt: { runId?: string }) =>
        typeof evt.runId === "string" && evt.runId.trim() ? evt.runId.trim() : undefined;

      const traceRunScopeAttrs = (
        primaryRunId?: string,
        ...runIdSources: Array<string | Iterable<string> | undefined>
      ) => traceAttrs(buildRunScopeAttrs(primaryRunId, ...runIdSources));

      const patchSpanAttributes = (
        span: any,
        attrs: Record<string, string | number | boolean | undefined>,
      ) => {
        if (!span) {
          return;
        }
        const normalizedAttrs = traceAttrs(attrs);
        if (Object.keys(normalizedAttrs).length === 0) {
          return;
        }
        if (!span.ended && typeof span.setAttributes === "function") {
          span.setAttributes(normalizedAttrs);
          return;
        }
        if (span.attributes && typeof span.attributes === "object") {
          Object.assign(span.attributes, normalizedAttrs);
        }
      };

      const patchRuntimeLifecycleRunScopeAttrs = (
        run: ActiveRunSpan | undefined,
        root?: ActiveRootSpan,
        eventRunId?: string,
      ) => {
        if (!run?.runtimeLifecycleSpans?.length) {
          return;
        }
        const attrs = traceRunScopeAttrs(
          eventRunId ?? run.runId ?? root?.runId,
          run.runIds,
          root?.runIds,
          eventRunId,
        );
        for (const span of run.runtimeLifecycleSpans) {
          patchSpanAttributes(span, attrs);
        }
      };

      const buildReplaySummaryAttrs = (
        source: "transcript" | "trajectory",
      ) => stringAttrs({
        replay_source: source,
        trace_completeness: "partial",
      });

      const resolveEventMessageId = (evt: { messageId?: string | number }) =>
        evt.messageId !== undefined && evt.messageId !== null
          ? String(evt.messageId)
          : undefined;

      const resolveRequestStartedAt = (evt: { ts?: number }) =>
        typeof evt.ts === "number" && Number.isFinite(evt.ts) ? evt.ts : Date.now();

      const resolveRequestSeqFromKey = (requestKey: string): number | undefined => {
        const separatorIndex = requestKey.lastIndexOf(":");
        if (separatorIndex < 0) {
          return undefined;
        }
        const value = Number.parseInt(requestKey.slice(separatorIndex + 1), 10);
        return Number.isFinite(value) ? value : undefined;
      };

      const rememberRequestRecord = (
        sessionKey: string,
        requestKey: string,
        evt: { ts?: number; messageId?: string | number },
      ) => {
        const records = requestHistoryBySession.get(sessionKey) ?? [];
        const startedAt = resolveRequestStartedAt(evt);
        const messageId = resolveEventMessageId(evt);
        const requestSeq = resolveRequestSeqFromKey(requestKey) ?? requestSequence;
        const existingIndex = records.findIndex((record) => record.requestKey === requestKey);
        const nextRecord = {
          requestKey,
          requestSeq,
          startedAt,
          messageId,
          closedAt: existingIndex >= 0 ? records[existingIndex]?.closedAt : undefined,
        };
        if (existingIndex >= 0) {
          records[existingIndex] = nextRecord;
        } else {
          records.push(nextRecord);
          records.sort((left, right) => left.startedAt - right.startedAt || left.requestSeq - right.requestSeq);
        }
        const trimmed = records.slice(-64);
        requestHistoryBySession.set(sessionKey, trimmed);
      };

      const markRequestRecordClosed = (
        sessionKey: string | undefined,
        requestKey: string | undefined,
        closedAt?: number,
      ) => {
        if (!sessionKey || !requestKey) {
          return;
        }
        const records = requestHistoryBySession.get(sessionKey);
        if (!records) {
          return;
        }
        const record = records.find((current) => current.requestKey === requestKey);
        if (!record) {
          return;
        }
        record.closedAt = typeof closedAt === "number" && Number.isFinite(closedAt) ? closedAt : Date.now();
      };

      const buildRequestKey = (evt: { sessionKey?: string; sessionId?: string; ts?: number; messageId?: string | number; runId?: string }) => {
        const sessionKey = resolveSessionKey(evt);
        if (!sessionKey) {
          return undefined;
        }
        const messageId = resolveEventMessageId(evt);
        const seed = messageId ?? String(typeof evt.ts === "number" ? evt.ts : Date.now());
        requestSequence += 1;
        return `${sessionKey}#${seed}:${requestSequence}`;
      };

      const resolveRequestKey = (
        evt: { sessionKey?: string; sessionId?: string; ts?: number; messageId?: string | number; runId?: string },
        createIfMissing = false,
      ) => {
        const sessionKey = resolveSessionKey(evt);
        const resolvedRunId = resolveRunId(evt);
        const messageId = resolveEventMessageId(evt);
        if (!sessionKey) {
          return undefined;
        }
        const hasLiveRequest = (requestKey: string) =>
          activeRuns.has(requestKey) || activeRoots.has(requestKey);
        const findMatchingRequestKey = () => {
          if (!resolvedRunId) {
            return undefined;
          }
          for (const [requestKey, run] of activeRuns.entries()) {
            if (run.sessionIdentity !== sessionKey) {
              continue;
            }
            if (run.runId === resolvedRunId || run.runIds?.has(resolvedRunId)) {
              return requestKey;
            }
          }
          for (const [requestKey, root] of activeRoots.entries()) {
            if (root.sessionIdentity !== sessionKey) {
              continue;
            }
            if (root.runId === resolvedRunId || root.runIds?.has(resolvedRunId)) {
              return requestKey;
            }
          }
          return undefined;
        };
        const findRequestRecord = () => {
          const records = requestHistoryBySession.get(sessionKey) ?? [];
          if (messageId) {
            for (let index = records.length - 1; index >= 0; index -= 1) {
              if (records[index].messageId === messageId) {
                return records[index];
              }
            }
          }
          if (typeof evt.ts === "number" && Number.isFinite(evt.ts)) {
            let matched: (typeof records)[number] | undefined;
            for (const record of records) {
              if (record.startedAt <= evt.ts) {
                matched = record;
                continue;
              }
              break;
            }
            return matched;
          }
          return undefined;
        };
        const activeRequestKey = activeRequestKeyBySession.get(sessionKey);
        const resolveActiveRequestStartedAt = (requestKey: string): number | undefined => {
          const root = activeRoots.get(requestKey);
          const run = activeRuns.get(requestKey);
          const candidates = [
            root?.startedAt,
            run?.messageQueuedTs,
            run?.userStartTs,
            run?.mainStartTs,
          ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
          if (candidates.length === 0) {
            return undefined;
          }
          return Math.min(...candidates);
        };
        const matchingRequestKey = findMatchingRequestKey();
        if (matchingRequestKey) {
          return matchingRequestKey;
        }
        const matchingRecord = findRequestRecord();
        if (matchingRecord) {
          if (matchingRecord.closedAt !== undefined && !hasLiveRequest(matchingRecord.requestKey)) {
            return undefined;
          }
          return matchingRecord.requestKey;
        }
        if (activeRequestKey) {
          if (!shouldFallbackRunBoundEventToActiveRequest({
            runId: resolvedRunId,
            eventTs: typeof evt.ts === "number" && Number.isFinite(evt.ts) ? evt.ts : undefined,
            activeRequestStartedAt: resolveActiveRequestStartedAt(activeRequestKey),
          })) {
            return undefined;
          }
          return activeRequestKey;
        }
        if (!createIfMissing) {
          return undefined;
        }
        const nextRequestKey = buildRequestKey(evt);
        if (!nextRequestKey) {
          return undefined;
        }
        activeRequestKeyBySession.set(sessionKey, nextRequestKey);
        rememberRequestRecord(sessionKey, nextRequestKey, evt);
        return nextRequestKey;
      };

      const beginRequestTrace = (
        evt: { sessionKey?: string; sessionId?: string; ts?: number; messageId?: string | number; runId?: string },
      ) => {
        const sessionKey = resolveSessionKey(evt);
        if (!sessionKey) {
          return undefined;
        }
        const nextRequestKey = buildRequestKey(evt);
        if (!nextRequestKey) {
          return undefined;
        }
        activeRequestKeyBySession.set(sessionKey, nextRequestKey);
        rememberRequestRecord(sessionKey, nextRequestKey, evt);
        return nextRequestKey;
      };

      const releaseRequestKey = (
        sessionKey: string | undefined,
        requestKey: string | undefined,
      ) => {
        if (!sessionKey || !requestKey) {
          return;
        }
        if (activeRequestKeyBySession.get(sessionKey) !== requestKey) {
          return;
        }
        if (activeRoots.has(requestKey) || activeRuns.has(requestKey)) {
          return;
        }
        activeRequestKeyBySession.delete(sessionKey);
      };

      const emitRuntimeOrchestrationSpan = (
        evt: { sessionKey?: string; sessionId?: string; runId?: string },
        startTs: number | undefined,
        endTs: number | undefined,
        phase: string,
        attrs?: Record<string, string | number | boolean | undefined>,
        parentCtx?: any,
      ) => {
        const sessionKey = resolveSessionKey(evt);
        const requestKey = resolveRequestKey(evt, false);
        if (!sessionKey || !requestKey || typeof startTs !== "number" || typeof endTs !== "number") {
          return undefined;
        }
        const root = activeRoots.get(requestKey);
        const run = activeRuns.get(requestKey);
        const effectiveStartTs = Math.max(
          startTs,
          phase === "dispatch_queue"
            ? root?.startedAt ?? startTs
            : run?.mainStartTs ?? startTs,
        );
        const effectiveEndTs = Math.max(endTs, effectiveStartTs + 1);
        if (effectiveEndTs <= effectiveStartTs) {
          return undefined;
        }
        const span = tracer.startSpan(
          phase === "dispatch_queue"
              ? "dispatch_queue"
            : phase === "session_processing"
              ? "session_processing"
              : "runtime_orchestration",
          {
            startTime: new Date(effectiveStartTs),
            kind: SpanKind.INTERNAL,
            attributes: traceAttrs(enrichWithTranscript(sessionKey, {
              __suppress_session_input_preview: true,
              __suppress_session_output_preview: true,
              __suppress_session_output_summary:
                phase === "dispatch_queue"
                || phase === "session_processing",
              ...buildRunScopeAttrs(
                resolveRunId(evt) ?? run?.runId ?? root?.runId,
                run?.runIds,
                root?.runIds,
                resolveRunId(evt),
              ),
              session_id: evt.sessionId,
              "openclaw.sessionId": evt.sessionId,
              session_update_time: endTs,
              "span.kind": "runtime",
              "openclaw.runtime.phase": phase,
              __min_snapshot_user_ts:
                phase === "dispatch_queue" || phase === "session_processing"
                  ? effectiveStartTs
                  : undefined,
              ...attrs,
            })),
          },
          parentCtx ?? run?.ctx ?? root?.ctx ?? context.active(),
        );
        span.setStatus({ code: SpanStatusCode.OK });
        endSpanSafely(span, new Date(effectiveEndTs));
        if (run) {
          run.runtimeLifecycleSpans ??= [];
          run.runtimeLifecycleSpans.push(span);
          patchRuntimeLifecycleRunScopeAttrs(run, root, resolveRunId(evt));
        }
        if (run && phase !== "session_processing") {
          run.orchestrationCursorTs = effectiveEndTs;
        }
        return span;
      };

      const ensureRuntimeLifecycleSpans = (
        evt: {
          sessionKey?: string;
          sessionId?: string;
          runId?: string;
          ts?: number;
          channel?: string;
          source?: string;
          outcome?: string;
        },
        options?: {
          createIfMissing?: boolean;
          startTsHint?: number;
          processingStartTs?: number;
          nextActionTs?: number;
          snapshot?: ReturnType<typeof loadSessionSnapshot>;
          outputPreview?: string;
          outputLength?: number;
          outcome?: string;
        },
      ) => {
        const sessionKey = resolveSessionKey(evt);
        if (!sessionKey) {
          return undefined;
        }
        const providedSnapshot = options?.snapshot;
        const snapshot = providedSnapshot ?? loadSessionSnapshot(sessionKey);
        const lifecycleEvt = {
          sessionKey: evt.sessionKey,
          sessionId: evt.sessionId,
          runId: evt.runId ?? providedSnapshot?.runId,
          ts: options?.startTsHint ?? evt.ts,
        };
        const run = getRun(lifecycleEvt, options?.createIfMissing ?? false);
        if (!run) {
          return undefined;
        }
        const root = getRoot(lifecycleEvt, options?.createIfMissing ?? false);
        const resolvedSessionId = snapshot?.sessionId ?? evt.sessionId;
        const ingressStartTs = typeof run.messageQueuedTs === "number"
          ? run.messageQueuedTs
          : root?.startedAt ?? run.startedAt ?? lifecycleEvt.ts;
        const processingStartTs = typeof options?.processingStartTs === "number"
          ? options.processingStartTs
          : run.mainStartTs;

        if (resolvedSessionId) {
          if (!run.dispatchQueueEmitted && run.pendingDispatchQueueWindow) {
            emitRuntimeOrchestrationSpan(
              { ...lifecycleEvt, sessionId: resolvedSessionId },
              run.pendingDispatchQueueWindow.startTs,
              run.pendingDispatchQueueWindow.endTs,
              "dispatch_queue",
              {
                "openclaw.channel": run.pendingDispatchQueueWindow.channel,
                "openclaw.source": run.pendingDispatchQueueWindow.source,
                "openclaw.queue.wait_ms": run.pendingDispatchQueueWindow.queueWaitMs,
              },
              root?.ctx,
            );
            run.dispatchQueueEmitted = true;
            run.pendingDispatchQueueWindow = undefined;
          }
          if (!run.sessionProcessingEmitted && run.pendingSessionProcessingWindow) {
            emitRuntimeOrchestrationSpan(
              { ...lifecycleEvt, sessionId: resolvedSessionId },
              run.pendingSessionProcessingWindow.startTs,
              run.pendingSessionProcessingWindow.endTs,
              "session_processing",
              {
                "openclaw.state": "processing",
              },
              run.ctx,
            );
            run.sessionProcessingEmitted = true;
            run.orchestrationCursorTs = Math.max(
              run.orchestrationCursorTs ?? run.pendingSessionProcessingWindow.startTs,
              run.pendingSessionProcessingWindow.endTs,
            );
            run.pendingSessionProcessingWindow = undefined;
          }
        }

        if (!run.dispatchQueueEmitted && typeof ingressStartTs === "number") {
          const { queueStartTs, queueEndTs } = resolveIngressLifecycleWindows(ingressStartTs, processingStartTs);
          if (typeof queueStartTs === "number" && typeof queueEndTs === "number") {
            if (resolvedSessionId) {
              emitRuntimeOrchestrationSpan(
                { ...lifecycleEvt, sessionId: resolvedSessionId },
                queueStartTs,
                queueEndTs,
                "dispatch_queue",
                {
                  "openclaw.channel": evt.channel ?? snapshot?.lastChannel,
                  "openclaw.source": evt.source,
                  "openclaw.queue.wait_ms": Math.max(queueEndTs - queueStartTs, 1),
                },
                root?.ctx,
              );
            } else {
              run.pendingDispatchQueueWindow = {
                startTs: queueStartTs,
                endTs: queueEndTs,
                channel: evt.channel ?? snapshot?.lastChannel,
                source: evt.source,
                queueWaitMs: Math.max(queueEndTs - queueStartTs, 1),
              };
            }
          }
          if (resolvedSessionId || typeof queueStartTs !== "number" || typeof queueEndTs !== "number") {
            run.dispatchQueueEmitted = true;
          }
          if (run.dispatchQueueEmitted) {
            run.messageQueuedTs = undefined;
          }
        }

        if (!run.sessionProcessingEmitted && typeof processingStartTs === "number") {
          const processingEndTs = typeof options?.nextActionTs === "number"
            ? Math.max(Math.min(processingStartTs + MIN_VISIBLE_CHILD_MS, options.nextActionTs), processingStartTs + 1)
            : processingStartTs + MIN_VISIBLE_CHILD_MS;
          if (resolvedSessionId) {
            emitRuntimeOrchestrationSpan(
              { ...lifecycleEvt, sessionId: resolvedSessionId },
              processingStartTs,
              processingEndTs,
              "session_processing",
              {
                "openclaw.state": "processing",
              },
              run.ctx,
            );
            run.sessionProcessingEmitted = true;
            run.orchestrationCursorTs = Math.max(
              run.orchestrationCursorTs ?? processingStartTs,
              processingEndTs,
            );
          } else {
            run.pendingSessionProcessingWindow = {
              startTs: processingStartTs,
              endTs: processingEndTs,
            };
          }
        }

        return run;
      };

      const emitModelTurnDebugLog = (payload: Record<string, unknown>) => {
        try {
          ctx.logger.info(`[otel-plugin] model-turn ${JSON.stringify(payload)}`);
        } catch {
          ctx.logger.info("[otel-plugin] model-turn log failed to serialize");
        }
      };

      const emitDiagnosticLog = (
        evt: DiagnosticEventPayload,
        attrs: Record<string, string | number | boolean | undefined>,
        options?: {
          body?: string;
          severityNumber?: number;
          severityText?: string;
          context?: any;
          eventName?: string;
          exception?: unknown;
        },
      ) => {
        if (!diagnosticsLogger) {
          return;
        }
        const sessionKey = "sessionKey" in evt || "sessionId" in evt ? resolveSessionKey(evt) : undefined;
        const requestKey = "sessionKey" in evt || "sessionId" in evt ? resolveRequestKey(evt, false) : undefined;
        const currentRun = requestKey ? activeRuns.get(requestKey) : undefined;
        const currentRoot = requestKey ? activeRoots.get(requestKey) : undefined;
        diagnosticsLogger.emit({
          body: options?.body ? redactSensitiveText(options.body) : evt.type,
          eventName: options?.eventName ?? evt.type,
          severityNumber: options?.severityNumber,
          severityText: options?.severityText,
          attributes: traceAttrs(enrichWithTranscript(sessionKey, {
            "openclaw.event.type": evt.type,
            ...attrs,
          })),
          ...(options?.exception ? { exception: options.exception } : {}),
          timestamp: eventTimestamp(evt),
          observedTimestamp: new Date(),
          context: options?.context ?? currentRun?.modelCtx ?? currentRun?.ctx ?? currentRoot?.ctx ?? context.active(),
        });
      };

      function replayTranscriptSnapshot(
        sessionKey: string,
        options?: { source?: "update" | "sweep"; sessionFile?: string },
      ) {
        sessionStore?.refreshSessionsIndex();
        if (options?.sessionFile) {
          sessionStore?.invalidateSessionFile(options.sessionFile);
        }
        const snapshot = loadSessionSnapshot(sessionKey);
        if (!snapshot?.lastAssistantTs || (!snapshot.lastAssistantText && !snapshot.lastRunAssistantTurns?.length)) {
          return;
        }
        if (isHeartbeatSessionSnapshot(snapshot)) {
          return;
        }
        const transcriptEvt = buildTranscriptReplayEvent(sessionKey, snapshot);
        const activeRun = getRun(transcriptEvt, false);
        const hasActiveTrace = Boolean(activeRun || getRoot(transcriptEvt, false));
        const replayAlreadyFinalized = hasReplayWatermark(sessionKey, snapshot);
        const replaySnapshotFreshness = resolveTranscriptReplayFreshness({
          snapshot,
          activeRun,
          fallbackTs: transcriptEvt.ts,
        });
        const replayPlan = resolveTranscriptReplayPlan({
          hasActiveTrace,
          replayAlreadyFinalized,
          runCompleted: snapshot.runCompleted === true,
          replaySnapshotFresh: replaySnapshotFreshness,
        });
        if (replayPlan.markFinalizationOnly) {
          markReplayFinalization(sessionKey, snapshot);
        }
        if (!replayPlan.emitReplay) {
          return;
        }
        const replaySummaryAttrs = !hasActiveTrace
          ? buildReplaySummaryAttrs("transcript")
          : undefined;
        syncTranscriptSkillSummary(transcriptEvt);
        const emittedTranscriptModelSpans = emitTranscriptModelSpans(transcriptEvt);
        if (emittedTranscriptModelSpans) {
          emitTranscriptToolSpans(transcriptEvt);
        } else {
          emitSyntheticModelSpan(transcriptEvt);
        }
        if (snapshot.runCompleted !== true) {
          return;
        }
        markReplayFinalization(sessionKey, snapshot);
        ensureRuntimeLifecycleSpans(transcriptEvt, {
          createIfMissing: true,
          snapshot,
          outputPreview: clipPreview(snapshot.lastAssistantText),
          outputLength: snapshot.lastAssistantText?.length,
          outcome: "completed",
        });
        syncRootFromRun(transcriptEvt);
        const run = getRun(transcriptEvt, false);
        if (run) {
          run.pendingFinalOutcome = "completed";
          run.lastTouchedAt = Date.now();
        }
        endRun(transcriptEvt, stringAttrs({
          "openclaw.state": "completed",
          "openclaw.outcome": "completed",
          ...(replaySummaryAttrs ?? {}),
        }));
        endRoot(transcriptEvt, stringAttrs({
          "openclaw.state": "completed",
          "openclaw.outcome": "completed",
          ...(replaySummaryAttrs ?? {}),
        }));
        clearRun(transcriptEvt);
      }

      const replayCompletedTrajectoryRuns = (sessionKey: string) => {
        const lastTrajectorySourceSeq = replayTrajectorySourceSeqBySession.get(sessionKey) ?? 0;
        const completedRuns = sessionStore?.listCompletedTrajectoryRuns(sessionKey, lastTrajectorySourceSeq) ?? [];
        if (completedRuns.length === 0) {
          return;
        }

        const createImmediateSpan = (
          name: string,
          startTs: number,
          endTs: number,
          kind: any,
          attrs: Record<string, string | number | boolean | undefined>,
          parentCtx?: any,
        ) => {
          const span = tracer.startSpan(
            name,
            {
              startTime: new Date(startTs),
              kind,
              attributes: traceAttrs(attrs),
            },
            parentCtx ?? context.active(),
          );
          span.setStatus({ code: SpanStatusCode.OK });
          endSpanSafely(span, new Date(endTs));
          return span;
        };

        const recordTrajectoryModelMetrics = (
          trajectoryRun: CompletedTrajectoryRun,
          usageTotals: ReturnType<typeof resolveUsageTokenTotals>,
        ) => {
          const modelMetricAttrs = buildGenAiClientModelMetricAttrs(
            trajectoryRun.provider,
            trajectoryRun.model,
            {
              session_id: trajectoryRun.sessionId,
            },
          );
          const durationMs = Math.max(
            (trajectoryRun.assistantTs ?? trajectoryRun.completedAt ?? Date.now())
            - (trajectoryRun.userTs ?? trajectoryRun.startedAt ?? Date.now()),
            1,
          );
          instruments.genAiClientOperationDuration?.record(durationMsToSeconds(durationMs), modelMetricAttrs);
          const tokenMetrics = [
            ["input", usageTotals.inputTokens],
            ["output", usageTotals.outputTokens],
          ] as const;
          for (const [tokenType, tokenValue] of tokenMetrics) {
            if (tokenValue <= 0) {
              continue;
            }
            instruments.genAiClientTokenUsage?.record(
              tokenValue,
              buildGenAiClientTokenMetricAttrs(trajectoryRun.provider, trajectoryRun.model, {
                session_id: trajectoryRun.sessionId,
                token_type: tokenType,
              }),
            );
          }
        };

        for (const trajectoryRun of completedRuns) {
          const pendingRunIds = pendingTrajectoryReplayRunIdsBySession.get(sessionKey);
          if (trajectoryRun.runId && pendingRunIds?.has(trajectoryRun.runId)) {
            markTrajectoryReplaySourceSeq(sessionKey, trajectoryRun.sourceSeq);
            forgetPendingTrajectoryReplayRunId(sessionKey, trajectoryRun.runId);
            continue;
          }
          const latestSnapshot = loadSessionSnapshot(sessionKey);
          const sessionId = trajectoryRun.sessionId ?? latestSnapshot?.sessionId;
          const userText = trajectoryRun.finalPromptText ?? trajectoryRun.userText;
          const assistantText = trajectoryRun.assistantText;
          const outputPreview = clipPreview(assistantText);
          const usageTotals = resolveUsageTokenTotals({
            input: trajectoryRun.usage?.input,
            output: trajectoryRun.usage?.output,
            cacheRead: trajectoryRun.usage?.cacheRead,
            cacheWrite: trajectoryRun.usage?.cacheWrite,
            total: trajectoryRun.usage?.total,
          });
          const requestClassification = resolveRequestClassification({
            lastUserText: userText,
            lastAssistantText: assistantText,
            inputPreview: userText,
            outputPreview,
          });
          const finalStatus = normalizeFinalStatus(trajectoryRun.finalStatus) ?? "completed";
          const requestStartTs = trajectoryRun.startedAt
            ?? trajectoryRun.userTs
            ?? trajectoryRun.completedAt
            ?? Date.now();
          const processingStartTs = trajectoryRun.userTs ?? requestStartTs;
          const modelStartTs = trajectoryRun.userTs ?? processingStartTs;
          const rawModelEndTs = trajectoryRun.assistantTs
            ?? trajectoryRun.completedAt
            ?? (modelStartTs + MIN_VISIBLE_MODEL_MS);
          const modelEndTs = Math.max(rawModelEndTs, modelStartTs + 1);
          const egressEndTs = Math.max(trajectoryRun.completedAt ?? modelEndTs, modelEndTs + MIN_VISIBLE_CHILD_MS);
          const processingEndTs = Math.max(
            Math.min(processingStartTs + MIN_VISIBLE_CHILD_MS, modelStartTs),
            processingStartTs + 1,
          );

          const baseAttrs = {
            ...stringAttrs({
              "openclaw.sessionKey": sessionKey,
              "openclaw.sessionId": sessionId,
              "openclaw.channel": latestSnapshot?.lastChannel,
              "openclaw.provider": trajectoryRun.provider,
              "openclaw.model": trajectoryRun.model,
              "openclaw.input.preview": userText,
              "openclaw.input.length": userText?.length,
              "openclaw.output.preview": outputPreview,
              "openclaw.output.length": assistantText?.length,
              "openclaw.tokens.input": usageTotals.inputTokens,
              "openclaw.tokens.output": usageTotals.outputTokens,
              "openclaw.tokens.total": usageTotals.totalTokens,
              "openclaw.tokens.cache_read": usageTotals.cacheReadTokens,
              "openclaw.tokens.cache_write": usageTotals.cacheWriteTokens,
              "openclaw.outcome": finalStatus,
              "openclaw.output.kind": assistantText ? "text" : undefined,
              replay_source: "trajectory",
              trace_completeness: "partial",
            }),
            ...buildRunScopeAttrs(trajectoryRun.runId, trajectoryRun.runId),
            request_type: requestClassification.requestType,
            request_category: requestClassification.requestCategory,
            is_internal_request: requestClassification.isInternalRequest,
            session_create_at: latestSnapshot?.createdAt,
            session_update_time: egressEndTs,
            "openclaw.session.file": latestSnapshot?.sessionFile,
            "openclaw.session.chatType": latestSnapshot?.chatType,
            "openclaw.session.origin.provider": latestSnapshot?.originProvider,
            "openclaw.session.origin.surface": latestSnapshot?.originSurface,
            "openclaw.session.cwd": latestSnapshot?.sessionCwd,
          };

          const rootSpan = tracer.startSpan(
            "openclaw_request",
            {
              startTime: new Date(requestStartTs),
              kind: SpanKind.SERVER,
              attributes: buildAgentSummaryTraceAttrs(sessionKey, {
                ...baseAttrs,
                "span.kind": "request",
              }),
            },
            context.active(),
          );
          const rootCtx = trace.setSpan(context.active(), rootSpan);
          const runSpan = tracer.startSpan(
            "invoke_agent",
            {
              startTime: new Date(requestStartTs),
              kind: SpanKind.INTERNAL,
              attributes: buildAgentSummaryTraceAttrs(sessionKey, {
                ...baseAttrs,
                "span.kind": "agent",
              }),
            },
            rootCtx,
          );
          const runCtx = trace.setSpan(rootCtx, runSpan);

          createImmediateSpan(
            "session_processing",
            processingStartTs,
            processingEndTs,
            SpanKind.INTERNAL,
            {
              ...baseAttrs,
              "span.kind": "runtime",
              "openclaw.runtime.phase": "session_processing",
              "openclaw.state": "processing",
            },
            runCtx,
          );
          if (modelStartTs > processingEndTs) {
            createImmediateSpan(
              "runtime_orchestration",
              processingEndTs,
              modelStartTs,
              SpanKind.INTERNAL,
              {
                ...baseAttrs,
                "span.kind": "runtime",
                "openclaw.runtime.phase": "agent_plan",
              },
              runCtx,
            );
          }
          const modelSpan = createImmediateSpan(
            "llm",
            modelStartTs,
            modelEndTs,
            SpanKind.CLIENT,
            {
              ...baseAttrs,
              "span.kind": "model",
              turn_index: 1,
              input_preview: userText,
              output_preview: outputPreview,
              output_length: assistantText?.length,
              usage_input_tokens: usageTotals.inputTokens,
              usage_output_tokens: usageTotals.outputTokens,
              usage_total_tokens: usageTotals.totalTokens,
              usage_cache_read_input_tokens: usageTotals.cacheReadTokens,
              usage_cache_write_input_tokens: usageTotals.cacheWriteTokens,
            },
            runCtx,
          );
          runSpan.setAttributes(buildAgentSummaryTraceAttrs(sessionKey, {
            ...baseAttrs,
            "span.kind": "agent",
          }));
          rootSpan.setAttributes(buildAgentSummaryTraceAttrs(sessionKey, {
            ...baseAttrs,
            "span.kind": "request",
          }));

          emitModelTurnDebugLog({
            source: "trajectory",
            trace_id: typeof modelSpan.spanContext === "function" ? modelSpan.spanContext().traceId : undefined,
            span_id: typeof modelSpan.spanContext === "function" ? modelSpan.spanContext().spanId : undefined,
            session_key: sessionKey,
            session_id: sessionId,
            run_id: trajectoryRun.runId,
            provider: trajectoryRun.provider,
            model: trajectoryRun.model,
            start_ts: modelStartTs,
            end_ts: modelEndTs,
            duration_ms: Math.max(modelEndTs - modelStartTs, 1),
            usage_input_tokens: usageTotals.inputTokens,
            usage_output_tokens: usageTotals.outputTokens,
            usage_total_tokens: usageTotals.totalTokens,
            usage_cache_read_input_tokens: usageTotals.cacheReadTokens,
            usage_cache_write_input_tokens: usageTotals.cacheWriteTokens,
            input_preview: userText,
            output_preview: outputPreview,
            output_kind: assistantText ? "text" : undefined,
          });

          recordTrajectoryModelMetrics(trajectoryRun, usageTotals);
          const requestMetricSnapshot = {
            sessionId,
            lastChannel: latestSnapshot?.lastChannel,
            lastProvider: trajectoryRun.provider,
            lastModel: trajectoryRun.model,
          };
          const requestSummaryAttrs = {
            "openclaw.state": "completed",
            "openclaw.outcome": finalStatus,
          };
          const requestMetricAttrs = buildGenAiWorkflowMetricAttrs(
            requestMetricSnapshot as any,
            requestSummaryAttrs,
          );
          instruments.genAiWorkflowDuration?.record(
            durationMsToSeconds(Math.max(egressEndTs - requestStartTs, 1)),
            requestMetricAttrs,
          );

          runSpan.setStatus({ code: SpanStatusCode.OK });
          rootSpan.setStatus({ code: SpanStatusCode.OK });
          endSpanSafely(runSpan, new Date(egressEndTs));
          endSpanSafely(rootSpan, new Date(egressEndTs));

          const latestCompletedSnapshot = loadSessionSnapshot(sessionKey);
          if (
            latestCompletedSnapshot?.runCompleted === true
            && latestCompletedSnapshot.runId === trajectoryRun.runId
          ) {
            markReplayFinalization(sessionKey, latestCompletedSnapshot);
          } else {
            markTrajectoryReplaySourceSeq(sessionKey, trajectoryRun.sourceSeq);
          }
        }
      };

      const reportSessionMetrics = () => {
        try {
          sessionStore?.refreshSessionsIndex();
          const now = Date.now();
          const pendingSessionKeys = Array.from(sessionMetricTokenState.entries())
            .filter(([, state]) => state.dirty)
            .map(([sessionKey]) => sessionKey);
          const recentSessionKeys = sessionStore?.listRecentSessionKeys(recentSessionSweepAt) ?? [];
          const activeSessionKeys = new Set<string>([
            ...Array.from(activeRoots.values())
              .map((current) => current.sessionIdentity)
              .filter((value): value is string => Boolean(value)),
            ...Array.from(activeRuns.values())
              .map((current) => current.sessionIdentity)
              .filter((value): value is string => Boolean(value)),
            ...pendingSessionKeys,
            ...recentSessionKeys,
          ]);
          for (const sessionKey of activeSessionKeys) {
            replayCompletedTrajectoryRuns(sessionKey);
            replayTranscriptSnapshot(sessionKey, { source: "sweep" });
            const snapshot = loadSessionSnapshot(sessionKey);
            const tokenState = sessionMetricTokenState.get(sessionKey);
            const seriesKey = snapshot?.sessionId?.trim() || sessionKey;
            if (!seriesKey) {
              continue;
            }
            const currentTotals = resolveSessionMetricTotals(snapshot);
            currentTotals.inputTokens = Math.max(
              currentTotals.inputTokens,
              tokenState?.inputTokens ?? 0,
            );
            currentTotals.outputTokens = Math.max(
              currentTotals.outputTokens,
              tokenState?.outputTokens ?? 0,
            );
            currentTotals.totalTokens = Math.max(
              currentTotals.totalTokens,
              tokenState?.totalTokens ?? 0,
            );
            reportedSessionMetrics.set(seriesKey, currentTotals);
            if (tokenState) {
              tokenState.dirty = false;
              if (!tokenState.active) {
                sessionMetricTokenState.delete(sessionKey);
              }
            }
          }
          recentSessionSweepAt = now;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.logger.error?.(`[otel-plugin] active session metrics scan failed: ${message}`);
        }
      };

      const finalizeRunSpans = (current: ActiveRunSpan, endTime?: Date) => {
        if (current.modelSpan) {
          current.modelSpan.setStatus({ code: SpanStatusCode.OK });
          endSpanSafely(current.modelSpan, endTime);
          current.modelSpan = undefined;
          current.modelCtx = undefined;
          current.modelStartTs = undefined;
        }
        toolSpanManager.finalizeToolAndSkillSpans(current, endTime);
        if (current.span) {
          current.span.setStatus({ code: SpanStatusCode.OK });
          endSpanSafely(current.span, endTime);
          current.span = undefined;
        }
        current.ctx = current.userCtx ?? current.ctx;
        if (current.userSpan) {
          current.userSpan.setStatus({ code: SpanStatusCode.OK });
          endSpanSafely(current.userSpan, endTime);
          current.userSpan = undefined;
          current.userCtx = undefined;
          current.userStartTs = undefined;
        }
      };

      const getRoot = (
        evt: { sessionKey?: string; sessionId?: string; runId?: string; channel?: string; source?: string; queueDepth?: number },
        createIfMissing = false,
      ) => {
        const sessionKey = resolveSessionKey(evt);
        const requestKey = resolveRequestKey(evt, createIfMissing);
        if (!sessionKey || !requestKey) {
          return undefined;
        }
        const current = activeRoots.get(requestKey);
        if (current) {
          const resolvedRunId = resolveRunId(evt);
          if (rememberRunId(current, resolvedRunId)) {
            const run = activeRuns.get(requestKey);
            if (run) {
              rememberRunId(run, resolvedRunId);
              if (run.span) {
                run.span.setAttributes(traceRunScopeAttrs(resolvedRunId ?? run.runId, run.runIds, current.runIds));
              }
              patchRuntimeLifecycleRunScopeAttrs(run, current, resolvedRunId);
            }
            current.span.setAttributes(traceRunScopeAttrs(resolvedRunId ?? current.runId, current.runIds));
          }
          current.lastTouchedAt = Date.now();
          return current;
        }
        if (!createIfMissing) {
          return undefined;
        }
        const seededRun = activeRuns.get(requestKey);
        const rootStartTs = typeof seededRun?.messageQueuedTs === "number"
          ? seededRun.messageQueuedTs
          : eventTimestamp(evt).getTime();
        const snapshot = loadSessionSnapshot(sessionKey);
        const span = tracer.startSpan(
          "openclaw_request",
          {
            startTime: new Date(rootStartTs),
            kind: SpanKind.SERVER,
            attributes: traceAttrs(enrichWithTranscript(sessionKey, {
              __suppress_session_model: true,
              "openclaw.sessionKey": evt.sessionKey,
              "openclaw.sessionId": evt.sessionId,
              ...buildRunScopeAttrs(resolveRunId(evt), resolveRunId(evt)),
              "openclaw.channel": evt.channel,
              "openclaw.source": evt.source,
              "openclaw.queueDepth": evt.queueDepth,
              session_create_at: snapshot?.createdAt,
              session_update_time: rootStartTs,
              "span.kind": "request",
            })),
          },
        );
        const root = {
          requestKey,
          sessionIdentity: sessionKey,
          runId: resolveRunId(evt),
          runIds: resolveRunId(evt) ? new Set([resolveRunId(evt)]) : new Set<string>(),
          span,
          ctx: trace.setSpan(context.active(), span),
          startedAt: rootStartTs,
          lastTouchedAt: Date.now(),
        };
        activeRoots.set(requestKey, root);
        return root;
      };

      const getRun = (
        evt: { sessionKey?: string; sessionId?: string; runId?: string },
        createIfMissing = false,
      ) => {
        const sessionKey = resolveSessionKey(evt);
        const requestKey = resolveRequestKey(evt, createIfMissing);
        if (!sessionKey || !requestKey) {
          return undefined;
        }
        const current = activeRuns.get(requestKey);
        if (current?.span || (current && !createIfMissing)) {
          const resolvedRunId = resolveRunId(evt);
          if (rememberRunId(current, resolvedRunId)) {
            const root = activeRoots.get(requestKey);
            if (root) {
              rememberRunId(root, resolvedRunId);
              root.span.setAttributes(traceRunScopeAttrs(resolvedRunId ?? root.runId, root.runIds, current.runIds));
            }
            if (current.span) {
              current.span.setAttributes(traceRunScopeAttrs(resolvedRunId ?? current.runId, current.runIds));
            }
            patchRuntimeLifecycleRunScopeAttrs(current, root, resolvedRunId);
          }
          current.lastTouchedAt = Date.now();
          return current;
        }
        if (!createIfMissing) {
          return undefined;
        }
        const root = getRoot(evt, true);
        if (!root) {
          return undefined;
        }
        const resolvedRunId = resolveRunId(evt);
        if (rememberRunId(root, resolvedRunId)) {
          root.span.setAttributes(traceRunScopeAttrs(resolvedRunId ?? root.runId, root.runIds));
        }
        const userCtx = current?.userCtx;
        const snapshot = loadSessionSnapshot(sessionKey);
        const span = tracer.startSpan(
          "invoke_agent",
          {
            startTime: eventTimestamp(evt),
            kind: SpanKind.INTERNAL,
            attributes: traceAttrs(enrichWithTranscript(sessionKey, {
              __suppress_session_model: true,
              "openclaw.sessionKey": evt.sessionKey,
              "openclaw.sessionId": evt.sessionId,
              ...buildRunScopeAttrs(resolvedRunId ?? root.runId, root.runIds, resolvedRunId),
              session_create_at: snapshot?.createdAt,
              session_update_time: eventTimestamp(evt).getTime(),
              "span.kind": "agent",
            })),
          },
          userCtx ?? root.ctx,
        );
        const runStartTs = eventTimestamp(evt).getTime();
        const run = current ?? createRunState(userCtx ?? root.ctx, runStartTs, runStartTs);
        run.requestKey = requestKey;
        run.sessionIdentity = sessionKey;
        rememberRunId(run, resolvedRunId ?? root.runId);
        run.span = span;
        run.ctx = trace.setSpan(userCtx ?? root.ctx, span);
        activeRuns.set(requestKey, run);
        patchRuntimeLifecycleRunScopeAttrs(run, root, resolvedRunId);
        return run;
      };

      const ensureUserSpan = (
        evt: { sessionKey?: string; sessionId?: string; runId?: string; ts: number; channel?: string; source?: string; queueDepth?: number },
      ) => {
        const sessionKey = resolveSessionKey(evt);
        const requestKey = resolveRequestKey(evt, true);
        if (!sessionKey || !requestKey) {
          return undefined;
        }
        const existing = activeRuns.get(requestKey);
        const root = getRoot(evt, true);
        if (!root) {
          return undefined;
        }
        const resolvedRunId = resolveRunId(evt);
        if (rememberRunId(root, resolvedRunId)) {
          root.span.setAttributes(traceRunScopeAttrs(resolvedRunId ?? root.runId, root.runIds));
        }
        const snapshot = loadSnapshotForEvent(evt, loadSessionSnapshot, resolveSessionKey);
        root.span.setAttributes(traceAttrs({
          session_update_time: evt.ts,
          "openclaw.input.preview": normalizeUserInputPreview(snapshot?.lastUserText),
          "openclaw.input.length": snapshot?.lastUserText?.length,
        }));
        const run = existing ?? createRunState(root.ctx, evt.ts, evt.ts);
        run.requestKey = requestKey;
        run.sessionIdentity = sessionKey;
        rememberRunId(run, resolvedRunId ?? root.runId);
        run.userCtx = root.ctx;
        run.userStartTs = evt.ts;
        run.lastTouchedAt = Date.now();
        activeRuns.set(requestKey, run as ActiveRunSpan);
        return activeRuns.get(requestKey);
      };

      const endRoot = (evt: { sessionKey?: string; sessionId?: string; runId?: string }, attrs?: Record<string, string | number | boolean>) => {
        const sessionKey = resolveSessionKey(evt);
        const requestKey = resolveRequestKey(evt, false);
        if (!sessionKey || !requestKey) {
          return;
        }
        const current = activeRoots.get(requestKey);
        if (!current) {
          return;
        }
        if (current.finalAttrsApplied) {
          finalizeRunSpans(current, eventTimestamp(evt));
          return;
        }
        const run = activeRuns.get(requestKey);
        const snapshot = loadSessionSnapshot(sessionKey);
        const summaryAttrs = normalizeTerminalSpanAttrs(attrs ?? {});
        const finalAttrs = buildAgentSummaryTraceAttrs(sessionKey, {
          ...enrichWithTranscript(sessionKey, summaryAttrs),
          ...buildRunScopeAttrs(
            resolveRunId(evt) ?? current.runId ?? run?.runId,
            current.runIds,
            run?.runIds,
            resolveRunId(evt),
          ),
          session_create_at: snapshot?.createdAt,
          session_update_time: eventTimestamp(evt).getTime(),
          "openclaw.skills": run ? Array.from(run.usedSkillNames).join(", ") : undefined,
          "openclaw.skill.count": run ? run.usedSkillNames.size : undefined,
          "openclaw.tools": run ? Array.from(run.usedToolNames).join(", ") : undefined,
          "openclaw.tool.count": run ? run.usedToolNames.size : undefined,
          "openclaw.tool.targets": run ? Array.from(run.usedToolTargets).join(" | ") : undefined,
          "openclaw.tool.commands": run ? Array.from(run.usedToolCommands).join(" | ") : undefined,
          "openclaw.tool.result_statuses": run ? Array.from(run.usedToolResultStatuses).join(", ") : undefined,
        });
        if (Object.keys(finalAttrs).length > 0) {
          current.span.setAttributes(finalAttrs);
        }
        patchRuntimeLifecycleRunScopeAttrs(run, current, resolveRunId(evt));
        if (attrs) {
          addEvent(current.span, "session.finish");
        }
        current.span.setStatus({ code: SpanStatusCode.OK });
        endSpanSafely(current.span, eventTimestamp(evt));
        const finalOutcome = typeof summaryAttrs["openclaw.outcome"] === "string"
          ? summaryAttrs["openclaw.outcome"]
          : undefined;
        if (finalOutcome && finalOutcome !== "interrupted") {
          const finalizedRunIds = new Set<string>([
            current.runId,
            run?.runId,
            resolveRunId(evt),
            ...Array.from(current.runIds ?? []),
            ...Array.from(run?.runIds ?? []),
          ].filter((value): value is string => Boolean(value)));
          for (const runId of finalizedRunIds) {
            rememberPendingTrajectoryReplayRunId(sessionKey, runId);
          }
        }
        markRequestRecordClosed(sessionKey, requestKey, eventTimestamp(evt).getTime());
        const metricState = sessionMetricTokenState.get(sessionKey);
        if (metricState) {
          metricState.active = false;
        }
        activeRoots.delete(requestKey);
        releaseRequestKey(sessionKey, requestKey);
      };

      const resolveSnapshotUsageTotals = (snapshot: ReturnType<typeof loadSessionSnapshot>) => ({
        inputTokens: snapshot?.sessionUsageTotals?.input ?? snapshot?.lastAssistantUsage?.input ?? 0,
        outputTokens: snapshot?.sessionUsageTotals?.output ?? snapshot?.lastAssistantUsage?.output ?? 0,
        cacheReadTokens: snapshot?.sessionUsageTotals?.cacheRead ?? snapshot?.lastAssistantUsage?.cacheRead ?? 0,
        cacheWriteTokens: snapshot?.sessionUsageTotals?.cacheWrite ?? snapshot?.lastAssistantUsage?.cacheWrite ?? 0,
        totalTokens: snapshot?.sessionUsageTotals?.totalTokens
          ?? resolveUsageTokenTotals(snapshot?.lastAssistantUsage).totalTokens,
      });

      const syncRootFromRun = (evt: { sessionKey?: string; sessionId?: string; runId?: string }) => {
        const sessionKey = resolveSessionKey(evt);
        const requestKey = resolveRequestKey(evt, false);
        if (!sessionKey || !requestKey) {
          return;
        }
        const run = activeRuns.get(requestKey);
        const root = activeRoots.get(requestKey);
        if (!run || !root) {
          return;
        }
        const snapshot = loadSessionSnapshot(sessionKey);
        root.span.setAttributes(buildAgentSummaryTraceAttrs(sessionKey, {
          ...buildRunScopeAttrs(resolveRunId(evt) ?? root.runId ?? run.runId, root.runIds, run.runIds, resolveRunId(evt)),
          session_create_at: snapshot?.createdAt,
          session_update_time: run.modelEndTs ?? run.mainEndTs ?? run.lastTouchedAt ?? Date.now(),
          "openclaw.skills": Array.from(run.usedSkillNames).join(", "),
          "openclaw.skill.count": run.usedSkillNames.size,
          "openclaw.tools": Array.from(run.usedToolNames).join(", "),
          "openclaw.tool.count": run.usedToolNames.size,
          "openclaw.tool.targets": Array.from(run.usedToolTargets).join(" | "),
          "openclaw.tool.commands": Array.from(run.usedToolCommands).join(" | "),
          "openclaw.tool.result_statuses": Array.from(run.usedToolResultStatuses).join(", "),
        }));
        patchRuntimeLifecycleRunScopeAttrs(run, root, resolveRunId(evt));
      };

      const endRun = (
        evt: { sessionKey?: string; sessionId?: string; runId?: string },
        attrs?: Record<string, string | number | boolean>,
      ) => {
        const sessionKey = resolveSessionKey(evt);
        const requestKey = resolveRequestKey(evt, false);
        if (!sessionKey || !requestKey) {
          return;
        }
        const current = activeRuns.get(requestKey);
        if (!current) {
          return;
        }
        const snapshot = loadSessionSnapshot(sessionKey);
        const summaryAttrs = normalizeTerminalSpanAttrs(attrs ?? {});
        syncTranscriptSkillSummary({
          sessionKey,
          sessionId: evt.sessionId,
          runId: evt.runId,
          ts: current.mainStartTs,
        });
        const finalAttrs = buildAgentSummaryTraceAttrs(sessionKey, {
          ...enrichWithTranscript(sessionKey, summaryAttrs),
          ...buildRunScopeAttrs(resolveRunId(evt) ?? current.runId, current.runIds, resolveRunId(evt)),
          session_create_at: snapshot?.createdAt,
          session_update_time: eventTimestamp(evt).getTime(),
          "openclaw.skills": Array.from(current.usedSkillNames).join(", "),
          "openclaw.skill.count": current.usedSkillNames.size,
          "openclaw.tools": Array.from(current.usedToolNames).join(", "),
          "openclaw.tool.count": current.usedToolNames.size,
          "openclaw.tool.targets": Array.from(current.usedToolTargets).join(" | "),
          "openclaw.tool.commands": Array.from(current.usedToolCommands).join(" | "),
          "openclaw.tool.result_statuses": Array.from(current.usedToolResultStatuses).join(", "),
        });
        if (current.span && Object.keys(finalAttrs).length > 0) {
          current.span.setAttributes(finalAttrs);
        }
        current.finalAttrsApplied = true;
        patchRuntimeLifecycleRunScopeAttrs(current, activeRoots.get(requestKey), resolveRunId(evt));
        if (attrs) {
          current.span && addEvent(current.span, "run.finish");
        }
        const genAiRequestMetricAttrs = buildGenAiWorkflowMetricAttrs(snapshot, summaryAttrs);
        instruments.genAiWorkflowDuration?.record(
          durationMsToSeconds(Math.max(0, eventTimestamp(evt).getTime() - current.startedAt)),
          genAiRequestMetricAttrs,
        );
        finalizeRunSpans(current, eventTimestamp(evt));
      };

      const clearRun = (evt: { sessionKey?: string; sessionId?: string; runId?: string }) => {
        const sessionKey = resolveSessionKey(evt);
        const requestKey = resolveRequestKey(evt, false);
        if (!sessionKey || !requestKey) {
          return;
        }
        activeRuns.delete(requestKey);
        releaseRequestKey(sessionKey, requestKey);
      };

      const discardActiveRequest = (evt: { sessionKey?: string; sessionId?: string; runId?: string }) => {
        const sessionKey = resolveSessionKey(evt);
        const requestKey = resolveRequestKey(evt, false);
        if (!sessionKey || !requestKey) {
          return;
        }
        activeRuns.delete(requestKey);
        activeRoots.delete(requestKey);
        const metricState = sessionMetricTokenState.get(sessionKey);
        if (metricState) {
          metricState.active = false;
        }
        releaseRequestKey(sessionKey, requestKey);
      };

      const concludeActiveRequest = (
        evt: { sessionKey?: string; sessionId?: string; runId?: string; ts?: number },
        attrs: Record<string, string | number | boolean>,
      ) => {
        endRun(evt, attrs);
        endRoot(evt, attrs);
        clearRun(evt);
      };

      const cleanupExpiredRoots = () => {
        const now = Date.now();
        for (const [requestKey, current] of Array.from(activeRoots.entries())) {
          if (activeRuns.has(requestKey)) {
            continue;
          }
          if (now - current.lastTouchedAt < config.rootSpanTtlMs) {
            continue;
          }
          addEvent(current.span, "session.timeout", { "openclaw.root.ttl_ms": config.rootSpanTtlMs });
          current.span.setAttributes(traceAttrs(normalizeTerminalSpanAttrs(stringAttrs({
            "openclaw.outcome": "interrupted",
            "openclaw.reason": "session.timeout",
          }))));
          endSpanSafely(current.span);
          const metricState = current.sessionIdentity
            ? sessionMetricTokenState.get(current.sessionIdentity)
            : undefined;
          if (metricState) {
            metricState.active = false;
          }
          markRequestRecordClosed(current.sessionIdentity, requestKey, now);
          activeRoots.delete(requestKey);
          releaseRequestKey(current.sessionIdentity, requestKey);
        }
        for (const [requestKey, current] of Array.from(activeRuns.entries())) {
          if (now - current.lastTouchedAt < config.rootSpanTtlMs) {
            continue;
          }
          const terminalAttrs = stringAttrs({
            "openclaw.outcome": "interrupted",
            "openclaw.reason": "session.timeout",
          });
          const concludeEvt = {
            sessionKey: current.sessionIdentity,
            runId: current.runId,
            ts: now,
          };
          if (current.sessionIdentity) {
            concludeActiveRequest(concludeEvt, terminalAttrs);
          } else {
            if (current.span) {
              addEvent(current.span, "run.timeout", { "openclaw.root.ttl_ms": config.rootSpanTtlMs });
            } else if (current.userSpan) {
              addEvent(current.userSpan, "run.timeout", { "openclaw.root.ttl_ms": config.rootSpanTtlMs });
            }
            finalizeRunSpans(current);
          }
          const metricState = current.sessionIdentity
            ? sessionMetricTokenState.get(current.sessionIdentity)
            : undefined;
          if (metricState) {
            metricState.active = false;
          }
          activeRuns.delete(requestKey);
          releaseRequestKey(current.sessionIdentity, requestKey);
        }
      };

      const createChildSpan = (
        name: string,
        evt: DiagnosticEventPayload,
        attrs: Record<string, string | number | boolean | undefined>,
        durationMs?: number,
        parentCtx?: any,
      ) => {
        const run = "sessionKey" in evt || "sessionId" in evt ? getRun(evt) : undefined;
        const root = run ?? ("sessionKey" in evt || "sessionId" in evt ? getRoot(evt) : undefined);
        const effectiveDurationMs =
          typeof durationMs === "number"
            ? Math.max(durationMs, name.includes("/") ? MIN_VISIBLE_MODEL_MS : MIN_VISIBLE_CHILD_MS)
            : MIN_VISIBLE_CHILD_MS;
        const { startTime, endTime } = resolveSpanWindow(
          evt.ts,
          typeof durationMs === "number" ? effectiveDurationMs : undefined,
        );
        const span = tracer.startSpan(
          name,
          {
            startTime,
            kind: name.includes("/")
              ? SpanKind.CLIENT
              : SpanKind.INTERNAL,
            attributes: traceAttrs({
              ...buildRunScopeAttrs(
                ("runId" in evt ? resolveRunId(evt) : undefined) ?? run?.runId ?? root?.runId,
                ("runId" in evt ? resolveRunId(evt) : undefined),
                run?.runIds,
                root?.runIds,
              ),
              ...attrs,
            }),
          },
          parentCtx ?? root?.ctx,
        );
        return { span, root, effectiveDurationMs, startTime, endTime };
      };

      const updateAggregateTokens = (
        evt: Extract<DiagnosticEventPayload, { type: "model.usage" }>,
      ) => {
        const run = getRun(evt, true);
        const root = getRoot(evt, true);
        if (!run || !root) {
          return;
        }
        const usageTotals = resolveUsageTokenTotals(evt.usage);

        run.aggregate.inputTokens += usageTotals.inputTokens;
        run.aggregate.outputTokens += usageTotals.outputTokens;
        run.aggregate.cacheReadTokens += usageTotals.cacheReadTokens;
        run.aggregate.cacheWriteTokens += usageTotals.cacheWriteTokens;
        run.aggregate.totalTokens += usageTotals.totalTokens;
        run.aggregate.promptTokens += evt.usage.promptTokens ?? 0;
        run.aggregate.costUsd += evt.costUsd ?? 0;
        run.aggregate.modelCalls += 1;
        run.aggregate.lastProvider = evt.provider ?? run.aggregate.lastProvider;
        run.aggregate.lastModel = evt.model ?? run.aggregate.lastModel;
        const sessionKey = resolveSessionKey(evt);
        if (sessionKey) {
          const metricState = sessionMetricTokenState.get(sessionKey) ?? {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            active: true,
            dirty: false,
          };
          metricState.inputTokens += usageTotals.inputTokens;
          metricState.outputTokens += usageTotals.outputTokens;
          metricState.totalTokens += usageTotals.totalTokens;
          metricState.modelProvider = evt.provider ?? metricState.modelProvider;
          metricState.modelName = evt.model ?? metricState.modelName;
          metricState.active = true;
          metricState.dirty = true;
          sessionMetricTokenState.set(sessionKey, metricState);
        }
        const summaryAttrs = traceAttrs({
          "openclaw.tokens.prompt": run.aggregate.promptTokens,
          "openclaw.cost.usd": Number(run.aggregate.costUsd.toFixed(8)),
          "openclaw.model.calls": run.aggregate.modelCalls,
          "openclaw.provider": run.aggregate.lastProvider,
          "openclaw.tools": Array.from(run.usedToolNames).join(", "),
          "openclaw.tool.count": run.usedToolNames.size,
          "openclaw.tool.targets": Array.from(run.usedToolTargets).join(" | "),
          "openclaw.tool.commands": Array.from(run.usedToolCommands).join(" | "),
          "openclaw.tool.result_statuses": Array.from(run.usedToolResultStatuses).join(", "),
          "openclaw.skills": Array.from(run.usedSkillNames).join(", "),
          "openclaw.skill.count": run.usedSkillNames.size,
        });

        const transcriptAttrs = buildAgentSummaryTraceAttrs(evt.sessionKey, summaryAttrs);
        run.span.setAttributes(transcriptAttrs);
        root.span.setAttributes(transcriptAttrs);
        run.modelSpanEmitted = true;
      };

      const toolSpanManager = createToolSpanManager({
        tracer,
        trace,
        SpanKind,
        SpanStatusCode,
        instruments,
        getRun,
        getRoot,
        ensureUserSpan,
        loadSessionSnapshot,
        enrichWithTranscript,
        createChildSpan,
        eventTimestamp,
        setLatestAssistantText(sessionKey, text) {
          sessionStore?.setLatestAssistantText(sessionKey, text);
        },
        emitRuntimeOrchestrationSpan,
        ensureRuntimeLifecycleSpans,
        emitModelTurnDebugLog,
      });
      const {
        annotateToolLoop,
        emitTranscriptModelSpans,
        emitSyntheticModelSpan,
        emitTranscriptToolSpans,
        ensureSkillSpan,
        syncTranscriptSkillSummary,
        getActiveSkillCtx,
        handleAgentEvent,
      } = toolSpanManager;

      const emitFallbackThinkingSpan = (
        _evt: { sessionKey?: string; sessionId?: string; ts?: number; channel?: string },
      ) => {};

      unsubscribeAgent = runtime?.events?.onAgentEvent?.(handleAgentEvent) ?? null;

      unsubscribeTranscript = runtime?.events?.onSessionTranscriptUpdate?.((update) => {
        const sessionKey = sessionStore?.resolveSessionKeyByFile(update.sessionFile);
        if (!sessionKey) {
          return;
        }
        replayTranscriptSnapshot(sessionKey, { source: "update", sessionFile: update.sessionFile });
      }) ?? null;

      const handleDiagnosticEvent = createDiagnosticEventHandler({
        trace,
        instruments,
        SpanStatusCode,
        cleanupExpiredRoots,
        beginRequestTrace,
        getRoot,
        getRun,
        ensureUserSpan,
        syncRootFromRun,
        endRun,
        endRoot,
        clearRun,
        discardActiveRequest,
        updateAggregateTokens,
        loadSessionSnapshot,
        resolveSessionKey,
        enrichWithTranscript,
        createChildSpan,
        emitDiagnosticLog,
        emitRuntimeOrchestrationSpan,
        ensureRuntimeLifecycleSpans,
        emitModelTurnDebugLog,
        SeverityNumber,
        getActiveSkillCtx,
        syncTranscriptSkillSummary,
        emitTranscriptModelSpans,
        emitSyntheticModelSpan,
        emitTranscriptToolSpans,
        emitFallbackThinkingSpan,
        annotateToolLoop,
        hasReplayWatermark,
        markReplayWatermark,
      });

      unsubscribeDiagnostic = onDiagnosticEvent(handleDiagnosticEvent);

      reportSessionMetrics();
      sessionMetricsInterval = setInterval(reportSessionMetrics, config.flushIntervalMs);
      sessionMetricsInterval.unref?.();

      ctx.logger.info(
        `[otel-plugin] trace exporter enabled (${config.protocol}) -> ${resolveOtelUrl(config.endpoint, config.tracePath)}`,
      );
      ctx.logger.info(
        `[otel-plugin] metric exporter enabled (${config.protocol}) -> ${resolveOtelUrl(config.endpoint, config.metricsPath)}`,
      );
      if (config.logsEnabled) {
        ctx.logger.info(
          `[otel-plugin] log exporter enabled (${config.protocol}) -> ${resolveOtelUrl(config.endpoint, config.logsPath)}`,
        );
      } else {
        ctx.logger.info("[otel-plugin] log exporter disabled");
      }
    },
    async stop() {
      unsubscribeDiagnostic?.();
      unsubscribeDiagnostic = null;
      unsubscribeAgent?.();
      unsubscribeAgent = null;
      unsubscribeTranscript?.();
      unsubscribeTranscript = null;
      if (sessionMetricsInterval) {
        clearInterval(sessionMetricsInterval);
        sessionMetricsInterval = null;
      }
      for (const current of Array.from(activeRuns.values())) {
        if (current.sessionIdentity) {
          concludeActiveRequest(
            {
              sessionKey: current.sessionIdentity,
              runId: current.runId,
              ts: Date.now(),
            },
            stringAttrs({
              "openclaw.outcome": "interrupted",
              "openclaw.reason": "runtime.stop",
            }),
          );
          continue;
        }
        toolSpanManager.finalizeToolAndSkillSpans(current);
        endSpanSafely(current.modelSpan);
        endSpanSafely(current.span);
        endSpanSafely(current.userSpan);
      }
      activeRuns.clear();
      for (const { span } of Array.from(activeRoots.values())) {
        span.setAttributes(traceAttrs(normalizeTerminalSpanAttrs(stringAttrs({
          "openclaw.outcome": "interrupted",
          "openclaw.reason": "runtime.stop",
        }))));
        endSpanSafely(span);
      }
      activeRoots.clear();
      activeRequestKeyBySession.clear();
      requestHistoryBySession.clear();
      replayWatermarkBySession.clear();
      replayTrajectorySourceSeqBySession.clear();
      pendingTrajectoryReplayRunIdsBySession.clear();
      reportedSessionMetrics.clear();
      sessionMetricTokenState.clear();
      recentSessionSweepAt = 0;
      sessionStore?.clear();
      sessionStore = null;
      await sdk?.shutdown();
      sdk = null;
    },
  };
}
