import type { DiagnosticEventPayload } from "openclaw/plugin-sdk";
import type { ActiveRunSpan, MetricInstruments, SessionSnapshot } from "./service-types.js";
import {
  addEvent,
  buildGenAiClientModelMetricAttrs,
  buildDiagnosticsMessageMetricAttrs,
  buildDiagnosticsModelMetricAttrs,
  buildDiagnosticsQueueMetricAttrs,
  buildDiagnosticsSessionMetricAttrs,
  buildDiagnosticsWebhookMetricAttrs,
  buildGenAiRuntimeMessageMetricAttrs,
  buildGenAiRuntimeQueueMetricAttrs,
  buildGenAiRuntimeSessionMetricAttrs,
  buildGenAiRuntimeWebhookMetricAttrs,
  clipPreview,
  endSpanSafely,
  endTimeFromStart,
  eventTime,
  MIN_VISIBLE_CHILD_MS,
  redactSensitiveText,
  setError,
  stringAttrs,
  traceAttrs,
} from "./service-utils.js";
import {
  shouldCloseForSessionState,
  shouldCreateRootForSessionState,
  shouldSyncRootForSessionState,
} from "./trace-runtime.js";

const MAX_PROCESSING_BACKFILL_MS = 5 * 60 * 1000;

type SessionEvent = {
  sessionKey?: string;
  sessionId?: string;
  ts?: number;
};

type UserSpanEvent = SessionEvent & {
  ts: number;
  channel?: string;
  source?: string;
  queueDepth?: number;
};

type ChildSpanFactory = (
  name: string,
  evt: DiagnosticEventPayload,
  attrs: Record<string, string | number | boolean | undefined>,
  durationMs?: number,
  parentCtx?: any,
) => {
  span: any;
  root: unknown;
  effectiveDurationMs: number;
  startTime: Date;
  endTime?: Date;
};

type DiagnosticEventHandlerDeps = {
  trace: any;
  instruments: MetricInstruments;
  SpanStatusCode: any;
  SeverityNumber: any;
  cleanupExpiredRoots(): void;
  beginRequestTrace(evt: UserSpanEvent & { messageId?: string | number }): void;
  getRoot(evt: SessionEvent, createIfMissing?: boolean): { span: any; ctx?: any } | undefined;
  getRun(evt: SessionEvent, createIfMissing?: boolean): ActiveRunSpan | undefined;
  ensureUserSpan(evt: UserSpanEvent): ActiveRunSpan | undefined;
  syncRootFromRun(evt: SessionEvent): void;
  endRun(evt: SessionEvent, attrs?: Record<string, string | number | boolean>): void;
  endRoot(evt: SessionEvent, attrs?: Record<string, string | number | boolean>): void;
  clearRun(evt: SessionEvent): void;
  updateAggregateTokens(evt: Extract<DiagnosticEventPayload, { type: "model.usage" }>): void;
  loadSessionSnapshot(sessionKey: string | undefined): SessionSnapshot | undefined;
  enrichWithTranscript(
    sessionKey: string | undefined,
    attrs: Record<string, string | number | boolean | undefined>,
  ): Record<string, string | number | boolean | undefined>;
  createChildSpan: ChildSpanFactory;
  emitDiagnosticLog(
    evt: DiagnosticEventPayload,
    attrs: Record<string, string | number | boolean | undefined>,
    options?: {
      body?: string;
      severityNumber?: any;
      severityText?: string;
      context?: any;
      eventName?: string;
      exception?: unknown;
    },
  ): void;
  emitRuntimeOrchestrationSpan(
    evt: SessionEvent,
    startTs: number | undefined,
    endTs: number | undefined,
    phase: string,
    attrs?: Record<string, string | number | boolean | undefined>,
    parentCtx?: any,
  ): any;
  ensureRuntimeLifecycleSpans(
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
      snapshot?: SessionSnapshot | undefined;
      outputPreview?: string;
      outputLength?: number;
      outcome?: string;
    },
  ): ActiveRunSpan | undefined;
  emitModelTurnDebugLog(payload: Record<string, unknown>): void;
  getActiveSkillCtx(run: ActiveRunSpan | undefined): any;
  ensureTranscriptSkillSpans(evt: { sessionKey?: string; sessionId?: string; ts?: number }): void;
  emitTranscriptModelSpans(evt: SessionEvent): boolean;
  emitSyntheticModelSpan(evt: SessionEvent): void;
  emitTranscriptToolSpans(evt: SessionEvent): void;
  emitFallbackThinkingSpan(evt: SessionEvent): void;
  annotateToolLoop(evt: Extract<DiagnosticEventPayload, { type: "tool.loop" }>): boolean;
  hasReplayWatermark?(sessionKey: string | undefined, snapshot: SessionSnapshot | undefined): boolean;
  markReplayWatermark?(sessionKey: string | undefined, snapshot: SessionSnapshot | undefined): void;
};

