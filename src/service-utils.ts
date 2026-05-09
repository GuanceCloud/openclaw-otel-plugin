import fs from "node:fs";
import { stripAnsiEscapeCodes } from "./trace-runtime.js";
import type {
  ActiveRunSpan,
  ActiveToolSpan,
  RunAggregate,
  SessionSnapshot,
  SkillCatalogEntry,
} from "./service-types.js";

const PREVIEW_LIMIT = 1200;
const REASONING_PREVIEW_LIMIT = 360;

export const MIN_VISIBLE_CHILD_MS = 120;
export const MIN_VISIBLE_MODEL_MS = 800;
export const MAX_OPENCLAW_THINKING_MS = 1500;

export function redactSensitiveText(text: string): string {
  return text;
}

export function createRunAggregate(): RunAggregate {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    promptTokens: 0,
    costUsd: 0,
    modelCalls: 0,
  };
}

export function createRunState(ctx: any, mainStartTs: number, startedAt = Date.now()): ActiveRunSpan {
  return {
    span: null,
    ctx,
    startedAt,
    lastTouchedAt: startedAt,
    mainStartTs,
    orchestrationCursorTs: mainStartTs,
    channelIngressEmitted: false,
    dispatchQueueEmitted: false,
    sessionProcessingEmitted: false,
    channelEgressEmitted: false,
    modelSpanEmitted: false,
    thinkingSpanEmitted: false,
    transcriptAssistantTurnsEmitted: 0,
    transcriptToolCallIds: new Set<string>(),
    finalAttrsApplied: false,
    aggregate: createRunAggregate(),
    usedSkillNames: new Set<string>(),
    usedToolNames: new Set<string>(),
    usedToolTargets: new Set<string>(),
    usedToolCommands: new Set<string>(),
    usedToolResultStatuses: new Set<string>(),
    skillSpans: new Map(),
    skillInvocationSpans: new Map(),
    toolSpans: new Map(),
  };
}

export function resolveIngressLifecycleWindows(
  ingressStartTs: number,
  processingStartTs?: number,
): {
  ingressEndTs: number;
  queueStartTs?: number;
  queueEndTs?: number;
} {
  const ingressEndTs = typeof processingStartTs === "number"
    ? Math.max(Math.min(ingressStartTs + MIN_VISIBLE_CHILD_MS, processingStartTs), ingressStartTs + 1)
    : ingressStartTs + MIN_VISIBLE_CHILD_MS;
  if (typeof processingStartTs !== "number" || processingStartTs <= ingressEndTs) {
    return { ingressEndTs };
  }
  return {
    ingressEndTs,
    queueStartTs: ingressEndTs,
    queueEndTs: processingStartTs,
  };
}

export function eventTime(ts: number): Date {
  return new Date(ts);
}

export function endTimeFromStart(startTs: number, durationMs: number): Date {
  return new Date(startTs + Math.max(durationMs, 1));
}

export function resolveOpenClawThinkingDurationMs(
  modelWindowMs: number,
  requestedDurationMs?: number,
): number {
  const boundedModelWindowMs = Math.max(modelWindowMs, MIN_VISIBLE_CHILD_MS);
  const maxDurationMs = Math.min(
    MAX_OPENCLAW_THINKING_MS,
    Math.max(MIN_VISIBLE_CHILD_MS, Math.floor(boundedModelWindowMs / 4)),
  );
  const preferredDurationMs = typeof requestedDurationMs === "number"
    ? requestedDurationMs
    : maxDurationMs;
  return Math.max(MIN_VISIBLE_CHILD_MS, Math.min(preferredDurationMs, maxDurationMs));
}

export function resolveSpanWindow(
  ts: number | undefined,
  durationMs?: number,
): {
  startTime: Date;
  endTime: Date;
  effectiveDurationMs?: number;
} {
  const endTs = typeof ts === "number" ? ts : Date.now();
  if (typeof durationMs !== "number") {
    const endTime = new Date(endTs);
    return {
      startTime: endTime,
      endTime,
    };
  }
  const effectiveDurationMs = Math.max(durationMs, 1);
  return {
    startTime: new Date(endTs - effectiveDurationMs),
    endTime: new Date(endTs),
    effectiveDurationMs,
  };
}

export function sessionIdentity(evt: {
  sessionKey?: string;
  sessionId?: string;
}): string | undefined {
  return evt.sessionKey ?? evt.sessionId;
}

export function resolveSessionSpanName(
  evt: { sessionKey?: string; sessionId?: string },
  fallback: string,
): string {
  const name = sessionIdentity(evt)?.trim();
  return name || fallback;
}

export function parseSessionKey(
  value: string | undefined,
): {
  sessionNamespace?: string;
  sessionChannel?: string;
  sessionAgent?: string;
  sessionScope?: string;
  sessionChannelTarget?: string;
} {
  const normalized = value?.trim();
  if (!normalized) {
    return {};
  }
  const segments = normalized.split(":");
  if (segments.length < 3 || segments[0] !== "agent") {
    return {};
  }
  const [, sessionAgent, sessionRuntime, sessionScope, ...rest] = segments;
  return {
    sessionNamespace: "agent",
    sessionChannel: sessionRuntime?.trim() || undefined,
    sessionAgent: sessionAgent?.trim() || undefined,
    sessionScope: sessionScope?.trim() || undefined,
    sessionChannelTarget: rest.join(":").trim() || undefined,
  };
}

