import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripAnsiEscapeCodes } from "./trace-runtime.js";
import type {
  ActiveRunSpan,
  ActiveToolSpan,
  RunAggregate,
  RuntimeMetadata,
  SessionSnapshot,
  SkillCatalogEntry,
  SkillSourceType,
} from "./service-types.js";

const PREVIEW_LIMIT = 1200;
const REASONING_PREVIEW_LIMIT = 360;
const REPLAY_FINALIZATION_STATE_VERSION = 1;
const REPLAY_FINALIZATION_STATE_MAX_SESSIONS = 2048;

export const MIN_VISIBLE_CHILD_MS = 120;
export const MIN_VISIBLE_MODEL_MS = 800;
export const MAX_OPENCLAW_THINKING_MS = 1500;

const HEARTBEAT_REQUEST_TEXT = "[OpenClaw heartbeat poll]";
const HEARTBEAT_RESPONSE_TEXT = "HEARTBEAT_OK";
const RUNTIME_CONTINUE_REQUEST_TEXT = "Continue the OpenClaw runtime event.";

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

export function resolveUsageTokenTotals(
  usage:
    | {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
      totalTokens?: number;
    }
    | undefined,
): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
} {
  const inputTokens = typeof usage?.input === "number" ? usage.input : 0;
  const outputTokens = typeof usage?.output === "number" ? usage.output : 0;
  const cacheReadTokens = typeof usage?.cacheRead === "number" ? usage.cacheRead : 0;
  const cacheWriteTokens = typeof usage?.cacheWrite === "number" ? usage.cacheWrite : 0;
  const rawTotalTokens = typeof usage?.totalTokens === "number"
    ? usage.totalTokens
    : typeof usage?.total === "number"
      ? usage.total
      : 0;
  const totalTokens = inputTokens > 0 || outputTokens > 0
    ? inputTokens + outputTokens
    : rawTotalTokens;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
  };
}