export function createDiagnosticEventHandler(deps: DiagnosticEventHandlerDeps) {
  const {
    trace,
    instruments,
    SpanStatusCode,
    SeverityNumber,
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
    getActiveSkillCtx,
    ensureTranscriptSkillSpans,
    emitTranscriptModelSpans,
    emitSyntheticModelSpan,
    emitTranscriptToolSpans,
    emitFallbackThinkingSpan,
    annotateToolLoop,
    hasReplayWatermark = () => false,
    markReplayWatermark = () => {},
  } = deps;

  const logDiagnosticEvent = (
    evt: DiagnosticEventPayload,
    attrs: Record<string, string | number | boolean | undefined>,
    options?: {
      body?: string;
      severityNumber?: any;
      severityText?: string;
      context?: any;
      eventName?: string;
      exception?: unknown;
    },
  ) => {
    emitDiagnosticLog(evt, attrs, {
      body: options?.body ?? evt.type,
      severityNumber: options?.severityNumber,
      severityText: options?.severityText,
      context: options?.context,
      eventName: options?.eventName ?? evt.type,
      exception: options?.exception,
    });
  };

  const resolveTranscriptRequestStartTs = (
    snapshot: SessionSnapshot | undefined,
    fallbackTs: number | undefined,
    minStartTs?: number,
  ) => {
    const minAcceptedTs = typeof fallbackTs === "number"
      ? fallbackTs - MAX_PROCESSING_BACKFILL_MS
      : undefined;
    const candidates = [
      snapshot?.lastUserTs,
      ...(snapshot?.lastRunToolCalls ?? []).map((toolCall) => toolCall.startedAt),
      ...(snapshot?.lastRunAssistantTurns ?? []).flatMap((turn) => [turn.startedAt, turn.endedAt]),
      fallbackTs,
    ].filter((value): value is number => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return false;
      }
      if (typeof minAcceptedTs === "number" && value < minAcceptedTs) {
        return false;
      }
      return true;
    });
    if (candidates.length === 0) {
      if (typeof minStartTs === "number" && typeof fallbackTs === "number") {
        return Math.max(fallbackTs, minStartTs);
      }
      return fallbackTs;
    }
    const resolvedTs = Math.min(...candidates);
    if (typeof minStartTs === "number") {
      return Math.max(resolvedTs, minStartTs);
    }
    return resolvedTs;
  };

  return (evt: DiagnosticEventPayload) => {
    cleanupExpiredRoots();

    switch (evt.type) {
      case "session.state": {
        const existingRun = evt.state === "processing"
          ? getRun(evt, false)
          : undefined;
        const processingSnapshot = evt.state === "processing"
          ? loadSessionSnapshot(evt.sessionKey)
          : undefined;
        const processingTraceTs = evt.state === "processing"
          ? resolveTranscriptRequestStartTs(processingSnapshot, evt.ts, existingRun?.messageQueuedTs)
          : evt.ts;
        const traceEvt = evt.state === "processing" && typeof processingTraceTs === "number"
          ? { ...evt, ts: processingTraceTs }
          : evt;
        const sessionStateAttrs = {
          "openclaw.prevState": evt.prevState,
          "openclaw.state": evt.state,
          "openclaw.reason": evt.reason ? redactSensitiveText(evt.reason) : undefined,
          "openclaw.queueDepth": evt.queueDepth,
        };
        instruments.diagnosticsSessionStateCounter.add(
          1,
          buildDiagnosticsSessionMetricAttrs(evt.state, evt.reason),
        );
        instruments.genAiRuntimeSessionStateCount?.add(
          1,
          buildGenAiRuntimeSessionMetricAttrs(evt.state, evt.reason, evt.sessionId),
        );
        if (typeof evt.queueDepth === "number") {
          instruments.diagnosticsQueueDepth.record(
            evt.queueDepth,
            buildDiagnosticsSessionMetricAttrs(evt.state, evt.reason),
          );
          instruments.genAiRuntimeQueueDepth?.record(
            evt.queueDepth,
            buildGenAiRuntimeSessionMetricAttrs(evt.state, evt.reason, evt.sessionId),
          );
        }
        const root = getRoot(traceEvt, shouldCreateRootForSessionState(evt.state));
        if (root) {
          addEvent(root.span, "session.state");
        }
        logDiagnosticEvent(evt, sessionStateAttrs, {
          body: `session.state ${evt.state}`,
          severityNumber: SeverityNumber.INFO,
          severityText: "INFO",
        });
        if (shouldSyncRootForSessionState(evt.state)) {
          syncRootFromRun(evt);
        }
        if (evt.state === "processing") {
          const snapshot = processingSnapshot;
          const lifecycleStartTs = typeof processingTraceTs === "number" ? processingTraceTs : evt.ts;
          ensureUserSpan({
            sessionKey: evt.sessionKey,
            sessionId: evt.sessionId,
            ts: lifecycleStartTs ?? Date.now(),
          });
          const run = getRun({
            sessionKey: evt.sessionKey,
            sessionId: evt.sessionId,
            ts: lifecycleStartTs,
          }, true);
          if (run) {
            if (typeof lifecycleStartTs === "number") {
              run.mainStartTs = Math.min(run.mainStartTs, lifecycleStartTs);
            }
            if (typeof evt.ts === "number") {
              run.orchestrationCursorTs = evt.ts;
            }
            ensureRuntimeLifecycleSpans(
              {
                sessionKey: evt.sessionKey,
                sessionId: evt.sessionId,
                ts: lifecycleStartTs,
                channel: snapshot?.lastChannel,
              },
              {
                createIfMissing: true,
                startTsHint: lifecycleStartTs,
                processingStartTs: evt.ts,
                nextActionTs: evt.ts + MIN_VISIBLE_CHILD_MS,
                snapshot,
              },
            );
          }
        }
        if (shouldCloseForSessionState(evt.state)) {
          const snapshot = loadSessionSnapshot(evt.sessionKey);
          const hasActiveTrace = Boolean(getRun(evt, false) || getRoot(evt, false));
          if (hasReplayWatermark(evt.sessionKey, snapshot) && !hasActiveTrace) {
            break;
          }
          const emittedTranscriptModelSpans = emitTranscriptModelSpans(evt);
          emitTranscriptToolSpans(evt);
          if (!emittedTranscriptModelSpans) {
            emitSyntheticModelSpan(evt);
          }
          ensureRuntimeLifecycleSpans(
            {
              sessionKey: evt.sessionKey,
              sessionId: evt.sessionId,
              ts: evt.ts,
              channel: snapshot?.lastChannel,
              outcome: evt.state,
            },
            {
              createIfMissing: true,
              emitEgress: true,
              snapshot,
              outputPreview: clipPreview(snapshot?.lastAssistantText),
              outputLength: snapshot?.lastAssistantText?.length,
              outcome: evt.state,
            },
          );
          markReplayWatermark(evt.sessionKey, snapshot);
          const finalOutcome = getRun(evt, false)?.pendingFinalOutcome;
          endRun(evt, stringAttrs({
            "openclaw.state": evt.state,
            "openclaw.outcome": finalOutcome,
            "openclaw.reason": evt.reason ? redactSensitiveText(evt.reason) : undefined,
          }));
          endRoot(evt, stringAttrs({
            "openclaw.state": evt.state,
            "openclaw.outcome": finalOutcome,
            "openclaw.reason": evt.reason ? redactSensitiveText(evt.reason) : undefined,
          }));
          clearRun(evt);
        }
        break;
      }
      case "run.attempt": {
        const attemptAttrs = {
          "openclaw.runId": evt.runId,
          "openclaw.attempt": evt.attempt,
        };
        instruments.diagnosticsRunAttemptCounter.add(
          1,
          stringAttrs({ "openclaw.attempt": evt.attempt }),
        );
        const root = getRoot(evt, true);
        if (root) {
          addEvent(root.span, "run.attempt", attemptAttrs);
        }
        logDiagnosticEvent(evt, attemptAttrs, {
          body: `run.attempt ${evt.attempt}`,
          severityNumber: SeverityNumber.INFO,
          severityText: "INFO",
        });
        break;
      }
      case "message.queued": {
        const activeRun = getRun(evt, false);
        const hasStartedExecution = Boolean(
          activeRun
          && (
            activeRun.modelSpanEmitted
            || typeof activeRun.modelEndTs === "number"
            || activeRun.usedToolNames.size > 0
            || activeRun.aggregate.modelCalls > 0
          ),
        );
        if (
          activeRun
          && hasStartedExecution
          && typeof evt.ts === "number"
          && evt.ts > activeRun.mainStartTs
        ) {
          const finalOutcome = activeRun.pendingFinalOutcome;
          endRun(
            {
              sessionKey: evt.sessionKey,
              sessionId: evt.sessionId,
              ts: evt.ts - 1,
            },
            stringAttrs({ "openclaw.outcome": finalOutcome ?? "superseded_by_next_message" }),
          );
          endRoot(
            {
              sessionKey: evt.sessionKey,
              sessionId: evt.sessionId,
              ts: evt.ts - 1,
            },
            stringAttrs({ "openclaw.outcome": finalOutcome ?? "superseded_by_next_message" }),
          );
          clearRun(evt);
        }
        if (!activeRun || hasStartedExecution) {
          beginRequestTrace(evt);
        }
        const queuedAttrs = {
          "openclaw.channel": evt.channel,
          "openclaw.source": evt.source,
          "openclaw.queueDepth": evt.queueDepth,
        };
        instruments.diagnosticsMessageQueuedCounter.add(
          1,
          buildDiagnosticsMessageMetricAttrs(evt.channel, {
            "openclaw.source": evt.source,
          }),
        );
        instruments.genAiRuntimeMessageQueuedCount?.add(
          1,
          buildGenAiRuntimeMessageMetricAttrs(evt.channel, evt.sessionId, {
            source: evt.source,
          }),
        );
        if (typeof evt.queueDepth === "number") {
          instruments.diagnosticsQueueDepth.record(
            evt.queueDepth,
            buildDiagnosticsMessageMetricAttrs(evt.channel),
          );
          instruments.genAiRuntimeQueueDepth?.record(
            evt.queueDepth,
            buildGenAiRuntimeMessageMetricAttrs(evt.channel, evt.sessionId),
          );
        }
        const root = getRoot(evt, true);
        if (root) {
          addEvent(root.span, "message.queued");
        }
        logDiagnosticEvent(evt, queuedAttrs, {
          body: "message.queued",
          severityNumber: SeverityNumber.INFO,
          severityText: "INFO",
        });
        const run = ensureUserSpan(evt);
        if (run && typeof evt.ts === "number") {
          run.messageQueuedTs = typeof run.messageQueuedTs === "number"
            ? Math.min(run.messageQueuedTs, evt.ts)
            : evt.ts;
        }
        break;
      }
      case "model.usage": {
        const snapshot = loadSessionSnapshot(evt.sessionKey);
        const resolvedSessionId = evt.sessionId ?? snapshot?.sessionId;
        const modelStartTs = typeof evt.ts === "number" && typeof evt.durationMs === "number"
          ? evt.ts - Math.max(evt.durationMs, 1)
          : evt.ts;
        const modelUsageAttrs = {
          "openclaw.channel": evt.channel,
          "openclaw.provider": evt.provider,
          "openclaw.model": evt.model,
          "openclaw.sessionKey": evt.sessionKey,
          "openclaw.sessionId": resolvedSessionId,
          "span.kind": "model",
          "openclaw.tokens.input": evt.usage.input ?? 0,
          "openclaw.tokens.output": evt.usage.output ?? 0,
          "openclaw.tokens.cache_read": evt.usage.cacheRead ?? 0,
          "openclaw.tokens.cache_write": evt.usage.cacheWrite ?? 0,
          "openclaw.tokens.total": evt.usage.total ?? 0,
          "openclaw.context.limit": evt.context?.limit,
          "openclaw.context.used": evt.context?.used,
          "openclaw.cost.usd": evt.costUsd,
          "llm.provider": evt.provider,
          "llm.model": evt.model,
          "llm.input_tokens": evt.usage.input ?? 0,
          "llm.output_tokens": evt.usage.output ?? 0,
          "llm.total_tokens": evt.usage.total ?? 0,
        };
        updateAggregateTokens({
          ...evt,
          ts: modelStartTs,
        });
        const modelMetricAttrs = buildDiagnosticsModelMetricAttrs(
          evt.channel,
          evt.provider,
          evt.model,
        );
        const genAiModelMetricAttrs = buildGenAiClientModelMetricAttrs(
          evt.provider,
          evt.model,
          { session_id: resolvedSessionId },
        );
        const enrichedModelUsageAttrs = enrichWithTranscript(evt.sessionKey, modelUsageAttrs);
        const tokenMetrics = [
          ["input", evt.usage.input],
          ["output", evt.usage.output],
          ["cache_read", evt.usage.cacheRead],
          ["cache_write", evt.usage.cacheWrite],
          ["prompt", evt.usage.promptTokens],
          ["total", evt.usage.total],
        ] as const;
        for (const [tokenType, tokenValue] of tokenMetrics) {
          if (typeof tokenValue === "number" && tokenValue > 0) {
            instruments.diagnosticsTokensCounter.add(
              tokenValue,
              buildDiagnosticsModelMetricAttrs(evt.channel, evt.provider, evt.model, {
                "openclaw.token": tokenType,
              }),
            );
            if (tokenType === "input" || tokenType === "output" || tokenType === "total") {
              const genAiTokenMetricAttrs = buildGenAiClientModelMetricAttrs(evt.provider, evt.model, {
                session_id: resolvedSessionId,
                token_type: tokenType,
              });
              instruments.genAiClientTokenUsage?.add(
                tokenValue,
                genAiTokenMetricAttrs,
              );
            }
          }
        }
        if (typeof evt.costUsd === "number" && evt.costUsd > 0) {
          instruments.diagnosticsCostUsdCounter.add(evt.costUsd, modelMetricAttrs);
        }
        if (typeof evt.durationMs === "number") {
          instruments.diagnosticsRunDurationMs.record(evt.durationMs, modelMetricAttrs);
          instruments.genAiClientOperationDuration?.record(evt.durationMs, genAiModelMetricAttrs);
        }
        if (typeof evt.context?.limit === "number") {
          instruments.diagnosticsContextTokens.record(
            evt.context.limit,
            buildDiagnosticsModelMetricAttrs(evt.channel, evt.provider, evt.model, {
              "openclaw.context": "limit",
            }),
          );
        }
        if (typeof evt.context?.used === "number") {
          instruments.diagnosticsContextTokens.record(
            evt.context.used,
            buildDiagnosticsModelMetricAttrs(evt.channel, evt.provider, evt.model, {
              "openclaw.context": "used",
            }),
          );
        }
        const run = ensureRuntimeLifecycleSpans(
          {
            ...evt,
            ts: modelStartTs,
          },
          {
            createIfMissing: true,
            startTsHint: modelStartTs,
            processingStartTs: modelStartTs,
            nextActionTs: typeof modelStartTs === "number" ? modelStartTs + MIN_VISIBLE_CHILD_MS : undefined,
          },
        );
        if (run && typeof run.orchestrationCursorTs === "number" && typeof modelStartTs === "number"
          && modelStartTs > run.orchestrationCursorTs) {
          emitRuntimeOrchestrationSpan(
            evt,
            run.orchestrationCursorTs,
            modelStartTs,
            "pre_model",
            {
              "openclaw.provider": evt.provider,
              "openclaw.model": evt.model,
            },
            getActiveSkillCtx(run) ?? run.ctx,
          );
        }
        if (run?.modelSpan) {
          run.modelSpan.setAttributes(traceAttrs({
            ...enrichedModelUsageAttrs,
            session_update_time: evt.ts,
          }));
          run.modelSpan.setStatus({ code: SpanStatusCode.OK });
          endSpanSafely(run.modelSpan, eventTime(evt.ts));
          emitModelTurnDebugLog({
            source: "runtime",
            trace_id: typeof run.modelSpan.spanContext === "function" ? run.modelSpan.spanContext().traceId : undefined,
            span_id: typeof run.modelSpan.spanContext === "function" ? run.modelSpan.spanContext().spanId : undefined,
            session_key: evt.sessionKey,
            session_id: evt.sessionId,
            provider: evt.provider,
            model: evt.model,
            start_ts: run.modelStartTs,
            end_ts: evt.ts,
            duration_ms: typeof run.modelStartTs === "number" && typeof evt.ts === "number"
              ? Math.max(evt.ts - run.modelStartTs, 1)
              : evt.durationMs,
            input_preview: enrichedModelUsageAttrs["openclaw.input.preview"],
            output_preview: enrichedModelUsageAttrs["openclaw.output.preview"],
            output_kind: enrichedModelUsageAttrs["openclaw.output.kind"],
          });
          run.modelSpan = undefined;
          run.modelEndTs = evt.ts;
          run.orchestrationCursorTs = evt.ts;
        } else {
          const { span, effectiveDurationMs, startTime, endTime } = createChildSpan(
            "model_request",
            evt,
            enrichedModelUsageAttrs,
            evt.durationMs,
            getActiveSkillCtx(run) ?? run?.ctx,
          );
          span.setStatus({ code: SpanStatusCode.OK });
          span.end(endTime ?? endTimeFromStart(startTime.getTime(), effectiveDurationMs));
          if (run) {
            run.modelCtx = trace.setSpan(getActiveSkillCtx(run) ?? run.ctx, span);
            run.modelStartTs = startTime.getTime();
            run.modelEndTs = (endTime ?? endTimeFromStart(startTime.getTime(), effectiveDurationMs)).getTime();
            run.modelSpanEmitted = true;
            run.orchestrationCursorTs = run.modelEndTs;
          }
          emitModelTurnDebugLog({
            source: "runtime",
            trace_id: typeof span.spanContext === "function" ? span.spanContext().traceId : undefined,
            span_id: typeof span.spanContext === "function" ? span.spanContext().spanId : undefined,
            session_key: evt.sessionKey,
            session_id: evt.sessionId,
            provider: evt.provider,
            model: evt.model,
            start_ts: startTime.getTime(),
            end_ts: (endTime ?? endTimeFromStart(startTime.getTime(), effectiveDurationMs)).getTime(),
            duration_ms: effectiveDurationMs,
            input_preview: enrichedModelUsageAttrs["openclaw.input.preview"],
            output_preview: enrichedModelUsageAttrs["openclaw.output.preview"],
            output_kind: enrichedModelUsageAttrs["openclaw.output.kind"],
          });
        }
        logDiagnosticEvent(evt, modelUsageAttrs, {
          body: `model.usage ${evt.provider ?? "unknown"}/${evt.model ?? "unknown"}`,
          severityNumber: SeverityNumber.INFO,
          severityText: "INFO",
          context: run?.modelCtx ?? getActiveSkillCtx(run) ?? run?.ctx,
        });
        break;
      }
      case "message.processed": {
        const snapshot = loadSessionSnapshot(evt.sessionKey);
        const processedAttrs = {
          "openclaw.channel": evt.channel,
          "openclaw.messageId": evt.messageId ? String(evt.messageId) : undefined,
          "openclaw.chatId": evt.chatId ? String(evt.chatId) : undefined,
          "openclaw.outcome": evt.outcome,
          "openclaw.reason": evt.reason ? redactSensitiveText(evt.reason) : undefined,
          "span.kind": "output",
          "openclaw.output.preview": clipPreview(snapshot?.lastAssistantText),
          "openclaw.output.length": snapshot?.lastAssistantText?.length,
          "openclaw.provider": snapshot?.lastProvider,
          "openclaw.model": snapshot?.lastModel,
        };
        instruments.diagnosticsMessageProcessedCounter.add(
          1,
          buildDiagnosticsMessageMetricAttrs(evt.channel, {
            "openclaw.outcome": evt.outcome,
          }),
        );
        instruments.genAiRuntimeMessageProcessedCount?.add(
          1,
          buildGenAiRuntimeMessageMetricAttrs(evt.channel, evt.sessionId, {
            outcome: evt.outcome,
          }),
        );
        if (typeof evt.durationMs === "number") {
          instruments.diagnosticsMessageDurationMs.record(
            evt.durationMs,
            buildDiagnosticsMessageMetricAttrs(evt.channel, {
              "openclaw.outcome": evt.outcome,
            }),
          );
          instruments.genAiRuntimeMessageDuration?.record(
            evt.durationMs,
            buildGenAiRuntimeMessageMetricAttrs(evt.channel, evt.sessionId, {
              outcome: evt.outcome,
            }),
          );
        }
        ensureTranscriptSkillSpans(evt);
        const hasActiveTrace = Boolean(getRun(evt, false) || getRoot(evt, false));
        const replayAlreadyFinalized = hasReplayWatermark(evt.sessionKey, snapshot);
        if (!replayAlreadyFinalized || hasActiveTrace) {
          const emittedTranscriptModelSpans = emitTranscriptModelSpans(evt);
          if (emittedTranscriptModelSpans) {
            emitTranscriptToolSpans(evt);
          } else {
            emitSyntheticModelSpan(evt);
          }
          markReplayWatermark(evt.sessionKey, snapshot);
        }
        if (replayAlreadyFinalized && !hasActiveTrace) {
          break;
        }
        const run = ensureRuntimeLifecycleSpans(evt, {
          createIfMissing: true,
          emitEgress: true,
          snapshot,
          outputPreview: clipPreview(snapshot?.lastAssistantText),
          outputLength: snapshot?.lastAssistantText?.length,
          outcome: evt.outcome,
        });
        logDiagnosticEvent(evt, processedAttrs, {
          body: `message.processed ${evt.outcome}`,
          severityNumber: evt.outcome === "error" ? SeverityNumber.ERROR : SeverityNumber.INFO,
          severityText: evt.outcome === "error" ? "ERROR" : "INFO",
          context: run?.modelCtx ?? getActiveSkillCtx(run) ?? run?.ctx,
          exception: evt.outcome === "error" ? evt.error ?? evt.reason : undefined,
        });
        syncRootFromRun(evt);
        if (run) {
          run.pendingFinalOutcome = evt.outcome;
          run.lastTouchedAt = Date.now();
        }
        break;
      }
      case "webhook.received": {
        const webhookReceivedAttrs = {
          "openclaw.channel": evt.channel,
          "openclaw.webhook": evt.updateType,
          "openclaw.chatId": evt.chatId ? String(evt.chatId) : undefined,
        };
        instruments.diagnosticsWebhookReceivedCounter.add(
          1,
          buildDiagnosticsWebhookMetricAttrs(evt.channel, evt.updateType),
        );
        instruments.genAiRuntimeWebhookReceivedCount?.add(
          1,
          buildGenAiRuntimeWebhookMetricAttrs(evt.channel, evt.updateType),
        );
        const { span } = createChildSpan("openclaw.webhook.received", evt, webhookReceivedAttrs);
        span.setStatus({ code: SpanStatusCode.OK });
        span.end(eventTime(evt.ts));
        logDiagnosticEvent(evt, webhookReceivedAttrs, {
          body: `webhook.received ${evt.updateType ?? "unknown"}`,
          severityNumber: SeverityNumber.INFO,
          severityText: "INFO",
        });
        break;
      }
      case "webhook.processed": {
        const webhookProcessedAttrs = {
          "openclaw.channel": evt.channel,
          "openclaw.webhook": evt.updateType,
          "openclaw.chatId": evt.chatId ? String(evt.chatId) : undefined,
        };
        if (typeof evt.durationMs === "number") {
          instruments.diagnosticsWebhookDurationMs.record(
            evt.durationMs,
            buildDiagnosticsWebhookMetricAttrs(evt.channel, evt.updateType),
          );
          instruments.genAiRuntimeWebhookDuration?.record(
            evt.durationMs,
            buildGenAiRuntimeWebhookMetricAttrs(evt.channel, evt.updateType),
          );
        }
        const { span } = createChildSpan(
          "openclaw.webhook.processed",
          evt,
          webhookProcessedAttrs,
          evt.durationMs,
        );
        span.setStatus({ code: SpanStatusCode.OK });
        span.end(eventTime(evt.ts));
        logDiagnosticEvent(evt, webhookProcessedAttrs, {
          body: `webhook.processed ${evt.updateType ?? "unknown"}`,
          severityNumber: SeverityNumber.INFO,
          severityText: "INFO",
        });
        break;
      }
      case "webhook.error": {
        const webhookErrorAttrs = {
          "openclaw.channel": evt.channel,
          "openclaw.webhook": evt.updateType,
          "openclaw.chatId": evt.chatId ? String(evt.chatId) : undefined,
          "openclaw.error": redactSensitiveText(evt.error),
        };
        instruments.diagnosticsWebhookErrorCounter.add(
          1,
          buildDiagnosticsWebhookMetricAttrs(evt.channel, evt.updateType),
        );
        instruments.genAiRuntimeWebhookErrorCount?.add(
          1,
          buildGenAiRuntimeWebhookMetricAttrs(evt.channel, evt.updateType),
        );
        const { span } = createChildSpan("openclaw.webhook.error", evt, webhookErrorAttrs);
        setError(span, SpanStatusCode.ERROR, evt.error);
        span.end(eventTime(evt.ts));
        logDiagnosticEvent(evt, webhookErrorAttrs, {
          body: `webhook.error ${evt.updateType ?? "unknown"}`,
          severityNumber: SeverityNumber.ERROR,
          severityText: "ERROR",
          exception: evt.error,
        });
        break;
      }
      case "session.stuck": {
        const sessionStuckAttrs = {
          "openclaw.state": evt.state,
          "openclaw.ageMs": evt.ageMs,
          "openclaw.queueDepth": evt.queueDepth,
          "openclaw.alert": true,
          "openclaw.alert.kind": "session_stuck",
        };
        instruments.diagnosticsSessionStuckCounter.add(
          1,
          buildDiagnosticsSessionMetricAttrs(evt.state),
        );
        instruments.genAiRuntimeSessionStuckCount?.add(
          1,
          buildGenAiRuntimeSessionMetricAttrs(evt.state, undefined, evt.sessionId),
        );
        instruments.diagnosticsSessionStuckAgeMs.record(
          evt.ageMs,
          buildDiagnosticsSessionMetricAttrs(evt.state),
        );
        instruments.genAiRuntimeSessionStuckAge?.record(
          evt.ageMs,
          buildGenAiRuntimeSessionMetricAttrs(evt.state, undefined, evt.sessionId),
        );
        if (typeof evt.queueDepth === "number") {
          instruments.diagnosticsQueueDepth.record(
            evt.queueDepth,
            buildDiagnosticsSessionMetricAttrs(evt.state),
          );
          instruments.genAiRuntimeQueueDepth?.record(
            evt.queueDepth,
            buildGenAiRuntimeSessionMetricAttrs(evt.state, undefined, evt.sessionId),
          );
        }
        const { span } = createChildSpan("openclaw.session.stuck", evt, sessionStuckAttrs);
        addEvent(span, "openclaw.session.stuck", sessionStuckAttrs);
        span.setStatus({ code: SpanStatusCode.OK });
        span.end(eventTime(evt.ts));
        logDiagnosticEvent(evt, sessionStuckAttrs, {
          body: `session.stuck ${evt.state}`,
          severityNumber: SeverityNumber.WARN,
          severityText: "WARN",
        });
        break;
      }
      case "queue.lane.enqueue":
      case "queue.lane.dequeue":
      case "diagnostic.heartbeat":
      case "tool.loop": {
        if (evt.type === "queue.lane.enqueue") {
          instruments.diagnosticsQueueLaneEnqueueCounter.add(
            1,
            buildDiagnosticsQueueMetricAttrs(evt.lane),
          );
          instruments.genAiRuntimeQueueEnqueueCount?.add(
            1,
            buildGenAiRuntimeQueueMetricAttrs(evt.lane, evt.sessionId),
          );
          instruments.diagnosticsQueueDepth.record(
            evt.queueSize,
            buildDiagnosticsQueueMetricAttrs(evt.lane),
          );
          instruments.genAiRuntimeQueueDepth?.record(
            evt.queueSize,
            buildGenAiRuntimeQueueMetricAttrs(evt.lane, evt.sessionId),
          );
        }
        if (evt.type === "queue.lane.dequeue") {
          instruments.diagnosticsQueueLaneDequeueCounter.add(
            1,
            buildDiagnosticsQueueMetricAttrs(evt.lane),
          );
          instruments.genAiRuntimeQueueDequeueCount?.add(
            1,
            buildGenAiRuntimeQueueMetricAttrs(evt.lane, evt.sessionId),
          );
          instruments.diagnosticsQueueDepth.record(
            evt.queueSize,
            buildDiagnosticsQueueMetricAttrs(evt.lane),
          );
          instruments.genAiRuntimeQueueDepth?.record(
            evt.queueSize,
            buildGenAiRuntimeQueueMetricAttrs(evt.lane, evt.sessionId),
          );
          instruments.diagnosticsQueueWaitMs.record(
            evt.waitMs,
            buildDiagnosticsQueueMetricAttrs(evt.lane),
          );
          instruments.genAiRuntimeQueueWait?.record(
            evt.waitMs,
            buildGenAiRuntimeQueueMetricAttrs(evt.lane, evt.sessionId),
          );
        }
        if (evt.type === "diagnostic.heartbeat") {
          instruments.diagnosticsQueueDepth.record(
            evt.queued,
            stringAttrs({ "openclaw.channel": "heartbeat" }),
          );
        }
        if (evt.type === "tool.loop" && annotateToolLoop(evt)) {
          break;
        }
        const queueOrLoopAttrs = {
          ...("lane" in evt ? { "openclaw.lane": evt.lane } : {}),
          ...("queueSize" in evt ? { "openclaw.queueSize": evt.queueSize } : {}),
          ...("waitMs" in evt ? { "openclaw.waitMs": evt.waitMs } : {}),
          ...("toolName" in evt ? { "openclaw.toolName": evt.toolName } : {}),
          ...("detector" in evt ? { "openclaw.detector": evt.detector } : {}),
          ...("action" in evt ? { "openclaw.action": evt.action } : {}),
          ...("count" in evt ? { "openclaw.count": evt.count } : {}),
        };
        logDiagnosticEvent(evt, queueOrLoopAttrs, {
          body: evt.type,
          severityNumber: evt.type === "tool.loop" ? SeverityNumber.ERROR : SeverityNumber.INFO,
          severityText: evt.type === "tool.loop" ? "ERROR" : "INFO",
          exception: evt.type === "tool.loop" ? evt.message : undefined,
        });
        if (evt.type !== "tool.loop") {
          break;
        }
        const { span } = createChildSpan(evt.type, evt, queueOrLoopAttrs);
        setError(span, SpanStatusCode.ERROR, evt.message);
        span.end(eventTime(evt.ts));
        break;
      }
    }
  };
}