function promoteAlias(
  target: Record<string, string | number | boolean | undefined>,
  aliasKey: string,
  ...sourceKeys: string[]
) {
  let aliasValue = target[aliasKey];
  if (aliasValue === undefined || aliasValue === "") {
    for (const sourceKey of sourceKeys) {
      const value = target[sourceKey];
      if (value !== undefined && value !== "") {
        aliasValue = value;
        target[aliasKey] = value;
        break;
      }
    }
  }
  if (aliasValue === undefined || aliasValue === "") {
    return;
  }
  for (const sourceKey of sourceKeys) {
    if (sourceKey !== aliasKey) {
      delete target[sourceKey];
    }
  }
}

function mirrorAlias(
  target: Record<string, string | number | boolean | undefined>,
  aliasKey: string,
  ...sourceKeys: string[]
) {
  let value = target[aliasKey];
  if (value === undefined || value === "") {
    for (const sourceKey of sourceKeys) {
      const sourceValue = target[sourceKey];
      if (sourceValue !== undefined && sourceValue !== "") {
        value = sourceValue;
        target[aliasKey] = sourceValue;
        break;
      }
    }
  }
  if (value === undefined || value === "") {
    return;
  }
  for (const sourceKey of sourceKeys) {
    if (target[sourceKey] === undefined || target[sourceKey] === "") {
      target[sourceKey] = value;
    }
  }
}

function promotePrefixedKeys(
  target: Record<string, string | number | boolean | undefined>,
  prefix: string,
  aliasPrefix: string,
) {
  for (const [key, value] of Object.entries({ ...target })) {
    if (!key.startsWith(prefix) || value === undefined || value === "") {
      continue;
    }
    const suffix = key.slice(prefix.length).replace(/\./g, "_");
    if (!suffix) {
      continue;
    }
    const aliasKey = `${aliasPrefix}${suffix}`;
    if (target[aliasKey] === undefined || target[aliasKey] === "") {
      target[aliasKey] = value;
    }
    delete target[key];
  }
}

function flattenGenAiKey(key: string): string {
  if (!key.startsWith("gen_ai.")) {
    return key;
  }
  const suffix = key.slice("gen_ai.".length);
  return `gen_ai.${suffix.replaceAll(".", "_")}`;
}

