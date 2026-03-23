import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type {
  DiagnosticEventPayload,
  OpenClawPluginService,
} from "openclaw/plugin-sdk/diagnostics-otel";
import { onDiagnosticEvent, redactSensitiveText } from "openclaw/plugin-sdk/diagnostics-otel";
import type { OtelPluginConfig } from "./config.js";
import {
  normalizeTerminalSpanAttrs,
  resolveOtelUrl,
  shouldCloseForSessionState,
  shouldCreateRootForSessionState,
  shouldSyncRootForSessionState,
  stripAnsiEscapeCodes,
} from "./trace-runtime.js";

type ActiveRootSpan = {
  span: any;
  ctx: any;
  startedAt: number;
  lastTouchedAt: number;
};

type ActiveSkillSpan = {
  name: string;
  span: any;
  ctx: any;
  startedAt: number;
  source: "runtime" | "transcript";
};

type ActiveToolSpan = {
  toolCallId: string;
  name: string;
  span: any;
  ctx: any;
  startedAt: number;
  skillName?: string;
  hasError?: boolean;
  argKeys?: string;
  target?: string;
  command?: string;
};

type ActiveRunSpan = {
  span: any;
  ctx: any;
  startedAt: number;
  lastTouchedAt: number;
  mainStartTs: number;
  modelSpanEmitted: boolean;
  usedSkillNames: Set<string>;
  usedToolNames: Set<string>;
  usedToolTargets: Set<string>;
  usedToolCommands: Set<string>;
  usedToolResultStatuses: Set<string>;
  skillSpans: Map<string, ActiveSkillSpan>;
  toolSpans: Map<string, ActiveToolSpan>;
  activeSkillName?: string;
  userSpan?: any;
  userCtx?: any;
  userStartTs?: number;
  modelSpan?: any;
  modelCtx?: any;
  modelStartTs?: number;
  aggregate: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    promptTokens: number;
    costUsd: number;
    modelCalls: number;
    lastProvider?: string;
    lastModel?: string;
  };
};

type RuntimeEvents = {
  onAgentEvent?: (listener: (evt: any) => void) => (() => boolean) | (() => void);
  onSessionTranscriptUpdate?: (listener: (update: { sessionFile: string }) => void) => (() => void);
};

type RuntimeLike = {
  events?: RuntimeEvents;
};

type SessionSnapshot = {
  sessionFile: string;
  sessionKey?: string;
  sessionId?: string;
  updatedAt?: number;
  chatType?: string;
  lastChannel?: string;
  originProvider?: string;
  originSurface?: string;
  sessionCwd?: string;
  sessionSkills?: string[];
  mentionedSkillNames?: string[];
  lastUserText?: string;
  lastAssistantText?: string;
  lastAssistantThinking?: string;
  lastProvider?: string;
  lastModel?: string;
  lastAssistantUsage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
  };
  mtimeMs: number;
};

type SkillCatalogEntry = {
  name: string;
  aliases: string[];
};

const PREVIEW_LIMIT = 1200;
const REASONING_PREVIEW_LIMIT = 360;
const MIN_VISIBLE_CHILD_MS = 120;
const MIN_VISIBLE_MODEL_MS = 800;

function eventTime(ts: number): Date {
  return new Date(ts);
}

function endTimeFromStart(startTs: number, durationMs: number): Date {
  return new Date(startTs + Math.max(durationMs, 1));
}

function sessionIdentity(evt: {
  sessionKey?: string;
  sessionId?: string;
}): string | undefined {
  return evt.sessionKey ?? evt.sessionId;
}

