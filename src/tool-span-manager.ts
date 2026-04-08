import type { DiagnosticEventPayload } from "openclaw/plugin-sdk";
import type {
  ActiveRunSpan,
  ActiveSkillSpan,
  ActiveToolSpan,
  MetricInstruments,
  SessionSnapshot,
} from "./service-types.js";
import {
  addEvent,
  buildSkillMetricAttrs,
  buildToolAttrs,
  buildToolMetricAttrs,
  clipPreview,
  clipValuePreview,
  collectToolSummaryValues,
  endSpanSafely,
  endTimeFromStart,
  eventTime,
  extractToolResultStatus,
  inferSkillNameFromTool,
  mergeToolIdentity,
  MIN_VISIBLE_CHILD_MS,
  MIN_VISIBLE_MODEL_MS,
  redactSensitiveText,
  setError,
  skillSpanName,
  stringAttrs,
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
  } = deps;

  const getActiveSkillCtx = (run: ActiveRunSpan | undefined) => {
    if (!run?.activeSkillName) {
      return undefined;
    }
    return run.skillSpans.get(run.activeSkillName)?.ctx;
  };

  const syncToolSummaryAttrs = (evt: SessionEvent, run: ActiveRunSpan) => {
    const attrs = stringAttrs({
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
      existing.span.setAttributes(stringAttrs({
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
        attributes: stringAttrs({
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
    const attrs = stringAttrs({
      "openclaw.skills": Array.from(run.usedSkillNames).join(", "),
      "openclaw.skill.count": run.usedSkillNames.size,
    });
    run.span?.setAttributes(attrs);
    getRoot(evt, false)?.span.setAttributes(attrs);
    return skillState;
  };

  const ensureTranscriptSkillSpans = (evt: SessionEvent) => {
    const snapshot = loadSessionSnapshot(evt.sessionKey);
    for (const skillName of snapshot?.mentionedSkillNames ?? []) {
      ensureSkillSpan(evt, skillName, "transcript");
    }
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
    const skillName = inferSkillNameFromTool(normalizedToolName);
    if (skillName) {
      ensureSkillSpan(evt, skillName, "runtime");
    }
    const existing = run.toolSpans.get(normalizedToolCallId);
    if (existing) {
      const merged = mergeToolIdentity(existing);
      existing.span.setAttributes(stringAttrs({
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
    const parentCtx = skillName
      ? run.skillSpans.get(skillName)?.ctx ?? getActiveSkillCtx(run) ?? run.ctx
      : getActiveSkillCtx(run) ?? run.ctx;
    const startTs = typeof evt.ts === "number"
      ? Math.max(evt.ts, run.mainStartTs + MIN_VISIBLE_CHILD_MS)
      : Date.now();
    const span = tracer.startSpan(
      `tool:${normalizedToolName}`,
      {
        startTime: new Date(startTs),
        kind: SpanKind.CLIENT,
        attributes: stringAttrs({
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
      tool.span.setAttributes(stringAttrs({
        ...buildToolAttrs(tool.name, tool.toolCallId, {
          skillName: tool.skillName,
          partialResult,
        }),
        "openclaw.tool.arg_keys": tool.argKeys,
        "openclaw.tool.target": tool.target,
        "openclaw.tool.command": tool.command,
      }));
      addEvent(tool.span, "tool.update", {
        "openclaw.tool.name": tool.name,
        "openclaw.tool.call_id": tool.toolCallId,
        "openclaw.tool.partial_result.preview": preview,
      });
      return;
    }
    addEvent(tool.span, "tool.update", {
      "openclaw.tool.name": tool.name,
      "openclaw.tool.call_id": tool.toolCallId,
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
    tool.span.setAttributes(stringAttrs({
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
    addEvent(tool.span, "tool.result", stringAttrs({
      "openclaw.tool.name": tool.name,
      "openclaw.tool.call_id": tool.toolCallId,
      "openclaw.tool.outcome": isError ? "error" : "completed",
      "openclaw.tool.result.preview": resultPreview,
      "openclaw.tool.result_status": extractToolResultStatus(payload?.result),
    }));
    const toolMetricAttrs = buildToolMetricAttrs(
      tool,
      isError ? "error" : "completed",
      merged.resultStatus,
    );
    instruments.toolCallCounter.add(1, toolMetricAttrs);
    instruments.toolDuration.record(
      Math.max(0, eventTimestamp(evt).getTime() - tool.startedAt),
      toolMetricAttrs,
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
    run.toolSpans.delete(tool.toolCallId);
  };

  const annotateToolLoop = (
    evt: Extract<DiagnosticEventPayload, { type: "tool.loop" }>,
  ) => {
    const tool = findActiveToolSpanByName(evt, evt.toolName);
    if (!tool) {
      return false;
    }
    const loopAttrs = stringAttrs({
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
    addEvent(tool.span, "tool.loop", loopAttrs);
    if (evt.level === "critical") {
      tool.hasError = true;
      setError(tool.span, SpanStatusCode.ERROR, evt.message ?? "tool loop detected");
    }
    return true;
  };

  const emitSyntheticModelSpan = (
    evt: Extract<DiagnosticEventPayload, { type: "message.processed" }>,
  ) => {
    const run = getRun(evt, false);
    const snapshot = loadSessionSnapshot(evt.sessionKey);
    if (!run || run.modelSpanEmitted || (!snapshot?.lastProvider && !snapshot?.lastModel)) {
      return;
    }
    if (run.usedSkillNames.size === 0) {
      ensureTranscriptSkillSpans(evt);
    }
    const totalDuration = Math.max(evt.durationMs ?? 0, MIN_VISIBLE_MODEL_MS);
    const startTs = Math.max(evt.ts - totalDuration, run.mainStartTs + MIN_VISIBLE_CHILD_MS * 2);
    const span = tracer.startSpan(
      `${snapshot.lastProvider ?? "model"}/${snapshot.lastModel ?? "unknown"}`,
      {
        startTime: new Date(startTs),
        kind: SpanKind.CLIENT,
        attributes: stringAttrs(enrichWithTranscript(evt.sessionKey, {
          "span.kind": "model",
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
    run.modelSpan = span;
    run.modelCtx = trace.setSpan(getActiveSkillCtx(run) ?? run.ctx, span);
    run.modelStartTs = startTs;
    run.modelSpanEmitted = true;
  };

  const handleAgentEvent = (evt: any) => {
    const sessionKey = typeof evt?.sessionKey === "string" ? evt.sessionKey : undefined;
    if (!sessionKey) {
      return;
    }
    if (evt.stream === "assistant" && evt.data && typeof evt.data === "object") {
      const text = typeof evt.data.text === "string" ? evt.data.text : undefined;
      if (text?.trim()) {
        setLatestAssistantText(sessionKey, text);
        const run = getRun({ sessionKey }, false);
        const root = getRoot({ sessionKey }, false);
        const attrs = stringAttrs({
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
    const skillName = inferSkillNameFromTool(toolName);
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
    if (summary.target) run.usedToolTargets.add(summary.target);
    if (summary.command) run.usedToolCommands.add(summary.command);
    if (summary.resultStatus) run.usedToolResultStatuses.add(summary.resultStatus);
    if (skillName) {
      ensureSkillSpan({ sessionKey, ts: evt.ts ?? Date.now() }, skillName, "runtime");
    }
    syncToolSummaryAttrs({ sessionKey }, run);
    if (skillName) {
      run.skillSpans.get(skillName)?.span.setAttributes(stringAttrs({
        "span.kind": "skill",
        "openclaw.skill.name": skillName,
        "openclaw.skill.source": "runtime",
        "openclaw.tools": Array.from(run.usedToolNames).join(", "),
        "openclaw.tool.count": run.usedToolNames.size,
      }));
    }
    const toolCallId = typeof evt.data.toolCallId === "string" ? evt.data.toolCallId : undefined;
    if (!toolCallId) {
      return;
    }
    const toolEvt = { sessionKey, ts: evt.ts ?? Date.now() };
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
      tool.span.setAttributes(stringAttrs({
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
    for (const skill of current.skillSpans.values()) {
      skill.span.setAttributes(stringAttrs({
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
    emitSyntheticModelSpan,
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
