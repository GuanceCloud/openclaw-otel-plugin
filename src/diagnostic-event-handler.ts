import type { DiagnosticEventPayload } from "openclaw/plugin-sdk";
import type { ActiveRunSpan, MetricInstruments, SessionSnapshot } from "./service-types.js";
import {
  addEvent,
  buildDiagnosticsMessageMetricAttrs,
  buildDiagnosticsModelMetricAttrs,
  buildDiagnosticsQueueMetricAttrs,
  buildDiagnosticsSessionMetricAttrs,
  buildDiagnosticsWebhookMetricAttrs,
  clipPreview,
  endSpanSafely,
  endTimeFromStart,
  eventTime,
  MIN_VISIBLE_CHILD_MS,
  redactSensitiveText,
  setError,
  stringAttrs,
} from "./service-utils.js";
import {
  shouldCloseForSessionState,
  shouldCreateRootForSessionState,
  shouldSyncRootForSessionState,
} from "./trace-runtime.js";

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
};

type DiagnosticEventHandlerDeps = {
  instruments: MetricInstruments;
  SpanStatusCode: any;
  cleanupExpiredRoots(): void;
  getRoot(evt: SessionEvent, createIfMissing?: boolean): { span: any } | undefined;
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
  getActiveSkillCtx(run: ActiveRunSpan | undefined): any;
  ensureTranscriptSkillSpans(evt: { sessionKey?: string; sessionId?: string; ts?: number }): void;
  emitSyntheticModelSpan(evt: Extract<DiagnosticEventPayload, { type: "message.processed" }>): void;
  annotateToolLoop(evt: Extract<DiagnosticEventPayload, { type: "tool.loop" }>): boolean;
};

