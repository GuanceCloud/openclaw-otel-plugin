import type { DiagnosticEventPayload } from "openclaw/plugin-sdk";
import type {
  ActiveRunSpan,
  ActiveSkillInvocationSpan,
  ActiveSkillSpan,
  ActiveToolSpan,
  MetricInstruments,
  SessionSnapshot,
} from "./service-types.js";
import {
  addEvent,
  buildGenAiAgentSkillMetricAttrs,
  buildGenAiClientModelMetricAttrs,
  buildGenAiClientToolMetricAttrs,
  buildSkillMetricAttrs,
  buildToolAttrs,
  buildToolMetricAttrs,
  clipPreview,
  clipValuePreview,
  collectToolSummaryValues,
  endSpanSafely,
  extractToolResultStatus,
  inferSkillNameFromTool,
  inferSkillNameFromToolIdentity,
  mergeToolIdentity,
  MIN_VISIBLE_CHILD_MS,
  MIN_VISIBLE_MODEL_MS,
  redactSensitiveText,
  setError,
  skillCallSpanName,
  skillSpanName,
  stringAttrs,
  traceAttrs,
} from "./service-utils.js";

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

type ToolSpanEndPayload = {
  result?: unknown;
  meta?: unknown;
  isError?: boolean;
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

type ToolSpanManagerDeps = {
  tracer: any;
  trace: any;
  SpanKind: any;
  SpanStatusCode: any;
  instruments: MetricInstruments;
  getRun(evt: SessionEvent, createIfMissing?: boolean): ActiveRunSpan | undefined;
  getRoot(evt: SessionEvent, createIfMissing?: boolean): { span: any } | undefined;
  ensureUserSpan(evt: UserSpanEvent): ActiveRunSpan | undefined;
  loadSessionSnapshot(sessionKey: string | undefined): SessionSnapshot | undefined;
  enrichWithTranscript(
    sessionKey: string | undefined,
    attrs: Record<string, string | number | boolean | undefined>,
  ): Record<string, string | number | boolean | undefined>;
  createChildSpan: ChildSpanFactory;
  eventTimestamp(evt: { ts?: number }): Date;
  setLatestAssistantText(sessionKey: string, text: string): void;
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
};

export type ToolSpanManager = ReturnType<typeof createToolSpanManager>;

export function createToolSpanManager(deps: ToolSpanManagerDeps) {
  const {
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
    setLatestAssistantText,
    emitRuntimeOrchestrationSpan,
    ensureRuntimeLifecycleSpans,
    emitModelTurnDebugLog,
  } = deps;

  const getActiveSkillCtx = (run: ActiveRunSpan | undefined) => {
    if (!run?.activeSkillName) {
      return undefined;
    }
    return run.skillSpans.get(run.activeSkillName)?.ctx;
  };

  const buildSessionSpanAttrs = (
    evt: SessionEvent & {
      channel?: string;
    },
  ) => {
    const snapshot = loadSessionSnapshot(evt.sessionKey);
    return {
      session_id: evt.sessionId ?? snapshot?.sessionId,
      session_key: evt.sessionKey ?? snapshot?.sessionKey,
      channel: evt.channel ?? snapshot?.lastChannel,
    };
  };

  const syncToolSummaryAttrs = (evt: SessionEvent, run: ActiveRunSpan) => {
    const attrs = traceAttrs({
      "openclaw.tools": Array.from(run.usedToolNames).join(", "),
      "openclaw.tool.count": run.usedToolNames.size,
      "openclaw.tool.targets": Array.from(run.usedToolTargets).join(" | "),
      "openclaw.tool.commands": Array.from(run.usedToolCommands).join(" | "),
      "openclaw.tool.result_statuses": Array.from(run.usedToolResultStatuses).join(", "),
      "openclaw.skills": Array.from(run.usedSkillNames).join(", "),
      "openclaw.skill.count": run.usedSkillNames.size,
    });
    run.span?.setAttributes(attrs);
    getRoot(evt, false)?.span.setAttributes(attrs);
  };

  const ensureSkillSpan = (
    evt: SessionEvent,
    skillName: string,
    source: "runtime" | "transcript",
  ) => {
    const run = getRun(evt, false);
    if (!run) {
      return undefined;
    }
    const normalizedSkillName = skillName.trim();
    if (!normalizedSkillName) {
      return undefined;
    }
    run.usedSkillNames.add(normalizedSkillName);
    const existing = run.skillSpans.get(normalizedSkillName);
    if (existing) {
      run.activeSkillName = normalizedSkillName;
      if (existing.source !== "runtime" && source === "runtime") {
        existing.source = "runtime";
      }
      existing.span.setAttributes(traceAttrs({
        ...buildSessionSpanAttrs(evt),
        "span.kind": "skill",
        "openclaw.skill.name": normalizedSkillName,
        "openclaw.skill.source": existing.source,
      }));
      return existing;
    }
    const baseStartTs =
      source === "transcript"
        ? run.mainStartTs + MIN_VISIBLE_CHILD_MS
        : typeof evt.ts === "number"
          ? evt.ts
          : Date.now();
    const startTs = Math.max(baseStartTs, run.mainStartTs + MIN_VISIBLE_CHILD_MS);
    const span = tracer.startSpan(
      skillSpanName(normalizedSkillName),
      {
        startTime: new Date(startTs),
        kind: SpanKind.INTERNAL,
        attributes: traceAttrs({
          ...buildSessionSpanAttrs(evt),
          "span.kind": "skill",
          "openclaw.skill.name": normalizedSkillName,
          "openclaw.skill.source": source,
        }),
      },
      run.ctx,
    );
    span.setStatus({ code: SpanStatusCode.OK });
    const skillState: ActiveSkillSpan = {
      name: normalizedSkillName,
      span,
      ctx: trace.setSpan(run.ctx, span),
      startedAt: startTs,
      source,
    };
    run.skillSpans.set(normalizedSkillName, skillState);
    run.activeSkillName = normalizedSkillName;
    instruments.skillActivationCounter.add(1, buildSkillMetricAttrs(normalizedSkillName, source));
    instruments.genAiAgentSkillActivationCount?.add(
      1,
      buildGenAiAgentSkillMetricAttrs(normalizedSkillName, source, evt.sessionId),
    );
    const attrs = traceAttrs({
      "openclaw.skills": Array.from(run.usedSkillNames).join(", "),
      "openclaw.skill.count": run.usedSkillNames.size,
    });
    run.span?.setAttributes(attrs);
    getRoot(evt, false)?.span.setAttributes(attrs);
    return skillState;
  };

  const ensureSkillInvocationSpan = (
    evt: SessionEvent,
    skillName: string,
    toolCallId: string,
    toolName?: string,
  ) => {
    const run = getRun(evt, false);
    if (!run) {
      return undefined;
    }
    const normalizedSkillName = skillName.trim();
    const normalizedToolCallId = toolCallId.trim();
    if (!normalizedSkillName || !normalizedToolCallId) {
      return undefined;
    }
    const existing = run.skillInvocationSpans.get(normalizedToolCallId);
    if (existing) {
      if (toolName?.trim()) {
        existing.toolName = toolName.trim();
      }
      existing.span.setAttributes(traceAttrs({
        ...buildSessionSpanAttrs(evt),
        "span.kind": "skill",
        "openclaw.skill.name": normalizedSkillName,
        "openclaw.skill.kind": "call",
        "openclaw.skill.source": existing.source,
        "openclaw.skill.call_id": normalizedToolCallId,
        "openclaw.tool.call_id": normalizedToolCallId,
        "openclaw.tool.name": existing.toolName,
      }));
      return existing;
    }
    const summaryCtx = run.skillSpans.get(normalizedSkillName)?.ctx ?? getActiveSkillCtx(run) ?? run.ctx;
    const startTs = typeof evt.ts === "number"
      ? Math.max(evt.ts, run.mainStartTs + MIN_VISIBLE_CHILD_MS)
      : Date.now();
    const span = tracer.startSpan(
      skillCallSpanName(normalizedSkillName),
      {
        startTime: new Date(startTs),
        kind: SpanKind.INTERNAL,
        attributes: traceAttrs({
          ...buildSessionSpanAttrs(evt),
          "span.kind": "skill",
          "openclaw.skill.name": normalizedSkillName,
          "openclaw.skill.kind": "call",
          "openclaw.skill.source": "runtime",
          "openclaw.skill.call_id": normalizedToolCallId,
          "openclaw.tool.call_id": normalizedToolCallId,
          "openclaw.tool.name": toolName,
        }),
      },
      summaryCtx,
    );
    const skillInvocation: ActiveSkillInvocationSpan = {
      callId: normalizedToolCallId,
      name: normalizedSkillName,
      span,
      ctx: trace.setSpan(summaryCtx, span),
      startedAt: startTs,
      source: "runtime",
      toolName: toolName?.trim() || undefined,
    };
    run.skillInvocationSpans.set(normalizedToolCallId, skillInvocation);
    return skillInvocation;
  };

  const endSkillInvocationSpan = (
    evt: SessionEvent,
    toolCallId: string,
    endTime?: Date,
    isError = false,
  ) => {
    const run = getRun(evt, false);
    if (!run) {
      return;
    }
    const normalizedToolCallId = toolCallId.trim();
    if (!normalizedToolCallId) {
      return;
    }
    const invocation = run.skillInvocationSpans.get(normalizedToolCallId);
    if (!invocation) {
      return;
    }
    invocation.span.setAttributes(traceAttrs({
      ...buildSessionSpanAttrs(evt),
      "span.kind": "skill",
      "openclaw.skill.name": invocation.name,
      "openclaw.skill.kind": "call",
      "openclaw.skill.source": invocation.source,
      "openclaw.skill.call_id": invocation.callId,
      "openclaw.tool.call_id": invocation.callId,
      "openclaw.tool.name": invocation.toolName,
    }));
    if (isError) {
      setError(invocation.span, SpanStatusCode.ERROR, "skill call error");
    } else {
      invocation.span.setStatus({ code: SpanStatusCode.OK });
    }
    endSpanSafely(invocation.span, endTime);
    run.skillInvocationSpans.delete(normalizedToolCallId);
  };

  const ensureTranscriptSkillSpans = (evt: SessionEvent) => {
    const snapshot = loadSessionSnapshot(evt.sessionKey);
    for (const skillName of snapshot?.invokedSkillNames ?? []) {
      ensureSkillSpan(evt, skillName, "transcript");
    }
  };

  const resolveSkillName = (
    evt: SessionEvent,
    toolName: string | undefined,
    toolCallId: string | undefined,
    target?: string,
    command?: string,
  ) => {
    const transcriptSkillName = toolCallId
      ? loadSessionSnapshot(evt.sessionKey)?.toolCallSkillNamesById?.[toolCallId]
      : undefined;
    return transcriptSkillName ?? inferSkillNameFromToolIdentity(toolName, target, command);
  };

  const ensureToolSpan = (
    evt: SessionEvent,
    toolName: string,
    toolCallId: string,
    attrs?: Record<string, string | number | boolean | undefined>,
  ) => {
    const run = getRun(evt, false) ?? ensureUserSpan({
      sessionKey: evt.sessionKey,
      sessionId: evt.sessionId,
      ts: evt.ts ?? Date.now(),
    });
    if (!run) {
      return undefined;
    }
    const normalizedToolName = toolName.trim();
    const normalizedToolCallId = toolCallId.trim();
    if (!normalizedToolName || !normalizedToolCallId) {
      return undefined;
    }
    run.usedToolNames.add(normalizedToolName);
    const summary = collectToolSummaryValues(normalizedToolName);
    if (summary.target) run.usedToolTargets.add(summary.target);
    if (summary.command) run.usedToolCommands.add(summary.command);
    if (summary.resultStatus) run.usedToolResultStatuses.add(summary.resultStatus);
    const skillName = resolveSkillName(
      evt,
      normalizedToolName,
      normalizedToolCallId,
      attrs?.["openclaw.tool.target"] as string | undefined,
      attrs?.["openclaw.tool.command"] as string | undefined,
    );
    if (skillName) {
      ensureSkillSpan(evt, skillName, "runtime");
      ensureSkillInvocationSpan(evt, skillName, normalizedToolCallId, normalizedToolName);
    }
    const existing = run.toolSpans.get(normalizedToolCallId);
    if (existing) {
      const merged = mergeToolIdentity(existing);
      existing.span.setAttributes(traceAttrs({
        ...buildSessionSpanAttrs(evt),
        ...buildToolAttrs(normalizedToolName, normalizedToolCallId, {
          skillName: existing.skillName,
        }),
        "openclaw.tool.arg_keys": merged.argKeys,
        "openclaw.tool.target": merged.target,
        "openclaw.tool.command": merged.command,
        ...attrs,
      }));
      syncToolSummaryAttrs(evt, run);
      return existing;
    }
    const merged = {
      argKeys: typeof attrs?.["openclaw.tool.arg_keys"] === "string"
        ? attrs["openclaw.tool.arg_keys"]
        : undefined,
      target: typeof attrs?.["openclaw.tool.target"] === "string"
        ? attrs["openclaw.tool.target"]
        : undefined,
      command: typeof attrs?.["openclaw.tool.command"] === "string"
        ? attrs["openclaw.tool.command"]
        : undefined,
    };
    const invocation = skillName
      ? run.skillInvocationSpans.get(normalizedToolCallId)
      : undefined;
    const parentCtx = invocation?.ctx
      ?? (skillName
        ? run.skillSpans.get(skillName)?.ctx ?? getActiveSkillCtx(run) ?? run.ctx
        : getActiveSkillCtx(run) ?? run.ctx);
    const startTs = typeof evt.ts === "number"
      ? Math.max(evt.ts, run.mainStartTs + MIN_VISIBLE_CHILD_MS)
      : Date.now();
    const span = tracer.startSpan(
      `tool:${normalizedToolName}`,
      {
        startTime: new Date(startTs),
        kind: SpanKind.CLIENT,
        attributes: traceAttrs({
          ...buildSessionSpanAttrs(evt),
          ...buildToolAttrs(normalizedToolName, normalizedToolCallId, {
            skillName,
          }),
          ...attrs,
        }),
      },
      parentCtx,
    );
    const toolState: ActiveToolSpan = {
      toolCallId: normalizedToolCallId,
      name: normalizedToolName,
      span,
      ctx: trace.setSpan(parentCtx, span),
      startedAt: startTs,
      skillName,
      argKeys: merged.argKeys,
      target: merged.target,
      command: merged.command,
    };
    run.toolSpans.set(normalizedToolCallId, toolState);
    syncToolSummaryAttrs(evt, run);
    return toolState;
  };

  const updateToolSpan = (
    evt: SessionEvent,
    toolName: string,
    toolCallId: string,
    partialResult: unknown,
  ) => {
    const tool = ensureToolSpan(evt, toolName, toolCallId);
    if (!tool) {
      return;
    }
    const preview = clipValuePreview(partialResult);
    const merged = mergeToolIdentity(tool, { partialResult });
    tool.argKeys = merged.argKeys;
    tool.target = merged.target;
    tool.command = merged.command;
    if (merged.resultStatus) {
      const run = getRun(evt, false);
      if (run) {
        run.usedToolResultStatuses.add(merged.resultStatus);
        syncToolSummaryAttrs(evt, run);
      }
    }
    if (preview) {
      tool.span.setAttributes(traceAttrs({
        ...buildSessionSpanAttrs(evt),
        ...buildToolAttrs(tool.name, tool.toolCallId, {
          skillName: tool.skillName,
          partialResult,
        }),
        "openclaw.tool.arg_keys": tool.argKeys,
        "openclaw.tool.target": tool.target,
        "openclaw.tool.command": tool.command,
      }));
      addEvent(tool.span, "tool.update", {
        event_tool_name: tool.name,
        event_tool_call_id: tool.toolCallId,
        event_tool_partial_result_preview: preview,
      });
      return;
    }
    addEvent(tool.span, "tool.update", {
      event_tool_name: tool.name,
      event_tool_call_id: tool.toolCallId,
    });
  };

  const findActiveToolSpanByName = (evt: SessionEvent, toolName: string) => {
    const run = getRun(evt, false);
    if (!run) {
      return undefined;
    }
    const normalizedToolName = toolName.trim();
    if (!normalizedToolName) {
      return undefined;
    }
    const matches = Array.from(run.toolSpans.values())
      .filter((tool) => tool.name === normalizedToolName)
      .sort((a, b) => b.startedAt - a.startedAt);
    return matches[0];
  };

  const endToolSpan = (
    evt: SessionEvent,
    toolName: string,
    toolCallId: string,
    payload?: ToolSpanEndPayload,
  ) => {
    const tool = ensureToolSpan(evt, toolName, toolCallId, {
      "openclaw.tool.args.preview": undefined,
    });
    const run = getRun(evt, false);
    if (!tool || !run) {
      return;
    }
    const resultPreview = clipValuePreview(payload?.result);
    const isError = payload?.isError === true;
    const merged = mergeToolIdentity(tool, {
      meta: payload?.meta,
      result: payload?.result,
    });
    tool.argKeys = merged.argKeys;
    tool.target = merged.target;
    tool.command = merged.command;
    if (merged.target) run.usedToolTargets.add(merged.target);
    if (merged.command) run.usedToolCommands.add(merged.command);
    if (merged.resultStatus) run.usedToolResultStatuses.add(merged.resultStatus);
    syncToolSummaryAttrs(evt, run);
    tool.hasError = isError;
    tool.span.setAttributes(traceAttrs({
      ...buildSessionSpanAttrs(evt),
      ...buildToolAttrs(tool.name, tool.toolCallId, {
        skillName: tool.skillName,
        meta: payload?.meta,
        result: payload?.result,
        outcome: isError ? "error" : "completed",
      }),
      "openclaw.tool.arg_keys": tool.argKeys,
      "openclaw.tool.target": tool.target,
      "openclaw.tool.command": tool.command,
    }));
    addEvent(tool.span, "tool.result", traceAttrs({
      event_tool_name: tool.name,
      event_tool_call_id: tool.toolCallId,
      event_tool_outcome: isError ? "error" : "completed",
      event_tool_result_preview: resultPreview,
      event_tool_result_status: extractToolResultStatus(payload?.result),
    }));
    const toolMetricAttrs = buildToolMetricAttrs(
      tool,
      isError ? "error" : "completed",
      merged.resultStatus,
    );
    const genAiToolMetricAttrs = buildGenAiClientToolMetricAttrs(
      tool,
      isError ? "error" : "completed",
      merged.resultStatus,
      evt.sessionId,
    );
    instruments.toolCallCounter.add(1, toolMetricAttrs);
    instruments.toolDuration.record(
      Math.max(0, eventTimestamp(evt).getTime() - tool.startedAt),
      toolMetricAttrs,
    );
    instruments.genAiClientOperationDuration?.record(
      Math.max(0, eventTimestamp(evt).getTime() - tool.startedAt),
      genAiToolMetricAttrs,
    );
    if (isError) {
      instruments.toolErrorCounter.add(1, toolMetricAttrs);
      setError(tool.span, SpanStatusCode.ERROR, resultPreview ?? "tool error");
    } else {
      tool.span.setStatus({ code: SpanStatusCode.OK });
    }
    const endTs = typeof evt.ts === "number"
      ? new Date(Math.max(evt.ts, tool.startedAt + MIN_VISIBLE_CHILD_MS))
      : undefined;
    endSpanSafely(tool.span, endTs);
    run.orchestrationCursorTs = endTs?.getTime() ?? evt.ts ?? run.orchestrationCursorTs;
    if (tool.skillName) {
      endSkillInvocationSpan(evt, tool.toolCallId, endTs, isError);
    }
    run.toolSpans.delete(tool.toolCallId);
  };

  const annotateToolLoop = (
    evt: Extract<DiagnosticEventPayload, { type: "tool.loop" }>,
  ) => {
    const tool = findActiveToolSpanByName(evt, evt.toolName);
    if (!tool) {
      return false;
    }
    const loopAttrs = traceAttrs({
      "openclaw.tool.name": evt.toolName,
      "openclaw.tool.call_id": tool.toolCallId,
      "openclaw.tool.loop.level": evt.level,
      "openclaw.tool.loop.action": evt.action,
      "openclaw.tool.loop.detector": evt.detector,
      "openclaw.tool.loop.count": evt.count,
      "openclaw.tool.loop.paired_tool": evt.pairedToolName,
      "openclaw.tool.loop.message": evt.message ? redactSensitiveText(evt.message) : undefined,
    });
    tool.span.setAttributes(loopAttrs);
    addEvent(tool.span, "tool.loop", {
      event_tool_name: evt.toolName,
      event_tool_call_id: tool.toolCallId,
      event_tool_loop_level: evt.level,
      event_tool_loop_action: evt.action,
      event_tool_loop_detector: evt.detector,
      event_tool_loop_count: evt.count,
      event_tool_loop_paired_tool: evt.pairedToolName,
      event_tool_loop_message: evt.message ? redactSensitiveText(evt.message) : undefined,
    });
    if (evt.level === "critical") {
      tool.hasError = true;
      setError(tool.span, SpanStatusCode.ERROR, evt.message ?? "tool loop detected");
    }
    return true;
  };

  const firstToolStartedAt = (snapshot: SessionSnapshot | undefined): number | undefined => {
    const values = (snapshot?.lastRunToolCalls ?? [])
      .map((toolCall) => toolCall.startedAt)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      .sort((a, b) => a - b);
    return values[0];
  };

  const resolveReplayRunStartTs = (
    snapshot: SessionSnapshot | undefined,
    fallbackTs: number,
  ): number => {
    const candidates = [
      snapshot?.lastUserTs,
      firstToolStartedAt(snapshot),
      snapshot?.lastAssistantTs,
      fallbackTs,
    ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return candidates.length > 0 ? Math.min(...candidates) : fallbackTs;
  };

  const resolveSyntheticModelEndTs = (
    snapshot: SessionSnapshot | undefined,
    fallbackTs: number,
  ): number => firstToolStartedAt(snapshot) ?? snapshot?.lastAssistantTs ?? fallbackTs;

  const emitTranscriptModelSpans = (evt: SessionEvent) => {
    const snapshot = loadSessionSnapshot(evt.sessionKey);
    const turns = (snapshot?.lastRunAssistantTurns ?? [])
      .filter((turn) => typeof turn.endedAt === "number" && Number.isFinite(turn.endedAt))
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    if (turns.length === 0) {
      return false;
    }
    const replayEndTs = typeof evt.ts === "number" ? evt.ts : Date.now();
    const replayStartTs = resolveReplayRunStartTs(snapshot, replayEndTs);
    const run = getRun({
      sessionKey: evt.sessionKey,
      sessionId: evt.sessionId,
      ts: replayStartTs,
    }, true);
    if (!run) {
      return false;
    }
    const emittedTurns = run.transcriptAssistantTurnsEmitted ?? 0;
    if (emittedTurns >= turns.length) {
      return emittedTurns > 0 || run.modelSpanEmitted === true;
    }
    const pendingTurns = turns.slice(emittedTurns);
    ensureRuntimeLifecycleSpans(
      {
        sessionKey: evt.sessionKey,
        sessionId: evt.sessionId,
        ts: replayStartTs,
        channel: snapshot?.lastChannel,
      },
      {
        createIfMissing: true,
        startTsHint: replayStartTs,
        processingStartTs: replayStartTs,
        nextActionTs: pendingTurns[0]?.startedAt,
        snapshot,
      },
    );

    for (const [offset, turn] of pendingTurns.entries()) {
      const index = emittedTurns + offset;
      if (offset === 0 && typeof run.orchestrationCursorTs === "number") {
        emitRuntimeOrchestrationSpan(
          evt,
          run.orchestrationCursorTs,
          turn.startedAt,
          "pre_model",
          {
            "openclaw.provider": turn.provider ?? snapshot?.lastProvider,
            "openclaw.model": turn.model ?? snapshot?.lastModel,
          },
          run.ctx,
        );
      }
      const rawStartTs = typeof turn.startedAt === "number" ? turn.startedAt : replayStartTs;
      const rawEndTs = typeof turn.endedAt === "number" ? turn.endedAt : rawStartTs + 1;
      const startTs = Math.max(rawStartTs, run.mainStartTs);
      const endTs = Math.max(rawEndTs, startTs + 1);
      const span = tracer.startSpan(
        "model_request",
        {
          startTime: new Date(startTs),
          kind: SpanKind.CLIENT,
          attributes: traceAttrs(enrichWithTranscript(evt.sessionKey, {
            __suppress_session_output_preview: true,
            __suppress_session_output_summary: true,
            session_update_time: endTs,
            "span.kind": "model",
            "openclaw.input.preview": turn.inputPreview,
            "openclaw.output.preview": turn.outputPreview,
            "openclaw.output.kind": turn.outputKind,
            output_summary: clipPreview(turn.thinking?.trim()),
            output_text_length: turn.thinking?.length,
            "openclaw.provider": turn.provider ?? snapshot?.lastProvider,
            "openclaw.model": turn.model ?? snapshot?.lastModel,
            "llm.provider": turn.provider ?? snapshot?.lastProvider,
            "llm.model": turn.model ?? snapshot?.lastModel,
          })),
        },
        run.ctx,
      );
      span.setStatus({ code: SpanStatusCode.OK });
      endSpanSafely(span, new Date(endTs));
      instruments.genAiClientOperationDuration?.record(
        Math.max(endTs - startTs, 1),
        buildGenAiClientModelMetricAttrs(
          turn.provider ?? snapshot?.lastProvider,
          turn.model ?? snapshot?.lastModel,
          {
            session_id: snapshot?.sessionId ?? evt.sessionId,
          },
        ),
      );
      run.modelCtx = trace.setSpan(run.ctx, span);
      run.modelStartTs = startTs;
      run.modelEndTs = endTs;
      run.orchestrationCursorTs = endTs;
      emitModelTurnDebugLog({
        source: "transcript",
        trace_id: typeof span.spanContext === "function" ? span.spanContext().traceId : undefined,
        span_id: typeof span.spanContext === "function" ? span.spanContext().spanId : undefined,
        session_key: evt.sessionKey,
        session_id: evt.sessionId,
        turn_index: index + 1,
        provider: turn.provider ?? snapshot?.lastProvider,
        model: turn.model ?? snapshot?.lastModel,
        start_ts: startTs,
        end_ts: endTs,
        duration_ms: Math.max(endTs - startTs, 1),
        input_preview: turn.inputPreview,
        output_preview: turn.outputPreview,
        output_kind: turn.outputKind,
        thinking_summary: clipPreview(turn.thinking?.trim()),
      });
    }

    run.transcriptAssistantTurnsEmitted = turns.length;
    run.modelSpanEmitted = true;
    return true;
  };

  const emitSyntheticModelSpan = (evt: SessionEvent) => {
    const snapshot = loadSessionSnapshot(evt.sessionKey);
    const endTs = typeof evt.ts === "number" ? evt.ts : Date.now();
    const replayStartTs = resolveReplayRunStartTs(snapshot, endTs);
    const run = getRun({
      sessionKey: evt.sessionKey,
      sessionId: evt.sessionId,
      ts: replayStartTs,
    }, true);
    if (!run || run.modelSpanEmitted || (!snapshot?.lastProvider && !snapshot?.lastModel)) {
      return;
    }
    const modelEndTs = resolveSyntheticModelEndTs(snapshot, endTs);
    ensureRuntimeLifecycleSpans(
      {
        sessionKey: evt.sessionKey,
        sessionId: evt.sessionId,
        ts: replayStartTs,
        channel: snapshot?.lastChannel,
      },
      {
        createIfMissing: true,
        startTsHint: replayStartTs,
        processingStartTs: replayStartTs,
        nextActionTs: modelEndTs,
        snapshot,
      },
    );
    if (run.usedSkillNames.size === 0) {
      ensureTranscriptSkillSpans(evt);
    }
    const totalDuration = Math.max(
      typeof evt.durationMs === "number" ? evt.durationMs : 0,
      modelEndTs - replayStartTs,
      MIN_VISIBLE_MODEL_MS,
    );
    const minStartTs = Math.min(run.mainStartTs + MIN_VISIBLE_CHILD_MS * 2, modelEndTs - 1);
    const startTs = Math.max(modelEndTs - totalDuration, minStartTs);
    const lastTurn = snapshot.lastRunAssistantTurns?.at(-1);
    emitRuntimeOrchestrationSpan(
      evt,
      run.mainStartTs,
      startTs,
      "pre_model",
      {
        "openclaw.provider": snapshot.lastProvider,
        "openclaw.model": snapshot.lastModel,
      },
      run.ctx,
    );
    const span = tracer.startSpan(
      "model_request",
      {
        startTime: new Date(startTs),
        kind: SpanKind.CLIENT,
        attributes: traceAttrs(enrichWithTranscript(evt.sessionKey, {
          __suppress_session_output_preview: true,
          __suppress_session_output_summary: true,
          session_update_time: modelEndTs,
          "span.kind": "model",
          "openclaw.input.preview": lastTurn?.inputPreview ?? snapshot.lastUserText,
          "openclaw.output.preview": lastTurn?.outputPreview ?? clipPreview(snapshot.lastAssistantText),
          "openclaw.output.kind": lastTurn?.outputKind ?? (snapshot.lastAssistantText ? "text" : undefined),
          output_summary: clipPreview(snapshot.lastAssistantThinking?.trim()),
          output_text_length: snapshot.lastAssistantThinking?.length,
          "openclaw.provider": snapshot.lastProvider,
          "openclaw.model": snapshot.lastModel,
          "llm.provider": snapshot.lastProvider,
          "llm.model": snapshot.lastModel,
          "llm.input_tokens": snapshot.lastAssistantUsage?.input,
          "llm.output_tokens": snapshot.lastAssistantUsage?.output,
          "llm.total_tokens": snapshot.lastAssistantUsage?.totalTokens,
          "openclaw.tokens.input": snapshot.lastAssistantUsage?.input,
          "openclaw.tokens.output": snapshot.lastAssistantUsage?.output,
          "openclaw.tokens.total": snapshot.lastAssistantUsage?.totalTokens,
        })),
      },
      getActiveSkillCtx(run) ?? run.ctx,
    );
    span.setStatus({ code: SpanStatusCode.OK });
    instruments.genAiClientOperationDuration?.record(
      Math.max(modelEndTs - startTs, 1),
      buildGenAiClientModelMetricAttrs(snapshot.lastProvider, snapshot.lastModel, {
        session_id: snapshot.sessionId ?? evt.sessionId,
      }),
    );
    run.modelSpan = span;
    run.modelCtx = trace.setSpan(getActiveSkillCtx(run) ?? run.ctx, span);
    run.modelStartTs = startTs;
    run.modelEndTs = modelEndTs;
    run.modelSpanEmitted = true;
    run.orchestrationCursorTs = modelEndTs;
    emitModelTurnDebugLog({
      source: "synthetic",
      trace_id: typeof span.spanContext === "function" ? span.spanContext().traceId : undefined,
      span_id: typeof span.spanContext === "function" ? span.spanContext().spanId : undefined,
      session_key: evt.sessionKey,
      session_id: evt.sessionId,
      turn_index: lastTurn ? snapshot.lastRunAssistantTurns?.length : undefined,
      provider: snapshot.lastProvider,
      model: snapshot.lastModel,
      start_ts: startTs,
      end_ts: modelEndTs,
      duration_ms: Math.max(modelEndTs - startTs, 1),
      input_preview: lastTurn?.inputPreview ?? snapshot.lastUserText,
      output_preview: lastTurn?.outputPreview ?? clipPreview(snapshot.lastAssistantText),
      output_kind: lastTurn?.outputKind ?? (snapshot.lastAssistantText ? "text" : undefined),
      thinking_summary: clipPreview(snapshot.lastAssistantThinking?.trim()),
    });
  };

  const emitTranscriptToolSpans = (evt: SessionEvent) => {
    const sessionKey = evt.sessionKey;
    if (!sessionKey) {
      return;
    }
    const snapshot = loadSessionSnapshot(sessionKey);
    const replayStartTs = resolveReplayRunStartTs(snapshot, evt.ts ?? Date.now());
    const run = getRun({
      sessionKey,
      sessionId: evt.sessionId,
      ts: replayStartTs,
    }, true);
    if (!run) {
      return;
    }
    const emittedToolCallIds = run.transcriptToolCallIds ?? new Set<string>();
    run.transcriptToolCallIds = emittedToolCallIds;
    for (const toolCall of snapshot?.lastRunToolCalls ?? []) {
      if (emittedToolCallIds.has(toolCall.callId)) {
        continue;
      }
      handleAgentEvent({
        sessionKey,
        ts: toolCall.startedAt ?? evt.ts ?? Date.now(),
        stream: "tool",
        data: {
          name: toolCall.name,
          toolCallId: toolCall.callId,
          phase: "start",
          args: toolCall.args,
        },
      });
      if (toolCall.result === undefined && toolCall.isError !== true) {
        continue;
      }
      handleAgentEvent({
        sessionKey,
        ts: toolCall.endedAt ?? toolCall.startedAt ?? evt.ts ?? Date.now(),
        stream: "tool",
        data: {
          name: toolCall.name,
          toolCallId: toolCall.callId,
          phase: "result",
          result: toolCall.result,
          meta: toolCall.meta,
          isError: toolCall.isError === true,
        },
      });
      emittedToolCallIds.add(toolCall.callId);
    }
  };

  const handleAgentEvent = (evt: any) => {
    const sessionKey = typeof evt?.sessionKey === "string" ? evt.sessionKey : undefined;
    const sessionId = typeof evt?.sessionId === "string" ? evt.sessionId : undefined;
    const channel = typeof evt?.channel === "string" ? evt.channel : undefined;
    if (!sessionKey) {
      return;
    }
    if (evt.stream === "assistant" && evt.data && typeof evt.data === "object") {
      const text = typeof evt.data.text === "string" ? evt.data.text : undefined;
      if (text?.trim()) {
        setLatestAssistantText(sessionKey, text);
        const run = getRun({ sessionKey }, false);
        const root = getRoot({ sessionKey }, false);
        const attrs = traceAttrs({
          "openclaw.output.preview": clipPreview(text),
        });
        run?.span.setAttributes(attrs);
        root?.span.setAttributes(attrs);
      }
    }
    if (evt.stream !== "tool" || !evt.data || typeof evt.data !== "object") {
      return;
    }
    const toolName = typeof evt.data.name === "string" ? evt.data.name : undefined;
    const run = getRun({ sessionKey }, false) ?? ensureUserSpan({ sessionKey, ts: evt.ts ?? Date.now() });
    if (!run || !toolName) {
      return;
    }
    run.usedToolNames.add(toolName);
    const summary = collectToolSummaryValues(toolName, {
      args: evt.data.args,
      meta: evt.data.meta,
      result: evt.data.result,
      partialResult: evt.data.partialResult,
    });
    const toolCallId = typeof evt.data.toolCallId === "string" ? evt.data.toolCallId : undefined;
    const skillName = resolveSkillName(
      { sessionKey, sessionId, ts: evt.ts ?? Date.now() },
      toolName,
      toolCallId,
      summary.target,
      summary.command,
    );
    if (summary.target) run.usedToolTargets.add(summary.target);
    if (summary.command) run.usedToolCommands.add(summary.command);
    if (summary.resultStatus) run.usedToolResultStatuses.add(summary.resultStatus);
    if (skillName) {
      ensureSkillSpan({ sessionKey, sessionId, channel, ts: evt.ts ?? Date.now() }, skillName, "runtime");
      if (toolCallId) {
        ensureSkillInvocationSpan(
          { sessionKey, sessionId, channel, ts: evt.ts ?? Date.now() },
          skillName,
          toolCallId,
          toolName,
        );
      }
    }
    syncToolSummaryAttrs({ sessionKey }, run);
    if (skillName) {
      run.skillSpans.get(skillName)?.span.setAttributes(traceAttrs({
        ...buildSessionSpanAttrs({ sessionKey, sessionId, channel }),
        "span.kind": "skill",
        "openclaw.skill.name": skillName,
        "openclaw.skill.source": "runtime",
        "openclaw.tools": Array.from(run.usedToolNames).join(", "),
        "openclaw.tool.count": run.usedToolNames.size,
      }));
    }
    if (!toolCallId) {
      return;
    }
    const toolEvt = { sessionKey, sessionId, channel, ts: evt.ts ?? Date.now() };
    if (evt.data.phase === "start") {
      ensureToolSpan(toolEvt, toolName, toolCallId, {
        ...buildToolAttrs(toolName, toolCallId, {
          args: evt.data.args,
          phase: "start",
          skillName,
        }),
      });
      return;
    }
    if (evt.data.phase === "update") {
      updateToolSpan(toolEvt, toolName, toolCallId, evt.data.partialResult);
      return;
    }
    if (evt.data.phase === "result") {
      endToolSpan(toolEvt, toolName, toolCallId, {
        result: evt.data.result,
        meta: evt.data.meta,
        isError: evt.data.isError === true,
      });
      return;
    }
    ensureToolSpan(toolEvt, toolName, toolCallId, {
      ...buildToolAttrs(toolName, toolCallId, {
        phase: String(evt.data.phase ?? "unknown"),
        skillName,
      }),
    });
  };

  const finalizeToolAndSkillSpans = (current: ActiveRunSpan, endTime?: Date) => {
    for (const tool of current.toolSpans.values()) {
      tool.span.setAttributes(traceAttrs({
        ...buildToolAttrs(tool.name, tool.toolCallId, {
          skillName: tool.skillName,
          outcome: tool.hasError ? "error" : "completed",
        }),
        "openclaw.tool.arg_keys": tool.argKeys,
        "openclaw.tool.target": tool.target,
        "openclaw.tool.command": tool.command,
      }));
      if (tool.hasError) {
        tool.span.setStatus({ code: SpanStatusCode.ERROR, message: "tool error" });
      } else {
        tool.span.setStatus({ code: SpanStatusCode.OK });
      }
      endSpanSafely(tool.span, endTime);
    }
    current.toolSpans.clear();
    for (const invocation of current.skillInvocationSpans.values()) {
      invocation.span.setAttributes(traceAttrs({
        "span.kind": "skill",
        "openclaw.skill.name": invocation.name,
        "openclaw.skill.kind": "call",
        "openclaw.skill.source": invocation.source,
        "openclaw.skill.call_id": invocation.callId,
        "openclaw.tool.call_id": invocation.callId,
        "openclaw.tool.name": invocation.toolName,
      }));
      invocation.span.setStatus({ code: SpanStatusCode.OK });
      endSpanSafely(invocation.span, endTime);
    }
    current.skillInvocationSpans.clear();
    for (const skill of current.skillSpans.values()) {
      skill.span.setAttributes(traceAttrs({
        "span.kind": "skill",
        "openclaw.skill.name": skill.name,
        "openclaw.skill.source": skill.source,
      }));
      skill.span.setStatus({ code: SpanStatusCode.OK });
      endSpanSafely(skill.span, endTime);
    }
    current.skillSpans.clear();
    current.activeSkillName = undefined;
  };

  return {
    annotateToolLoop,
    emitTranscriptModelSpans,
    emitSyntheticModelSpan,
    emitTranscriptToolSpans,
    endToolSpan,
    ensureSkillSpan,
    ensureToolSpan,
    ensureTranscriptSkillSpans,
    finalizeToolAndSkillSpans,
    getActiveSkillCtx,
    handleAgentEvent,
    updateToolSpan,
  };
}