function normalizeGenAiKeys(
  attrs: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean | undefined> {
  const next = { ...attrs };
  for (const [key, value] of Object.entries({ ...next })) {
    if (!key.startsWith("gen_ai.") || value === undefined || value === "") {
      continue;
    }
    const flattened = flattenGenAiKey(key);
    if (flattened === key) {
      continue;
    }
    if (!(flattened in next)) {
      next[flattened] = value;
    }
    delete next[key];
  }
  return next;
}

function withCanonicalAliases(
  attrs: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean | undefined> {
  const next = normalizeGenAiKeys(attrs);
  promotePrefixedKeys(next, "openclaw.tool.", "tool_");
  promoteAlias(next, "session_id", "openclaw.sessionId");
  promoteAlias(next, "session_key", "openclaw.sessionKey");
  delete next["openclaw.sessionId"];
  delete next["openclaw.sessionKey"];
  const sessionKeyParts = parseSessionKey(
    typeof next.session_key === "string" ? next.session_key : undefined,
  );
  if (sessionKeyParts.sessionNamespace && (next.session_namespace === undefined || next.session_namespace === "")) {
    next.session_namespace = sessionKeyParts.sessionNamespace;
  }
  if (sessionKeyParts.sessionChannel && (next.session_channel === undefined || next.session_channel === "")) {
    next.session_channel = sessionKeyParts.sessionChannel;
  }
  if (sessionKeyParts.sessionAgent && (next.session_agent === undefined || next.session_agent === "")) {
    next.session_agent = sessionKeyParts.sessionAgent;
  }
  if (sessionKeyParts.sessionScope && (next.session_scope === undefined || next.session_scope === "")) {
    next.session_scope = sessionKeyParts.sessionScope;
  }
  if (
    sessionKeyParts.sessionChannelTarget &&
    (next.session_channel_target === undefined || next.session_channel_target === "")
  ) {
    next.session_channel_target = sessionKeyParts.sessionChannelTarget;
  }
  promoteAlias(next, "channel", "openclaw.channel", "openclaw.session.lastChannel");
  promoteAlias(next, "session_cwd", "openclaw.session.cwd");
  promoteAlias(next, "source_app", "openclaw.session.origin.provider");
  promoteAlias(next, "entry_point", "openclaw.session.origin.surface");
  mirrorAlias(next, "gen_ai.agent_id", "agent_id");
  mirrorAlias(next, "gen_ai.agent_name", "agent_name");
  mirrorAlias(next, "gen_ai.agent_runtime", "agent_runtime");
  mirrorAlias(next, "gen_ai.agent_channel", "channel");
  mirrorAlias(next, "gen_ai.session_id", "session_id");
  mirrorAlias(next, "gen_ai.session_key", "session_key");
  mirrorAlias(next, "gen_ai.session_namespace", "session_namespace");
  mirrorAlias(next, "gen_ai.session_agent", "session_agent");
  mirrorAlias(next, "gen_ai.session_channel", "session_channel");
  mirrorAlias(next, "gen_ai.session_scope", "session_scope");
  mirrorAlias(next, "gen_ai.session_channel_target", "session_channel_target");
  mirrorAlias(next, "gen_ai.session_cwd", "session_cwd");
  mirrorAlias(next, "gen_ai.origin_provider", "source_app");
  mirrorAlias(next, "gen_ai.origin_surface", "entry_point");
  mirrorAlias(next, "gen_ai.provider_name", "openclaw.provider", "llm.provider");
  mirrorAlias(next, "gen_ai.request_model", "openclaw.model", "llm.model");
  mirrorAlias(next, "gen_ai.response_model", "openclaw.model", "llm.model");
  mirrorAlias(next, "gen_ai.input_preview", "openclaw.input.preview");
  mirrorAlias(next, "gen_ai.input_length", "openclaw.input.length");
  mirrorAlias(next, "gen_ai.output_preview", "openclaw.output.preview");
  mirrorAlias(next, "gen_ai.output_length", "openclaw.output.length");
  mirrorAlias(next, "gen_ai.output_summary", "output_summary");
  mirrorAlias(next, "gen_ai.output_text_length", "output_text_length");
  mirrorAlias(next, "gen_ai.usage_input_tokens", "openclaw.tokens.input", "llm.input_tokens");
  mirrorAlias(next, "gen_ai.usage_output_tokens", "openclaw.tokens.output", "llm.output_tokens");
  mirrorAlias(next, "gen_ai.usage_total_tokens", "openclaw.tokens.total", "llm.total_tokens");
  mirrorAlias(next, "gen_ai.usage_cache_read_input_tokens", "openclaw.tokens.cache_read");
  mirrorAlias(next, "gen_ai.usage_cache_write_input_tokens", "openclaw.tokens.cache_write");
  delete next["llm.provider"];
  delete next["llm.model"];
  delete next["llm.input_tokens"];
  delete next["llm.output_tokens"];
  delete next["llm.total_tokens"];
  delete next["openclaw.provider"];
  delete next["openclaw.model"];
  delete next["openclaw.input.preview"];
  delete next["openclaw.input.length"];
  delete next["openclaw.output.preview"];
  delete next["openclaw.output.length"];
  delete next["openclaw.tokens.input"];
  delete next["openclaw.tokens.output"];
  delete next["openclaw.tokens.total"];
  delete next["openclaw.tokens.cache_read"];
  delete next["openclaw.tokens.cache_write"];
  delete next.output_summary;
  delete next.output_text_length;
  mirrorAlias(next, "gen_ai.output_kind", "openclaw.output.kind", "output.kind");
  mirrorAlias(next, "gen_ai.tool_call_id", "openclaw.tool.call_id", "tool_call_id");
  mirrorAlias(next, "gen_ai.tool_name", "openclaw.tool.name", "tool_name");
  mirrorAlias(next, "gen_ai.tool_target", "openclaw.tool.target", "tool_target");
  mirrorAlias(next, "gen_ai.tool_command", "openclaw.tool.command", "tool_command");
  mirrorAlias(next, "gen_ai.tool_outcome", "openclaw.tool.outcome", "tool_outcome");
  mirrorAlias(next, "gen_ai.tool_phase", "openclaw.tool.phase", "tool_phase");
  mirrorAlias(next, "gen_ai.tool_loop_level", "openclaw.tool.loop.level", "tool_loop_level");
  mirrorAlias(next, "gen_ai.skill_call_id", "openclaw.skill.call_id", "skill_call_id", "skill.call_id");
  mirrorAlias(next, "gen_ai.skill_name", "openclaw.skill.name", "skill_name", "skill.name");
  mirrorAlias(next, "gen_ai.skill_type", "openclaw.skill.kind", "skill_type", "skill.kind");
  mirrorAlias(next, "gen_ai.skill_source", "openclaw.skill.source", "skill_source", "skill.source");
  mirrorAlias(next, "gen_ai.final_status", "openclaw.outcome", "openclaw.final_state", "final_status");
  mirrorAlias(next, "gen_ai.agent_version", "agent_version");
  mirrorAlias(next, "gen_ai.runtime_environment", "runtime_environment");
  mirrorAlias(next, "gen_ai.state", "openclaw.state", "state");
  mirrorAlias(next, "gen_ai.prev_state", "openclaw.prevState", "prevState", "prev_state");
  mirrorAlias(next, "gen_ai.reason", "openclaw.reason", "reason");
  mirrorAlias(next, "gen_ai.queue_depth", "openclaw.queueDepth", "queueDepth", "queue_depth");
  mirrorAlias(next, "gen_ai.runtime_phase", "openclaw.runtime.phase", "runtime.phase");
  mirrorAlias(next, "gen_ai.tools", "tools");
  mirrorAlias(next, "gen_ai.tool_count", "tool_count");
  mirrorAlias(next, "gen_ai.skills", "skills");
  mirrorAlias(next, "gen_ai.skill_count", "skill.count", "skill_count");
  mirrorAlias(next, "gen_ai.tool_targets", "tool_targets");
  mirrorAlias(next, "gen_ai.tool_commands", "tool_commands");
  mirrorAlias(next, "gen_ai.tool_result_statuses", "tool_result_statuses");
  mirrorAlias(next, "gen_ai.tool_arg_keys", "tool_arg_keys");
  mirrorAlias(next, "gen_ai.tool_args_preview", "tool_args_preview");
  mirrorAlias(next, "gen_ai.tool_meta_preview", "tool_meta_preview");
  mirrorAlias(next, "gen_ai.tool_result_preview", "tool_result_preview");
  mirrorAlias(next, "gen_ai.tool_result_status", "tool_result_status");
  mirrorAlias(next, "gen_ai.session_create_at", "session_create_time", "gen_ai.session_create_time");
  mirrorAlias(next, "gen_ai.session_created_at", "session.createdAt");
  mirrorAlias(next, "gen_ai.session_updated_at", "session.updatedAt", "session_update_time");
  mirrorAlias(next, "gen_ai.session_chat_type", "session.chatType");
  mirrorAlias(next, "gen_ai.session_file", "session.file");
  mirrorAlias(next, "skill_call_id", "openclaw.skill.call_id");
  mirrorAlias(next, "skill_name", "openclaw.skill.name");
  mirrorAlias(next, "skill_type", "openclaw.skill.kind");
  mirrorAlias(next, "skill_source", "openclaw.skill.source");
  promoteAlias(next, "final_status", "openclaw.outcome", "openclaw.final_state");
  return next;
}

function stripOpenClawNamespace(
  attrs: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean | undefined> {
  const next = { ...attrs };
  for (const [key, value] of Object.entries({ ...next })) {
    if (!key.startsWith("openclaw.") || value === undefined || value === "") {
      continue;
    }
    const strippedKey = key.slice("openclaw.".length);
    if (!strippedKey) {
      delete next[key];
      continue;
    }
    if (next[strippedKey] === undefined || next[strippedKey] === "") {
      next[strippedKey] = value;
    }
    delete next[key];
  }
  return next;
}

export function stringAttrs(
  attrs: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const withGlobalRuntime = {
    agent_runtime: "openclaw",
    ...attrs,
  };
  return Object.fromEntries(
    Object.entries(stripOpenClawNamespace(withCanonicalAliases(withGlobalRuntime)))
      .filter(([key, value]) => key !== "trace_id" && value !== undefined && value !== "")
      .map(([key, value]) => [
        key,
        typeof value === "string" ? stripAnsiEscapeCodes(value) : value,
      ]),
  ) as Record<string, string | number | boolean>;
}

const LEGACY_TRACE_CONTEXT_KEYS = new Set([
  "agent_id",
  "agent_name",
  "agent_runtime",
  "channel",
  "session_id",
  "session_key",
  "session_namespace",
  "session_agent",
  "session_channel",
  "session_scope",
  "session_channel_target",
  "session_cwd",
  "source_app",
  "entry_point",
  "tool_call_id",
  "tool_name",
  "tool_target",
  "tool_command",
  "tool_outcome",
  "tool_phase",
  "tool_loop_level",
  "skill_call_id",
  "skill_name",
  "skill_type",
  "skill_source",
  "skill.call_id",
  "skill.name",
  "skill.kind",
  "skill.source",
  "final_status",
  "output.kind",
  "agent_version",
  "runtime_environment",
  "state",
  "prevState",
  "prev_state",
  "reason",
  "queueDepth",
  "queue_depth",
  "runtime.phase",
  "tools",
  "tool_count",
  "skills",
  "skill.count",
  "skill_count",
  "tool_targets",
  "tool_commands",
  "tool_result_statuses",
  "tool_arg_keys",
  "tool_args_preview",
  "tool_meta_preview",
  "tool_result_preview",
  "tool_result_status",
  "tool.call_id",
  "tool.name",
  "tool.target",
  "tool.command",
  "tool.phase",
  "tool.outcome",
  "session_create_time",
  "session.createdAt",
  "session.updatedAt",
  "session_update_time",
  "session.chatType",
  "session.file",
  "gen_ai.agent_id",
  "gen_ai.agent_name",
  "gen_ai.agent_runtime",
]);

export function traceAttrs(
  attrs: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const normalized = stringAttrs(attrs);
  return Object.fromEntries(
    Object.entries(normalized).filter(([key]) => !LEGACY_TRACE_CONTEXT_KEYS.has(key)),
  ) as Record<string, string | number | boolean>;
}

export function setError(span: any, spanStatusCode: number, message?: string) {
  const safeMessage = message ? redactSensitiveText(message) : "unknown";
  span.setStatus({ code: spanStatusCode, message: safeMessage });
}

export function addEvent(span: any, name: string, attrs?: Record<string, string | number | boolean>) {
  span.addEvent(
    name,
    attrs
      ? traceAttrs(attrs as Record<string, string | number | boolean | undefined>)
      : attrs,
  );
}

export function endSpanSafely(span: any, endTime?: Date) {
  if (!span) {
    return;
  }
  try {
    if (endTime) {
      span.end(endTime);
      return;
    }
    span.end();
  } catch {
    // Ignore duplicate end attempts.
  }
}

export function clipPreview(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const normalized = stripAnsiEscapeCodes(text).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  const clipped = normalized.length > PREVIEW_LIMIT
    ? `${normalized.slice(0, PREVIEW_LIMIT - 3)}...`
    : normalized;
  return redactSensitiveText(clipped);
}

export function summarizeToolCallOutput(toolNames: string[]): string | undefined {
  const normalized = toolNames
    .map((name) => name.trim())
    .filter(Boolean);
  if (normalized.length === 0) {
    return undefined;
  }
  if (normalized.length === 1) {
    return clipPreview(`toolCall:${normalized[0]}`);
  }
  return clipPreview(`toolCall:${normalized.join(",")}`);
}

export function normalizeUserInputPreview(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  let normalized = stripAnsiEscapeCodes(text).trim();
  if (!normalized) {
    return undefined;
  }

  normalized = normalized
    .replace(/^Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/i, "")
    .replace(/^\[[^\]]+\]\s*/, "")
    .trim();

  return clipPreview(normalized) ?? clipPreview(text);
}

export function normalizeReasoningPreview(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const normalized = stripAnsiEscapeCodes(text).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }

  const sentences = normalized
    .split(/(?<=[。！？.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const deduped: string[] = [];
  for (const sentence of sentences) {
    const previous = deduped[deduped.length - 1];
    if (previous && previous === sentence) {
      continue;
    }
    deduped.push(sentence);
  }

  const compact = deduped.join(" ").trim();
  if (!compact) {
    return undefined;
  }
  const clipped = compact.length > REASONING_PREVIEW_LIMIT
    ? `${compact.slice(0, REASONING_PREVIEW_LIMIT - 3)}...`
    : compact;
  return redactSensitiveText(clipped);
}

export function clipValuePreview(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return clipPreview(value);
  }
  try {
    return clipPreview(JSON.stringify(value));
  } catch {
    return clipPreview(String(value));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function summarizeToolArgKeys(args: unknown): string | undefined {
  if (!isRecord(args)) {
    return undefined;
  }
  const keys = Object.keys(args).sort();
  return keys.length > 0 ? keys.join(", ") : undefined;
}

function extractUrlLikeTarget(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s"'`]+/i);
  if (!match) {
    return undefined;
  }
  const candidate = match[0];
  try {
    const url = new URL(candidate);
    return clipPreview(`${url.host}${url.pathname}${url.search}`);
  } catch {
    return clipPreview(candidate);
  }
}

function extractPathLikeTarget(text: string): string | undefined {
  const match = text.match(/(?:~|\/)[^\s"'`]+/);
  return match ? clipPreview(match[0]) : undefined;
}

function extractExecTarget(command: string): string | undefined {
  const urlTarget = extractUrlLikeTarget(command);
  if (urlTarget) {
    return urlTarget;
  }
  const pathTarget = extractPathLikeTarget(command);
  if (pathTarget) {
    return pathTarget;
  }
  const compact = command.trim().replace(/\s+/g, " ");
  if (!compact) {
    return undefined;
  }
  const match = compact.match(/^([^\s]+)\s+(.+)$/);
  if (!match) {
    return clipPreview(compact);
  }
  const [, executable, remainder] = match;
  const firstArg = remainder.match(/^("[^"]+"|'[^']+'|`[^`]+`|[^\s]+)/)?.[0];
  const normalizedArg = firstArg?.replace(/^["'`]|["'`]$/g, "");
  return clipPreview(normalizedArg || executable);
}

export function extractToolTarget(toolName: string, args: unknown, meta: unknown): string | undefined {
  const normalizedToolName = toolName.trim().toLowerCase();
  const argsRecord = isRecord(args) ? args : undefined;
  const metaPreview = clipValuePreview(meta);

  if (normalizedToolName === "exec" && typeof argsRecord?.command === "string") {
    return extractExecTarget(argsRecord.command);
  }
  if (normalizedToolName === "process") {
    if (typeof argsRecord?.sessionId === "string") return argsRecord.sessionId;
    if (typeof argsRecord?.action === "string") return argsRecord.action;
  }
  if (normalizedToolName === "read" && typeof argsRecord?.path === "string") {
    return argsRecord.path;
  }
  if (normalizedToolName === "write" && typeof argsRecord?.path === "string") {
    return argsRecord.path;
  }
  if (normalizedToolName === "edit" && typeof argsRecord?.path === "string") {
    return argsRecord.path;
  }
  if (normalizedToolName === "grep" && typeof argsRecord?.pattern === "string") {
    return argsRecord.pattern;
  }
  if (normalizedToolName === "glob" && typeof argsRecord?.pattern === "string") {
    return argsRecord.pattern;
  }
  return metaPreview;
}

export function extractToolCommand(toolName: string, args: unknown): string | undefined {
  const normalizedToolName = toolName.trim().toLowerCase();
  const argsRecord = isRecord(args) ? args : undefined;
  if (normalizedToolName === "exec" && typeof argsRecord?.command === "string") {
    return clipPreview(argsRecord.command);
  }
  return undefined;
}

export function extractToolResultStatus(result: unknown): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }
  if (isRecord(result.details) && typeof result.details.status === "string") {
    return result.details.status;
  }
  if (typeof result.status === "string") {
    return result.status;
  }
  return undefined;
}

export function buildToolAttrs(
  toolName: string,
  toolCallId: string,
  options?: {
    args?: unknown;
    meta?: unknown;
    result?: unknown;
    partialResult?: unknown;
    phase?: string;
    outcome?: string;
    skillName?: string;
  },
): Record<string, string | number | boolean | undefined> {
  return {
    "span.kind": "tool",
    "openclaw.tool.name": toolName,
    "openclaw.tool.call_id": toolCallId,
    "openclaw.skill.name": options?.skillName,
    "openclaw.tool.phase": options?.phase,
    "openclaw.tool.outcome": options?.outcome,
    "openclaw.tool.arg_keys": summarizeToolArgKeys(options?.args),
    "openclaw.tool.target": extractToolTarget(toolName, options?.args, options?.meta),
    "openclaw.tool.command": extractToolCommand(toolName, options?.args),
    "openclaw.tool.args.preview": clipValuePreview(options?.args),
    "openclaw.tool.meta.preview": clipValuePreview(options?.meta),
    "openclaw.tool.result.preview": clipValuePreview(options?.result),
    "openclaw.tool.partial_result.preview": clipValuePreview(options?.partialResult),
    "openclaw.tool.result_status": extractToolResultStatus(options?.result ?? options?.partialResult),
  };
}

export function collectToolSummaryValues(
  toolName: string,
  options?: {
    args?: unknown;
    meta?: unknown;
    result?: unknown;
    partialResult?: unknown;
  },
) {
  return {
    target: extractToolTarget(toolName, options?.args, options?.meta),
    command: extractToolCommand(toolName, options?.args),
    resultStatus: extractToolResultStatus(options?.result ?? options?.partialResult),
  };
}

export function buildRequestMetricAttrs(
  snapshot: SessionSnapshot | undefined,
  summaryAttrs?: Record<string, string | number | boolean>,
) {
  return stringAttrs({
    "openclaw.channel": snapshot?.lastChannel,
    "openclaw.chat_type": snapshot?.chatType,
    "openclaw.provider": snapshot?.lastProvider,
    "openclaw.model": snapshot?.lastModel,
    "openclaw.final_state":
      typeof summaryAttrs?.["openclaw.final_state"] === "string"
        ? summaryAttrs["openclaw.final_state"]
        : typeof summaryAttrs?.["openclaw.state"] === "string"
          ? summaryAttrs["openclaw.state"]
          : undefined,
    "openclaw.outcome":
      typeof summaryAttrs?.["openclaw.outcome"] === "string"
        ? summaryAttrs["openclaw.outcome"]
        : typeof summaryAttrs?.["openclaw.final_reason"] === "string"
          ? summaryAttrs["openclaw.final_reason"]
          : typeof summaryAttrs?.["openclaw.reason"] === "string"
            ? summaryAttrs["openclaw.reason"]
            : undefined,
  });
}

export function buildGenAiAgentRequestMetricAttrs(
  snapshot: SessionSnapshot | undefined,
  summaryAttrs?: Record<string, string | number | boolean>,
) {
  return stringAttrs({
    channel: snapshot?.lastChannel,
    session_id: snapshot?.sessionId,
    provider_name: snapshot?.lastProvider,
    request_model: snapshot?.lastModel,
    session_state:
      typeof summaryAttrs?.["openclaw.final_state"] === "string"
        ? summaryAttrs["openclaw.final_state"]
        : typeof summaryAttrs?.["openclaw.state"] === "string"
          ? summaryAttrs["openclaw.state"]
          : undefined,
    outcome:
      typeof summaryAttrs?.["openclaw.outcome"] === "string"
        ? summaryAttrs["openclaw.outcome"]
        : typeof summaryAttrs?.["openclaw.final_reason"] === "string"
          ? summaryAttrs["openclaw.final_reason"]
          : typeof summaryAttrs?.["openclaw.reason"] === "string"
            ? summaryAttrs["openclaw.reason"]
            : undefined,
  });
}

export function buildToolMetricAttrs(
  tool: Pick<ActiveToolSpan, "name" | "skillName">,
  outcome?: string,
  resultStatus?: string,
) {
  return stringAttrs({
    "openclaw.tool_name": tool.name,
    "openclaw.skill_name": tool.skillName,
    "openclaw.tool_outcome": outcome,
    "openclaw.tool_result_status": resultStatus,
  });
}

export function buildGenAiClientToolMetricAttrs(
  tool: Pick<ActiveToolSpan, "name" | "skillName">,
  outcome?: string,
  resultStatus?: string,
  sessionId?: string,
) {
  return stringAttrs({
    operation_name: "execute_tool",
    session_id: sessionId,
    tool_name: tool.name,
    skill_name: tool.skillName,
    outcome,
    tool_result_status: resultStatus,
  });
}

export function buildSkillMetricAttrs(skillName: string, source: "runtime" | "transcript") {
  return stringAttrs({
    "openclaw.skill_name": skillName,
    "openclaw.skill_source": source,
  });
}

export function buildGenAiAgentSkillMetricAttrs(
  skillName: string,
  source: "runtime" | "transcript",
  sessionId?: string,
) {
  return stringAttrs({
    session_id: sessionId,
    skill_name: skillName,
    skill_source: source,
  });
}

export function buildModelMetricAttrs(provider?: string, model?: string) {
  return stringAttrs({
    "openclaw.provider": provider,
    "openclaw.model": model,
  });
}

export function buildGenAiClientModelMetricAttrs(
  provider?: string,
  model?: string,
  extra?: Record<string, string | number | boolean | undefined>,
) {
  return stringAttrs({
    operation_name: "chat",
    provider_name: provider,
    request_model: model,
    response_model: model,
    ...(extra ?? {}),
  });
}

export function resolveSessionMetricTotals(snapshot: SessionSnapshot | undefined): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  traceCount: number;
} {
  const usageTotals = snapshot?.sessionUsageTotals;
  return {
    inputTokens: usageTotals?.input ?? 0,
    outputTokens: usageTotals?.output ?? 0,
    totalTokens: usageTotals?.totalTokens ?? 0,
    traceCount: snapshot?.traceCount ?? 0,
  };
}

export function buildSessionMetricAttrs(
  snapshot: SessionSnapshot | undefined,
  sessionKey: string,
  overrides?: {
    modelProvider?: string;
    modelName?: string;
  },
) {
  return stringAttrs({
    session_id: snapshot?.sessionId,
    session_key: sessionKey,
    model_provider: overrides?.modelProvider ?? snapshot?.lastProvider,
    model_name: overrides?.modelName ?? snapshot?.lastModel,
  });
}

export function buildGenAiAgentSessionMetricAttrs(
  snapshot: SessionSnapshot | undefined,
  sessionKey: string,
  overrides?: {
    modelProvider?: string;
    modelName?: string;
    tokenType?: string;
  },
) {
  return stringAttrs({
    session_id: snapshot?.sessionId,
    session_key: sessionKey,
    provider_name: overrides?.modelProvider ?? snapshot?.lastProvider,
    request_model: overrides?.modelName ?? snapshot?.lastModel,
    token_type: overrides?.tokenType,
  });
}

export function computeSessionMetricDelta(
  current: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    traceCount: number;
  },
  previous?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    traceCount: number;
  },
): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  traceCount: number;
} {
  if (!previous) {
    return current;
  }
  return {
    inputTokens:
      current.inputTokens >= previous.inputTokens
        ? current.inputTokens - previous.inputTokens
        : current.inputTokens,
    outputTokens:
      current.outputTokens >= previous.outputTokens
        ? current.outputTokens - previous.outputTokens
        : current.outputTokens,
    totalTokens:
      current.totalTokens >= previous.totalTokens
        ? current.totalTokens - previous.totalTokens
        : current.totalTokens,
    traceCount:
      current.traceCount >= previous.traceCount
        ? current.traceCount - previous.traceCount
        : current.traceCount,
  };
}

export function buildDiagnosticsModelMetricAttrs(
  channel?: string,
  provider?: string,
  model?: string,
  extra?: Record<string, string | number | boolean | undefined>,
) {
  return stringAttrs({
    "openclaw.channel": channel,
    "openclaw.provider": provider,
    "openclaw.model": model,
    ...(extra ?? {}),
  });
}

export function buildDiagnosticsWebhookMetricAttrs(channel?: string, webhook?: string) {
  return stringAttrs({
    "openclaw.channel": channel,
    "openclaw.webhook": webhook,
  });
}

export function buildGenAiRuntimeWebhookMetricAttrs(channel?: string, webhook?: string) {
  return stringAttrs({
    channel,
    webhook_name: webhook,
  });
}

export function buildDiagnosticsMessageMetricAttrs(
  channel?: string,
  extra?: Record<string, string | number | boolean | undefined>,
) {
  return stringAttrs({
    "openclaw.channel": channel,
    ...(extra ?? {}),
  });
}

export function buildGenAiRuntimeMessageMetricAttrs(
  channel?: string,
  sessionId?: string,
  extra?: Record<string, string | number | boolean | undefined>,
) {
  return stringAttrs({
    channel,
    session_id: sessionId,
    ...(extra ?? {}),
  });
}

export function buildDiagnosticsQueueMetricAttrs(
  lane?: string,
  extra?: Record<string, string | number | boolean | undefined>,
) {
  return stringAttrs({
    "openclaw.lane": lane,
    ...(extra ?? {}),
  });
}

export function buildGenAiRuntimeQueueMetricAttrs(
  lane?: string,
  sessionId?: string,
  extra?: Record<string, string | number | boolean | undefined>,
) {
  return stringAttrs({
    queue_name: lane,
    session_id: sessionId,
    ...(extra ?? {}),
  });
}

export function buildDiagnosticsSessionMetricAttrs(
  state?: string,
  reason?: string,
  extra?: Record<string, string | number | boolean | undefined>,
) {
  return stringAttrs({
    "openclaw.state": state,
    "openclaw.reason": reason,
    ...(extra ?? {}),
  });
}

export function buildGenAiRuntimeSessionMetricAttrs(
  state?: string,
  reason?: string,
  sessionId?: string,
  extra?: Record<string, string | number | boolean | undefined>,
) {
  return stringAttrs({
    session_id: sessionId,
    session_state: state,
    outcome: reason,
    ...(extra ?? {}),
  });
}

export function mergeToolIdentity(
  tool: Pick<ActiveToolSpan, "name" | "argKeys" | "target" | "command">,
  options?: { args?: unknown; meta?: unknown; result?: unknown; partialResult?: unknown },
) {
  const summary = collectToolSummaryValues(tool.name, options);
  return {
    argKeys: tool.argKeys ?? summarizeToolArgKeys(options?.args),
    target: tool.target ?? summary.target,
    command: tool.command ?? summary.command,
    resultStatus: summary.resultStatus,
  };
}

export function inferSkillNameFromTool(toolName: string | undefined): string | undefined {
  if (!toolName) {
    return undefined;
  }
  const normalized = toolName.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith("feishu_doc")) return "feishu-doc";
  if (normalized.startsWith("feishu_drive")) return "feishu-drive";
  if (normalized.startsWith("feishu_wiki")) return "feishu-wiki";
  if (normalized.startsWith("feishu_perm")) return "feishu-perm";
  if (normalized === "weather" || normalized.startsWith("weather_")) return "weather";
  if (normalized.includes("weekly") && normalized.includes("report")) return "weekly-report-merger";
  if (normalized.includes("skill") && normalized.includes("creator")) return "skill-creator";
  if (normalized.includes("codex") || normalized.includes("claude") || normalized.includes("sessions_spawn")) {
    return "coding-agent";
  }
  return undefined;
}

function inferSkillNameFromSkillPath(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const normalized = text.trim().replace(/\\/g, "/").toLowerCase();
  const match = normalized.match(/\/workspace\/skills\/([^/\s"'`]+)/);
  if (!match) {
    return undefined;
  }
  return match[1]?.trim();
}

function inferSkillNameFromContextText(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const normalized = text.trim().replace(/\\/g, "/").toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (/(^|[\/_\-\s])dashboard([\/_\-\s.]|$)/.test(normalized)) {
    return "dashboard";
  }
  return undefined;
}

export function inferSkillNameFromToolIdentity(
  toolName: string | undefined,
  target?: string,
  command?: string,
): string | undefined {
  return (
    inferSkillNameFromTool(toolName)
    ?? inferSkillNameFromSkillPath(target)
    ?? inferSkillNameFromSkillPath(command)
    ?? inferSkillNameFromContextText(target)
    ?? inferSkillNameFromContextText(command)
  );
}

export function uniqStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized) {
      continue;
    }
    seen.add(normalized);
  }
  return Array.from(seen);
}

function splitAliasCandidates(text: string | undefined): string[] {
  if (!text?.trim()) {
    return [];
  }
  return uniqStrings(
    text
      .split(/[\n,，。.!！？;；:：()（）]+/g)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2 && part.length <= 32),
  );
}

export function extractFrontmatter(source: string): Record<string, string> {
  const match = source.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return {};
  }
  const record: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key && value) {
      record[key] = value;
    }
  }
  return record;
}

