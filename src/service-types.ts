export type ActiveRootSpan = {
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

export type ActiveRunSpan = {
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
  skillInvocationSpans: Map<string, ActiveSkillInvocationSpan>;
  toolSpans: Map<string, ActiveToolSpan>;
  activeSkillName?: string;
  userSpan?: any;
  userCtx?: any;
  userStartTs?: number;
  modelSpan?: any;
  modelCtx?: any;
  modelStartTs?: number;
  aggregate: RunAggregate;
};

export type RuntimeEvents = {
  onAgentEvent?: (listener: (evt: any) => void) => (() => boolean) | (() => void);
  onSessionTranscriptUpdate?: (listener: (update: { sessionFile: string }) => void) => (() => void);
};

export type RuntimeLike = {
  events?: RuntimeEvents;
};

export type MetricInstruments = {
  requestCounter: any;
  requestDuration: any;
  toolCallCounter: any;
  toolErrorCounter: any;
  toolDuration: any;
  skillActivationCounter: any;
  modelCallCounter: any;
  diagnosticsTokensCounter: any;
  diagnosticsCostUsdCounter: any;
  diagnosticsRunDurationMs: any;
  diagnosticsContextTokens: any;
  diagnosticsWebhookReceivedCounter: any;
  diagnosticsWebhookErrorCounter: any;
  diagnosticsWebhookDurationMs: any;
  diagnosticsMessageQueuedCounter: any;
  diagnosticsMessageProcessedCounter: any;
  diagnosticsMessageDurationMs: any;
  diagnosticsQueueLaneEnqueueCounter: any;
  diagnosticsQueueLaneDequeueCounter: any;
  diagnosticsQueueDepth: any;
  diagnosticsQueueWaitMs: any;
  diagnosticsSessionStateCounter: any;
  diagnosticsSessionStuckCounter: any;
  diagnosticsSessionStuckAgeMs: any;
  diagnosticsRunAttemptCounter: any;
};

export type SessionSnapshot = {
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
  instruments: MetricInstruments;
};