export function createRunState(ctx: any, mainStartTs: number, startedAt = Date.now()): ActiveRunSpan {
  return {
    span: null,
    ctx,
    runIds: new Set(),
    startedAt,
    lastTouchedAt: startedAt,
    mainStartTs,
    orchestrationCursorTs: mainStartTs,
    dispatchQueueEmitted: false,
    sessionProcessingEmitted: false,
    runtimeLifecycleSpans: [],
    modelSpanEmitted: false,
    thinkingSpanEmitted: false,
    transcriptAssistantTurnsEmitted: 0,
    transcriptToolCallIds: new Set<string>(),
    observedToolCallIds: new Set<string>(),
    finalAttrsApplied: false,
    aggregate: createRunAggregate(),
    usedSkillNames: new Set<string>(),
    usedToolNames: new Set<string>(),
    usedToolTargets: new Set<string>(),
    usedToolCommands: new Set<string>(),
    usedToolResultStatuses: new Set<string>(),
    skillSpans: new Map(),
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

export function loadSnapshotForEvent(
  evt: { sessionKey?: string; sessionId?: string },
  loadSessionSnapshot: (sessionKey: string | undefined) => SessionSnapshot | undefined,
  resolveSessionKey?: (evt: { sessionKey?: string; sessionId?: string }) => string | undefined,
): SessionSnapshot | undefined {
  const directSessionKey = typeof evt.sessionKey === "string" && evt.sessionKey.trim()
    ? evt.sessionKey.trim()
    : undefined;
  if (directSessionKey) {
    return loadSessionSnapshot(directSessionKey);
  }
  const resolvedSessionKey = resolveSessionKey?.(evt);
  if (typeof resolvedSessionKey === "string" && resolvedSessionKey.trim()) {
    return loadSessionSnapshot(resolvedSessionKey.trim());
  }
  return undefined;
}

export function isHeartbeatSessionSnapshot(snapshot: SessionSnapshot | undefined): boolean {
  return resolveRequestClassification({
    lastUserText: snapshot?.lastUserText,
    lastAssistantText: snapshot?.lastAssistantText,
    inputPreview: snapshot?.lastRunAssistantTurns?.at(-1)?.inputPreview,
    outputPreview: snapshot?.lastRunAssistantTurns?.at(-1)?.outputPreview,
  }).requestCategory === "heartbeat";
}

export function normalizeFinalStatus(rawStatus: string | undefined): string | undefined {
  const raw = typeof rawStatus === "string" ? rawStatus.trim().toLowerCase() : "";
  if (!raw) {
    return undefined;
  }
  if (raw === "success" || raw === "completed") {
    return "completed";
  }
  if (raw === "error" || raw === "failed" || raw === "failure") {
    return "error";
  }
  if (raw === "cancelled" || raw === "canceled") {
    return "cancelled";
  }
  if (raw === "timeout" || raw === "timed_out" || raw === "timed-out") {
    return "timeout";
  }
  if (raw === "superseded" || raw === "superseded_by_next_message") {
    return "superseded";
  }
  return raw;
}

export function resolveRequestClassification(input: {
  lastUserText?: string;
  lastAssistantText?: string;
  inputPreview?: string;
  outputPreview?: string;
}): {
  requestType: "user_request" | "internal_request";
  requestCategory?: "heartbeat" | "runtime_continue";
  isInternalRequest: boolean;
} {
  const normalizedInputs = [
    input.lastUserText,
    input.inputPreview,
  ]
    .map((value) => normalizeUserInputPreview(value) ?? value?.trim())
    .filter((value): value is string => Boolean(value));
  const normalizedOutputs = [
    input.lastAssistantText,
    input.outputPreview,
  ]
    .map((value) => clipPreview(value) ?? value?.trim())
    .filter((value): value is string => Boolean(value));

  if (
    normalizedInputs.includes(HEARTBEAT_REQUEST_TEXT)
    || normalizedOutputs.includes(HEARTBEAT_RESPONSE_TEXT)
  ) {
    return {
      requestType: "internal_request",
      requestCategory: "heartbeat",
      isInternalRequest: true,
    };
  }

  if (normalizedInputs.includes(RUNTIME_CONTINUE_REQUEST_TEXT)) {
    return {
      requestType: "internal_request",
      requestCategory: "runtime_continue",
      isInternalRequest: true,
    };
  }

  return {
    requestType: "user_request",
    isInternalRequest: false,
  };
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

export function buildTranscriptReplayEvent(
  sessionKey: string,
  snapshot: Pick<SessionSnapshot, "sessionId" | "runId" | "lastAssistantTs" | "lastChannel">,
): {
  sessionKey: string;
  sessionId?: string;
  runId?: string;
  ts?: number;
  channel?: string;
} {
  return {
    sessionKey,
    sessionId: snapshot.sessionId,
    runId: snapshot.runId,
    ts: snapshot.lastAssistantTs,
    channel: snapshot.lastChannel,
  };
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function resolveTranscriptReplayActivityTs(
  snapshot: Pick<SessionSnapshot, "lastAssistantTs" | "lastRunToolCalls" | "lastRunAssistantTurns"> | undefined,
): number | undefined {
  const candidates = [
    snapshot?.lastAssistantTs,
    ...(snapshot?.lastRunToolCalls ?? []).flatMap((toolCall) => [toolCall.startedAt, toolCall.endedAt]),
    ...(snapshot?.lastRunAssistantTurns ?? []).flatMap((turn) => [turn.startedAt, turn.endedAt]),
  ].filter(isFiniteTimestamp);
  if (candidates.length === 0) {
    return undefined;
  }
  return Math.max(...candidates);
}

export function resolveTranscriptReplayFreshness(options: {
  snapshot: Pick<SessionSnapshot, "lastAssistantTs" | "lastRunToolCalls" | "lastRunAssistantTurns"> | undefined;
  activeRun?: Pick<ActiveRunSpan, "mainStartTs" | "messageQueuedTs"> | undefined;
  fallbackTs?: number;
  backfillWindowMs?: number;
}): boolean | undefined {
  const replayActivityTs = resolveTranscriptReplayActivityTs(options.snapshot);
  if (!isFiniteTimestamp(replayActivityTs)) {
    return undefined;
  }
  const minRequestTs = isFiniteTimestamp(options.activeRun?.messageQueuedTs)
    ? options.activeRun.messageQueuedTs
    : isFiniteTimestamp(options.activeRun?.mainStartTs)
      ? options.activeRun.mainStartTs
      : undefined;
  if (isFiniteTimestamp(minRequestTs)) {
    return replayActivityTs >= minRequestTs;
  }
  if (isFiniteTimestamp(options.fallbackTs)) {
    return replayActivityTs >= (options.fallbackTs - (options.backfillWindowMs ?? 5 * 60 * 1000));
  }
  return true;
}

export function resolveTranscriptReplayPlan(options: {
  hasActiveTrace: boolean;
  replayAlreadyFinalized: boolean;
  runCompleted: boolean;
  replaySnapshotFresh?: boolean;
}): {
  emitReplay: boolean;
  markFinalizationOnly: boolean;
} {
  if (options.replaySnapshotFresh === false) {
    return {
      emitReplay: false,
      markFinalizationOnly: false,
    };
  }
  if (options.hasActiveTrace) {
    return {
      emitReplay: true,
      markFinalizationOnly: false,
    };
  }
  if (options.replayAlreadyFinalized) {
    return {
      emitReplay: false,
      markFinalizationOnly: false,
    };
  }
  return {
    emitReplay: options.runCompleted,
    markFinalizationOnly: false,
  };
}

export function resolveReplayFinalizationStateFile(stateDir: string): string {
  return path.join(stateDir, "plugins", "openclaw-otel-plugin", "replay-finalization-state.json");
}

export function readReplayFinalizationState(filePath: string): Map<string, {
  watermark?: string;
  trajectorySourceSeq?: number;
  pendingRunIds?: string[];
  updatedAt?: number;
}> {
  const entries = new Map<string, {
    watermark?: string;
    trajectorySourceSeq?: number;
    pendingRunIds?: string[];
    updatedAt?: number;
  }>();
  try {
    if (!fs.existsSync(filePath)) {
      return entries;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as {
      sessions?: Record<string, {
        watermark?: unknown;
        trajectorySourceSeq?: unknown;
        pendingRunIds?: unknown;
        updatedAt?: unknown;
      }>;
    };
    for (const [sessionKey, value] of Object.entries(parsed.sessions ?? {})) {
      const watermark = typeof value?.watermark === "string" && value.watermark.trim()
        ? value.watermark
        : undefined;
      const trajectorySourceSeq = typeof value?.trajectorySourceSeq === "number"
        && Number.isFinite(value.trajectorySourceSeq)
        ? value.trajectorySourceSeq
        : undefined;
      const pendingRunIds = Array.isArray(value?.pendingRunIds)
        ? value.pendingRunIds
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .slice(0, 16)
        : undefined;
      const updatedAt = typeof value?.updatedAt === "number" && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : undefined;
      if (!watermark && trajectorySourceSeq === undefined && !pendingRunIds?.length) {
        continue;
      }
      entries.set(sessionKey, { watermark, trajectorySourceSeq, pendingRunIds, updatedAt });
    }
  } catch {
    return new Map();
  }
  return entries;
}

export function writeReplayFinalizationState(
  filePath: string,
  entries: Map<string, {
    watermark?: string;
    trajectorySourceSeq?: number;
    pendingRunIds?: string[];
    updatedAt?: number;
  }>,
): void {
  const normalizedSessions = Array.from(entries.entries())
    .filter(([, value]) => Boolean(
      value?.watermark
      || value?.trajectorySourceSeq !== undefined
      || value?.pendingRunIds?.length,
    ))
    .sort((left, right) => (right[1].updatedAt ?? 0) - (left[1].updatedAt ?? 0))
    .slice(0, REPLAY_FINALIZATION_STATE_MAX_SESSIONS);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      version: REPLAY_FINALIZATION_STATE_VERSION,
      sessions: Object.fromEntries(normalizedSessions.map(([sessionKey, value]) => [
        sessionKey,
        {
          ...(value.watermark ? { watermark: value.watermark } : {}),
          ...(typeof value.trajectorySourceSeq === "number"
            ? { trajectorySourceSeq: value.trajectorySourceSeq }
            : {}),
          ...(value.pendingRunIds?.length
            ? { pendingRunIds: value.pendingRunIds.slice(0, 16) }
            : {}),
          ...(typeof value.updatedAt === "number" ? { updatedAt: value.updatedAt } : {}),
        },
      ])),
    }, null, 2));
  } catch {
    // Best-effort persistence only; replay dedupe still works in-memory.
  }
}

export function rememberRunId(
  state: {
    runId?: string;
    runIds?: Set<string>;
  },
  nextRunId?: string,
): boolean {
  const normalizedRunId = typeof nextRunId === "string" ? nextRunId.trim() : "";
  if (!normalizedRunId) {
    return false;
  }
  let changed = false;
  if (!state.runId) {
    state.runId = normalizedRunId;
    changed = true;
  }
  if (!state.runIds) {
    state.runIds = new Set<string>();
  }
  const sizeBefore = state.runIds.size;
  state.runIds.add(normalizedRunId);
  return changed || state.runIds.size !== sizeBefore;
}

export function buildRunScopeAttrs(
  primaryRunId?: string,
  ...runIdSources: Array<string | Iterable<string> | undefined>
): {
  run_id?: string;
  run_ids?: string;
} {
  const seen = new Set<string>();
  const orderedRunIds: string[] = [];
  const push = (value: string | undefined) => {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    orderedRunIds.push(normalized);
  };
  push(primaryRunId);
  for (const source of runIdSources) {
    if (!source) {
      continue;
    }
    if (typeof source === "string") {
      push(source);
      continue;
    }
    for (const value of source) {
      push(value);
    }
  }
  const resolvedPrimaryRunId = orderedRunIds[0];
  return {
    run_id: resolvedPrimaryRunId,
    run_ids: orderedRunIds.length > 0 ? orderedRunIds.join(",") : undefined,
  };
}

export function shouldFallbackRunBoundEventToActiveRequest(
  options: {
    runId?: string;
    eventTs?: number;
    activeRequestStartedAt?: number;
  },
): boolean {
  const normalizedRunId = typeof options.runId === "string" ? options.runId.trim() : "";
  if (!normalizedRunId) {
    return true;
  }
  if (
    typeof options.eventTs !== "number"
    || !Number.isFinite(options.eventTs)
    || typeof options.activeRequestStartedAt !== "number"
    || !Number.isFinite(options.activeRequestStartedAt)
  ) {
    return false;
  }
  return options.eventTs >= options.activeRequestStartedAt;
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

const OFFICIAL_GEN_AI_ATTR_KEYS = new Set([
  "gen_ai.agent.version",
  "gen_ai.conversation.id",
  "gen_ai.input.messages",
  "gen_ai.operation.name",
  "gen_ai.output.messages",
  "gen_ai.output.type",
  "gen_ai.provider.name",
  "gen_ai.request.model",
  "gen_ai.response.model",
  "gen_ai.skill.name",
  "gen_ai.token.type",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.id",
  "gen_ai.tool.call.result",
  "gen_ai.tool.name",
  "gen_ai.usage.cache_creation.input_tokens",
  "gen_ai.usage.cache_read.input_tokens",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
]);

function setIfMissing(
  target: Record<string, string | number | boolean | undefined>,
  key: string,
  value: string | number | boolean | undefined,
) {
  if (value === undefined || value === "") {
    return;
  }
  if (target[key] === undefined || target[key] === "") {
    target[key] = value;
  }
}

function mapGenAiOperationName(
  value: string | number | boolean | undefined,
  options?: { allowCustom?: boolean },
): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return undefined;
  }
  switch (normalized) {
    case "model":
      return "chat";
    case "tool":
    case "skill":
      return "execute_tool";
    case "agent":
      return "invoke_agent";
    case "request":
      return "invoke_workflow";
    case "agent_plan":
    case "planning":
      return "plan";
    default:
      return options?.allowCustom === false ? undefined : normalized;
  }
}

