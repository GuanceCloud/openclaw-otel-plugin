import type { DiagnosticEventPayload } from "openclaw/plugin-sdk";
import type { ActiveRunSpan, MetricInstruments, SessionSnapshot } from "./service-types.js";
import {
  addEvent,
  buildGenAiAgentTokenMetricAttrs,
  buildGenAiClientModelMetricAttrs,
  buildGenAiRuntimeMessageMetricAttrs,
  buildGenAiRuntimeQueueMetricAttrs,
  buildGenAiRuntimeSessionMetricAttrs,
  buildGenAiRuntimeWebhookMetricAttrs,
  clipPreview,
  endSpanSafely,
  endTimeFromStart,
  eventTime,
  isHeartbeatSessionSnapshot,
  MIN_VISIBLE_CHILD_MS,
  redactSensitiveText,
  resolveUsageTokenTotals,
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
  hasFinalizedReplayRunId?(sessionKey: string | undefined, runId: string | undefined): boolean;
  markFinalizedReplayRunId?(sessionKey: string | undefined, runId: string | undefined): void;
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
    hasFinalizedReplayRunId = () => false,
    markFinalizedReplayRunId = () => {},
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

  const resolveSnapshotActivityTs = (snapshot: SessionSnapshot | undefined): number | undefined => {
    const candidates = [
      snapshot?.lastUserTs,
      snapshot?.lastAssistantTs,
      ...(snapshot?.lastRunToolCalls ?? []).flatMap((toolCall) => [toolCall.startedAt, toolCall.endedAt]),
      ...(snapshot?.lastRunAssistantTurns ?? []).flatMap((turn) => [turn.startedAt, turn.endedAt]),
    ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (candidates.length === 0) {
      return undefined;
    }
    return Math.max(...candidates);
  };

  const snapshotIsFreshForQueuedRequest = (
    snapshot: SessionSnapshot | undefined,
    run: ActiveRunSpan | undefined,
  ): boolean => {
    const minRequestTs = run?.messageQueuedTs;
    if (typeof minRequestTs !== "number") {
      return true;
    }
    const snapshotActivityTs = resolveSnapshotActivityTs(snapshot);
    if (typeof snapshotActivityTs !== "number") {
      return false;
    }
    return snapshotActivityTs >= minRequestTs;
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
        if (isHeartbeatSessionSnapshot(processingSnapshot)) {
          break;
        }
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
        instruments.genAiRuntimeSessionStateCount?.add(
          1,
          buildGenAiRuntimeSessionMetricAttrs(evt.state, evt.reason, evt.sessionId),
        );
        if (typeof evt.queueDepth === "number") {
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
          if (isHeartbeatSessionSnapshot(snapshot)) {
            break;
          }
          const hasActiveTrace = Boolean(getRun(evt, false) || getRoot(evt, false));
          const replayAlreadyFinalized = hasReplayWatermark(evt.sessionKey, snapshot);
          const replayRunAlreadyFinalized = hasFinalizedReplayRunId(evt.sessionKey, snapshot?.runId);
          if ((replayAlreadyFinalized || replayRunAlreadyFinalized) && !hasActiveTrace) {
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
        if (snapshot?.runCompleted === true) {
          markReplayWatermark(evt.sessionKey, snapshot);
        }
        markFinalizedReplayRunId(
          evt.sessionKey,
          getRun(evt, false)?.runId ?? snapshot?.runId,
        );
        const finalOutcome = getRun(evt, false)?.pendingFinalOutcome
          ?? (snapshot?.runCompleted === true ? "completed" : evt.state);
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
          run_id: evt.runId,
          "openclaw.attempt": evt.attempt,
        };
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
        const snapshot = loadSessionSnapshot(evt.sessionKey);
        if (isHeartbeatSessionSnapshot(snapshot)) {
          break;
        }
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
        instruments.genAiRuntimeMessageQueuedCount?.add(
          1,
          buildGenAiRuntimeMessageMetricAttrs(evt.channel, evt.sessionId, {
            source: evt.source,
          }),
        );
        if (typeof evt.queueDepth === "number") {
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
        const usageTotals = resolveUsageTokenTotals(evt.usage);
        const modelUsageAttrs = {
          "openclaw.channel": evt.channel,
          "openclaw.provider": evt.provider,
          "openclaw.model": evt.model,
          "openclaw.sessionKey": evt.sessionKey,
          "openclaw.sessionId": resolvedSessionId,
          "span.kind": "model",
          "openclaw.tokens.input": usageTotals.inputTokens,
          "openclaw.tokens.output": usageTotals.outputTokens,
          "openclaw.tokens.total": usageTotals.totalTokens,
          "openclaw.tokens.cache_read": usageTotals.cacheReadTokens,
          "openclaw.tokens.cache_write": usageTotals.cacheWriteTokens,
          "openclaw.context.limit": evt.context?.limit,
          "openclaw.context.used": evt.context?.used,
          "openclaw.cost.usd": evt.costUsd,
          "llm.provider": evt.provider,
          "llm.model": evt.model,
          "llm.input_tokens": usageTotals.inputTokens,
          "llm.output_tokens": usageTotals.outputTokens,
        };
        updateAggregateTokens({
          ...evt,
          ts: modelStartTs,
          usage: {
            ...evt.usage,
            total: usageTotals.totalTokens,
          },
        });
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
          ["total", usageTotals.totalTokens],
        ] as const;
        for (const [tokenType, tokenValue] of tokenMetrics) {
          if (typeof tokenValue === "number" && tokenValue > 0) {
            if (tokenType === "input" || tokenType === "output" || tokenType === "total") {
              const genAiTokenMetricAttrs = buildGenAiAgentTokenMetricAttrs(evt.provider, evt.model, {
                session_id: resolvedSessionId,
                token_type: tokenType,
              });
              instruments.genAiAgentTokenUsage?.record(
                tokenValue,
                genAiTokenMetricAttrs,
              );
            }
          }
        }
        if (typeof evt.durationMs === "number") {
          instruments.genAiAgentOperationCount?.add(1, genAiModelMetricAttrs);
          instruments.genAiAgentOperationDuration?.record(evt.durationMs, genAiModelMetricAttrs);
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
            "llm",
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
        if (isHeartbeatSessionSnapshot(snapshot)) {
          break;
        }
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
        instruments.genAiRuntimeMessageProcessedCount?.add(
          1,
          buildGenAiRuntimeMessageMetricAttrs(evt.channel, evt.sessionId, {
            outcome: evt.outcome,
          }),
        );
        if (typeof evt.durationMs === "number") {
          instruments.genAiRuntimeMessageDuration?.record(
            evt.durationMs,
            buildGenAiRuntimeMessageMetricAttrs(evt.channel, evt.sessionId, {
              outcome: evt.outcome,
            }),
          );
        }
        ensureTranscriptSkillSpans(evt);
        const activeRun = getRun(evt, false);
        const hasActiveTrace = Boolean(activeRun || getRoot(evt, false));
        const replayAlreadyFinalized = hasReplayWatermark(evt.sessionKey, snapshot);
        const replayRunAlreadyFinalized = hasFinalizedReplayRunId(evt.sessionKey, snapshot?.runId);
        const replaySnapshotIsFresh = snapshotIsFreshForQueuedRequest(snapshot, activeRun);
        if (((!replayAlreadyFinalized && !replayRunAlreadyFinalized) || hasActiveTrace) && replaySnapshotIsFresh) {
          const emittedTranscriptModelSpans = emitTranscriptModelSpans(evt);
          if (emittedTranscriptModelSpans) {
            emitTranscriptToolSpans(evt);
          } else {
            emitSyntheticModelSpan(evt);
          }
        }
        if ((replayAlreadyFinalized || replayRunAlreadyFinalized) && !hasActiveTrace) {
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
        if (snapshot?.runCompleted === true) {
          markReplayWatermark(evt.sessionKey, snapshot);
          markFinalizedReplayRunId(evt.sessionKey, snapshot.runId);
        }
        break;
      }
      case "webhook.received": {
        const webhookReceivedAttrs = {
          "openclaw.channel": evt.channel,
          "openclaw.webhook": evt.updateType,
          "openclaw.chatId": evt.chatId ? String(evt.chatId) : undefined,
        };
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
        instruments.genAiRuntimeSessionStuckCount?.add(
          1,
          buildGenAiRuntimeSessionMetricAttrs(evt.state, undefined, evt.sessionId),
        );
        instruments.genAiRuntimeSessionStuckAge?.record(
          evt.ageMs,
          buildGenAiRuntimeSessionMetricAttrs(evt.state, undefined, evt.sessionId),
        );
        if (typeof evt.queueDepth === "number") {
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
          instruments.genAiRuntimeQueueEnqueueCount?.add(
            1,
            buildGenAiRuntimeQueueMetricAttrs(evt.lane, evt.sessionId),
          );
          instruments.genAiRuntimeQueueDepth?.record(
            evt.queueSize,
            buildGenAiRuntimeQueueMetricAttrs(evt.lane, evt.sessionId),
          );
        }
        if (evt.type === "queue.lane.dequeue") {
          instruments.genAiRuntimeQueueDequeueCount?.add(
            1,
            buildGenAiRuntimeQueueMetricAttrs(evt.lane, evt.sessionId),
          );
          instruments.genAiRuntimeQueueDepth?.record(
            evt.queueSize,
            buildGenAiRuntimeQueueMetricAttrs(evt.lane, evt.sessionId),
          );
          instruments.genAiRuntimeQueueWait?.record(
            evt.waitMs,
            buildGenAiRuntimeQueueMetricAttrs(evt.lane, evt.sessionId),
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
