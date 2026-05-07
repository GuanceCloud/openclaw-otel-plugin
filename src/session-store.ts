import fs from "node:fs";
import path from "node:path";
import type {
  RuntimeMetadata,
  SessionSnapshot,
  SessionSnapshotStore,
  SkillCatalogEntry,
  TranscriptAssistantTurn,
  TranscriptToolCall,
} from "./service-types.js";
import {
  clipValuePreview,
  buildSkillCatalogEntry,
  extractContentText,
  extractFrontmatter,
  extractMentionedSkillNames,
  extractToolTarget,
  inferSkillNameFromToolIdentity,
  normalizeUserInputPreview,
  parseSessionKey,
  readJsonLines,
  summarizeToolCallOutput,
  uniqStrings,
} from "./service-utils.js";

type ConfiguredAgent = {
  id: string;
  name?: string;
  isDefault?: boolean;
};

function listSessionsIndexPaths(stateDir: string): string[] {
  const agentsDir = path.join(stateDir, "agents");
  const discovered: string[] = [];
  try {
    const dirents = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) {
        continue;
      }
      const candidate = path.join(agentsDir, dirent.name, "sessions", "sessions.json");
      if (fs.existsSync(candidate)) {
        discovered.push(candidate);
      }
    }
  } catch {
    // Ignore missing or unreadable agents directories.
  }
  return uniqStrings([
    ...discovered,
    path.join(stateDir, "agents", "main", "sessions", "sessions.json"),
    path.join(stateDir, "agents", "main-agent", "sessions", "sessions.json"),
  ].filter((candidate) => fs.existsSync(candidate)));
}

function getAgentNameFromSessionsIndexPath(sessionsIndexPath: string): string | undefined {
  const agentDir = path.basename(path.dirname(path.dirname(sessionsIndexPath)));
  return agentDir.trim() || undefined;
}

function parseMessageTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function resolveConfiguredAgents(stateDir: string): ConfiguredAgent[] {
  const configPath = path.join(stateDir, "openclaw.json");
  try {
    if (!fs.existsSync(configPath)) {
      return [];
    }
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as {
      agents?: {
        list?: Array<{
          id?: unknown;
          name?: unknown;
          default?: unknown;
        }>;
      };
    };
    return (parsed.agents?.list ?? [])
      .map((agent) => {
        const id = typeof agent?.id === "string" ? agent.id.trim() : "";
        if (!id) {
          return undefined;
        }
        return {
          id,
          name: typeof agent?.name === "string" && agent.name.trim() ? agent.name.trim() : undefined,
          isDefault: agent?.default === true,
        };
      })
      .filter(Boolean) as ConfiguredAgent[];
  } catch {
    return [];
  }
}

function resolveEnvelopeTimestamp(
  lineTimestamp: unknown,
  messageTimestamp: unknown,
): number | undefined {
  return parseMessageTimestamp(lineTimestamp) ?? parseMessageTimestamp(messageTimestamp);
}

function resolveSessionTrajectoryFile(sessionFile: string): string | undefined {
  if (!sessionFile.endsWith(".jsonl")) {
    return undefined;
  }
  return sessionFile.replace(/\.jsonl$/, ".trajectory.jsonl");
}

function readSessionCreatedAt(sessionFile: string): number | undefined {
  const trajectoryFile = resolveSessionTrajectoryFile(sessionFile);
  if (!trajectoryFile || !fs.existsSync(trajectoryFile)) {
    return undefined;
  }
  try {
    for (const line of readJsonLines(trajectoryFile)) {
      if (line?.type !== "session.started") {
        continue;
      }
      return parseMessageTimestamp(line.ts);
    }
  } catch {
    // Ignore trajectory read failures; session traces can still be emitted.
  }
  return undefined;
}

