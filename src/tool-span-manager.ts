import type { DiagnosticEventPayload } from "openclaw/plugin-sdk";
import type {
  ActiveRunSpan,
  ActiveSkillInvocationSpan,
  ActiveSkillSpan,
  ActiveToolSpan,
  MetricInstruments,
  SessionSnapshot,
  SkillCatalogEntry,
} from "./service-types.js";
import {
  addEvent,
  buildGenAiClientTokenMetricAttrs,
  buildRunScopeAttrs,
  buildGenAiClientModelMetricAttrs,
  buildGenAiClientSkillMetricAttrs,
  buildGenAiClientToolMetricAttrs,
  buildSkillSpanAttrs,
  buildToolAttrs,
  clipPreview,
  clipValuePreview,
  collectToolSummaryValues,
  durationMsToSeconds,
  endSpanSafely,
  inferSkillNameFromTool,
  inferSkillNameFromToolIdentity,
  mergeToolIdentity,
  MIN_VISIBLE_CHILD_MS,
  MIN_VISIBLE_MODEL_MS,
  redactSensitiveText,
  resolveUsageTokenTotals,
  setError,
  skillCallSpanName,
  skillSpanName,
  stringAttrs,
  traceAttrs,
} from "./service-utils.js";

type SessionEvent = {
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
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
    const run = getRun(evt, false);
    const root = getRoot(evt, false);
    return {
      ...buildRunScopeAttrs(
        evt.runId ?? run?.runId ?? root?.runId,
        evt.runId,
        run?.runIds,
        root?.runIds,
      ),
      session_id: evt.sessionId ?? snapshot?.sessionId,
      session_key: evt.sessionKey ?? snapshot?.sessionKey,
      channel: evt.channel ?? snapshot?.lastChannel,
    };
  };

  const mergeSkillMetadata = (
    current: SkillCatalogEntry | undefined,
    incoming: SkillCatalogEntry | undefined,
  ): SkillCatalogEntry | undefined => {
    if (!incoming) {
      return current;
    }
    if (!current) {
      return incoming;
    }
    return {
      name: incoming.name || current.name,
      aliases: Array.from(new Set([...(current.aliases ?? []), ...(incoming.aliases ?? [])])),
      description: incoming.description ?? current.description,
      path: incoming.path ?? current.path,
      sourceType: incoming.sourceType ?? current.sourceType,
      version: incoming.version ?? current.version,
    };
  };

  const resolveSkillMetadata = (
    evt: SessionEvent,
    skillName: string | undefined,
  ): SkillCatalogEntry | undefined => {
    const normalizedSkillName = skillName?.trim();
    if (!normalizedSkillName) {
      return undefined;
    }
    const snapshot = loadSessionSnapshot(evt.sessionKey);
    return snapshot?.sessionSkillCatalog?.find((entry) => entry.name === normalizedSkillName);
  };

  const recordGenAiAgentTokenUsage = (
    provider: string | undefined,
    model: string | undefined,
    sessionId: string | undefined,
    usage:
      | {
        input?: number;
        output?: number;
        totalTokens?: number;
      }
      | undefined,
  ) => {
    if (!usage) {
      return;
    }
    const usageTotals = resolveUsageTokenTotals(usage);
    const tokenMetrics = [
      ["input", usageTotals.inputTokens],
      ["output", usageTotals.outputTokens],
    ] as const;
    for (const [tokenType, tokenValue] of tokenMetrics) {
      if (typeof tokenValue === "number" && tokenValue > 0) {
        instruments.genAiClientTokenUsage?.record(
          tokenValue,
          buildGenAiClientTokenMetricAttrs(provider, model, {
            session_id: sessionId,
            token_type: tokenType,
          }),
        );
      }
    }
  };

  const recordGenAiAgentOperation = (
    durationMs: number,
    attrs: Record<string, string | number | boolean | undefined>,
  ) => {
    instruments.genAiClientOperationDuration?.record(durationMsToSeconds(durationMs), attrs);
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

  const accumulateTranscriptUsage = (
    run: ActiveRunSpan,
    usage:
      | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        totalTokens?: number;
      }
      | undefined,
    provider: string | undefined,
    model: string | undefined,
  ) => {
    const {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
    } = resolveUsageTokenTotals(usage);
    if (
      inputTokens <= 0 &&
      outputTokens <= 0 &&
      cacheReadTokens <= 0 &&
      cacheWriteTokens <= 0 &&
      totalTokens <= 0
    ) {
      return;
    }
    run.aggregate.inputTokens += inputTokens;
    run.aggregate.outputTokens += outputTokens;
    run.aggregate.cacheReadTokens += cacheReadTokens;
    run.aggregate.cacheWriteTokens += cacheWriteTokens;
    run.aggregate.totalTokens += totalTokens;
    run.aggregate.modelCalls += 1;
    run.aggregate.lastProvider = provider ?? run.aggregate.lastProvider;
    run.aggregate.lastModel = model ?? run.aggregate.lastModel;
  };

  const syncRunUsageSummaryAttrs = (evt: SessionEvent, run: ActiveRunSpan) => {
    const attrs = traceAttrs({
      "openclaw.model.calls": run.aggregate.modelCalls,
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
    const resolvedMetadata = resolveSkillMetadata(evt, normalizedSkillName);
    run.usedSkillNames.add(normalizedSkillName);
    const existing = run.skillSpans.get(normalizedSkillName);
    if (existing) {
      run.activeSkillName = normalizedSkillName;
      if (existing.source !== "runtime" && source === "runtime") {
        existing.source = "runtime";
      }
      existing.metadata = mergeSkillMetadata(existing.metadata, resolvedMetadata);
      existing.span.setAttributes(traceAttrs({
        ...buildSessionSpanAttrs(evt),
        ...buildSkillSpanAttrs(normalizedSkillName, {
          source: existing.source,
          skill: existing.metadata,
          callId: existing.lastCallId,
          resultStatus: existing.resultStatus,
        }),
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
          ...buildSkillSpanAttrs(normalizedSkillName, {
            source,
            skill: resolvedMetadata,
          }),
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
      metadata: resolvedMetadata,
    };
    run.skillSpans.set(normalizedSkillName, skillState);
    run.activeSkillName = normalizedSkillName;
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
    const resolvedMetadata = resolveSkillMetadata(evt, normalizedSkillName);
    const existing = run.skillInvocationSpans.get(normalizedToolCallId);
    if (existing) {
      if (toolName?.trim()) {
        existing.toolName = toolName.trim();
      }
      existing.metadata = mergeSkillMetadata(existing.metadata, resolvedMetadata);
      existing.span.setAttributes(traceAttrs({
        ...buildSessionSpanAttrs(evt),
        ...buildSkillSpanAttrs(normalizedSkillName, {
          kind: "call",
          source: existing.source,
          skill: existing.metadata,
          callId: normalizedToolCallId,
          toolName: existing.toolName,
          resultStatus: existing.resultStatus,
        }),
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
          ...buildSkillSpanAttrs(normalizedSkillName, {
            kind: "call",
            source: "runtime",
            skill: resolvedMetadata,
            callId: normalizedToolCallId,
            toolName,
          }),
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
      metadata: resolvedMetadata,
    };
    run.skillInvocationSpans.set(normalizedToolCallId, skillInvocation);
    const summarySpan = run.skillSpans.get(normalizedSkillName);
    if (summarySpan) {
      summarySpan.lastCallId = normalizedToolCallId;
      summarySpan.metadata = mergeSkillMetadata(summarySpan.metadata, resolvedMetadata);
      summarySpan.span.setAttributes(traceAttrs({
        ...buildSessionSpanAttrs(evt),
        ...buildSkillSpanAttrs(normalizedSkillName, {
          source: summarySpan.source,
          skill: summarySpan.metadata,
          callId: summarySpan.lastCallId,
          resultStatus: summarySpan.resultStatus,
        }),
      }));
    }
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
    invocation.resultStatus = isError ? "error" : "completed";
    invocation.span.setAttributes(traceAttrs({
      ...buildSessionSpanAttrs(evt),
      ...buildSkillSpanAttrs(invocation.name, {
        kind: "call",
        source: invocation.source,
        skill: invocation.metadata,
        callId: invocation.callId,
        toolName: invocation.toolName,
        resultStatus: invocation.resultStatus,
      }),
    }));
    const summarySpan = run.skillSpans.get(invocation.name);
    if (summarySpan) {
      summarySpan.lastCallId = invocation.callId;
      summarySpan.metadata = mergeSkillMetadata(summarySpan.metadata, invocation.metadata);
      summarySpan.resultStatus = isError ? "error" : summarySpan.resultStatus ?? "completed";
      summarySpan.span.setAttributes(traceAttrs({
        ...buildSessionSpanAttrs(evt),
        ...buildSkillSpanAttrs(summarySpan.name, {
          source: summarySpan.source,
          skill: summarySpan.metadata,
          callId: summarySpan.lastCallId,
          resultStatus: summarySpan.resultStatus,
        }),
      }));
    }
    if (isError) {
      setError(invocation.span, SpanStatusCode.ERROR, "skill call error");
    } else {
      invocation.span.setStatus({ code: SpanStatusCode.OK });
    }
    const durationMs = Math.max((endTime?.getTime() ?? Date.now()) - invocation.startedAt, 1);
    const skillMetricAttrs = buildGenAiClientSkillMetricAttrs(
      invocation.name,
      isError ? "error" : "completed",
      evt.sessionId,
      invocation.source,
    );
    recordGenAiAgentOperation(durationMs, skillMetricAttrs);
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
    const skillName = resolveSkillName(
      evt,
      normalizedToolName,
      normalizedToolCallId,
      attrs?.["openclaw.tool.target"] as string | undefined,
      attrs?.["openclaw.tool.command"] as string | undefined,
    );
    const skillMetadata = resolveSkillMetadata(evt, skillName);
    if (skillName) {
      ensureSkillSpan(evt, skillName, "runtime");
      ensureSkillInvocationSpan(evt, skillName, normalizedToolCallId, normalizedToolName);
    }
    const existing = run.toolSpans.get(normalizedToolCallId);
    if (existing) {
      existing.skillName = existing.skillName ?? skillName;
      existing.skillMetadata = mergeSkillMetadata(existing.skillMetadata, skillMetadata);
      const merged = mergeToolIdentity(existing);
      existing.span.setAttributes(traceAttrs({
        ...buildSessionSpanAttrs(evt),
        ...buildToolAttrs(normalizedToolName, normalizedToolCallId, {
          skillName: existing.skillName,
          skill: existing.skillMetadata,
          skillCallId: existing.skillName ? normalizedToolCallId : undefined,
          skillResultStatus: existing.hasError ? "error" : undefined,
        }),
        "openclaw.tool.arg_keys": merged.argKeys,
        "openclaw.tool.target": merged.target,
        "openclaw.tool.command": merged.command,
        "openclaw.tool.provider": merged.provider,
        "openclaw.tool.namespace": merged.namespace,
        "openclaw.tool.mcp_name": merged.mcpToolName,
        "openclaw.tool.mcp_host": merged.mcpHost,
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
      provider: typeof attrs?.["openclaw.tool.provider"] === "string"
        ? attrs["openclaw.tool.provider"]
        : undefined,
      namespace: typeof attrs?.["openclaw.tool.namespace"] === "string"
        ? attrs["openclaw.tool.namespace"]
        : undefined,
      mcpToolName: typeof attrs?.["openclaw.tool.mcp_name"] === "string"
        ? attrs["openclaw.tool.mcp_name"]
        : undefined,
      mcpHost: typeof attrs?.["openclaw.tool.mcp_host"] === "string"
        ? attrs["openclaw.tool.mcp_host"]
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
            skill: skillMetadata,
            skillCallId: skillName ? normalizedToolCallId : undefined,
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
      skillMetadata,
      argKeys: merged.argKeys,
      target: merged.target,
      command: merged.command,
      provider: merged.provider,
      namespace: merged.namespace,
      mcpToolName: merged.mcpToolName,
      mcpHost: merged.mcpHost,
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
    tool.provider = merged.provider;
    tool.namespace = merged.namespace;
    tool.mcpToolName = merged.mcpToolName;
    tool.mcpHost = merged.mcpHost;
    if (preview) {
      tool.span.setAttributes(traceAttrs({
        ...buildSessionSpanAttrs(evt),
        ...buildToolAttrs(tool.name, tool.toolCallId, {
          skillName: tool.skillName,
          skill: tool.skillMetadata,
          skillCallId: tool.skillName ? tool.toolCallId : undefined,
          partialResult,
        }),
        "openclaw.tool.arg_keys": tool.argKeys,
        "openclaw.tool.target": tool.target,
        "openclaw.tool.command": tool.command,
        "openclaw.tool.provider": tool.provider,
        "openclaw.tool.namespace": tool.namespace,
        "openclaw.tool.mcp_name": tool.mcpToolName,
        "openclaw.tool.mcp_host": tool.mcpHost,
      }));
      addEvent(tool.span, "tool.update");
      return;
    }
    addEvent(tool.span, "tool.update");
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
    tool.provider = merged.provider;
    tool.namespace = merged.namespace;
    tool.mcpToolName = merged.mcpToolName;
    tool.mcpHost = merged.mcpHost;
    if (merged.target) run.usedToolTargets.add(merged.target);
    if (merged.command) run.usedToolCommands.add(merged.command);
    const finalResultStatus = isError ? "error" : "completed";
    run.usedToolResultStatuses.add(finalResultStatus);
    syncToolSummaryAttrs(evt, run);
    tool.hasError = isError;
    tool.span.setAttributes(traceAttrs({
      ...buildSessionSpanAttrs(evt),
      ...buildToolAttrs(tool.name, tool.toolCallId, {
        skillName: tool.skillName,
        skill: tool.skillMetadata,
        skillCallId: tool.skillName ? tool.toolCallId : undefined,
        skillResultStatus: finalResultStatus,
        meta: payload?.meta,
        result: payload?.result,
        outcome: isError ? "error" : "completed",
      }),
      "openclaw.tool.arg_keys": tool.argKeys,
      "openclaw.tool.target": tool.target,
      "openclaw.tool.command": tool.command,
      "openclaw.tool.provider": tool.provider,
      "openclaw.tool.namespace": tool.namespace,
      "openclaw.tool.mcp_name": tool.mcpToolName,
      "openclaw.tool.mcp_host": tool.mcpHost,
    }));
    addEvent(tool.span, "tool.result");
    const snapshot = loadSessionSnapshot(evt.sessionKey);
    const genAiToolMetricAttrs = buildGenAiClientToolMetricAttrs(
      tool,
      finalResultStatus,
      evt.sessionId,
      run.aggregate.lastModel ?? snapshot?.lastModel,
    );
    const durationMs = Math.max(0, eventTimestamp(evt).getTime() - tool.startedAt);
    recordGenAiAgentOperation(durationMs, genAiToolMetricAttrs);
    if (isError) {
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
    addEvent(tool.span, "tool.loop");
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
      runId: evt.runId,
      ts: replayStartTs,
    }, true);
    if (!run) {
      return false;
    }
    const emittedTurns = run.transcriptAssistantTurnsEmitted ?? 0;
    const coveredTurnCount = Math.min(run.aggregate.modelCalls, turns.length);
    if (emittedTurns >= turns.length) {
      return emittedTurns > 0 || run.modelSpanEmitted === true;
    }
    const replayStartIndex = Math.max(emittedTurns, coveredTurnCount);
    if (replayStartIndex >= turns.length) {
      run.transcriptAssistantTurnsEmitted = turns.length;
      run.modelSpanEmitted = true;
      return turns.length > 0;
    }
    const pendingTurns = turns.slice(replayStartIndex);
    ensureRuntimeLifecycleSpans(
      {
        sessionKey: evt.sessionKey,
        sessionId: evt.sessionId,
        runId: evt.runId,
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
      const index = replayStartIndex + offset;
      if (offset === 0 && typeof run.orchestrationCursorTs === "number") {
        emitRuntimeOrchestrationSpan(
          evt,
          run.orchestrationCursorTs,
          turn.startedAt,
          "agent_plan",
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
      const usageTotals = resolveUsageTokenTotals(turn.usage);
      const span = tracer.startSpan(
        "llm",
        {
          startTime: new Date(startTs),
          kind: SpanKind.CLIENT,
          attributes: traceAttrs(enrichWithTranscript(evt.sessionKey, {
            ...buildSessionSpanAttrs(evt),
            __suppress_session_output_preview: true,
            __suppress_session_output_summary: true,
            session_update_time: endTs,
            turn_index: index + 1,
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
            "llm.input_tokens": usageTotals.inputTokens,
            "llm.output_tokens": usageTotals.outputTokens,
            "openclaw.tokens.input": usageTotals.inputTokens,
            "openclaw.tokens.output": usageTotals.outputTokens,
            "openclaw.tokens.total": usageTotals.totalTokens,
            "openclaw.tokens.cache_read": usageTotals.cacheReadTokens,
            "openclaw.tokens.cache_write": usageTotals.cacheWriteTokens,
          })),
        },
        run.ctx,
      );
      span.setStatus({ code: SpanStatusCode.OK });
      endSpanSafely(span, new Date(endTs));
      const durationMs = Math.max(endTs - startTs, 1);
      const modelMetricAttrs = buildGenAiClientModelMetricAttrs(
        turn.provider ?? snapshot?.lastProvider,
        turn.model ?? snapshot?.lastModel,
        {
          session_id: snapshot?.sessionId ?? evt.sessionId,
        },
      );
      recordGenAiAgentOperation(durationMs, modelMetricAttrs);
      recordGenAiAgentTokenUsage(
        turn.provider ?? snapshot?.lastProvider,
        turn.model ?? snapshot?.lastModel,
        snapshot?.sessionId ?? evt.sessionId,
        turn.usage,
      );
      accumulateTranscriptUsage(
        run,
        turn.usage,
        turn.provider ?? snapshot?.lastProvider,
        turn.model ?? snapshot?.lastModel,
      );
      syncRunUsageSummaryAttrs(evt, run);
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
        usage_input_tokens: usageTotals.inputTokens,
        usage_output_tokens: usageTotals.outputTokens,
        usage_total_tokens: usageTotals.totalTokens,
        usage_cache_read_input_tokens: usageTotals.cacheReadTokens,
        usage_cache_write_input_tokens: usageTotals.cacheWriteTokens,
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
      runId: evt.runId,
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
        runId: evt.runId,
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
    const usageTotals = resolveUsageTokenTotals(snapshot.lastAssistantUsage);
    const minStartTs = Math.min(run.mainStartTs + MIN_VISIBLE_CHILD_MS * 2, modelEndTs - 1);
    const startTs = Math.max(modelEndTs - totalDuration, minStartTs);
    const lastTurn = snapshot.lastRunAssistantTurns?.at(-1);
    emitRuntimeOrchestrationSpan(
      evt,
      run.mainStartTs,
      startTs,
      "agent_plan",
      {
        "openclaw.provider": snapshot.lastProvider,
        "openclaw.model": snapshot.lastModel,
      },
      run.ctx,
    );
    const span = tracer.startSpan(
      "llm",
      {
        startTime: new Date(startTs),
        kind: SpanKind.CLIENT,
        attributes: traceAttrs(enrichWithTranscript(evt.sessionKey, {
          ...buildSessionSpanAttrs(evt),
          __suppress_session_output_preview: true,
          __suppress_session_output_summary: true,
          session_update_time: modelEndTs,
          turn_index: lastTurn ? snapshot.lastRunAssistantTurns?.length : undefined,
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
          "llm.input_tokens": usageTotals.inputTokens,
          "llm.output_tokens": usageTotals.outputTokens,
          "openclaw.tokens.input": usageTotals.inputTokens,
          "openclaw.tokens.output": usageTotals.outputTokens,
          "openclaw.tokens.total": usageTotals.totalTokens,
          "openclaw.tokens.cache_read": usageTotals.cacheReadTokens,
          "openclaw.tokens.cache_write": usageTotals.cacheWriteTokens,
        })),
      },
      getActiveSkillCtx(run) ?? run.ctx,
    );
    span.setStatus({ code: SpanStatusCode.OK });
    const durationMs = Math.max(modelEndTs - startTs, 1);
    const modelMetricAttrs = buildGenAiClientModelMetricAttrs(snapshot.lastProvider, snapshot.lastModel, {
      session_id: snapshot.sessionId ?? evt.sessionId,
    });
    recordGenAiAgentOperation(durationMs, modelMetricAttrs);
    recordGenAiAgentTokenUsage(
      snapshot.lastProvider,
      snapshot.lastModel,
      snapshot.sessionId ?? evt.sessionId,
      snapshot.lastAssistantUsage,
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
      runId: evt.runId,
      ts: replayStartTs,
    }, true);
    if (!run) {
      return;
    }
    const emittedToolCallIds = run.transcriptToolCallIds ?? new Set<string>();
    run.transcriptToolCallIds = emittedToolCallIds;
    const observedToolCallIds = run.observedToolCallIds ?? new Set<string>();
    run.observedToolCallIds = observedToolCallIds;
    for (const toolCall of snapshot?.lastRunToolCalls ?? []) {
      if (emittedToolCallIds.has(toolCall.callId)) {
        continue;
      }
      if (observedToolCallIds.has(toolCall.callId)) {
        emittedToolCallIds.add(toolCall.callId);
        continue;
      }
      handleAgentEvent({
        sessionKey,
        sessionId: evt.sessionId ?? snapshot?.sessionId,
        runId: evt.runId,
        ts: toolCall.startedAt ?? evt.ts ?? Date.now(),
        stream: "tool",
        source: "transcript",
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
        sessionId: evt.sessionId ?? snapshot?.sessionId,
        runId: evt.runId,
        ts: toolCall.endedAt ?? toolCall.startedAt ?? evt.ts ?? Date.now(),
        stream: "tool",
        source: "transcript",
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
    const runId = typeof evt?.runId === "string" ? evt.runId : undefined;
    const channel = typeof evt?.channel === "string" ? evt.channel : undefined;
    const source = evt?.source === "transcript" ? "transcript" : "runtime";
    if (!sessionKey) {
      return;
    }
    if (evt.stream === "assistant" && evt.data && typeof evt.data === "object") {
      const text = typeof evt.data.text === "string" ? evt.data.text : undefined;
      if (text?.trim()) {
        setLatestAssistantText(sessionKey, text);
        const run = getRun({ sessionKey, sessionId, runId }, false);
        const root = getRoot({ sessionKey, sessionId, runId }, false);
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
    const run = getRun({ sessionKey, sessionId, runId }, false)
      ?? ensureUserSpan({ sessionKey, sessionId, runId, ts: evt.ts ?? Date.now(), channel });
    if (!run || !toolName) {
      return;
    }
    const toolCallId = typeof evt.data.toolCallId === "string" ? evt.data.toolCallId : undefined;
    const observedToolCallIds = run.observedToolCallIds ?? new Set<string>();
    run.observedToolCallIds = observedToolCallIds;
    if (toolCallId && source !== "transcript") {
      observedToolCallIds.add(toolCallId);
    }
    run.usedToolNames.add(toolName);
    const summary = collectToolSummaryValues(toolName, {
      args: evt.data.args,
      meta: evt.data.meta,
      result: evt.data.result,
      partialResult: evt.data.partialResult,
    });
    const skillName = resolveSkillName(
      { sessionKey, sessionId, ts: evt.ts ?? Date.now() },
      toolName,
      toolCallId,
      summary.target,
      summary.command,
    );
    if (summary.target) run.usedToolTargets.add(summary.target);
    if (summary.command) run.usedToolCommands.add(summary.command);
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
      const skill = run.skillSpans.get(skillName);
      skill?.span.setAttributes(traceAttrs({
        ...buildSessionSpanAttrs({ sessionKey, sessionId, channel }),
        ...buildSkillSpanAttrs(skillName, {
          source: "runtime",
          skill: skill?.metadata,
          callId: skill?.lastCallId,
          resultStatus: skill?.resultStatus,
        }),
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
          skill: resolveSkillMetadata(toolEvt, skillName),
          skillCallId: skillName ? toolCallId : undefined,
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
        skill: resolveSkillMetadata(toolEvt, skillName),
        skillCallId: skillName ? toolCallId : undefined,
      }),
    });
  };

  const finalizeToolAndSkillSpans = (current: ActiveRunSpan, endTime?: Date) => {
    for (const tool of current.toolSpans.values()) {
      tool.span.setAttributes(traceAttrs({
        ...buildToolAttrs(tool.name, tool.toolCallId, {
          skillName: tool.skillName,
          skill: tool.skillMetadata,
          skillCallId: tool.skillName ? tool.toolCallId : undefined,
          skillResultStatus: tool.hasError ? "error" : "completed",
          outcome: tool.hasError ? "error" : "completed",
        }),
        "openclaw.tool.arg_keys": tool.argKeys,
        "openclaw.tool.target": tool.target,
        "openclaw.tool.command": tool.command,
        "openclaw.tool.provider": tool.provider,
        "openclaw.tool.namespace": tool.namespace,
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
      invocation.resultStatus = invocation.resultStatus ?? "completed";
      invocation.span.setAttributes(traceAttrs({
        ...buildSkillSpanAttrs(invocation.name, {
          kind: "call",
          source: invocation.source,
          skill: invocation.metadata,
          callId: invocation.callId,
          toolName: invocation.toolName,
          resultStatus: invocation.resultStatus,
        }),
      }));
      invocation.span.setStatus({ code: SpanStatusCode.OK });
      endSpanSafely(invocation.span, endTime);
    }
    current.skillInvocationSpans.clear();
    for (const skill of current.skillSpans.values()) {
      skill.resultStatus = skill.resultStatus ?? "completed";
      skill.span.setAttributes(traceAttrs({
        ...buildSkillSpanAttrs(skill.name, {
          source: skill.source,
          skill: skill.metadata,
          callId: skill.lastCallId,
          resultStatus: skill.resultStatus,
        }),
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