export function buildSkillCatalogEntry(
  name: string,
  description?: string,
  extraAliases?: string[],
): SkillCatalogEntry {
  return {
    name,
    aliases: uniqStrings([name, ...(extraAliases ?? []), ...splitAliasCandidates(description)]),
  };
}

export function skillSpanName(skillName: string): string {
  return `skill:${skillName}`;
}

export function skillCallSpanName(skillName: string): string {
  return `skill_call:${skillName}`;
}

export function extractMentionedSkillNames(
  text: string | undefined,
  availableSkills?: SkillCatalogEntry[],
): string[] {
  if (!text?.trim()) {
    return [];
  }
  const found = new Set<string>();
  const normalizedText = text.toLowerCase();
  for (const skill of availableSkills ?? []) {
    if (!skill?.name?.trim()) {
      continue;
    }
    for (const alias of skill.aliases) {
      if (!alias?.trim()) {
        continue;
      }
      if (normalizedText.includes(alias.toLowerCase())) {
        found.add(skill.name);
        break;
      }
    }
  }
  return Array.from(found);
}

export function extractContentText(content: unknown, kind: "text" | "thinking"): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const joined = content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const record = item as Record<string, unknown>;
      if (record.type !== kind) {
        return "";
      }
      const value = typeof record[kind] === "string" ? record[kind] : "";
      return value;
    })
    .filter(Boolean)
    .join("\n");
  return joined.trim() || undefined;
}

export function readJsonLines(filePath: string): Array<Record<string, unknown>> {
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {};
      }
    })
    .filter((line) => Object.keys(line).length > 0);
}
