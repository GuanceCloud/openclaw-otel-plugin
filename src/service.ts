import type {
  DiagnosticEventPayload,
  OpenClawPluginService,
} from "openclaw/plugin-sdk";
import { onDiagnosticEvent } from "openclaw/plugin-sdk";
import type { OtelPluginConfig } from "./config.js";
import { createDiagnosticEventHandler } from "./diagnostic-event-handler.js";
import { startOtelBootstrap } from "./otel-bootstrap.js";
import { createSessionSnapshotStore, resolveRuntimeMetadata } from "./session-store.js";
import type {
  ActiveRootSpan,
  ActiveRunSpan,
  RuntimeLike,
  SessionSnapshotStore,
} from "./service-types.js";
import {
  addEvent,
  buildModelMetricAttrs,
  buildRequestMetricAttrs,
  clipPreview,
  createRunState,
  endSpanSafely,
  endTimeFromStart,
  eventTime,
  MIN_VISIBLE_CHILD_MS,
  MIN_VISIBLE_MODEL_MS,
  normalizeReasoningPreview,
  normalizeUserInputPreview,
  redactSensitiveText,
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
  const activeRoots = new Map<string, ActiveRootSpan>();
  const activeRuns = new Map<string, ActiveRunSpan>();

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
        instruments,
      } = await startOtelBootstrap(config, runtimeMetadata, ctx.logger);
      sdk = otelSdk;
      sessionStore.refreshSessionsIndex();

      const loadSessionSnapshot = (sessionKey: string | undefined) =>
        sessionStore?.loadSessionSnapshot(sessionKey);

      const enrichWithTranscript = (
        sessionKey: string | undefined,
        attrs: Record<string, string | number | boolean | undefined>,
      ) => {
        const snapshot = loadSessionSnapshot(sessionKey);
        if (!snapshot) {
          return attrs;
        }
        return {
          ...attrs,
          session_id: snapshot.sessionId,
          "openclaw.sessionId": attrs["openclaw.sessionId"] ?? snapshot.sessionId,
          "openclaw.session.file": snapshot.sessionFile,
          "openclaw.session.updatedAt": snapshot.updatedAt,
          "openclaw.session.chatType": snapshot.chatType,
          "openclaw.session.lastChannel": snapshot.lastChannel,
          "openclaw.session.origin.provider": snapshot.originProvider,
          "openclaw.session.origin.surface": snapshot.originSurface,
          "openclaw.session.cwd": snapshot.sessionCwd,
          "openclaw.input.preview": normalizeUserInputPreview(snapshot.lastUserText),
          "openclaw.output.preview": clipPreview(snapshot.lastAssistantText),
          "openclaw.reasoning.preview": normalizeReasoningPreview(snapshot.lastAssistantThinking),
          "openclaw.provider": attrs["openclaw.provider"] ?? snapshot.lastProvider,
          "openclaw.model": attrs["openclaw.model"] ?? snapshot.lastModel,
        };
      };

      const eventTimestamp = (evt: { ts?: number }): Date =>
        typeof evt.ts === "number" ? eventTime(evt.ts) : new Date();

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
        const key = sessionIdentity(evt);
        if (!key) {
          return undefined;
        }
        const current = activeRoots.get(key);
        if (current) {
          current.lastTouchedAt = Date.now();
          return current;
        }
        if (!createIfMissing) {
          return undefined;
        }
        const span = tracer.startSpan(
          "openclaw_request",
          {
            startTime: eventTimestamp(evt),
            kind: SpanKind.SERVER,
            attributes: stringAttrs(enrichWithTranscript(key, {
              "openclaw.sessionKey": evt.sessionKey,
              "openclaw.sessionId": evt.sessionId,
              "span.kind": "request",
            })),
          },
        );
        const root = {
          span,
          ctx: trace.setSpan(context.active(), span),
          startedAt: Date.now(),
          lastTouchedAt: Date.now(),
        };
        activeRoots.set(key, root);
        return root;
      };

      const getRun = (
        evt: { sessionKey?: string; sessionId?: string },
        createIfMissing = false,
      ) => {
        const key = sessionIdentity(evt);
        if (!key) {
          return undefined;
        }
        const current = activeRuns.get(key);
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
          "main",
          {
            startTime: eventTimestamp(evt),
            kind: SpanKind.INTERNAL,
            attributes: stringAttrs(enrichWithTranscript(key, {
              "openclaw.sessionKey": evt.sessionKey,
              "openclaw.sessionId": evt.sessionId,
              "span.kind": "agent",
            })),
          },
          userCtx ?? root.ctx,
        );
        const run = current ?? createRunState(userCtx ?? root.ctx, Date.now());
        run.span = span;
        run.ctx = trace.setSpan(userCtx ?? root.ctx, span);
        activeRuns.set(key, run);
        return run;
      };

      const ensureUserSpan = (
        evt: { sessionKey?: string; sessionId?: string; ts: number; channel?: string; source?: string; queueDepth?: number },
      ) => {
        const key = sessionIdentity(evt);
        if (!key) {
          return undefined;
        }
        const existing = activeRuns.get(key);
        if (existing?.userSpan) {
          return existing;
        }
        const root = getRoot(evt, true);
        if (!root) {
          return undefined;
        }
        const snapshot = loadSessionSnapshot(evt.sessionKey);
        const userSpan = tracer.startSpan(
          "user_message",
          {
            startTime: eventTime(evt.ts),
            kind: SpanKind.CONSUMER,
            attributes: stringAttrs({
              "openclaw.channel": evt.channel,
              "openclaw.source": evt.source,
              "openclaw.queueDepth": evt.queueDepth,
              "span.kind": "input",
              "openclaw.input.preview": normalizeUserInputPreview(snapshot?.lastUserText),
              "openclaw.input.length": snapshot?.lastUserText?.length,
            }),
          },
          root.ctx,
        );
        userSpan.setStatus({ code: SpanStatusCode.OK });
        const userCtx = trace.setSpan(root.ctx, userSpan);
        const run = existing ?? createRunState(userCtx, evt.ts);
        run.userSpan = userSpan;
        run.userCtx = userCtx;
        run.userStartTs = evt.ts;
        run.lastTouchedAt = Date.now();
        activeRuns.set(key, run as ActiveRunSpan);
        return activeRuns.get(key);
      };

      const endRoot = (evt: { sessionKey?: string; sessionId?: string }, attrs?: Record<string, string | number | boolean>) => {
        const key = sessionIdentity(evt);
        if (!key) {
          return;
        }
        const current = activeRoots.get(key);
        if (!current) {
          return;
        }
        const run = activeRuns.get(key);
        const summaryAttrs = normalizeTerminalSpanAttrs(attrs ?? {});
        const finalAttrs = stringAttrs({
          ...enrichWithTranscript(key, summaryAttrs),
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
        activeRoots.delete(key);
      };

      const syncRootFromRun = (evt: { sessionKey?: string; sessionId?: string }) => {
        const key = sessionIdentity(evt);
        if (!key) {
          return;
        }
        const run = activeRuns.get(key);
        const root = activeRoots.get(key);
        if (!run || !root) {
          return;
        }
        const snapshot = loadSessionSnapshot(key);
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
        const key = sessionIdentity(evt);
        if (!key) {
          return;
        }
        const current = activeRuns.get(key);
        if (!current) {
          return;
        }
        const snapshot = loadSessionSnapshot(key);
        const summaryAttrs = normalizeTerminalSpanAttrs(attrs ?? {});
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
          ...enrichWithTranscript(key, summaryAttrs),
          "openclaw.tokens.input":
            current.aggregate.inputTokens || snapshot?.lastAssistantUsage?.input || 0,
          "openclaw.tokens.output":
            current.aggregate.outputTokens || snapshot?.lastAssistantUsage?.output || 0,
          "openclaw.tokens.cache_read":
            current.aggregate.cacheReadTokens || snapshot?.lastAssistantUsage?.cacheRead || 0,
          "openclaw.tokens.cache_write":
            current.aggregate.cacheWriteTokens || snapshot?.lastAssistantUsage?.cacheWrite || 0,
          "openclaw.tokens.total":
            current.aggregate.totalTokens || snapshot?.lastAssistantUsage?.totalTokens || 0,
          "llm.input_tokens":
            current.aggregate.inputTokens || snapshot?.lastAssistantUsage?.input || 0,
          "llm.output_tokens":
            current.aggregate.outputTokens || snapshot?.lastAssistantUsage?.output || 0,
          "llm.total_tokens":
            current.aggregate.totalTokens || snapshot?.lastAssistantUsage?.totalTokens || 0,
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
        instruments.requestCounter.add(1, requestMetricAttrs);
        instruments.requestDuration.record(
          Math.max(0, eventTimestamp(evt).getTime() - current.startedAt),
          requestMetricAttrs,
        );
        finalizeRunSpans(current, eventTimestamp(evt));
      };

      const clearRun = (evt: { sessionKey?: string; sessionId?: string }) => {
        const key = sessionIdentity(evt);
        if (!key) {
          return;
        }
        activeRuns.delete(key);
      };

      const cleanupExpiredRoots = () => {
        const now = Date.now();
        for (const [key, current] of activeRoots.entries()) {
          if (now - current.lastTouchedAt < config.rootSpanTtlMs) {
            continue;
          }
          addEvent(current.span, "session.timeout", { "openclaw.root.ttl_ms": config.rootSpanTtlMs });
          endSpanSafely(current.span);
          activeRoots.delete(key);
        }
        for (const [key, current] of activeRuns.entries()) {
          if (now - current.lastTouchedAt < config.rootSpanTtlMs) {
            continue;
          }
          if (current.span) {
            addEvent(current.span, "run.timeout", { "openclaw.root.ttl_ms": config.rootSpanTtlMs });
          } else if (current.userSpan) {
            addEvent(current.userSpan, "run.timeout", { "openclaw.root.ttl_ms": config.rootSpanTtlMs });
          }
          finalizeRunSpans(current);
          activeRuns.delete(key);
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
            kind: name === "assistant_message"
              ? SpanKind.PRODUCER
              : name === "user_message"
                ? SpanKind.CONSUMER
                : name.includes("/")
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
      });
      const {
        annotateToolLoop,
        emitSyntheticModelSpan,
        ensureSkillSpan,
        ensureTranscriptSkillSpans,
        getActiveSkillCtx,
        handleAgentEvent,
      } = toolSpanManager;

      unsubscribeAgent = runtime?.events?.onAgentEvent?.(handleAgentEvent) ?? null;

      unsubscribeTranscript = runtime?.events?.onSessionTranscriptUpdate?.((update) => {
        sessionStore?.refreshSessionsIndex();
        sessionStore?.invalidateSessionFile(update.sessionFile);
      }) ?? null;

      const handleDiagnosticEvent = createDiagnosticEventHandler({
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
      });

      unsubscribeDiagnostic = onDiagnosticEvent(handleDiagnosticEvent);

      ctx.logger.info(
        `[otel-plugin] trace exporter enabled (${config.protocol}) -> ${resolveOtelUrl(config.endpoint, config.tracePath)}`,
      );
    },
    async stop() {
      unsubscribeDiagnostic?.();
      unsubscribeDiagnostic = null;
      unsubscribeAgent?.();
      unsubscribeAgent = null;
      unsubscribeTranscript?.();
      unsubscribeTranscript = null;
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
      sessionStore?.clear();
      sessionStore = null;
      await sdk?.shutdown();
      sdk = null;
    },
  };
}
