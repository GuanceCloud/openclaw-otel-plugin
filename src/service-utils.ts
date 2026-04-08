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
    modelSpanEmitted: false,
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

export function eventTime(ts: number): Date {
  return new Date(ts);
}

export function endTimeFromStart(startTs: number, durationMs: number): Date {
  return new Date(startTs + Math.max(durationMs, 1));
}

export function sessionIdentity(evt: {
  sessionKey?: string;
  sessionId?: string;
}): string | undefined {
  return evt.sessionKey ?? evt.sessionId;
}

export function stringAttrs(
  attrs: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(attrs)
      .filter(([key, value]) => key !== "trace_id" && value !== undefined && value !== "")
      .map(([key, value]) => [
        key,
        typeof value === "string" ? stripAnsiEscapeCodes(value) : value,
      ]),
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
      ? stringAttrs(attrs as Record<string, string | number | boolean | undefined>)
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
  if (typeof result.outcome === "string") {
    return result.outcome;
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
