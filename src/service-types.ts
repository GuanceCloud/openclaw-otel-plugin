export type ActiveRootSpan = {
  requestKey?: string;
  sessionIdentity?: string;
  runId?: string;
  runIds?: Set<string>;
  span: any;
  ctx: any;
  startedAt: number;
  lastTouchedAt: number;
};

export type ActiveSkillSpan = {
  name: string;
  span: any;
  ctx: any;
  startedAt: number;
  source: "runtime" | "transcript";
  metadata?: SkillCatalogEntry;
  resultStatus?: "completed" | "error";
  lastCallId?: string;
};

export type ActiveSkillInvocationSpan = {
  callId: string;
  name: string;
  span: any;
  ctx: any;
  startedAt: number;
  source: "runtime";
  toolName?: string;
  metadata?: SkillCatalogEntry;
  resultStatus?: "completed" | "error";
};

export type ActiveToolSpan = {
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
  provider?: string;
  namespace?: string;
  mcpToolName?: string;
  mcpHost?: string;
  skillMetadata?: SkillCatalogEntry;
};

export type RunAggregate = {
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

export type SessionUsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
};

export type RunUsageTotals = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export type ActiveRunSpan = {
  requestKey?: string;
  sessionIdentity?: string;
  runId?: string;
  runIds?: Set<string>;
  span: any;
  ctx: any;
  startedAt: number;
  lastTouchedAt: number;
  mainStartTs: number;
  messageQueuedTs?: number;
  orchestrationCursorTs?: number;
  channelIngressEmitted?: boolean;
  dispatchQueueEmitted?: boolean;
  sessionProcessingEmitted?: boolean;
  channelEgressEmitted?: boolean;
  runtimeLifecycleSpans?: any[];
  pendingChannelIngressWindow?: {
    startTs: number;
    endTs: number;
    channel?: string;
    source?: string;
  };
  pendingDispatchQueueWindow?: {
    startTs: number;
    endTs: number;
    channel?: string;
    source?: string;
    queueWaitMs?: number;
  };
  pendingSessionProcessingWindow?: {
    startTs: number;
    endTs: number;
  };
  modelSpanEmitted: boolean;
  thinkingSpanEmitted?: boolean;
  transcriptAssistantTurnsEmitted?: number;
  transcriptToolCallIds?: Set<string>;
  observedToolCallIds?: Set<string>;
  pendingFinalOutcome?: string;
  finalAttrsApplied?: boolean;
  usedSkillNames: Set<string>;
  usedToolNames: Set<string>;
  usedToolTargets: Set<string>;
  usedToolCommands: Set<string>;
  usedToolResultStatuses: Set<string>;
  skillSpans: Map<string, ActiveSkillSpan>;
  skillInvocationSpans: Map<string, ActiveSkillInvocationSpan>;
  toolSpans: Map<string, ActiveToolSpan>;
  activeSkillName?: string;
  userSpan?: any;
  userCtx?: any;
  userStartTs?: number;
  modelSpan?: any;
  modelCtx?: any;
  modelStartTs?: number;
  modelEndTs?: number;
  aggregate: RunAggregate;
};

export type RuntimeEvents = {
  onAgentEvent?: (listener: (evt: any) => void) => (() => boolean) | (() => void);
  onSessionTranscriptUpdate?: (listener: (update: { sessionFile: string }) => void) => (() => void);
};

export type RuntimeLike = {
  events?: RuntimeEvents;
};

export type RuntimeMetadata = {
  openclawVersion?: string;
  runtimeEnvironment?: string;
  agentId?: string;
  agentName?: string;
};