export function createSessionSnapshotStore(stateDir: string): SessionSnapshotStore {
  const transcriptSnapshotBySession = new Map<string, SessionSnapshot>();
  const latestAssistantTextBySession = new Map<string, string>();
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
  const workspaceSkillsDir = path.join(stateDir, "workspace", "skills");

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
      sessionFileBySessionKey.clear();
      sessionSkillsBySessionKey.clear();
      sessionModelBySessionKey.clear();
      sessionMetaBySessionKey.clear();
      for (const sessionsIndexPath of listSessionsIndexPaths(stateDir)) {
        try {
          const raw = fs.readFileSync(sessionsIndexPath, "utf8");
          const parsed = JSON.parse(raw) as Record<string, {
            sessionFile?: string;
            sessionId?: string;
            updatedAt?: number;
            chatType?: string;
            lastChannel?: string;
            origin?: { provider?: string; surface?: string };
            modelProvider?: string;
            model?: string;
            skillsSnapshot?: { resolvedSkills?: Array<{ name?: string; description?: string }> };
          }>;
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
        } catch {
          // Try the next sessions index file.
        }
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
      let lastUserTs: number | undefined;
      let lastAssistantText: string | undefined;
      let lastAssistantTs: number | undefined;
      let lastAssistantThinking: string | undefined;
      let lastProvider: string | undefined;
      let lastModel: string | undefined;
      let sessionCwd: string | undefined;
      let lastAssistantUsage: SessionSnapshot["lastAssistantUsage"];
      const sessionUsageTotals: SessionSnapshot["sessionUsageTotals"] = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
      };
      let traceCount = 0;
      const invokedSkillNames = new Set<string>();
      const toolCallSkillNamesById: Record<string, string> = {};
      const currentRunToolCalls = new Map<string, TranscriptToolCall>();
      const currentRunAssistantTurns: TranscriptAssistantTurn[] = [];
      let currentRunCursorTs: number | undefined;
      let currentRunInputPreview: string | undefined;
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
          const userText = extractContentText(message.content, "text");
          lastUserText = userText ?? lastUserText;
          lastUserTs = resolveEnvelopeTimestamp(line.timestamp, message.timestamp) ?? lastUserTs;
          traceCount += 1;
          currentRunToolCalls.clear();
          currentRunAssistantTurns.length = 0;
          currentRunCursorTs = lastUserTs;
          currentRunInputPreview = normalizeUserInputPreview(userText);
        }
        if (message.role === "assistant") {
          const assistantText = extractContentText(message.content, "text");
          const assistantThinking = extractContentText(message.content, "thinking");
          const turnToolCallNames: string[] = [];
          lastAssistantText = assistantText ?? lastAssistantText;
          lastAssistantThinking = assistantThinking ?? lastAssistantThinking;
          lastProvider = typeof message.provider === "string" ? message.provider : lastProvider;
          lastModel = typeof message.model === "string" ? message.model : lastModel;
          const startedAt = resolveEnvelopeTimestamp(line.timestamp, message.timestamp);
          lastAssistantTs = startedAt ?? lastAssistantTs;
          if (Array.isArray(message.content)) {
            for (const item of message.content) {
              if (!item || typeof item !== "object") {
                continue;
              }
              const record = item as Record<string, unknown>;
              if (record.type !== "toolCall") {
                continue;
              }
              const toolCallId = typeof record.id === "string" ? record.id.trim() : "";
              const toolName = typeof record.name === "string" ? record.name.trim() : "";
              const args = record.arguments ?? record.args;
              if (!toolCallId || !toolName) {
                continue;
              }
              turnToolCallNames.push(toolName);
              const existing = currentRunToolCalls.get(toolCallId);
              currentRunToolCalls.set(toolCallId, {
                callId: toolCallId,
                name: toolName,
                args,
                result: existing?.result,
                meta: existing?.meta,
                isError: existing?.isError,
                startedAt: existing?.startedAt ?? startedAt,
                endedAt: existing?.endedAt,
              });
              const skillName = inferSkillNameFromToolIdentity(
                toolName,
                extractToolTarget(toolName, args, undefined),
                typeof args === "object" && args !== null && typeof (args as Record<string, unknown>).command === "string"
                  ? (args as Record<string, unknown>).command as string
                  : undefined,
              );
              if (skillName) {
                invokedSkillNames.add(skillName);
                toolCallSkillNamesById[toolCallId] = skillName;
              }
            }
          }
          const outputPreview = assistantText
            ? clipValuePreview(assistantText)
            : summarizeToolCallOutput(turnToolCallNames);
          currentRunAssistantTurns.push({
            startedAt: currentRunCursorTs ?? startedAt,
            endedAt: startedAt,
            provider: typeof message.provider === "string" ? message.provider : undefined,
            model: typeof message.model === "string" ? message.model : undefined,
            inputPreview: currentRunInputPreview,
            thinking: assistantThinking,
            text: assistantText,
            outputPreview,
            outputKind: assistantText ? "text" : turnToolCallNames.length > 0 ? "tool_call" : undefined,
          });
          currentRunCursorTs = startedAt ?? currentRunCursorTs;
          if (message.usage && typeof message.usage === "object") {
            const usage = message.usage as Record<string, unknown>;
            const input = typeof usage.input === "number" ? usage.input : 0;
            const output = typeof usage.output === "number" ? usage.output : 0;
            const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
            const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
            const totalTokens = typeof usage.totalTokens === "number" ? usage.totalTokens : 0;
            lastAssistantUsage = {
              input: input || undefined,
              output: output || undefined,
              cacheRead: cacheRead || undefined,
              cacheWrite: cacheWrite || undefined,
              totalTokens: totalTokens || undefined,
            };
            sessionUsageTotals.input += input;
            sessionUsageTotals.output += output;
            sessionUsageTotals.cacheRead += cacheRead;
            sessionUsageTotals.cacheWrite += cacheWrite;
            sessionUsageTotals.totalTokens += totalTokens;
          }
        }
        if (message.role === "toolResult") {
          const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId.trim() : "";
          const toolName = typeof message.toolName === "string" ? message.toolName.trim() : "";
          if (!toolCallId || !toolName) {
            continue;
          }
          const existing = currentRunToolCalls.get(toolCallId);
          currentRunToolCalls.set(toolCallId, {
            callId: toolCallId,
            name: toolName,
            args: existing?.args,
            result: message.details ?? extractContentText(message.content, "text"),
            meta: message.details,
            isError: message.isError === true,
            startedAt: existing?.startedAt,
            endedAt: resolveEnvelopeTimestamp(line.timestamp, message.timestamp),
          });
          currentRunCursorTs = resolveEnvelopeTimestamp(line.timestamp, message.timestamp) ?? currentRunCursorTs;
          currentRunInputPreview = clipValuePreview(message.details ?? extractContentText(message.content, "text"));
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
        createdAt: readSessionCreatedAt(sessionFile),
        updatedAt: sessionMetaBySessionKey.get(sessionKey)?.updatedAt,
        chatType: sessionMetaBySessionKey.get(sessionKey)?.chatType,
        lastChannel: sessionMetaBySessionKey.get(sessionKey)?.lastChannel,
        originProvider: sessionMetaBySessionKey.get(sessionKey)?.originProvider,
        originSurface: sessionMetaBySessionKey.get(sessionKey)?.originSurface,
        sessionCwd,
        sessionSkills: (sessionSkillsBySessionKey.get(sessionKey) ?? []).map((skill) => skill.name),
        mentionedSkillNames: Array.from(mentionedSkillNames),
        invokedSkillNames: Array.from(invokedSkillNames),
        toolCallSkillNamesById,
        lastRunToolCalls: Array.from(currentRunToolCalls.values()),
        lastRunAssistantTurns: currentRunAssistantTurns,
        lastUserText,
        lastUserTs,
        lastAssistantText: liveAssistantText ?? lastAssistantText,
        lastAssistantTs,
        lastAssistantThinking,
        lastProvider: lastProvider ?? sessionModelBySessionKey.get(sessionKey)?.provider,
        lastModel: lastModel ?? sessionModelBySessionKey.get(sessionKey)?.model,
        lastAssistantUsage,
        sessionUsageTotals,
        traceCount,
        mtimeMs: stats.mtimeMs,
      };
      transcriptSnapshotBySession.set(sessionKey, snapshot);
      return snapshot;
    } catch {
      return transcriptSnapshotBySession.get(sessionKey);
    }
  };

  return {
    refreshSessionsIndex,
    loadSessionSnapshot,
    setLatestAssistantText(sessionKey: string, text: string) {
      latestAssistantTextBySession.set(sessionKey, text);
      const cached = transcriptSnapshotBySession.get(sessionKey);
      if (cached) {
        cached.lastAssistantText = text;
      }
    },
    invalidateSessionFile(sessionFile: string) {
      for (const [sessionKey, currentSessionFile] of sessionFileBySessionKey.entries()) {
        if (currentSessionFile === sessionFile) {
          transcriptSnapshotBySession.delete(sessionKey);
        }
      }
    },
    clear() {
      transcriptSnapshotBySession.clear();
      latestAssistantTextBySession.clear();
      sessionFileBySessionKey.clear();
      sessionSkillsBySessionKey.clear();
      sessionModelBySessionKey.clear();
      sessionMetaBySessionKey.clear();
    },
  };
}

