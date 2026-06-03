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
  resolveConfiguredAgents,
  resolveRuntimeMetadata,
} from "./session-store.js";
import type {
  ActiveRootSpan,
  ActiveRunSpan,
  RuntimeLike,
  SessionSnapshotStore,
} from "./service-types.js";
import {
  addEvent,
  buildGenAiAgentSessionMetricAttrs,
  buildGenAiAgentRequestMetricAttrs,
  buildRunScopeAttrs,
  buildTranscriptReplayEvent,
  clipPreview,
  computeSessionMetricDelta,
  createRunState,
  endSpanSafely,
  eventTime,
  isHeartbeatSessionSnapshot,
  loadSnapshotForEvent,
  MIN_VISIBLE_CHILD_MS,
  MIN_VISIBLE_MODEL_MS,
  normalizeReasoningPreview,
  normalizeUserInputPreview,
  parseSessionKey,
  redactSensitiveText,
  readReplayFinalizationState,
  rememberRunId,
  resolveAgentIdentity,
  resolveReplayFinalizationStateFile,
  resolveIngressLifecycleWindows,
  resolveRequestClassification,
  resolveSessionMetricTotals,
  resolveSpanWindow,
  resolveUsageTokenTotals,
  sessionIdentity,
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
  const reportedSessionMetrics = new Map<string, {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    traceCount: number;
  }>();
  const replayWatermarkBySession = new Map<string, string>();
  const finalizedReplayRunIdBySession = new Map<string, string>();
  let requestSequence = 0;
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
      const configuredAgentById = new Map(
        resolveConfiguredAgents(ctx.stateDir).map((agent) => [agent.id, agent]),
      );
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
        if (value.runId) {
          finalizedReplayRunIdBySession.set(sessionKey, value.runId);
        }
      }

      const loadSessionSnapshot = (sessionKey: string | undefined) =>
        sessionStore?.loadSessionSnapshot(sessionKey);

      const resolveSpanAgentIdentity = (
        sessionKey: string | undefined,
        snapshot: ReturnType<typeof loadSessionSnapshot> | undefined,
        attrs?: Record<string, string | number | boolean | undefined>,
      ) => resolveAgentIdentity({
        sessionKey,
        snapshot,
        attrs,
        configuredAgentById,
        runtimeMetadata,
      });

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

      const hasFinalizedReplayRunId = (
        sessionKey: string | undefined,
        runId: string | undefined,
      ) => {
        if (!sessionKey || !runId) {
          return false;
        }
        return finalizedReplayRunIdBySession.get(sessionKey) === runId;
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
          const current = persistedReplayFinalizationBySession.get(sessionKey) ?? {};
          current.watermark = watermark;
          current.updatedAt = Date.now();
          persistedReplayFinalizationBySession.set(sessionKey, current);
          writeReplayFinalizationState(replayFinalizationStateFile, persistedReplayFinalizationBySession);
        }
      };

      const markFinalizedReplayRunId = (
        sessionKey: string | undefined,
        runId: string | undefined,
      ) => {
        if (!sessionKey || !runId) {
          return;
        }
        finalizedReplayRunIdBySession.set(sessionKey, runId);
        const current = persistedReplayFinalizationBySession.get(sessionKey) ?? {};
        current.runId = runId;
        current.updatedAt = Date.now();
        persistedReplayFinalizationBySession.set(sessionKey, current);
        writeReplayFinalizationState(replayFinalizationStateFile, persistedReplayFinalizationBySession);
      };

      const markReplayFinalization = (
        sessionKey: string | undefined,
        snapshot: ReturnType<typeof loadSessionSnapshot>,
      ) => {
        if (snapshot?.runCompleted !== true) {
          return;
        }
        markReplayWatermark(sessionKey, snapshot);
        markFinalizedReplayRunId(sessionKey, snapshot.runId);
      };

      const enrichWithTranscript = (
        sessionKey: string | undefined,
        attrs: Record<string, string | number | boolean | undefined>,
      ) => {
        const suppressSessionInputPreview = attrs.__suppress_session_input_preview === true;
        const suppressSessionOutputPreview = attrs.__suppress_session_output_preview === true;
        const suppressSessionOutputSummary = attrs.__suppress_session_output_summary === true;
        const minSnapshotUserTs = typeof attrs.__min_snapshot_user_ts === "number"
          ? attrs.__min_snapshot_user_ts
          : undefined;
        const nextAttrs = {
          ...attrs,
        };
        delete nextAttrs.__suppress_session_input_preview;
        delete nextAttrs.__suppress_session_output_preview;
        delete nextAttrs.__suppress_session_output_summary;
        delete nextAttrs.__min_snapshot_user_ts;
        const snapshot = loadSessionSnapshot(sessionKey);
        const { agentId: resolvedAgentId, agentName: resolvedAgentName } = resolveSpanAgentIdentity(
          sessionKey,
          snapshot,
          nextAttrs,
        );
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
            agent_id: resolvedAgentId,
            agent_name: resolvedAgentName,
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
          agent_id: resolvedAgentId,
          agent_name: resolvedAgentName,
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
          "openclaw.model": nextAttrs["openclaw.model"] ?? snapshot.lastModel,
        };
      };

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

      const buildRequestKey = (evt: { sessionKey?: string; sessionId?: string; ts?: number; messageId?: string | number; runId?: string }) => {
        const sessionKey = resolveSessionKey(evt);
        if (!sessionKey) {
          return undefined;
        }
        const messageId = evt.messageId !== undefined && evt.messageId !== null
          ? String(evt.messageId)
          : undefined;
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
        if (!sessionKey) {
          return undefined;
        }
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
        const activeRequestKey = activeRequestKeyBySession.get(sessionKey);
        if (activeRequestKey) {
          const matchingRequestKey = findMatchingRequestKey();
          if (matchingRequestKey) {
            return matchingRequestKey;
          }
          return activeRequestKey;
        }
        const matchingRequestKey = findMatchingRequestKey();
        if (matchingRequestKey) {
          return matchingRequestKey;
        }
        if (!createIfMissing) {
          return undefined;
        }
        const nextRequestKey = buildRequestKey(evt);
        if (!nextRequestKey) {
          return undefined;
        }
        activeRequestKeyBySession.set(sessionKey, nextRequestKey);
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
          phase === "channel_ingress" || phase === "dispatch_queue"
            ? root?.startedAt ?? startTs
            : run?.mainStartTs ?? startTs,
        );
        const effectiveEndTs = Math.max(endTs, effectiveStartTs + 1);
        if (effectiveEndTs <= effectiveStartTs) {
          return undefined;
        }
        const span = tracer.startSpan(
          phase === "channel_ingress"
            ? "channel_ingress"
            : phase === "dispatch_queue"
              ? "dispatch_queue"
            : phase === "session_processing"
              ? "session_processing"
              : phase === "channel_egress"
                ? "channel_egress"
              : "runtime_orchestration",
          {
            startTime: new Date(effectiveStartTs),
            kind: SpanKind.INTERNAL,
            attributes: traceAttrs(enrichWithTranscript(sessionKey, {
              __suppress_session_input_preview: true,
              __suppress_session_output_preview: true,
              __suppress_session_output_summary:
                phase === "channel_ingress"
                || phase === "dispatch_queue"
                || phase === "session_processing",
              ...buildRunScopeAttrs(
                run?.runId ?? root?.runId ?? resolveRunId(evt),
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
                phase === "channel_ingress" || phase === "dispatch_queue" || phase === "session_processing"
                  ? effectiveStartTs
                  : undefined,
              ...attrs,
            })),
          },
          parentCtx ?? run?.ctx ?? root?.ctx ?? context.active(),
        );
        span.setStatus({ code: SpanStatusCode.OK });
        endSpanSafely(span, new Date(effectiveEndTs));
        if (run && phase !== "channel_ingress" && phase !== "session_processing" && phase !== "channel_egress") {
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
          emitEgress?: boolean;
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
        const lifecycleEvt = {
          sessionKey: evt.sessionKey,
          sessionId: evt.sessionId,
          runId: evt.runId,
          ts: options?.startTsHint ?? evt.ts,
        };
        const run = getRun(lifecycleEvt, options?.createIfMissing ?? false);
        if (!run) {
          return undefined;
        }
        const root = getRoot(lifecycleEvt, options?.createIfMissing ?? false);
        const snapshot = options?.snapshot ?? loadSessionSnapshot(sessionKey);
        const resolvedSessionId = snapshot?.sessionId ?? evt.sessionId;
        const ingressStartTs = typeof run.messageQueuedTs === "number"
          ? run.messageQueuedTs
          : root?.startedAt ?? run.startedAt ?? lifecycleEvt.ts;
        const processingStartTs = typeof options?.processingStartTs === "number"
          ? options.processingStartTs
          : run.mainStartTs;

        if (resolvedSessionId) {
          if (!run.channelIngressEmitted && run.pendingChannelIngressWindow) {
            emitRuntimeOrchestrationSpan(
              { ...lifecycleEvt, sessionId: resolvedSessionId },
              run.pendingChannelIngressWindow.startTs,
              run.pendingChannelIngressWindow.endTs,
              "channel_ingress",
              {
                "openclaw.channel": run.pendingChannelIngressWindow.channel,
                "openclaw.source": run.pendingChannelIngressWindow.source,
              },
              root?.ctx,
            );
            run.channelIngressEmitted = true;
            run.pendingChannelIngressWindow = undefined;
          }
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

        if (!run.channelIngressEmitted && typeof ingressStartTs === "number") {
          const { ingressEndTs } = resolveIngressLifecycleWindows(ingressStartTs, processingStartTs);
          if (resolvedSessionId) {
            emitRuntimeOrchestrationSpan(
              { ...lifecycleEvt, sessionId: resolvedSessionId },
              ingressStartTs,
              ingressEndTs,
              "channel_ingress",
              {
                "openclaw.channel": evt.channel ?? snapshot?.lastChannel,
                "openclaw.source": evt.source,
              },
              root?.ctx,
            );
            run.channelIngressEmitted = true;
          } else {
            run.pendingChannelIngressWindow = {
              startTs: ingressStartTs,
              endTs: ingressEndTs,
              channel: evt.channel ?? snapshot?.lastChannel,
              source: evt.source,
            };
          }
          run.messageQueuedTs = undefined;
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

        if (options?.emitEgress && !run.channelEgressEmitted && typeof evt.ts === "number") {
          emitRuntimeOrchestrationSpan(
            evt,
            evt.ts,
            evt.ts + MIN_VISIBLE_CHILD_MS,
            "channel_egress",
            {
              "openclaw.channel": evt.channel ?? snapshot?.lastChannel,
              "openclaw.outcome": options.outcome ?? evt.outcome,
              "openclaw.output.preview": options.outputPreview,
              "openclaw.output.length": options.outputLength,
            },
            run.ctx,
          );
          run.channelEgressEmitted = true;
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
        const hasActiveTrace = Boolean(getRun(transcriptEvt, false) || getRoot(transcriptEvt, false));
        const replayAlreadyFinalized = hasReplayWatermark(sessionKey, snapshot);
        const replayRunAlreadyFinalized = hasFinalizedReplayRunId(sessionKey, snapshot.runId);
        if ((replayAlreadyFinalized || replayRunAlreadyFinalized) && !hasActiveTrace) {
          return;
        }
        if (!hasActiveTrace) {
          ctx.logger.info(
            `[otel-plugin] transcript fallback replay${options?.source === "sweep" ? " (sweep)" : ""} for ${sessionKey} (${snapshot.sessionId ?? "unknown-session"})`,
          );
        }
        ensureTranscriptSkillSpans(transcriptEvt);
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
          emitEgress: true,
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
        }));
        endRoot(transcriptEvt, stringAttrs({
          "openclaw.state": "completed",
          "openclaw.outcome": "completed",
        }));
        clearRun(transcriptEvt);
      }

      const reportSessionMetrics = () => {
        try {
          sessionStore?.refreshSessionsIndex();
          const pendingSessionKeys = Array.from(sessionMetricTokenState.entries())
            .filter(([, state]) => state.dirty)
            .map(([sessionKey]) => sessionKey);
          const activeSessionKeys = new Set<string>([
            ...Array.from(activeRoots.values())
              .map((current) => current.sessionIdentity)
              .filter((value): value is string => Boolean(value)),
            ...Array.from(activeRuns.values())
              .map((current) => current.sessionIdentity)
              .filter((value): value is string => Boolean(value)),
            ...pendingSessionKeys,
          ]);
          for (const sessionKey of activeSessionKeys) {
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
            const previousTotals = reportedSessionMetrics.get(seriesKey);
            const deltaTotals = computeSessionMetricDelta(currentTotals, previousTotals);
            const genAiSessionMetricAttrs = buildGenAiAgentSessionMetricAttrs(snapshot, sessionKey, {
              modelProvider: tokenState?.modelProvider,
              modelName: tokenState?.modelName,
            });
            if (deltaTotals.inputTokens > 0) {
              instruments.genAiAgentSessionTokenInput?.add(
                deltaTotals.inputTokens,
                genAiSessionMetricAttrs,
              );
              instruments.genAiAgentSessionTokenUsage?.add(
                deltaTotals.inputTokens,
                buildGenAiAgentSessionMetricAttrs(snapshot, sessionKey, {
                  modelProvider: tokenState?.modelProvider,
                  modelName: tokenState?.modelName,
                  tokenType: "input",
                }),
              );
            }
            if (deltaTotals.outputTokens > 0) {
              instruments.genAiAgentSessionTokenOutput?.add(
                deltaTotals.outputTokens,
                genAiSessionMetricAttrs,
              );
              instruments.genAiAgentSessionTokenUsage?.add(
                deltaTotals.outputTokens,
                buildGenAiAgentSessionMetricAttrs(snapshot, sessionKey, {
                  modelProvider: tokenState?.modelProvider,
                  modelName: tokenState?.modelName,
                  tokenType: "output",
                }),
              );
            }
            if (deltaTotals.totalTokens > 0) {
              instruments.genAiAgentSessionTokenTotal?.add(
                deltaTotals.totalTokens,
                genAiSessionMetricAttrs,
              );
              instruments.genAiAgentSessionTokenUsage?.add(
                deltaTotals.totalTokens,
                buildGenAiAgentSessionMetricAttrs(snapshot, sessionKey, {
                  modelProvider: tokenState?.modelProvider,
                  modelName: tokenState?.modelName,
                  tokenType: "total",
                }),
              );
            }
            if (deltaTotals.traceCount > 0) {
              instruments.genAiAgentSessionTraceCount?.add(
                deltaTotals.traceCount,
                buildGenAiAgentSessionMetricAttrs(snapshot, sessionKey, {
                  modelProvider: tokenState?.modelProvider,
                  modelName: tokenState?.modelName,
                }),
              );
            }
            reportedSessionMetrics.set(seriesKey, currentTotals);
            if (tokenState) {
              tokenState.dirty = false;
              if (!tokenState.active) {
                sessionMetricTokenState.delete(sessionKey);
              }
            }
          }
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
                run.span.setAttributes(traceRunScopeAttrs(run.runId, run.runIds, current.runIds));
              }
            }
            current.span.setAttributes(traceRunScopeAttrs(current.runId, current.runIds));
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
              root.span.setAttributes(traceRunScopeAttrs(root.runId, root.runIds, current.runIds));
            }
            if (current.span) {
              current.span.setAttributes(traceRunScopeAttrs(current.runId, current.runIds));
            }
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
          root.span.setAttributes(traceRunScopeAttrs(root.runId, root.runIds));
        }
        const userCtx = current?.userCtx;
        const snapshot = loadSessionSnapshot(sessionKey);
        const span = tracer.startSpan(
          "agent_run",
          {
            startTime: eventTimestamp(evt),
            kind: SpanKind.INTERNAL,
            attributes: traceAttrs(enrichWithTranscript(sessionKey, {
              "openclaw.sessionKey": evt.sessionKey,
              "openclaw.sessionId": evt.sessionId,
              ...buildRunScopeAttrs(root.runId ?? resolvedRunId, root.runIds, resolvedRunId),
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
          root.span.setAttributes(traceRunScopeAttrs(root.runId, root.runIds));
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
        const snapshotUsageTotals = resolveSnapshotUsageTotals(snapshot);
        const rootInputTokens = run?.aggregate.inputTokens || snapshotUsageTotals.inputTokens;
        const rootOutputTokens = run?.aggregate.outputTokens || snapshotUsageTotals.outputTokens;
        const rootCacheReadTokens = run?.aggregate.cacheReadTokens || snapshotUsageTotals.cacheReadTokens;
        const rootCacheWriteTokens = run?.aggregate.cacheWriteTokens || snapshotUsageTotals.cacheWriteTokens;
        const rootTotalTokens = run?.aggregate.totalTokens || snapshotUsageTotals.totalTokens;
        const summaryAttrs = normalizeTerminalSpanAttrs(attrs ?? {});
        const finalAttrs = traceAttrs({
          ...enrichWithTranscript(sessionKey, summaryAttrs),
          ...buildRunScopeAttrs(
            current.runId ?? run?.runId ?? resolveRunId(evt),
            current.runIds,
            run?.runIds,
            resolveRunId(evt),
          ),
          session_create_at: snapshot?.createdAt,
          session_update_time: eventTimestamp(evt).getTime(),
          usage_input_tokens: rootInputTokens,
          usage_output_tokens: rootOutputTokens,
          usage_cache_read_input_tokens: rootCacheReadTokens,
          usage_cache_write_input_tokens: rootCacheWriteTokens,
          usage_total_tokens: rootTotalTokens,
          "openclaw.skills": run ? Array.from(run.usedSkillNames).join(", ") : undefined,
          "openclaw.skill.count": run ? run.usedSkillNames.size : undefined,
          "openclaw.tokens.input": rootInputTokens,
          "openclaw.tokens.output": rootOutputTokens,
          "openclaw.tokens.cache_read": rootCacheReadTokens,
          "openclaw.tokens.cache_write": rootCacheWriteTokens,
          "openclaw.tokens.total": rootTotalTokens,
          "openclaw.tools": run ? Array.from(run.usedToolNames).join(", ") : undefined,
          "openclaw.tool.count": run ? run.usedToolNames.size : undefined,
          "openclaw.tool.targets": run ? Array.from(run.usedToolTargets).join(" | ") : undefined,
          "openclaw.tool.commands": run ? Array.from(run.usedToolCommands).join(" | ") : undefined,
          "openclaw.tool.result_statuses": run ? Array.from(run.usedToolResultStatuses).join(", ") : undefined,
        });
        if (Object.keys(finalAttrs).length > 0) {
          current.span.setAttributes(finalAttrs);
        }
        if (attrs) {
          addEvent(current.span, "session.finish");
        }
        current.span.setStatus({ code: SpanStatusCode.OK });
        endSpanSafely(current.span, eventTimestamp(evt));
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
        const snapshotUsageTotals = resolveSnapshotUsageTotals(snapshot);
        const rootInputTokens = run.aggregate.inputTokens || snapshotUsageTotals.inputTokens;
        const rootOutputTokens = run.aggregate.outputTokens || snapshotUsageTotals.outputTokens;
        const rootCacheReadTokens = run.aggregate.cacheReadTokens || snapshotUsageTotals.cacheReadTokens;
        const rootCacheWriteTokens = run.aggregate.cacheWriteTokens || snapshotUsageTotals.cacheWriteTokens;
        const rootTotalTokens = run.aggregate.totalTokens || snapshotUsageTotals.totalTokens;
        root.span.setAttributes(traceAttrs({
          ...buildRunScopeAttrs(root.runId ?? run.runId ?? resolveRunId(evt), root.runIds, run.runIds, resolveRunId(evt)),
          session_create_at: snapshot?.createdAt,
          session_update_time: run.modelEndTs ?? run.mainEndTs ?? run.lastTouchedAt ?? Date.now(),
          usage_input_tokens: rootInputTokens,
          usage_output_tokens: rootOutputTokens,
          usage_cache_read_input_tokens: rootCacheReadTokens,
          usage_cache_write_input_tokens: rootCacheWriteTokens,
          usage_total_tokens: rootTotalTokens,
          "openclaw.tokens.input": rootInputTokens,
          "openclaw.tokens.output": rootOutputTokens,
          "openclaw.tokens.cache_read": rootCacheReadTokens,
          "openclaw.tokens.cache_write": rootCacheWriteTokens,
          "openclaw.tokens.total": rootTotalTokens,
          "openclaw.skills": Array.from(run.usedSkillNames).join(", "),
          "openclaw.skill.count": run.usedSkillNames.size,
          "openclaw.tools": Array.from(run.usedToolNames).join(", "),
          "openclaw.tool.count": run.usedToolNames.size,
          "openclaw.tool.targets": Array.from(run.usedToolTargets).join(" | "),
          "openclaw.tool.commands": Array.from(run.usedToolCommands).join(" | "),
          "openclaw.tool.result_statuses": Array.from(run.usedToolResultStatuses).join(", "),
        }));
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
        const snapshotUsageTotals = resolveSnapshotUsageTotals(snapshot);
        const summaryAttrs = normalizeTerminalSpanAttrs(attrs ?? {});
        const sessionInputTokens =
          current.aggregate.inputTokens || snapshotUsageTotals.inputTokens;
        const sessionOutputTokens =
          current.aggregate.outputTokens || snapshotUsageTotals.outputTokens;
        const sessionTotalTokens =
          current.aggregate.totalTokens || snapshotUsageTotals.totalTokens;
        for (const skillName of snapshot?.invokedSkillNames ?? []) {
          if (!current.skillSpans.has(skillName)) {
            ensureSkillSpan(
              {
                sessionKey: evt.sessionKey,
                sessionId: evt.sessionId,
                ts: current.mainStartTs,
              },
              skillName,
              "transcript",
            );
          }
        }
        const finalAttrs = traceAttrs({
          ...enrichWithTranscript(sessionKey, summaryAttrs),
          ...buildRunScopeAttrs(current.runId ?? resolveRunId(evt), current.runIds, resolveRunId(evt)),
          session_create_at: snapshot?.createdAt,
          session_update_time: eventTimestamp(evt).getTime(),
          usage_input_tokens: sessionInputTokens,
          usage_output_tokens: sessionOutputTokens,
          usage_cache_read_input_tokens: current.aggregate.cacheReadTokens || snapshotUsageTotals.cacheReadTokens,
          usage_cache_write_input_tokens: current.aggregate.cacheWriteTokens || snapshotUsageTotals.cacheWriteTokens,
          usage_total_tokens: sessionTotalTokens,
          "openclaw.tokens.input": sessionInputTokens,
          "openclaw.tokens.output": sessionOutputTokens,
          "openclaw.tokens.cache_read": current.aggregate.cacheReadTokens || snapshotUsageTotals.cacheReadTokens,
          "openclaw.tokens.cache_write": current.aggregate.cacheWriteTokens || snapshotUsageTotals.cacheWriteTokens,
          "openclaw.tokens.total": sessionTotalTokens,
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
        if (attrs) {
          current.span && addEvent(current.span, "run.finish");
        }
        const genAiRequestMetricAttrs = buildGenAiAgentRequestMetricAttrs(snapshot, summaryAttrs);
        instruments.genAiAgentRequestCount?.add(1, genAiRequestMetricAttrs);
        instruments.genAiAgentRequestDuration?.record(
          Math.max(0, eventTimestamp(evt).getTime() - current.startedAt),
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
          "openclaw.tokens.input": run.aggregate.inputTokens,
          "openclaw.tokens.output": run.aggregate.outputTokens,
          "openclaw.tokens.cache_read": run.aggregate.cacheReadTokens,
          "openclaw.tokens.cache_write": run.aggregate.cacheWriteTokens,
          "openclaw.tokens.prompt": run.aggregate.promptTokens,
          "openclaw.tokens.total": run.aggregate.totalTokens,
          "openclaw.cost.usd": Number(run.aggregate.costUsd.toFixed(8)),
          "openclaw.model.calls": run.aggregate.modelCalls,
          "openclaw.provider": run.aggregate.lastProvider,
          "openclaw.model": run.aggregate.lastModel,
          "openclaw.tools": Array.from(run.usedToolNames).join(", "),
          "openclaw.tool.count": run.usedToolNames.size,
          "openclaw.tool.targets": Array.from(run.usedToolTargets).join(" | "),
          "openclaw.tool.commands": Array.from(run.usedToolCommands).join(" | "),
          "openclaw.tool.result_statuses": Array.from(run.usedToolResultStatuses).join(", "),
          "openclaw.skills": Array.from(run.usedSkillNames).join(", "),
          "openclaw.skill.count": run.usedSkillNames.size,
        });

        const transcriptAttrs = traceAttrs(enrichWithTranscript(evt.sessionKey, summaryAttrs));
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
        resolveAgentIdentity: resolveSpanAgentIdentity,
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
        ensureTranscriptSkillSpans,
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
        ensureTranscriptSkillSpans,
        emitTranscriptModelSpans,
        emitSyntheticModelSpan,
        emitTranscriptToolSpans,
        emitFallbackThinkingSpan,
        annotateToolLoop,
        hasReplayWatermark,
        markReplayWatermark,
        hasFinalizedReplayRunId,
        markFinalizedReplayRunId,
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
      replayWatermarkBySession.clear();
      finalizedReplayRunIdBySession.clear();
      reportedSessionMetrics.clear();
      sessionMetricTokenState.clear();
      sessionStore?.clear();
      sessionStore = null;
      await sdk?.shutdown();
      sdk = null;
    },
  };
}