export function createDiagnosticEventHandler(deps: DiagnosticEventHandlerDeps) {
  const {
    instruments,
    SpanStatusCode,
    cleanupExpiredRoots,
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
    getActiveSkillCtx,
    ensureTranscriptSkillSpans,
    emitSyntheticModelSpan,
    annotateToolLoop,
  } = deps;

  return (evt: DiagnosticEventPayload) => {
    cleanupExpiredRoots();

    switch (evt.type) {
      case "session.state": {
        instruments.diagnosticsSessionStateCounter.add(
          1,
          buildDiagnosticsSessionMetricAttrs(evt.state, evt.reason),
        );
        if (typeof evt.queueDepth === "number") {
          instruments.diagnosticsQueueDepth.record(
            evt.queueDepth,
            buildDiagnosticsSessionMetricAttrs(evt.state, evt.reason),
          );
        }
        const root = getRoot(evt, shouldCreateRootForSessionState(evt.state));
        if (root) {
          addEvent(root.span, "session.state", stringAttrs({
            "openclaw.prevState": evt.prevState,
            "openclaw.state": evt.state,
            "openclaw.reason": evt.reason ? redactSensitiveText(evt.reason) : undefined,
            "openclaw.queueDepth": evt.queueDepth,
          }));
        }
        if (shouldSyncRootForSessionState(evt.state)) {
          syncRootFromRun(evt);
        }
        if (evt.state === "processing") {
          ensureUserSpan({
            sessionKey: evt.sessionKey,
            sessionId: evt.sessionId,
            ts: evt.ts,
          });
          const run = getRun(evt, true);
          if (run) {
            run.mainStartTs = evt.ts;
          }
        }
        if (shouldCloseForSessionState(evt.state)) {
          endRun(evt, stringAttrs({
            "openclaw.state": evt.state,
            "openclaw.reason": evt.reason ? redactSensitiveText(evt.reason) : undefined,
          }));
          endRoot(evt, stringAttrs({
            "openclaw.state": evt.state,
            "openclaw.reason": evt.reason ? redactSensitiveText(evt.reason) : undefined,
          }));
          clearRun(evt);
        }
        break;
      }
      case "run.attempt": {
        instruments.diagnosticsRunAttemptCounter.add(
          1,
          stringAttrs({ "openclaw.attempt": evt.attempt }),
        );
        const root = getRoot(evt, true);
        if (root) {
          addEvent(root.span, "run.attempt", {
            "openclaw.runId": evt.runId,
            "openclaw.attempt": evt.attempt,
          });
        }
        break;
      }
      case "message.queued": {
        instruments.diagnosticsMessageQueuedCounter.add(
          1,
          buildDiagnosticsMessageMetricAttrs(evt.channel, {
            "openclaw.source": evt.source,
          }),
        );
        if (typeof evt.queueDepth === "number") {
          instruments.diagnosticsQueueDepth.record(
            evt.queueDepth,
            buildDiagnosticsMessageMetricAttrs(evt.channel),
          );
        }
        const root = getRoot(evt, true);
        if (root) {
          addEvent(root.span, "message.queued", stringAttrs({
            "openclaw.channel": evt.channel,
            "openclaw.source": evt.source,
            "openclaw.queueDepth": evt.queueDepth,
          }));
        }
        ensureUserSpan(evt);
        break;
      }
      case "model.usage": {
        updateAggregateTokens(evt);
        const modelMetricAttrs = buildDiagnosticsModelMetricAttrs(
          evt.channel,
          evt.provider,
          evt.model,
        );
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
          }
        }
        if (typeof evt.costUsd === "number" && evt.costUsd > 0) {
          instruments.diagnosticsCostUsdCounter.add(evt.costUsd, modelMetricAttrs);
        }
        if (typeof evt.durationMs === "number") {
          instruments.diagnosticsRunDurationMs.record(evt.durationMs, modelMetricAttrs);
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
        const run = getRun(evt, true);
        if (run?.modelSpan) {
          run.modelSpan.setAttributes(stringAttrs(enrichWithTranscript(evt.sessionKey, {
            "span.kind": "model",
            "openclaw.provider": evt.provider,
            "openclaw.model": evt.model,
            "llm.provider": evt.provider,
            "llm.model": evt.model,
            "llm.input_tokens": evt.usage.input ?? 0,
            "llm.output_tokens": evt.usage.output ?? 0,
            "llm.total_tokens": evt.usage.total ?? 0,
            "openclaw.tokens.input": evt.usage.input ?? 0,
            "openclaw.tokens.output": evt.usage.output ?? 0,
            "openclaw.tokens.cache_read": evt.usage.cacheRead ?? 0,
            "openclaw.tokens.cache_write": evt.usage.cacheWrite ?? 0,
            "openclaw.tokens.total": evt.usage.total ?? 0,
            "openclaw.cost.usd": evt.costUsd,
          })));
          run.modelSpan.setStatus({ code: SpanStatusCode.OK });
          endSpanSafely(run.modelSpan, eventTime(evt.ts));
          run.modelSpan = undefined;
          run.modelCtx = undefined;
        } else {
          const { span, effectiveDurationMs, startTime } = createChildSpan(
            `${evt.provider ?? "model"}/${evt.model ?? "unknown"}`,
            evt,
            enrichWithTranscript(evt.sessionKey, {
              "openclaw.channel": evt.channel,
              "openclaw.provider": evt.provider,
              "openclaw.model": evt.model,
              "openclaw.sessionKey": evt.sessionKey,
              "openclaw.sessionId": evt.sessionId,
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
            }),
            evt.durationMs,
            getActiveSkillCtx(run) ?? run?.ctx,
          );
          span.setStatus({ code: SpanStatusCode.OK });
          span.end(endTimeFromStart(startTime.getTime(), effectiveDurationMs));
        }
        break;
      }
      case "message.processed": {
        instruments.diagnosticsMessageProcessedCounter.add(
          1,
          buildDiagnosticsMessageMetricAttrs(evt.channel, {
            "openclaw.outcome": evt.outcome,
          }),
        );
        if (typeof evt.durationMs === "number") {
          instruments.diagnosticsMessageDurationMs.record(
            evt.durationMs,
            buildDiagnosticsMessageMetricAttrs(evt.channel, {
              "openclaw.outcome": evt.outcome,
            }),
          );
        }
        const snapshot = loadSessionSnapshot(evt.sessionKey);
        ensureTranscriptSkillSpans(evt);
        emitSyntheticModelSpan(evt);
        const run = getRun(evt, true);
        const { span, effectiveDurationMs, startTime } = createChildSpan(
          "assistant_message",
          evt,
          {
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
          },
          MIN_VISIBLE_CHILD_MS,
          run?.modelCtx ?? getActiveSkillCtx(run) ?? run?.ctx,
        );
        if (evt.outcome === "error") {
          setError(span, SpanStatusCode.ERROR, evt.error ?? evt.reason);
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        span.end(endTimeFromStart(startTime.getTime(), effectiveDurationMs));
        syncRootFromRun(evt);
        endRun(evt, { "openclaw.outcome": evt.outcome });
        endRoot(evt, { "openclaw.outcome": evt.outcome });
        clearRun(evt);
        break;
      }
      case "webhook.received": {
        instruments.diagnosticsWebhookReceivedCounter.add(
          1,
          buildDiagnosticsWebhookMetricAttrs(evt.channel, evt.updateType),
        );
        const { span } = createChildSpan("openclaw.webhook.received", evt, {
          "openclaw.channel": evt.channel,
          "openclaw.webhook": evt.updateType,
          "openclaw.chatId": evt.chatId ? String(evt.chatId) : undefined,
        });
        span.setStatus({ code: SpanStatusCode.OK });
        span.end(eventTime(evt.ts));
        break;
      }
      case "webhook.processed": {
        if (typeof evt.durationMs === "number") {
          instruments.diagnosticsWebhookDurationMs.record(
            evt.durationMs,
            buildDiagnosticsWebhookMetricAttrs(evt.channel, evt.updateType),
          );
        }
        const { span } = createChildSpan(
          "openclaw.webhook.processed",
          evt,
          {
            "openclaw.channel": evt.channel,
            "openclaw.webhook": evt.updateType,
            "openclaw.chatId": evt.chatId ? String(evt.chatId) : undefined,
          },
          evt.durationMs,
        );
        span.setStatus({ code: SpanStatusCode.OK });
        span.end(eventTime(evt.ts));
        break;
      }
      case "webhook.error": {
        instruments.diagnosticsWebhookErrorCounter.add(
          1,
          buildDiagnosticsWebhookMetricAttrs(evt.channel, evt.updateType),
        );
        const { span } = createChildSpan("openclaw.webhook.error", evt, {
          "openclaw.channel": evt.channel,
          "openclaw.webhook": evt.updateType,
          "openclaw.chatId": evt.chatId ? String(evt.chatId) : undefined,
          "openclaw.error": redactSensitiveText(evt.error),
        });
        setError(span, SpanStatusCode.ERROR, evt.error);
        span.end(eventTime(evt.ts));
        break;
      }
      case "session.stuck": {
        instruments.diagnosticsSessionStuckCounter.add(
          1,
          buildDiagnosticsSessionMetricAttrs(evt.state),
        );
        instruments.diagnosticsSessionStuckAgeMs.record(
          evt.ageMs,
          buildDiagnosticsSessionMetricAttrs(evt.state),
        );
        if (typeof evt.queueDepth === "number") {
          instruments.diagnosticsQueueDepth.record(
            evt.queueDepth,
            buildDiagnosticsSessionMetricAttrs(evt.state),
          );
        }
        const { span } = createChildSpan("openclaw.session.stuck", evt, {
          "openclaw.state": evt.state,
          "openclaw.ageMs": evt.ageMs,
          "openclaw.queueDepth": evt.queueDepth,
          "openclaw.alert": true,
          "openclaw.alert.kind": "session_stuck",
        });
        addEvent(span, "openclaw.session.stuck", {
          "openclaw.state": evt.state,
          "openclaw.ageMs": evt.ageMs,
          "openclaw.queueDepth": evt.queueDepth,
          "openclaw.alert": true,
          "openclaw.alert.kind": "session_stuck",
        });
        span.setStatus({ code: SpanStatusCode.OK });
        span.end(eventTime(evt.ts));
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
          instruments.diagnosticsQueueDepth.record(
            evt.queueSize,
            buildDiagnosticsQueueMetricAttrs(evt.lane),
          );
        }
        if (evt.type === "queue.lane.dequeue") {
          instruments.diagnosticsQueueLaneDequeueCounter.add(
            1,
            buildDiagnosticsQueueMetricAttrs(evt.lane),
          );
          instruments.diagnosticsQueueDepth.record(
            evt.queueSize,
            buildDiagnosticsQueueMetricAttrs(evt.lane),
          );
          instruments.diagnosticsQueueWaitMs.record(
            evt.waitMs,
            buildDiagnosticsQueueMetricAttrs(evt.lane),
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
        const { span } = createChildSpan(evt.type, evt, {
          ...("lane" in evt ? { "openclaw.lane": evt.lane } : {}),
          ...("queueSize" in evt ? { "openclaw.queueSize": evt.queueSize } : {}),
          ...("waitMs" in evt ? { "openclaw.waitMs": evt.waitMs } : {}),
          ...("toolName" in evt ? { "openclaw.toolName": evt.toolName } : {}),
          ...("detector" in evt ? { "openclaw.detector": evt.detector } : {}),
          ...("action" in evt ? { "openclaw.action": evt.action } : {}),
          ...("count" in evt ? { "openclaw.count": evt.count } : {}),
        });
        if (evt.type === "tool.loop") {
          setError(span, SpanStatusCode.ERROR, evt.message);
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        span.end(eventTime(evt.ts));
        break;
      }
    }
  };
}