function parseAgentKey(value: string | undefined): { runtimeEnvironment?: string; agentName?: string } {
  const parsed = parseSessionKey(value);
  return {
    runtimeEnvironment: parsed.sessionChannel,
    agentName: parsed.sessionAgent,
  };
}

function detectOpenClawVersion(): string | undefined {
  const envVersion = process.env.OPENCLAW_VERSION?.trim();
  if (envVersion) {
    return envVersion;
  }
  const candidates = [
    path.join(path.dirname(path.dirname(process.execPath)), "lib", "node_modules", "openclaw", "package.json"),
    "/usr/local/lib/node_modules/openclaw/package.json",
    "/usr/lib/node_modules/openclaw/package.json",
  ];
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim()) {
        return parsed.version.trim();
      }
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

export function resolveRuntimeMetadata(stateDir: string): RuntimeMetadata {
  const sessionsIndexCandidates = listSessionsIndexPaths(stateDir);
  const configuredAgents = resolveConfiguredAgents(stateDir);
  const discoveredAgentNames = uniqStrings(
    sessionsIndexCandidates
      .map((candidate) => getAgentNameFromSessionsIndexPath(candidate))
      .filter(Boolean) as string[],
  );
  const singleConfiguredAgent = configuredAgents.length === 1 ? configuredAgents[0] : undefined;
  for (const candidate of sessionsIndexCandidates) {
    try {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      const raw = fs.readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const firstSessionKey = Object.keys(parsed)[0];
      const { runtimeEnvironment, agentName } = parseAgentKey(firstSessionKey);
      return {
        openclawVersion: detectOpenClawVersion(),
        runtimeEnvironment:
          discoveredAgentNames.length === 1
            ? runtimeEnvironment ?? (process.env.NODE_ENV?.trim() || undefined)
            : (process.env.NODE_ENV?.trim() || undefined),
        agentId:
          discoveredAgentNames.length === 1
            ? singleConfiguredAgent?.id ?? agentName
            : undefined,
        agentName:
          discoveredAgentNames.length === 1
            ? singleConfiguredAgent?.name ?? singleConfiguredAgent?.id ?? discoveredAgentNames[0] ?? agentName
            : undefined,
      };
    } catch {
      // Try the next candidate.
    }
  }
  return {
    openclawVersion: detectOpenClawVersion(),
    runtimeEnvironment: process.env.NODE_ENV?.trim() || undefined,
    agentId: singleConfiguredAgent?.id,
    agentName: singleConfiguredAgent?.name ?? singleConfiguredAgent?.id,
  };
}