function inferGenAiOperationName(
  attrs: Record<string, string | number | boolean | undefined>,
): string | undefined {
  const explicit = mapGenAiOperationName(attrs["gen_ai.operation.name"]);
  if (explicit) {
    return explicit;
  }
  const metricOperation = mapGenAiOperationName(attrs.operation_name);
  if (metricOperation) {
    return metricOperation;
  }
  const spanKind = typeof attrs["span.kind"] === "string" ? attrs["span.kind"] : undefined;
  if (spanKind) {
    const spanOperation = mapGenAiOperationName(spanKind, { allowCustom: false });
    if (spanOperation) {
      return spanOperation;
    }
  }
  const runtimePhase = mapGenAiOperationName(attrs.runtime_phase, { allowCustom: false });
  return runtimePhase === "plan" ? runtimePhase : undefined;
}

function normalizeGenAiTokenType(value: string | number | boolean | undefined): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return undefined;
  }
  return normalized;
}

function mapGenAiOutputType(value: string | number | boolean | undefined): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized === "text" || normalized === "json" || normalized === "image" || normalized === "speech") {
    return normalized;
  }
  return undefined;
}

function stringifyGenAiJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function stringValue(value: string | number | boolean | undefined): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  return String(value);
}

function inferGenAiFinishReason(
  attrs: Record<string, string | number | boolean | undefined>,
): string {
  const status = stringValue(attrs.final_status ?? attrs.outcome ?? attrs.tool_result_status)?.toLowerCase();
  if (status === "error" || status === "timeout" || status === "cancelled" || status === "canceled") {
    return "error";
  }
  if (attrs.output_kind === "tool_call" || attrs.tool_call_id || attrs.tool_name) {
    return "tool_call";
  }
  return "stop";
}

function buildGenAiInputMessages(
  attrs: Record<string, string | number | boolean | undefined>,
): string | undefined {
  const content = stringValue(attrs.input_preview);
  if (!content) {
    return undefined;
  }
  return stringifyGenAiJson([{
    role: "user",
    parts: [{ type: "text", content }],
  }]);
}

function buildGenAiOutputMessages(
  attrs: Record<string, string | number | boolean | undefined>,
): string | undefined {
  const outputPreview = stringValue(attrs.output_preview);
  const outputSummary = stringValue(attrs.output_summary);
  if (!outputPreview && !outputSummary) {
    return undefined;
  }

  const parts: Array<Record<string, string | null | Record<string, string>>> = [];
  const toolName = stringValue(attrs.tool_name);
  if (attrs.output_kind === "tool_call" && toolName) {
    parts.push({
      type: "tool_call",
      id: stringValue(attrs.tool_call_id) ?? null,
      name: toolName,
      arguments: stringValue(attrs.tool_args_preview) ?? outputPreview ?? "",
    });
  } else if (outputPreview) {
    parts.push({ type: "text", content: outputPreview });
  }
  if (outputSummary) {
    parts.push({ type: "reasoning", content: outputSummary });
  }
  if (parts.length === 0) {
    return undefined;
  }
  return stringifyGenAiJson([{
    role: "assistant",
    parts,
    finish_reason: inferGenAiFinishReason(attrs),
  }]);
}

