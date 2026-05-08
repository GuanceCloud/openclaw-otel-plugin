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
  buildSessionMetricAttrs,
  buildGenAiAgentSessionMetricAttrs,
  buildModelMetricAttrs,
  buildGenAiAgentRequestMetricAttrs,
  buildRequestMetricAttrs,
  clipPreview,
  computeSessionMetricDelta,
  createRunState,
  endSpanSafely,
  eventTime,
  MIN_VISIBLE_CHILD_MS,
  MIN_VISIBLE_MODEL_MS,
  normalizeReasoningPreview,
  normalizeUserInputPreview,
  parseSessionKey,
  redactSensitiveText,
  resolveIngressLifecycleWindows,
  resolveSessionMetricTotals,
  resolveSpanWindow,
  sessionIdentity,
  stringAttrs,
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
      };

      const enrichWithTranscript = (
        sessionKey: string | undefined,
        attrs: Record<string, string | number | boolean | undefined>,
      ) => {
        const suppressSessionInputPreview = attrs.__suppress_session_input_preview === true;
        const suppressSessionOutputPreview = attrs.__suppress_session_output_preview === true;
        const suppressSessionOutputSummary = attrs.__suppress_session_output_summary === true;
        const nextAttrs = {
          ...attrs,
        };
        delete nextAttrs.__suppress_session_input_preview;
        delete nextAttrs.__suppress_session_output_preview;
        delete nextAttrs.__suppress_session_output_summary;
        const parsedSessionKey = parseSessionKey(sessionKey);
        const configuredAgent = parsedSessionKey.sessionAgent
          ? configuredAgentById.get(parsedSessionKey.sessionAgent)
          : undefined;
        const dynamicAgentId = parsedSessionKey.sessionAgent;
        const dynamicAgentName = configuredAgent?.name ?? configuredAgent?.id ?? dynamicAgentId;
        const snapshot = loadSessionSnapshot(sessionKey);
        if (!snapshot) {
          return {
            ...nextAttrs,
            agent_id: nextAttrs.agent_id ?? dynamicAgentId,
            agent_name: nextAttrs.agent_name ?? dynamicAgentName,
          };
        }
        return {
          ...nextAttrs,
          agent_id: nextAttrs.agent_id ?? dynamicAgentId,
          agent_name: nextAttrs.agent_name ?? dynamicAgentName,
          session_id: snapshot.sessionId,
          "openclaw.sessionId": nextAttrs["openclaw.sessionId"] ?? snapshot.sessionId,
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

      const resolveSessionKey = (evt: { sessionKey?: string; sessionId?: string }) =>
        sessionIdentity(evt);

      const buildRequestKey = (evt: { sessionKey?: string; sessionId?: string; ts?: number; messageId?: string | number }) => {
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
        evt: { sessionKey?: string; sessionId?: string; ts?: number; messageId?: string | number },
        createIfMissing = false,
      ) => {
        const sessionKey = resolveSessionKey(evt);
        if (!sessionKey) {
          return undefined;
        }
        const activeRequestKey = activeRequestKeyBySession.get(sessionKey);
        if (activeRequestKey) {
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
        return nextRequestKey;
      };

      const beginRequestTrace = (
        evt: { sessionKey?: string; sessionId?: string; ts?: number; messageId?: string | number },
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
        evt: { sessionKey?: string; sessionId?: string },
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
            attributes: stringAttrs(enrichWithTranscript(sessionKey, {
              __suppress_session_input_preview: true,
              __suppress_session_output_preview: true,
              __suppress_session_output_summary: true,
              "span.kind": "runtime",
              "openclaw.runtime.phase": phase,
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
          ts: options?.startTsHint ?? evt.ts,
        };
        const run = getRun(lifecycleEvt, options?.createIfMissing ?? false);
        if (!run) {
          return undefined;
        }
        const root = getRoot(lifecycleEvt, options?.createIfMissing ?? false);
        const snapshot = options?.snapshot ?? loadSessionSnapshot(sessionKey);
        const ingressStartTs = typeof run.messageQueuedTs === "number"
          ? run.messageQueuedTs
          : root?.startedAt ?? run.startedAt ?? lifecycleEvt.ts;
        const processingStartTs = typeof options?.processingStartTs === "number"
          ? options.processingStartTs
          : run.mainStartTs;

        if (!run.channelIngressEmitted && typeof ingressStartTs === "number") {
          const { ingressEndTs } = resolveIngressLifecycleWindows(ingressStartTs, processingStartTs);
          emitRuntimeOrchestrationSpan(
            lifecycleEvt,
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
          run.messageQueuedTs = undefined;
        }

        if (!run.dispatchQueueEmitted && typeof ingressStartTs === "number") {
          const { queueStartTs, queueEndTs } = resolveIngressLifecycleWindows(ingressStartTs, processingStartTs);
          if (typeof queueStartTs === "number" && typeof queueEndTs === "number") {
            emitRuntimeOrchestrationSpan(
              lifecycleEvt,
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
          }
          run.dispatchQueueEmitted = true;
        }

        if (!run.sessionProcessingEmitted && typeof processingStartTs === "number") {
          const processingEndTs = typeof options?.nextActionTs === "number"
            ? Math.max(Math.min(processingStartTs + MIN_VISIBLE_CHILD_MS, options.nextActionTs), processingStartTs + 1)
            : processingStartTs + MIN_VISIBLE_CHILD_MS;
          emitRuntimeOrchestrationSpan(
            lifecycleEvt,
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
          attributes: stringAttrs(enrichWithTranscript(sessionKey, {
            "openclaw.event.type": evt.type,
            ...attrs,
          })),
          ...(options?.exception ? { exception: options.exception } : {}),
          timestamp: eventTimestamp(evt),
          observedTimestamp: new Date(),
          context: options?.context ?? currentRun?.modelCtx ?? currentRun?.ctx ?? currentRoot?.ctx ?? context.active(),
        });
      };

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
            const metricAttrs = buildSessionMetricAttrs(snapshot, sessionKey, {
              modelProvider: tokenState?.modelProvider,
              modelName: tokenState?.modelName,
            });
            if (deltaTotals.inputTokens > 0) {
              instruments.sessionInputTokensCounter.add(deltaTotals.inputTokens, metricAttrs);
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
              instruments.sessionOutputTokensCounter.add(deltaTotals.outputTokens, metricAttrs);
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
              instruments.sessionTotalTokensCounter.add(deltaTotals.totalTokens, metricAttrs);
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
              instruments.sessionTraceCounter.add(deltaTotals.traceCount, metricAttrs);
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

      const getRoot = (evt: { sessionKey?: string; sessionId?: string }, createIfMissing = false) => {
        const sessionKey = resolveSessionKey(evt);
        const requestKey = resolveRequestKey(evt, createIfMissing);
        if (!sessionKey || !requestKey) {
          return undefined;
        }
        const current = activeRoots.get(requestKey);
        if (current) {
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
        const span = tracer.startSpan(
          "openclaw_request",
          {
            startTime: new Date(rootStartTs),
            kind: SpanKind.SERVER,
            attributes: stringAttrs(enrichWithTranscript(sessionKey, {
              "openclaw.sessionKey": evt.sessionKey,
              "openclaw.sessionId": evt.sessionId,
              session_create_time: loadSessionSnapshot(sessionKey)?.createdAt,
              "span.kind": "request",
            })),
          },
        );
        const root = {
          requestKey,
          sessionIdentity: sessionKey,
          span,
          ctx: trace.setSpan(context.active(), span),
          startedAt: rootStartTs,
          lastTouchedAt: Date.now(),
        };
        activeRoots.set(requestKey, root);
        return root;
      };

      const getRun = (
        evt: { sessionKey?: string; sessionId?: string },
        createIfMissing = false,
      ) => {
        const sessionKey = resolveSessionKey(evt);
        const requestKey = resolveRequestKey(evt, createIfMissing);
        if (!sessionKey || !requestKey) {
          return undefined;
        }
        const current = activeRuns.get(requestKey);
        if (current?.span || (current && !createIfMissing)) {
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
        const userCtx = current?.userCtx;
        const span = tracer.startSpan(
          "agent_run",
          {
            startTime: eventTimestamp(evt),
            kind: SpanKind.INTERNAL,
            attributes: stringAttrs(enrichWithTranscript(sessionKey, {
              "openclaw.sessionKey": evt.sessionKey,
              "openclaw.sessionId": evt.sessionId,
              "span.kind": "agent",
            })),
          },
          userCtx ?? root.ctx,
        );
        const runStartTs = eventTimestamp(evt).getTime();
        const run = current ?? createRunState(userCtx ?? root.ctx, runStartTs, runStartTs);
        run.requestKey = requestKey;
        run.sessionIdentity = sessionKey;
        run.span = span;
        run.ctx = trace.setSpan(userCtx ?? root.ctx, span);
        activeRuns.set(requestKey, run);
        return run;
      };

      const ensureUserSpan = (
        evt: { sessionKey?: string; sessionId?: string; ts: number; channel?: string; source?: string; queueDepth?: number },
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
        const snapshot = loadSessionSnapshot(evt.sessionKey);
        root.span.setAttributes(stringAttrs({
          "openclaw.channel": evt.channel,
          "openclaw.source": evt.source,
          "openclaw.queueDepth": evt.queueDepth,
          "openclaw.input.preview": normalizeUserInputPreview(snapshot?.lastUserText),
          "openclaw.input.length": snapshot?.lastUserText?.length,
        }));
        const run = existing ?? createRunState(root.ctx, evt.ts, evt.ts);
        run.requestKey = requestKey;
        run.sessionIdentity = sessionKey;
        run.userCtx = root.ctx;
        run.userStartTs = evt.ts;
        run.lastTouchedAt = Date.now();
        activeRuns.set(requestKey, run as ActiveRunSpan);
        return activeRuns.get(requestKey);
      };

      const endRoot = (evt: { sessionKey?: string; sessionId?: string }, attrs?: Record<string, string | number | boolean>) => {
        const sessionKey = resolveSessionKey(evt);
        const requestKey = resolveRequestKey(evt, false);
        if (!sessionKey || !requestKey) {
          return;
        }
        const current = activeRoots.get(requestKey);
        if (!current) {
          return;
        }
        const run = activeRuns.get(requestKey);
        const summaryAttrs = normalizeTerminalSpanAttrs(attrs ?? {});
        const finalAttrs = stringAttrs({
          ...enrichWithTranscript(sessionKey, summaryAttrs),
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
        if (attrs) {
          addEvent(current.span, "session.finish", summaryAttrs);
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

      const syncRootFromRun = (evt: { sessionKey?: string; sessionId?: string }) => {
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
        root.span.setAttributes(stringAttrs({
          "openclaw.tokens.input":
            run.aggregate.inputTokens || snapshot?.lastAssistantUsage?.input || 0,
          "openclaw.tokens.output":
            run.aggregate.outputTokens || snapshot?.lastAssistantUsage?.output || 0,
          "openclaw.tokens.cache_read":
            run.aggregate.cacheReadTokens || snapshot?.lastAssistantUsage?.cacheRead || 0,
          "openclaw.tokens.cache_write":
            run.aggregate.cacheWriteTokens || snapshot?.lastAssistantUsage?.cacheWrite || 0,
          "openclaw.tokens.total":
            run.aggregate.totalTokens || snapshot?.lastAssistantUsage?.totalTokens || 0,
          "llm.input_tokens":
            run.aggregate.inputTokens || snapshot?.lastAssistantUsage?.input || 0,
          "llm.output_tokens":
            run.aggregate.outputTokens || snapshot?.lastAssistantUsage?.output || 0,
          "llm.total_tokens":
            run.aggregate.totalTokens || snapshot?.lastAssistantUsage?.totalTokens || 0,
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
        evt: { sessionKey?: string; sessionId?: string },
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
        const sessionInputTokens =
          current.aggregate.inputTokens || snapshot?.lastAssistantUsage?.input || 0;
        const sessionOutputTokens =
          current.aggregate.outputTokens || snapshot?.lastAssistantUsage?.output || 0;
        const sessionTotalTokens =
          current.aggregate.totalTokens || snapshot?.lastAssistantUsage?.totalTokens || 0;
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
        const finalAttrs = stringAttrs({
          ...enrichWithTranscript(sessionKey, summaryAttrs),
          "openclaw.tokens.input":
            sessionInputTokens,
          "openclaw.tokens.output":
            sessionOutputTokens,
          "openclaw.tokens.cache_read":
            current.aggregate.cacheReadTokens || snapshot?.lastAssistantUsage?.cacheRead || 0,
          "openclaw.tokens.cache_write":
            current.aggregate.cacheWriteTokens || snapshot?.lastAssistantUsage?.cacheWrite || 0,
          "openclaw.tokens.total":
            sessionTotalTokens,
          "llm.input_tokens":
            sessionInputTokens,
          "llm.output_tokens":
            sessionOutputTokens,
          "llm.total_tokens":
            sessionTotalTokens,
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
        if (attrs) {
          current.span && addEvent(current.span, "run.finish", summaryAttrs);
        }
        const requestMetricAttrs = buildRequestMetricAttrs(snapshot, summaryAttrs);
        const genAiRequestMetricAttrs = buildGenAiAgentRequestMetricAttrs(snapshot, summaryAttrs);
        instruments.requestCounter.add(1, requestMetricAttrs);
        instruments.genAiAgentRequestCount?.add(1, genAiRequestMetricAttrs);
        instruments.requestDuration.record(
          Math.max(0, eventTimestamp(evt).getTime() - current.startedAt),
          requestMetricAttrs,
        );
        instruments.genAiAgentRequestDuration?.record(
          Math.max(0, eventTimestamp(evt).getTime() - current.startedAt),
          genAiRequestMetricAttrs,
        );
        finalizeRunSpans(current, eventTimestamp(evt));
      };

      const clearRun = (evt: { sessionKey?: string; sessionId?: string }) => {
        const sessionKey = resolveSessionKey(evt);
        const requestKey = resolveRequestKey(evt, false);
        if (!sessionKey || !requestKey) {
          return;
        }
        activeRuns.delete(requestKey);
        releaseRequestKey(sessionKey, requestKey);
      };

      const cleanupExpiredRoots = () => {
        const now = Date.now();
        for (const [requestKey, current] of activeRoots.entries()) {
          if (now - current.lastTouchedAt < config.rootSpanTtlMs) {
            continue;
          }
          addEvent(current.span, "session.timeout", { "openclaw.root.ttl_ms": config.rootSpanTtlMs });
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
        for (const [requestKey, current] of activeRuns.entries()) {
          if (now - current.lastTouchedAt < config.rootSpanTtlMs) {
            continue;
          }
          if (current.span) {
            addEvent(current.span, "run.timeout", { "openclaw.root.ttl_ms": config.rootSpanTtlMs });
          } else if (current.userSpan) {
            addEvent(current.userSpan, "run.timeout", { "openclaw.root.ttl_ms": config.rootSpanTtlMs });
          }
          finalizeRunSpans(current);
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
            attributes: stringAttrs(attrs),
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

        run.aggregate.inputTokens += evt.usage.input ?? 0;
        run.aggregate.outputTokens += evt.usage.output ?? 0;
        run.aggregate.cacheReadTokens += evt.usage.cacheRead ?? 0;
        run.aggregate.cacheWriteTokens += evt.usage.cacheWrite ?? 0;
        run.aggregate.totalTokens += evt.usage.total ?? 0;
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
          metricState.inputTokens += evt.usage.input ?? 0;
          metricState.outputTokens += evt.usage.output ?? 0;
          metricState.totalTokens += evt.usage.total ?? 0;
          metricState.modelProvider = evt.provider ?? metricState.modelProvider;
          metricState.modelName = evt.model ?? metricState.modelName;
          metricState.active = true;
          metricState.dirty = true;
          sessionMetricTokenState.set(sessionKey, metricState);
        }
        instruments.modelCallCounter.add(
          1,
          buildModelMetricAttrs(
            evt.provider ?? run.aggregate.lastProvider,
            evt.model ?? run.aggregate.lastModel,
          ),
        );

        const summaryAttrs = stringAttrs({
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
          "llm.provider": run.aggregate.lastProvider,
          "llm.model": run.aggregate.lastModel,
          "llm.input_tokens": run.aggregate.inputTokens,
          "llm.output_tokens": run.aggregate.outputTokens,
          "llm.total_tokens": run.aggregate.totalTokens,
        });

        const transcriptAttrs = stringAttrs(enrichWithTranscript(evt.sessionKey, summaryAttrs));
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
        ensureTranscriptSkillSpans,
        getActiveSkillCtx,
        handleAgentEvent,
      } = toolSpanManager;

      const emitFallbackThinkingSpan = (
        _evt: { sessionKey?: string; sessionId?: string; ts?: number; channel?: string },
      ) => {};

      unsubscribeAgent = runtime?.events?.onAgentEvent?.(handleAgentEvent) ?? null;

      unsubscribeTranscript = runtime?.events?.onSessionTranscriptUpdate?.((update) => {
        sessionStore?.refreshSessionsIndex();
        sessionStore?.invalidateSessionFile(update.sessionFile);
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
      for (const current of activeRuns.values()) {
        toolSpanManager.finalizeToolAndSkillSpans(current);
        endSpanSafely(current.modelSpan);
        endSpanSafely(current.span);
        endSpanSafely(current.userSpan);
      }
      activeRuns.clear();
      for (const { span } of activeRoots.values()) {
        endSpanSafely(span);
      }
      activeRoots.clear();
      activeRequestKeyBySession.clear();
      replayWatermarkBySession.clear();
      reportedSessionMetrics.clear();
      sessionMetricTokenState.clear();
      sessionStore?.clear();
      sessionStore = null;
      await sdk?.shutdown();
      sdk = null;
    },
  };
}