function stringAttrs(
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

function setError(span: any, spanStatusCode: number, message?: string) {
  const safeMessage = message ? redactSensitiveText(message) : "unknown";
  span.setStatus({ code: spanStatusCode, message: safeMessage });
}

function addEvent(span: any, name: string, attrs?: Record<string, string | number | boolean>) {
  span.addEvent(
    name,
    attrs
      ? stringAttrs(attrs as Record<string, string | number | boolean | undefined>)
      : attrs,
  );
}

function endSpanSafely(span: any, endTime?: Date) {
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

function clipPreview(text: string | undefined): string | undefined {
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

function normalizeUserInputPreview(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  let normalized = stripAnsiEscapeCodes(text).trim();
  if (!normalized) {
    return undefined;
  }

  // OpenClaw webchat/user transcript may prepend sender metadata and a timestamp block.
  normalized = normalized
    .replace(/^Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/i, "")
    .replace(/^\[[^\]]+\]\s*/, "")
    .trim();

  return clipPreview(normalized) ?? clipPreview(text);
}

function normalizeReasoningPreview(text: string | undefined): string | undefined {
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

function clipValuePreview(value: unknown): string | undefined {
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

function summarizeToolArgKeys(args: unknown): string | undefined {
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

function extractToolTarget(toolName: string, args: unknown, meta: unknown): string | undefined {
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

function extractToolCommand(toolName: string, args: unknown): string | undefined {
  const normalizedToolName = toolName.trim().toLowerCase();
  const argsRecord = isRecord(args) ? args : undefined;
  if (normalizedToolName === "exec" && typeof argsRecord?.command === "string") {
    return clipPreview(argsRecord.command);
  }
  return undefined;
}

function extractToolResultStatus(result: unknown): string | undefined {
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

function buildToolAttrs(
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

function collectToolSummaryValues(
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

function mergeToolIdentity(
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

function inferSkillNameFromTool(toolName: string | undefined): string | undefined {
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

function uniqStrings(values: Array<string | undefined>): string[] {
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

function extractFrontmatter(source: string): Record<string, string> {
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

function buildSkillCatalogEntry(
  name: string,
  description?: string,
  extraAliases?: string[],
): SkillCatalogEntry {
  return {
    name,
    aliases: uniqStrings([name, ...(extraAliases ?? []), ...splitAliasCandidates(description)]),
  };
}

function skillSpanName(skillName: string): string {
  return `skill:${skillName}`;
}

function extractMentionedSkillNames(
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

function extractContentText(content: unknown, kind: "text" | "thinking"): string | undefined {
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

function readJsonLines(filePath: string): Array<Record<string, unknown>> {
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

export function createOtelPluginService(
  config: OtelPluginConfig,
  runtime?: RuntimeLike,
): OpenClawPluginService {
  let sdk: any = null;
  let unsubscribeDiagnostic: (() => void) | null = null;
  let unsubscribeAgent: (() => void) | null = null;
  let unsubscribeTranscript: (() => void) | null = null;
  const activeRoots = new Map<string, ActiveRootSpan>();
  const activeRuns = new Map<string, ActiveRunSpan>();
  const latestAssistantTextBySession = new Map<string, string>();
  const transcriptSnapshotBySession = new Map<string, SessionSnapshot>();
      const sessionFileBySessionKey = new Map<string, string>();
      const sessionSkillsBySessionKey = new Map<string, SkillCatalogEntry[]>();
      const sessionModelBySessionKey = new Map<string, { provider?: string; model?: string }>();
      const sessionMetaBySessionKey = new Map<string, {
        sessionId?: string;
        updatedAt?: number;
        chatType?: string;
        lastChannel?: string;
        originProvider?: string;
        originSurface?: string;
      }>();

  return {
    id: "openclaw-otel-plugin",
    async start(ctx) {
      if (!config.enabled) {
        ctx.logger.info("[otel-plugin] disabled");
        return;
      }

      const require = createRequire(import.meta.url);
      const { context, trace, SpanKind, SpanStatusCode } = require("@opentelemetry/api");
      const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-proto");
      const { resourceFromAttributes } = require("@opentelemetry/resources");
      const { NodeSDK } = require("@opentelemetry/sdk-node");
      const {
        ParentBasedSampler,
        TraceIdRatioBasedSampler,
      } = require("@opentelemetry/sdk-trace-base");
      const { ATTR_SERVICE_NAME } = require("@opentelemetry/semantic-conventions");

      const traceExporter = new OTLPTraceExporter({
        url: resolveOtelUrl(config.endpoint, "v1/traces"),
        ...(config.headers ? { headers: config.headers } : {}),
      });

      const resource = resourceFromAttributes({
        [ATTR_SERVICE_NAME]: config.serviceName,
        ...(config.resourceAttributes ?? {}),
      });

      sdk = new NodeSDK({
        resource,
        traceExporter,
        ...(config.sampleRate !== undefined
          ? {
              sampler: new ParentBasedSampler({
                root: new TraceIdRatioBasedSampler(config.sampleRate),
              }),
            }
          : {}),
      });

      await sdk.start();
      const tracer = trace.getTracer("openclaw-otel-plugin");
      const sessionsIndexPath = path.join(ctx.stateDir, "agents", "main-agent", "sessions", "sessions.json");
      const workspaceSkillsDir = path.join(ctx.stateDir, "workspace", "skills");

      const mergeSessionSkills = (sessionKey: string, entries: SkillCatalogEntry[]) => {
        if (entries.length === 0) {
          return;
        }
        const merged = new Map<string, SkillCatalogEntry>();
        for (const existing of sessionSkillsBySessionKey.get(sessionKey) ?? []) {
          merged.set(existing.name, existing);
        }
        for (const entry of entries) {
          const existing = merged.get(entry.name);
          if (!existing) {
            merged.set(entry.name, entry);
            continue;
          }
          merged.set(entry.name, {
            name: entry.name,
            aliases: uniqStrings([...existing.aliases, ...entry.aliases]),
          });
        }
        sessionSkillsBySessionKey.set(sessionKey, Array.from(merged.values()));
      };

      const refreshWorkspaceSkills = () => {
        try {
          const dirents = fs.readdirSync(workspaceSkillsDir, { withFileTypes: true });
          const workspaceEntries: SkillCatalogEntry[] = [];
          for (const dirent of dirents) {
            if (!dirent.isDirectory()) {
              continue;
            }
            const skillDir = path.join(workspaceSkillsDir, dirent.name);
            const skillFile = path.join(skillDir, "SKILL.md");
            if (!fs.existsSync(skillFile)) {
              continue;
            }
            const raw = fs.readFileSync(skillFile, "utf8");
            const frontmatter = extractFrontmatter(raw);
            const skillName = frontmatter.name?.trim() || dirent.name;
            workspaceEntries.push(
              buildSkillCatalogEntry(skillName, frontmatter.description, [dirent.name]),
            );
          }
          if (workspaceEntries.length > 0) {
            for (const sessionKey of sessionFileBySessionKey.keys()) {
              mergeSessionSkills(sessionKey, workspaceEntries);
            }
          }
        } catch {
          // Ignore workspace scan failures; session metadata still provides baseline skills.
        }
      };

      const refreshSessionsIndex = () => {
        try {
          const raw = fs.readFileSync(sessionsIndexPath, "utf8");
          const parsed = JSON.parse(raw) as Record<string, {
            sessionFile?: string;
            modelProvider?: string;
            model?: string;
            skillsSnapshot?: { resolvedSkills?: Array<{ name?: string; description?: string }> };
          }>;
          sessionFileBySessionKey.clear();
          sessionSkillsBySessionKey.clear();
          sessionModelBySessionKey.clear();
          sessionMetaBySessionKey.clear();
          for (const [sessionKey, sessionState] of Object.entries(parsed)) {
            if (typeof sessionState?.sessionFile === "string" && sessionState.sessionFile.trim()) {
              sessionFileBySessionKey.set(sessionKey, sessionState.sessionFile);
            }
            if (Array.isArray(sessionState?.skillsSnapshot?.resolvedSkills)) {
              const skillEntries = sessionState.skillsSnapshot.resolvedSkills
                .map((skill) => {
                  const skillName = typeof skill?.name === "string" ? skill.name.trim() : "";
                  const description =
                    typeof skill?.description === "string" ? skill.description.trim() : undefined;
                  return skillName ? buildSkillCatalogEntry(skillName, description) : undefined;
                })
                .filter(Boolean) as SkillCatalogEntry[];
              if (skillEntries.length > 0) {
                sessionSkillsBySessionKey.set(sessionKey, skillEntries);
              }
            }
            sessionModelBySessionKey.set(sessionKey, {
              provider: typeof sessionState?.modelProvider === "string" ? sessionState.modelProvider : undefined,
              model: typeof sessionState?.model === "string" ? sessionState.model : undefined,
            });
            sessionMetaBySessionKey.set(sessionKey, {
              sessionId: typeof sessionState?.sessionId === "string" ? sessionState.sessionId : undefined,
              updatedAt: typeof sessionState?.updatedAt === "number" ? sessionState.updatedAt : undefined,
              chatType: typeof sessionState?.chatType === "string" ? sessionState.chatType : undefined,
              lastChannel: typeof sessionState?.lastChannel === "string" ? sessionState.lastChannel : undefined,
              originProvider:
                typeof sessionState?.origin?.provider === "string" ? sessionState.origin.provider : undefined,
              originSurface:
                typeof sessionState?.origin?.surface === "string" ? sessionState.origin.surface : undefined,
            });
          }
          refreshWorkspaceSkills();
        } catch {
          // Ignore transient file read issues; diagnostics spans can still be emitted.
        }
      };

      const loadSessionSnapshot = (sessionKey: string | undefined): SessionSnapshot | undefined => {
        if (!sessionKey) {
          return undefined;
        }
        let sessionFile = sessionFileBySessionKey.get(sessionKey);
        if (!sessionFile) {
          refreshSessionsIndex();
          sessionFile = sessionFileBySessionKey.get(sessionKey);
        }
        if (!sessionFile) {
          return undefined;
        }
        try {
          const stats = fs.statSync(sessionFile);
          const cached = transcriptSnapshotBySession.get(sessionKey);
          if (cached && cached.sessionFile === sessionFile && cached.mtimeMs === stats.mtimeMs) {
            const liveAssistantText = latestAssistantTextBySession.get(sessionKey);
            if (liveAssistantText && liveAssistantText !== cached.lastAssistantText) {
              cached.lastAssistantText = liveAssistantText;
            }
            return cached;
          }
          const lines = readJsonLines(sessionFile);
          let lastUserText: string | undefined;
          let lastAssistantText: string | undefined;
          let lastAssistantThinking: string | undefined;
          let lastProvider: string | undefined;
          let lastModel: string | undefined;
          let sessionCwd: string | undefined;
          let lastAssistantUsage: SessionSnapshot["lastAssistantUsage"];
          for (const line of lines) {
            if (line.type === "session" && typeof line.cwd === "string" && !sessionCwd) {
              sessionCwd = line.cwd;
            }
            if (line.type !== "message") {
              continue;
            }
            const envelope = line.message;
            if (!envelope || typeof envelope !== "object") {
              continue;
            }
            const message = envelope as Record<string, unknown>;
            if (message.role === "user") {
              lastUserText = extractContentText(message.content, "text") ?? lastUserText;
            }
            if (message.role === "assistant") {
              lastAssistantText = extractContentText(message.content, "text") ?? lastAssistantText;
              lastAssistantThinking = extractContentText(message.content, "thinking") ?? lastAssistantThinking;
              lastProvider = typeof message.provider === "string" ? message.provider : lastProvider;
              lastModel = typeof message.model === "string" ? message.model : lastModel;
              if (message.usage && typeof message.usage === "object") {
                const usage = message.usage as Record<string, unknown>;
                lastAssistantUsage = {
                  input: typeof usage.input === "number" ? usage.input : undefined,
                  output: typeof usage.output === "number" ? usage.output : undefined,
                  cacheRead: typeof usage.cacheRead === "number" ? usage.cacheRead : undefined,
                  cacheWrite: typeof usage.cacheWrite === "number" ? usage.cacheWrite : undefined,
                  totalTokens:
                    typeof usage.totalTokens === "number" ? usage.totalTokens : undefined,
                };
              }
            }
          }

          const liveAssistantText = latestAssistantTextBySession.get(sessionKey);
          const mentionedSkillNames = new Set<string>();
          for (const skillName of extractMentionedSkillNames(
            lastUserText,
            sessionSkillsBySessionKey.get(sessionKey),
          )) {
            mentionedSkillNames.add(skillName);
          }
          for (const skillName of extractMentionedSkillNames(
            `${lastAssistantThinking ?? ""}\n${liveAssistantText ?? lastAssistantText ?? ""}`,
            sessionSkillsBySessionKey.get(sessionKey),
          )) {
            mentionedSkillNames.add(skillName);
          }
          const snapshot: SessionSnapshot = {
            sessionFile,
            sessionKey,
            sessionId: sessionMetaBySessionKey.get(sessionKey)?.sessionId,
            updatedAt: sessionMetaBySessionKey.get(sessionKey)?.updatedAt,
            chatType: sessionMetaBySessionKey.get(sessionKey)?.chatType,
            lastChannel: sessionMetaBySessionKey.get(sessionKey)?.lastChannel,
            originProvider: sessionMetaBySessionKey.get(sessionKey)?.originProvider,
            originSurface: sessionMetaBySessionKey.get(sessionKey)?.originSurface,
            sessionCwd,
            sessionSkills: (sessionSkillsBySessionKey.get(sessionKey) ?? []).map((skill) => skill.name),
            mentionedSkillNames: Array.from(mentionedSkillNames),
            lastUserText,
            lastAssistantText: liveAssistantText ?? lastAssistantText,
            lastAssistantThinking,
            lastProvider: lastProvider ?? sessionModelBySessionKey.get(sessionKey)?.provider,
            lastModel: lastModel ?? sessionModelBySessionKey.get(sessionKey)?.model,
            lastAssistantUsage,
            mtimeMs: stats.mtimeMs,
          };
          transcriptSnapshotBySession.set(sessionKey, snapshot);
          return snapshot;
        } catch {
          return transcriptSnapshotBySession.get(sessionKey);
        }
      };

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
        const run = current ?? {
          span: null,
          ctx: userCtx ?? root.ctx,
          startedAt: Date.now(),
          lastTouchedAt: Date.now(),
          mainStartTs: Date.now(),
          modelSpanEmitted: false,
          aggregate: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 0,
            promptTokens: 0,
            costUsd: 0,
            modelCalls: 0,
          },
          usedSkillNames: new Set<string>(),
          usedToolNames: new Set<string>(),
          usedToolTargets: new Set<string>(),
          usedToolCommands: new Set<string>(),
          usedToolResultStatuses: new Set<string>(),
          skillSpans: new Map<string, ActiveSkillSpan>(),
          toolSpans: new Map<string, ActiveToolSpan>(),
        };
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
        const run = existing ?? {
          span: null,
          ctx: userCtx,
          startedAt: Date.now(),
          lastTouchedAt: Date.now(),
          mainStartTs: evt.ts,
          modelSpanEmitted: false,
          aggregate: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 0,
            promptTokens: 0,
            costUsd: 0,
            modelCalls: 0,
          },
          usedSkillNames: new Set<string>(),
          usedToolNames: new Set<string>(),
          usedToolTargets: new Set<string>(),
          usedToolCommands: new Set<string>(),
          usedToolResultStatuses: new Set<string>(),
          skillSpans: new Map<string, ActiveSkillSpan>(),
          toolSpans: new Map<string, ActiveToolSpan>(),
        };
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
        if (current.usedSkillNames.size === 0) {
          for (const skillName of snapshot?.mentionedSkillNames ?? []) {
            current.usedSkillNames.add(skillName);
          }
        }
        if (current.usedSkillNames.size > 0) {
          for (const skillName of current.usedSkillNames) {
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
        const startTime =
          typeof durationMs === "number"
            ? new Date(Math.max(Date.now() - Math.max(0, effectiveDurationMs), evt.ts))
            : eventTime(evt.ts);
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
        return { span, root, effectiveDurationMs, startTime };
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

      const getActiveSkillCtx = (run: ActiveRunSpan | undefined) => {
        if (!run?.activeSkillName) {
          return undefined;
        }
        return run.skillSpans.get(run.activeSkillName)?.ctx;
      };

      const syncToolSummaryAttrs = (
        evt: { sessionKey?: string; sessionId?: string },
        run: ActiveRunSpan,
      ) => {
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

      const ensureTranscriptSkillSpans = (
        evt: { sessionKey?: string; sessionId?: string; ts?: number },
      ) => {
        const snapshot = loadSessionSnapshot(evt.sessionKey);
        for (const skillName of snapshot?.mentionedSkillNames ?? []) {
          ensureSkillSpan(evt, skillName, "transcript");
        }
      };

      const ensureSkillSpan = (
        evt: { sessionKey?: string; sessionId?: string; ts?: number },
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
        const attrs = stringAttrs({
          "openclaw.skills": Array.from(run.usedSkillNames).join(", "),
          "openclaw.skill.count": run.usedSkillNames.size,
        });
        run.span?.setAttributes(attrs);
        getRoot(evt, false)?.span.setAttributes(attrs);
        return skillState;
      };

      const ensureToolSpan = (
        evt: { sessionKey?: string; sessionId?: string; ts?: number },
        toolName: string,
        toolCallId: string,
        attrs?: Record<string, string | number | boolean | undefined>,
      ) => {
        const run = getRun(evt, false) ?? ensureUserSpan({ sessionKey: evt.sessionKey, sessionId: evt.sessionId, ts: evt.ts ?? Date.now() });
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
        evt: { sessionKey?: string; sessionId?: string; ts?: number },
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
        } else {
          addEvent(tool.span, "tool.update", {
            "openclaw.tool.name": tool.name,
            "openclaw.tool.call_id": tool.toolCallId,
          });
        }
      };

      const findActiveToolSpanByName = (
        evt: { sessionKey?: string; sessionId?: string },
        toolName: string,
      ) => {
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
        evt: { sessionKey?: string; sessionId?: string; ts?: number },
        toolName: string,
        toolCallId: string,
        payload?: { result?: unknown; meta?: unknown; isError?: boolean },
      ) => {
        const tool = ensureToolSpan(evt, toolName, toolCallId, {
          "openclaw.tool.args.preview": undefined,
        });
        const run = getRun(evt, false);
        if (!tool || !run) {
          return;
        }
        const resultPreview = clipValuePreview(payload?.result);
        const metaPreview = clipValuePreview(payload?.meta);
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
        if (isError) {
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

      refreshSessionsIndex();

      unsubscribeAgent = runtime?.events?.onAgentEvent?.((evt) => {
        const sessionKey = typeof evt?.sessionKey === "string" ? evt.sessionKey : undefined;
        if (!sessionKey) {
          return;
        }
        if (evt.stream === "assistant" && evt.data && typeof evt.data === "object") {
          const text = typeof evt.data.text === "string" ? evt.data.text : undefined;
          if (text?.trim()) {
            latestAssistantTextBySession.set(sessionKey, text);
            const run = getRun({ sessionKey }, false);
            const root = getRoot({ sessionKey }, false);
            const attrs = stringAttrs({
              "openclaw.output.preview": clipPreview(text),
            });
            run?.span.setAttributes(attrs);
            root?.span.setAttributes(attrs);
          }
        }
        if (evt.stream === "tool" && evt.data && typeof evt.data === "object") {
          const toolName = typeof evt.data.name === "string" ? evt.data.name : undefined;
          const skillName = inferSkillNameFromTool(toolName);
          const run = getRun({ sessionKey }, false) ?? ensureUserSpan({ sessionKey, ts: evt.ts ?? Date.now() });
          if (run && toolName) {
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
            if (toolCallId) {
              const toolEvt = { sessionKey, ts: evt.ts ?? Date.now() };
              if (evt.data.phase === "start") {
                ensureToolSpan(toolEvt, toolName, toolCallId, {
                  ...buildToolAttrs(toolName, toolCallId, {
                    args: evt.data.args,
                    phase: "start",
                    skillName,
                  }),
                });
              } else if (evt.data.phase === "update") {
                updateToolSpan(toolEvt, toolName, toolCallId, evt.data.partialResult);
              } else if (evt.data.phase === "result") {
                endToolSpan(toolEvt, toolName, toolCallId, {
                  result: evt.data.result,
                  meta: evt.data.meta,
                  isError: evt.data.isError === true,
                });
              } else {
                ensureToolSpan(toolEvt, toolName, toolCallId, {
                  ...buildToolAttrs(toolName, toolCallId, {
                    phase: String(evt.data.phase ?? "unknown"),
                    skillName,
                  }),
                });
              }
            }
          }
        }
      }) ?? null;

      unsubscribeTranscript = runtime?.events?.onSessionTranscriptUpdate?.((update) => {
        refreshSessionsIndex();
        for (const [sessionKey, sessionFile] of sessionFileBySessionKey.entries()) {
          if (sessionFile === update.sessionFile) {
            transcriptSnapshotBySession.delete(sessionKey);
          }
        }
      }) ?? null;

      unsubscribeDiagnostic = onDiagnosticEvent((evt) => {
        cleanupExpiredRoots();

        switch (evt.type) {
          case "session.state": {
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
            if (evt.type === "tool.loop" && annotateToolLoop(evt)) {
              break;
            }
            const span = tracer.startSpan(evt.type, {
              startTime: eventTime(evt.ts),
              kind: SpanKind.INTERNAL,
              attributes: stringAttrs({
                ...("lane" in evt ? { "openclaw.lane": evt.lane } : {}),
                ...("queueSize" in evt ? { "openclaw.queueSize": evt.queueSize } : {}),
                ...("waitMs" in evt ? { "openclaw.waitMs": evt.waitMs } : {}),
                ...("toolName" in evt ? { "openclaw.toolName": evt.toolName } : {}),
                ...("detector" in evt ? { "openclaw.detector": evt.detector } : {}),
                ...("action" in evt ? { "openclaw.action": evt.action } : {}),
                ...("count" in evt ? { "openclaw.count": evt.count } : {}),
              }),
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
      });

      ctx.logger.info(
        `[otel-plugin] trace exporter enabled (${config.protocol}) -> ${resolveOtelUrl(config.endpoint, "v1/traces")}`,
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
        endSpanSafely(current.modelSpan);
        for (const skill of current.skillSpans.values()) {
          endSpanSafely(skill.span);
        }
        endSpanSafely(current.span);
        endSpanSafely(current.userSpan);
      }
      activeRuns.clear();
      for (const { span } of activeRoots.values()) {
        endSpanSafely(span);
      }
      activeRoots.clear();
      latestAssistantTextBySession.clear();
      transcriptSnapshotBySession.clear();
      sessionFileBySessionKey.clear();
      await sdk?.shutdown();
      sdk = null;
    },
  };
}