export type MetricInstruments = {
  genAiAgentRequestCount: any;
  genAiAgentRequestDuration: any;
  genAiAgentSessionTokenInput: any;
  genAiAgentSessionTokenOutput: any;
  genAiAgentSessionTokenTotal: any;
  genAiAgentSessionTokenUsage: any;
  genAiAgentSessionTraceCount: any;
  genAiAgentOperationCount: any;
  genAiAgentOperationDuration: any;
  genAiAgentSkillActivationCount: any;
  genAiAgentTokenUsage: any;
  genAiRuntimeWebhookReceivedCount: any;
  genAiRuntimeWebhookErrorCount: any;
  genAiRuntimeWebhookDuration: any;
  genAiRuntimeMessageQueuedCount: any;
  genAiRuntimeMessageProcessedCount: any;
  genAiRuntimeMessageDuration: any;
  genAiRuntimeQueueEnqueueCount: any;
  genAiRuntimeQueueDequeueCount: any;
  genAiRuntimeQueueDepth: any;
  genAiRuntimeQueueWait: any;
  genAiRuntimeSessionStateCount: any;
  genAiRuntimeSessionStuckCount: any;
  genAiRuntimeSessionStuckAge: any;
};

export type TranscriptToolCall = {
  callId: string;
  name: string;
  args?: unknown;
  result?: unknown;
  meta?: unknown;
  isError?: boolean;
  startedAt?: number;
  endedAt?: number;
};

export type TranscriptAssistantTurn = {
  startedAt?: number;
  endedAt?: number;
  provider?: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
  };
  inputPreview?: string;
  thinking?: string;
  text?: string;
  outputPreview?: string;
  outputKind?: string;
};

export type SessionSnapshot = {
  sessionFile: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  agentName?: string;
  runId?: string;
  runCompleted?: boolean;
  runTerminalType?: string;
  runFinalStatus?: string;
  createdAt?: number;
  updatedAt?: number;
  chatType?: string;
  lastChannel?: string;
  originProvider?: string;
  originSurface?: string;
  sessionCwd?: string;
  sessionSkills?: string[];
  sessionSkillCatalog?: SkillCatalogEntry[];
  mentionedSkillNames?: string[];
  invokedSkillNames?: string[];
  toolCallSkillNamesById?: Record<string, string>;
  lastRunToolCalls?: TranscriptToolCall[];
  lastRunAssistantTurns?: TranscriptAssistantTurn[];
  lastUserText?: string;
  lastUserTs?: number;
  lastAssistantText?: string;
  lastAssistantTs?: number;
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
  sessionUsageTotals?: SessionUsageTotals;
  traceCount?: number;
  mtimeMs: number;
  trajectoryMtimeMs?: number;
};

export type SessionRunState = {
  runId?: string;
  runCompleted?: boolean;
  runTerminalType?: string;
  runFinalStatus?: string;
  terminalSourceSeq?: number;
};

export type CompletedTrajectoryRun = {
  sessionKey: string;
  sessionFile: string;
  sessionId?: string;
  runId: string;
  sourceSeq: number;
  startedAt?: number;
  completedAt?: number;
  provider?: string;
  model?: string;
  finalStatus?: string;
  finalPromptText?: string;
  userText?: string;
  userTs?: number;
  assistantText?: string;
  assistantTs?: number;
  usage?: RunUsageTotals;
};

export type SkillSourceType = "system" | "user" | "workspace";

export type SkillCatalogEntry = {
  name: string;
  aliases: string[];
  description?: string;
  path?: string;
  sourceType?: SkillSourceType;
  version?: string;
};

export type SessionSnapshotStore = {
  refreshSessionsIndex(): void;
  loadSessionSnapshot(sessionKey: string | undefined): SessionSnapshot | undefined;
  loadSessionRunState(
    sessionKey: string | undefined,
    runId?: string,
  ): SessionRunState;
  listRecentSessionKeys(sinceUpdatedAt?: number): string[];
  listCompletedTrajectoryRuns(
    sessionKey: string | undefined,
    afterSourceSeqExclusive?: number,
  ): CompletedTrajectoryRun[];
  resolveSessionKeyById(sessionId: string): string | undefined;
  resolveSessionKeyByFile(sessionFile: string): string | undefined;
  setLatestAssistantText(sessionKey: string, text: string): void;
  invalidateSessionFile(sessionFile: string): void;
  clear(): void;
};

export type OtelBootstrapResult = {
  sdk: any;
  context: any;
  trace: any;
  tracer: any;
  SpanKind: any;
  SpanStatusCode: any;
  SeverityNumber: any;
  diagnosticsLogger: any;
  instruments: MetricInstruments;
};
