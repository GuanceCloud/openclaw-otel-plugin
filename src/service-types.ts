export type ActiveRootSpan = {
  requestKey?: string;
  sessionIdentity?: string;
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
};

export type ActiveSkillInvocationSpan = {
  callId: string;
  name: string;
  span: any;
  ctx: any;
  startedAt: number;
  source: "runtime";
  toolName?: string;
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

export type ActiveRunSpan = {
  requestKey?: string;
  sessionIdentity?: string;
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
  requestCounter: any;
  requestDuration: any;
  genAiAgentRequestCount: any;
  genAiAgentRequestDuration: any;
  sessionInputTokensCounter: any;
  sessionOutputTokensCounter: any;
  sessionTotalTokensCounter: any;
  sessionTraceCounter: any;
  genAiAgentSessionTokenInput: any;
  genAiAgentSessionTokenOutput: any;
  genAiAgentSessionTokenTotal: any;
  genAiAgentSessionTokenUsage: any;
  genAiAgentSessionTraceCount: any;
  toolCallCounter: any;
  toolErrorCounter: any;
  toolDuration: any;
  genAiClientOperationDuration: any;
  skillActivationCounter: any;
  genAiAgentSkillActivationCount: any;
  modelCallCounter: any;
  diagnosticsTokensCounter: any;
  genAiClientTokenUsage: any;
  diagnosticsCostUsdCounter: any;
  diagnosticsRunDurationMs: any;
  diagnosticsContextTokens: any;
  diagnosticsWebhookReceivedCounter: any;
  diagnosticsWebhookErrorCounter: any;
  diagnosticsWebhookDurationMs: any;
  genAiRuntimeWebhookReceivedCount: any;
  genAiRuntimeWebhookErrorCount: any;
  genAiRuntimeWebhookDuration: any;
  diagnosticsMessageQueuedCounter: any;
  diagnosticsMessageProcessedCounter: any;
  diagnosticsMessageDurationMs: any;
  genAiRuntimeMessageQueuedCount: any;
  genAiRuntimeMessageProcessedCount: any;
  genAiRuntimeMessageDuration: any;
  diagnosticsQueueLaneEnqueueCounter: any;
  diagnosticsQueueLaneDequeueCounter: any;
  diagnosticsQueueDepth: any;
  diagnosticsQueueWaitMs: any;
  genAiRuntimeQueueEnqueueCount: any;
  genAiRuntimeQueueDequeueCount: any;
  genAiRuntimeQueueDepth: any;
  genAiRuntimeQueueWait: any;
  diagnosticsSessionStateCounter: any;
  genAiRuntimeSessionStateCount: any;
  diagnosticsSessionStuckCounter: any;
  diagnosticsSessionStuckAgeMs: any;
  genAiRuntimeSessionStuckCount: any;
  genAiRuntimeSessionStuckAge: any;
  diagnosticsRunAttemptCounter: any;
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
  createdAt?: number;
  updatedAt?: number;
  chatType?: string;
  lastChannel?: string;
  originProvider?: string;
  originSurface?: string;
  sessionCwd?: string;
  sessionSkills?: string[];
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
};

export type SkillCatalogEntry = {
  name: string;
  aliases: string[];
};

export type SessionSnapshotStore = {
  refreshSessionsIndex(): void;
  loadSessionSnapshot(sessionKey: string | undefined): SessionSnapshot | undefined;
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