function withOfficialGenAiSemanticAttrs(
  attrs: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean | undefined> {
  const next = { ...attrs };
  const responseModel = next.response_model ?? next.request_model;

  setIfMissing(next, "gen_ai.operation.name", inferGenAiOperationName(next));
  setIfMissing(next, "gen_ai.provider.name", next.provider_name);
  setIfMissing(next, "gen_ai.request.model", next.request_model);
  setIfMissing(next, "gen_ai.response.model", responseModel);
  setIfMissing(next, "gen_ai.conversation.id", next.session_id);
  setIfMissing(next, "gen_ai.token.type", normalizeGenAiTokenType(next.token_type));
  setIfMissing(next, "gen_ai.output.type", mapGenAiOutputType(next.output_kind));
  setIfMissing(next, "gen_ai.input.messages", buildGenAiInputMessages(next));
  setIfMissing(next, "gen_ai.output.messages", buildGenAiOutputMessages(next));
  setIfMissing(next, "gen_ai.usage.input_tokens", next.usage_input_tokens);
  setIfMissing(next, "gen_ai.usage.output_tokens", next.usage_output_tokens);
  setIfMissing(next, "gen_ai.usage.cache_read.input_tokens", next.usage_cache_read_input_tokens);
  setIfMissing(next, "gen_ai.usage.cache_creation.input_tokens", next.usage_cache_write_input_tokens);
  setIfMissing(next, "gen_ai.tool.name", next.tool_name);
  setIfMissing(next, "gen_ai.tool.call.id", next.tool_call_id);
  setIfMissing(next, "gen_ai.tool.call.arguments", next.tool_args_preview);
  setIfMissing(next, "gen_ai.tool.call.result", next.tool_result_preview);

  if (next["gen_ai.agent.version"] === undefined || next["gen_ai.agent.version"] === "") {
    setIfMissing(next, "gen_ai.agent.version", next.agent_version);
  }

  return next;
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
    if (OFFICIAL_GEN_AI_ATTR_KEYS.has(key) || key.startsWith("gen_ai.skill.")) {
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
  promoteAlias(next, "provider_name", "openclaw.provider", "llm.provider");
  promoteAlias(next, "request_model", "openclaw.model", "llm.model");
  promoteAlias(next, "response_model", "openclaw.model", "llm.model");
  if (next.response_model === undefined || next.response_model === "") {
    next.response_model = next.request_model;
  }
  promoteAlias(next, "input_preview", "openclaw.input.preview");
  promoteAlias(next, "input_length", "openclaw.input.length");
  promoteAlias(next, "output_preview", "openclaw.output.preview");
  promoteAlias(next, "output_length", "openclaw.output.length");
  promoteAlias(next, "usage_input_tokens", "openclaw.tokens.input", "llm.input_tokens");
  promoteAlias(next, "usage_output_tokens", "openclaw.tokens.output", "llm.output_tokens");
  promoteAlias(next, "usage_total_tokens", "openclaw.tokens.total", "llm.total_tokens");
  promoteAlias(next, "usage_cache_read_input_tokens", "openclaw.tokens.cache_read");
  promoteAlias(next, "usage_cache_write_input_tokens", "openclaw.tokens.cache_write");
  const cacheReadTokens = typeof next.usage_cache_read_input_tokens === "number"
    ? next.usage_cache_read_input_tokens
    : undefined;
  const cacheWriteTokens = typeof next.usage_cache_write_input_tokens === "number"
    ? next.usage_cache_write_input_tokens
    : undefined;
  if (
    next.__suppress_usage_cache_total_tokens !== true &&
    next.usage_cache_total_tokens === undefined
    && (cacheReadTokens !== undefined || cacheWriteTokens !== undefined)
  ) {
    next.usage_cache_total_tokens = (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
  }
  if (next.__suppress_usage_cache_total_tokens === true) {
    delete next.usage_cache_total_tokens;
  }
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
  promoteAlias(next, "output_kind", "openclaw.output.kind", "output.kind");
  promoteAlias(next, "state", "openclaw.state", "state");
  promoteAlias(next, "prev_state", "openclaw.prevState", "prevState", "prev_state");
  promoteAlias(next, "reason", "openclaw.reason", "reason");
  promoteAlias(next, "queue_depth", "openclaw.queueDepth", "queueDepth", "queue_depth");
  promoteAlias(next, "runtime_phase", "openclaw.runtime.phase", "runtime.phase");
  promoteAlias(next, "tool_provider", "openclaw.tool.provider", "tool.provider");
  promoteAlias(next, "tool_namespace", "openclaw.tool.namespace", "tool.namespace");
  promoteAlias(next, "tool_mcp_name", "openclaw.tool.mcp_name", "tool.mcp_name");
  promoteAlias(next, "tool_mcp_host", "openclaw.tool.mcp_host", "tool.mcp_host");
  promoteAlias(next, "tool_result_status", "tool_outcome", "openclaw.tool.result_status", "openclaw.tool.outcome", "tool.outcome");
  delete next.tool_outcome;
  delete next["openclaw.tool.outcome"];
  promoteAlias(next, "skill_count", "skill.count", "skill_count");
  promoteAlias(next, "session_create_at", "session_create_time", "gen_ai.session_create_time", "openclaw.session.createdAt");
  promoteAlias(next, "session_created_at", "session.createdAt", "openclaw.session.createdAt");
  promoteAlias(next, "session_updated_at", "session.updatedAt", "session_update_time", "openclaw.session.updatedAt");
  promoteAlias(next, "session_chat_type", "session.chatType", "openclaw.session.chatType");
  promoteAlias(next, "session_file", "session.file", "openclaw.session.file");
  mirrorAlias(next, "skill_call_id", "openclaw.skill.call_id");
  mirrorAlias(next, "skill_name", "openclaw.skill.name");
  mirrorAlias(next, "skill_type", "openclaw.skill.kind");
  mirrorAlias(next, "skill_source", "openclaw.skill.source");
  promoteAlias(next, "final_status", "openclaw.outcome");
  delete next.__suppress_usage_cache_total_tokens;
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
  const withGlobalRuntime = { ...attrs };
  if (withGlobalRuntime.agent_runtime === undefined || withGlobalRuntime.agent_runtime === "") {
    withGlobalRuntime.agent_runtime = "openclaw";
  }
  return Object.fromEntries(
    Object.entries(stripOpenClawNamespace(withOfficialGenAiSemanticAttrs(withCanonicalAliases(withGlobalRuntime))))
      .filter(([key, value]) => (
        !OMITTED_AGENT_IDENTITY_ATTR_KEYS.has(key)
        && key !== "trace_id"
        && value !== undefined
        && value !== ""
      ))
      .map(([key, value]) => [
        key,
        typeof value === "string" ? stripAnsiEscapeCodes(value) : value,
      ]),
  ) as Record<string, string | number | boolean>;
}

const OMITTED_AGENT_IDENTITY_ATTR_KEYS = new Set([
  "agent_id",
  "agent_name",
  "gen_ai.agent_id",
  "gen_ai.agent_name",
  "gen_ai_agent_id",
  "gen_ai_agent_name",
  "session_namespace",
  "session_agent",
  "session_channel",
  "session_state",
]);

const LEGACY_TRACE_CONTEXT_KEYS = new Set([
  "skill.call_id",
  "skill.kind",
  "skill.source",
  "output.kind",
  "prevState",
  "queueDepth",
  "runtime.phase",
  "skill.count",
  "tool.call_id",
  "tool.name",
  "tool.target",
  "tool.command",
  "tool.phase",
  "tool.outcome",
  "session.createdAt",
  "session.updatedAt",
  "session_update_time",
  "session.chatType",
  "session.file",
  "gen_ai.agent_runtime",
  "gen_ai.agent_channel",
  "gen_ai.session_id",
  "gen_ai.session_key",
  "gen_ai.session_namespace",
  "gen_ai.session_agent",
  "gen_ai.session_channel",
  "gen_ai.session_scope",
  "gen_ai.session_channel_target",
  "gen_ai.session_cwd",
  "gen_ai.origin_provider",
  "gen_ai.origin_surface",
  "gen_ai.tool_call_id",
  "gen_ai.tool_name",
  "gen_ai.tool_target",
  "gen_ai.tool_command",
  "gen_ai.tool_outcome",
  "gen_ai.tool_phase",
  "gen_ai.tool_provider",
  "gen_ai.tool_namespace",
  "gen_ai.tool_mcp_name",
  "gen_ai.tool_mcp_host",
  "gen_ai.tool_loop_level",
  "gen_ai.skill_call_id",
  "gen_ai.skill_name",
  "gen_ai.skill_type",
  "gen_ai.skill_source",
  "gen_ai.final_status",
  "gen_ai.agent_version",
  "gen_ai.runtime_environment",
  "gen_ai.state",
  "gen_ai.prev_state",
  "gen_ai.reason",
  "gen_ai.queue_depth",
  "gen_ai.runtime_phase",
  "gen_ai.tools",
  "gen_ai.tool_count",
  "gen_ai.skills",
  "gen_ai.skill_count",
  "gen_ai.tool_targets",
  "gen_ai.tool_commands",
  "gen_ai.tool_result_statuses",
  "gen_ai.tool_arg_keys",
  "gen_ai.tool_args_preview",
  "gen_ai.tool_meta_preview",
  "gen_ai.tool_result_preview",
  "gen_ai.tool_result_status",
  "gen_ai.session_create_at",
  "gen_ai.session_created_at",
  "gen_ai.session_updated_at",
  "gen_ai.session_chat_type",
  "gen_ai.session_file",
]);

const RESOURCE_ONLY_TRACE_ATTR_KEYS = new Set([
  "agent_runtime",
  "agent_version",
  "runtime_environment",
]);

export function traceAttrs(
  attrs: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const normalized = stringAttrs(attrs);
  return Object.fromEntries(
    Object.entries(normalized).filter(
      ([key]) => !LEGACY_TRACE_CONTEXT_KEYS.has(key) && !RESOURCE_ONLY_TRACE_ATTR_KEYS.has(key),
    ),
  ) as Record<string, string | number | boolean>;
}

export function setError(span: any, spanStatusCode: number, message?: string) {
  const safeMessage = message ? redactSensitiveText(message) : "unknown";
  span.setStatus({ code: spanStatusCode, message: safeMessage });
  const attrs = traceAttrs({ "error.type": "error" });
  if (typeof span.setAttributes === "function") {
    span.setAttributes(attrs);
  } else if (typeof span.setAttribute === "function") {
    span.setAttribute("error.type", attrs["error.type"]);
  }
  if (span.attributes && typeof span.attributes === "object") {
    Object.assign(span.attributes, attrs);
  }
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

function readNestedString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readNestedRecord(
  record: Record<string, unknown> | undefined,
  keys: string[],
): Record<string, unknown> | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (isRecord(value)) {
      return value;
    }
  }
  return undefined;
}

let cachedMcpServerHosts: Map<string, string> | undefined;

function resolveOpenClawConfigPath(): string {
  const explicit = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) {
    return explicit;
  }
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  if (stateDir) {
    return path.join(stateDir, "openclaw.json");
  }
  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

function loadConfiguredMcpServerHosts(): Map<string, string> {
  if (cachedMcpServerHosts) {
    return cachedMcpServerHosts;
  }
  const hosts = new Map<string, string>();
  try {
    const configPath = resolveOpenClawConfigPath();
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const mcp = isRecord(parsed.mcp) ? parsed.mcp : undefined;
    const servers = isRecord(mcp?.servers) ? mcp?.servers : undefined;
    for (const [serverName, rawServer] of Object.entries(servers ?? {})) {
      if (!isRecord(rawServer) || typeof rawServer.url !== "string" || !rawServer.url.trim()) {
        continue;
      }
      try {
        const url = new URL(rawServer.url);
        if (url.host) {
          hosts.set(serverName, url.host);
        }
      } catch {
        // Ignore invalid configured MCP URLs.
      }
    }
  } catch {
    // Ignore missing or unreadable config; MCP host is optional enrichment.
  }
  cachedMcpServerHosts = hosts;
  return hosts;
}

function inferMcpToolIdentity(
  toolName: string,
  args: unknown,
  meta: unknown,
  result: unknown,
): {
  provider?: string;
  namespace?: string;
} {
  const argsRecord = isRecord(args) ? args : undefined;
  const metaRecord = isRecord(meta) ? meta : undefined;
  const resultRecord = isRecord(result) ? result : undefined;

  const explicitNamespace =
    readNestedString(metaRecord, ["tool_namespace", "toolNamespace", "server", "serverName", "namespace"])
    ?? readNestedString(argsRecord, ["tool_namespace", "toolNamespace", "server", "serverName", "namespace"])
    ?? readNestedString(resultRecord, ["tool_namespace", "toolNamespace", "server", "serverName", "namespace"])
    ?? readNestedString(readNestedRecord(metaRecord, ["mcp"]), ["server", "serverName", "namespace"])
    ?? readNestedString(readNestedRecord(argsRecord, ["mcp"]), ["server", "serverName", "namespace"])
    ?? readNestedString(readNestedRecord(resultRecord, ["mcp"]), ["server", "serverName", "namespace"]);
  const explicitProvider =
    readNestedString(metaRecord, ["tool_provider", "toolProvider", "provider"])
    ?? readNestedString(argsRecord, ["tool_provider", "toolProvider", "provider"])
    ?? readNestedString(resultRecord, ["tool_provider", "toolProvider", "provider"])
    ?? readNestedString(readNestedRecord(metaRecord, ["mcp"]), ["provider"])
    ?? readNestedString(readNestedRecord(argsRecord, ["mcp"]), ["provider"])
    ?? readNestedString(readNestedRecord(resultRecord, ["mcp"]), ["provider"]);

  if ((explicitProvider && explicitProvider.toLowerCase() === "mcp") || explicitNamespace) {
    return {
      provider: "mcp",
      namespace: explicitNamespace,
    };
  }

  const normalizedToolName = toolName.trim();
  const bundleMcpMatch = normalizedToolName.match(/^([a-z0-9][a-z0-9_-]{0,63})__([a-z0-9][\w.-]*)$/i);
  if (bundleMcpMatch) {
    return {
      provider: "mcp",
      namespace: bundleMcpMatch[1],
    };
  }
  const mcpDoubleUnderscoreMatch = normalizedToolName.match(/^mcp__([^_]+)__(.+)$/i);
  if (mcpDoubleUnderscoreMatch) {
    return {
      provider: "mcp",
      namespace: mcpDoubleUnderscoreMatch[1],
    };
  }
  const mcpDottedMatch = normalizedToolName.match(/^mcp\.([^.]+)\.(.+)$/i);
  if (mcpDottedMatch) {
    return {
      provider: "mcp",
      namespace: mcpDottedMatch[1],
    };
  }
  const dottedMatch = normalizedToolName.match(/^([a-z0-9][a-z0-9_-]*)\.[a-z0-9][\w.-]*$/i);
  if (dottedMatch) {
    return {
      provider: "mcp",
      namespace: dottedMatch[1],
    };
  }

  return {};
}

function extractMcpToolName(
  toolName: string,
  args: unknown,
  meta: unknown,
  result: unknown,
): string | undefined {
  const argsRecord = isRecord(args) ? args : undefined;
  const metaRecord = isRecord(meta) ? meta : undefined;
  const resultRecord = isRecord(result) ? result : undefined;
  const explicitToolName =
    readNestedString(metaRecord, ["mcp_tool_name", "mcpToolName"])
    ?? readNestedString(argsRecord, ["mcp_tool_name", "mcpToolName", "tool_name", "toolName"])
    ?? readNestedString(resultRecord, ["mcp_tool_name", "mcpToolName", "tool_name", "toolName"])
    ?? readNestedString(readNestedRecord(metaRecord, ["mcp"]), ["tool", "toolName"])
    ?? readNestedString(readNestedRecord(argsRecord, ["mcp"]), ["tool", "toolName"])
    ?? readNestedString(readNestedRecord(resultRecord, ["mcp"]), ["tool", "toolName"]);
  if (explicitToolName) {
    return explicitToolName;
  }

  const normalizedToolName = toolName.trim();
  const bundleMcpMatch = normalizedToolName.match(/^([a-z0-9][a-z0-9_-]{0,63})__([a-z0-9][\w.-]*)$/i);
  if (bundleMcpMatch) {
    return bundleMcpMatch[2];
  }
  return undefined;
}

function extractMcpToolHost(
  toolName: string,
  args: unknown,
  meta: unknown,
  result: unknown,
): string | undefined {
  const argsRecord = isRecord(args) ? args : undefined;
  const metaRecord = isRecord(meta) ? meta : undefined;
  const resultRecord = isRecord(result) ? result : undefined;
  const explicitHost =
    readNestedString(metaRecord, ["tool_mcp_host", "mcp_host", "host"])
    ?? readNestedString(argsRecord, ["tool_mcp_host", "mcp_host", "host"])
    ?? readNestedString(resultRecord, ["tool_mcp_host", "mcp_host", "host"])
    ?? readNestedString(readNestedRecord(metaRecord, ["mcp"]), ["host"])
    ?? readNestedString(readNestedRecord(argsRecord, ["mcp"]), ["host"])
    ?? readNestedString(readNestedRecord(resultRecord, ["mcp"]), ["host"]);
  if (explicitHost) {
    return explicitHost;
  }
  const identity = inferMcpToolIdentity(toolName, args, meta, result);
  if (!identity.namespace) {
    return undefined;
  }
  return loadConfiguredMcpServerHosts().get(identity.namespace);
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
  const mcpIdentity = inferMcpToolIdentity(toolName, args, meta, undefined);
  const mcpToolName = extractMcpToolName(toolName, args, meta, undefined);

  if (mcpIdentity.provider === "mcp" && mcpToolName) {
    return mcpToolName;
  }

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
    skill?: SkillCatalogEntry;
    skillCallId?: string;
    skillResultStatus?: "completed" | "error";
    originalToolName?: string;
  },
): Record<string, string | number | boolean | undefined> {
  const toolIdentity = inferMcpToolIdentity(
    toolName,
    options?.args,
    options?.meta,
    options?.result ?? options?.partialResult,
  );
  const mcpToolName = extractMcpToolName(
    toolName,
    options?.args,
    options?.meta,
    options?.result ?? options?.partialResult,
  );
  const mcpToolHost = extractMcpToolHost(
    toolName,
    options?.args,
    options?.meta,
    options?.result ?? options?.partialResult,
  );
  return {
    "span.kind": "tool",
    "openclaw.tool.name": toolName,
    "openclaw.tool.original_name": options?.originalToolName,
    "openclaw.tool.call_id": toolCallId,
    "openclaw.skill.name": options?.skillName,
    "openclaw.skill.description": options?.skill?.description,
    "openclaw.skill.path": options?.skill?.path,
    "openclaw.skill.source.type": options?.skill?.sourceType,
    skill_result_status: options?.skillResultStatus,
    "gen_ai.skill.name": options?.skillName,
    "gen_ai.skill.description": options?.skill?.description,
    "gen_ai.skill.path": options?.skill?.path,
    "gen_ai.skill.source.type": options?.skill?.sourceType,
    "gen_ai.skill.result_status": options?.skillResultStatus,
    "gen_ai.skill.version": options?.skill?.version,
    "openclaw.tool.phase": options?.phase,
    "openclaw.tool.result_status": options?.outcome,
    "openclaw.tool.arg_keys": summarizeToolArgKeys(options?.args),
    "openclaw.tool.target": extractToolTarget(toolName, options?.args, options?.meta),
    "openclaw.tool.command": extractToolCommand(toolName, options?.args),
    "openclaw.tool.provider": toolIdentity.provider,
    "openclaw.tool.namespace": toolIdentity.namespace,
    "openclaw.tool.mcp_name": mcpToolName,
    "openclaw.tool.mcp_host": mcpToolHost,
    "openclaw.tool.args.preview": clipValuePreview(options?.args),
    "openclaw.tool.meta.preview": clipValuePreview(options?.meta),
    "openclaw.tool.result.preview": clipValuePreview(options?.result),
    "openclaw.tool.partial_result.preview": clipValuePreview(options?.partialResult),
    ...(options?.skillCallId ? { "openclaw.skill.call_id": options.skillCallId } : {}),
  };
}

export function buildSkillSpanAttrs(
  skillName: string,
  options?: {
    kind?: "call";
    source?: "runtime" | "transcript";
    skill?: SkillCatalogEntry;
    callId?: string;
    toolName?: string;
    resultStatus?: "completed" | "error";
  },
): Record<string, string | number | boolean | undefined> {
  return {
    "span.kind": "skill",
    "openclaw.skill.name": skillName,
    "openclaw.skill.kind": options?.kind,
    "openclaw.skill.source": options?.source,
    "openclaw.skill.description": options?.skill?.description,
    "openclaw.skill.path": options?.skill?.path,
    "openclaw.skill.source.type": options?.skill?.sourceType,
    "openclaw.skill.call_id": options?.callId,
    skill_result_status: options?.resultStatus,
    "openclaw.tool.call_id": options?.callId,
    "openclaw.tool.name": options?.toolName,
    "gen_ai.skill.name": skillName,
    "gen_ai.skill.path": options?.skill?.path,
    "gen_ai.skill.source.type": options?.skill?.sourceType,
    "gen_ai.skill.result_status": options?.resultStatus,
    "gen_ai.skill.description": options?.skill?.description,
    "gen_ai.skill.version": options?.skill?.version,
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
    mcpToolName: extractMcpToolName(
      toolName,
      options?.args,
      options?.meta,
      options?.result ?? options?.partialResult,
    ),
    mcpToolHost: extractMcpToolHost(
      toolName,
      options?.args,
      options?.meta,
      options?.result ?? options?.partialResult,
    ),
    ...inferMcpToolIdentity(toolName, options?.args, options?.meta, options?.result ?? options?.partialResult),
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

export function stripAgentSummaryModelUsageAttrs(
  attrs: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean | undefined> {
  const next = { ...attrs };
  for (const key of [
    "request_model",
    "response_model",
    "usage_input_tokens",
    "usage_output_tokens",
    "usage_total_tokens",
    "usage_cache_read_input_tokens",
    "usage_cache_write_input_tokens",
    "usage_cache_total_tokens",
    "gen_ai.request.model",
    "gen_ai.response.model",
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.cache_read.input_tokens",
    "gen_ai.usage.cache_creation.input_tokens",
    "openclaw.model",
    "openclaw.tokens.input",
    "openclaw.tokens.output",
    "openclaw.tokens.total",
    "openclaw.tokens.cache_read",
    "openclaw.tokens.cache_write",
  ]) {
    delete next[key];
  }
  return next;
}

export function durationMsToSeconds(durationMs: number): number {
  return Math.max(0, durationMs) / 1000;
}

export function buildGenAiWorkflowMetricAttrs(
  snapshot: SessionSnapshot | undefined,
  summaryAttrs?: Record<string, string | number | boolean>,
) {
  const sessionId = snapshot?.sessionId;
  return stringAttrs({
    session_id: sessionId,
    "gen_ai.conversation.id": sessionId,
    final_status:
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
  tool: Pick<ActiveToolSpan, "name" | "skillName" | "provider" | "namespace" | "mcpToolName" | "mcpHost">,
  resultStatus?: string,
) {
  return stringAttrs({
    "openclaw.tool_name": tool.name,
    "openclaw.skill_name": tool.skillName,
    "openclaw.tool.provider": tool.provider,
    "openclaw.tool.namespace": tool.namespace,
    "openclaw.tool.mcp_name": tool.mcpToolName,
    "openclaw.tool.mcp_host": tool.mcpHost,
    "openclaw.tool_result_status": resultStatus,
  });
}

export function buildGenAiClientToolMetricAttrs(
  tool: Pick<ActiveToolSpan, "name" | "skillName" | "provider" | "namespace" | "mcpToolName" | "mcpHost">,
  resultStatus?: string,
  sessionId?: string,
  _modelName?: string,
) {
  return stringAttrs({
    session_id: sessionId,
    "gen_ai.conversation.id": sessionId,
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": tool.name,
    skill_name: tool.skillName,
    tool_provider: tool.provider,
    tool_namespace: tool.namespace,
    tool_mcp_name: tool.mcpToolName,
    tool_mcp_host: tool.mcpHost,
    tool_result_status: resultStatus,
  });
}

export function buildGenAiClientSkillMetricAttrs(
  skillName: string,
  outcome?: string,
  sessionId?: string,
  source: "runtime" | "transcript" = "runtime",
) {
  return stringAttrs({
    session_id: sessionId,
    "gen_ai.conversation.id": sessionId,
    "gen_ai.operation.name": "skill",
    "gen_ai.skill.name": skillName,
    skill_name: skillName,
    skill_source: source,
    tool_result_status: outcome,
  });
}

export function buildSkillMetricAttrs(skillName: string, source: "runtime" | "transcript") {
  return stringAttrs({
    "openclaw.skill_name": skillName,
    "openclaw.skill_source": source,
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
  const sessionId = typeof extra?.session_id === "string" ? extra.session_id : undefined;
  return stringAttrs({
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": provider,
    "gen_ai.request.model": model,
    "gen_ai.response.model": model,
    "gen_ai.conversation.id": sessionId,
    ...(extra ?? {}),
  });
}

export function buildGenAiClientTokenMetricAttrs(
  provider?: string,
  model?: string,
  extra?: Record<string, string | number | boolean | undefined>,
) {
  const sessionId = typeof extra?.session_id === "string" ? extra.session_id : undefined;
  const tokenType = typeof extra?.token_type === "string" ? extra.token_type : undefined;
  const { token_type: _tokenType, ...rest } = extra ?? {};
  return stringAttrs({
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": provider,
    "gen_ai.request.model": model,
    "gen_ai.response.model": model,
    "gen_ai.conversation.id": sessionId,
    "gen_ai.token.type": tokenType,
    ...rest,
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
  overrides?: {
    modelProvider?: string;
    modelName?: string;
  },
) {
  return stringAttrs({
    session_id: snapshot?.sessionId,
    model_provider: overrides?.modelProvider ?? snapshot?.lastProvider,
    model_name: overrides?.modelName ?? snapshot?.lastModel,
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

export function buildDiagnosticsMessageMetricAttrs(
  channel?: string,
  extra?: Record<string, string | number | boolean | undefined>,
) {
  return stringAttrs({
    "openclaw.channel": channel,
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

export function mergeToolIdentity(
  tool: Pick<ActiveToolSpan, "name" | "argKeys" | "target" | "command" | "provider" | "namespace" | "mcpToolName" | "mcpHost">,
  options?: { args?: unknown; meta?: unknown; result?: unknown; partialResult?: unknown },
) {
  const summary = collectToolSummaryValues(tool.name, options);
  return {
    argKeys: tool.argKeys ?? summarizeToolArgKeys(options?.args),
    target: tool.target ?? summary.target,
    command: tool.command ?? summary.command,
    provider: tool.provider ?? summary.provider,
    namespace: tool.namespace ?? summary.namespace,
    mcpToolName: tool.mcpToolName ?? summary.mcpToolName,
    mcpHost: tool.mcpHost ?? summary.mcpToolHost,
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

function readPackageJsonVersion(packageJsonPath: string): string | undefined {
  try {
    const raw = fs.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveSkillDirFromIdentityText(text: string | undefined, skillName: string): string | undefined {
  if (!text?.trim() || !skillName.trim()) {
    return undefined;
  }
  const normalizedText = text.replace(/\\/g, "/");
  const escapedName = skillName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = normalizedText.match(new RegExp(`([^\\s"'\\\`]*\\/workspace\\/skills\\/${escapedName})(?:\\/[^\\s"'\\\`]*)?`, "i"));
  return match?.[1];
}

export function resolveSkillCatalogEntryFromToolIdentity(
  skillName: string | undefined,
  target?: string,
  command?: string,
): SkillCatalogEntry | undefined {
  const normalizedSkillName = skillName?.trim();
  if (!normalizedSkillName) {
    return undefined;
  }
  const skillDir = resolveSkillDirFromIdentityText(target, normalizedSkillName)
    ?? resolveSkillDirFromIdentityText(command, normalizedSkillName);
  if (!skillDir) {
    return undefined;
  }
  const skillFile = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    return undefined;
  }
  try {
    const raw = fs.readFileSync(skillFile, "utf8");
    const frontmatter = extractFrontmatter(raw);
    const resolvedName = frontmatter.name?.trim() || normalizedSkillName;
    return buildSkillCatalogEntry(resolvedName, {
      description: extractSkillDescription(raw, frontmatter),
      path: skillFile,
      sourceType: "workspace",
      version: frontmatter.version?.trim() || readPackageJsonVersion(path.join(skillDir, "package.json")),
      extraAliases: [normalizedSkillName],
    });
  } catch {
    return undefined;
  }
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

export function extractSkillDescription(source: string, frontmatter?: Record<string, string>): string | undefined {
  const frontmatterDescription = frontmatter?.description?.trim();
  if (frontmatterDescription) {
    return frontmatterDescription;
  }
  const body = source.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  if (!body) {
    return undefined;
  }
  for (const paragraph of body.split(/\n\s*\n/g)) {
    const normalized = paragraph
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    if (normalized.length === 0) {
      continue;
    }
    return clipPreview(normalized.join(" "));
  }
  return undefined;
}

export function buildSkillCatalogEntry(
  name: string,
  options?: {
    description?: string;
    path?: string;
    sourceType?: SkillSourceType;
    version?: string;
    extraAliases?: string[];
  },
): SkillCatalogEntry {
  return {
    name,
    aliases: uniqStrings([name, ...(options?.extraAliases ?? []), ...splitAliasCandidates(options?.description)]),
    description: options?.description,
    path: options?.path,
    sourceType: options?.sourceType,
    version: options?.version,
  };
}

export function skillSpanName(skillName: string): string {
  return `skill:${skillName}`;
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
  if (typeof content === "string") {
    return kind === "text" ? content.trim() || undefined : undefined;
  }
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const record = content as Record<string, unknown>;
    const directValue = typeof record[kind] === "string" ? record[kind].trim() : "";
    if (directValue) {
      return directValue;
    }
    if (kind === "text" && typeof record.text === "string" && record.text.trim()) {
      return record.text.trim();
    }
    return undefined;
  }
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
