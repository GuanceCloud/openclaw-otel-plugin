import test from "node:test";
import assert from "node:assert/strict";

import { createDiagnosticEventHandler } from "../dist/src/diagnostic-event-handler.js";

function createFakeSpan(name) {
  return {
    name,
    status: undefined,
    ended: false,
    endTime: undefined,
    setStatus(status) {
      this.status = status;
    },
    end(endTime) {
      this.ended = true;
      this.endTime = endTime;
    },
    setAttributes() {},
    addEvent() {},
  };
}

test("message.processed does not emit standalone thinking span", () => {
  const childCalls = [];
  const run = {
    ctx: { ctx: "run" },
    modelCtx: { ctx: "model" },
  };

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsSessionStateCounter: { add() {} },
      diagnosticsQueueDepth: { record() {} },
      diagnosticsMessageProcessedCounter: { add() {} },
      diagnosticsMessageDurationMs: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {},
    getRoot() {
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    getRun() {
      return run;
    },
    ensureUserSpan() {
      return run;
    },
    syncRootFromRun() {},
    endRun() {},
    endRoot() {},
    clearRun() {},
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        lastAssistantText: "final answer",
        lastAssistantThinking: "step one\nstep two",
        lastProvider: "openai",
        lastModel: "gpt-5",
      };
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan(name, evt, attrs, durationMs, parentCtx) {
      const span = createFakeSpan(name);
      childCalls.push({ name, evt, attrs, durationMs, parentCtx, span });
      return {
        span,
        root: undefined,
        effectiveDurationMs: durationMs ?? 0,
        startTime: new Date((evt.ts ?? 0) - (durationMs ?? 0)),
        endTime: new Date(evt.ts ?? 0),
      };
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {
      return run;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      return false;
    },
    emitSyntheticModelSpan() {},
    emitTranscriptToolSpans() {},
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
  });

  handler({
    type: "message.processed",
    sessionKey: "s1",
    ts: 1000,
    channel: "chat",
    messageId: 1,
    chatId: 2,
    outcome: "completed",
    durationMs: 900,
  });

  assert.deepEqual(
    childCalls.map((call) => call.name),
    [],
  );
});

test("message.processed requests channel_egress lifecycle span", () => {
  const lifecycleCalls = [];
  const run = {
    ctx: { ctx: "run" },
    modelCtx: { ctx: "model" },
  };

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsMessageProcessedCounter: { add() {} },
      diagnosticsMessageDurationMs: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {},
    getRoot() {
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    getRun() {
      return run;
    },
    ensureUserSpan() {
      return run;
    },
    syncRootFromRun() {},
    endRun() {},
    endRoot() {},
    clearRun() {},
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        lastAssistantText: "final answer",
        lastProvider: "openai",
        lastModel: "gpt-5",
      };
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan(...args) {
      lifecycleCalls.push({ type: "runtime", args });
    },
    ensureRuntimeLifecycleSpans(evt, options) {
      lifecycleCalls.push({ type: "lifecycle", evt, options });
      return run;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      return false;
    },
    emitSyntheticModelSpan() {},
    emitTranscriptToolSpans() {},
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
  });

  handler({
    type: "message.processed",
    sessionKey: "s1",
    ts: 1000,
    channel: "chat",
    outcome: "completed",
  });

  assert.equal(lifecycleCalls.length, 1);
  assert.equal(lifecycleCalls[0].type, "lifecycle");
  assert.equal(lifecycleCalls[0].evt.ts, 1000);
  assert.equal(lifecycleCalls[0].options.emitEgress, true);
  assert.equal(lifecycleCalls[0].options.outcome, "completed");
});

test("message.processed keeps the active trace open for later transcript growth", () => {
  let endRunCalls = 0;
  let endRootCalls = 0;
  let clearRunCalls = 0;
  const run = {
    ctx: { ctx: "run" },
    modelCtx: { ctx: "model" },
    lastTouchedAt: 0,
  };

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsMessageProcessedCounter: { add() {} },
      diagnosticsMessageDurationMs: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {},
    getRoot() {
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    getRun() {
      return run;
    },
    ensureUserSpan() {
      return run;
    },
    syncRootFromRun() {},
    endRun() {
      endRunCalls += 1;
    },
    endRoot() {
      endRootCalls += 1;
    },
    clearRun() {
      clearRunCalls += 1;
    },
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        lastAssistantText: "final answer",
        lastRunAssistantTurns: [{ startedAt: 1, endedAt: 2 }],
      };
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {
      return run;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      return true;
    },
    emitSyntheticModelSpan() {},
    emitTranscriptToolSpans() {},
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
    hasReplayWatermark() {
      return false;
    },
    markReplayWatermark() {},
  });

  handler({
    type: "message.processed",
    sessionKey: "s1",
    sessionId: "sid-1",
    ts: 1000,
    channel: "chat",
    outcome: "completed",
  });

  assert.equal(endRunCalls, 0);
  assert.equal(endRootCalls, 0);
  assert.equal(clearRunCalls, 0);
  assert.equal(run.pendingFinalOutcome, "completed");
});

test("message.processed prefers transcript replay and marks replay watermark for completed sessions", () => {
  let transcriptCalls = 0;
  let toolReplayCalls = 0;
  let syntheticCalls = 0;
  let watermarkMarked = 0;
  const run = {
    ctx: { ctx: "run" },
    modelCtx: { ctx: "model" },
  };
  const snapshot = {
    sessionFile: "session.jsonl",
    mtimeMs: 1,
    runId: "run-123",
    runCompleted: true,
    lastAssistantText: "final answer",
    lastRunAssistantTurns: [{ startedAt: 1, endedAt: 2 }],
  };

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsMessageProcessedCounter: { add() {} },
      diagnosticsMessageDurationMs: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {},
    getRoot() {
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    getRun() {
      return run;
    },
    ensureUserSpan() {
      return run;
    },
    syncRootFromRun() {},
    endRun() {},
    endRoot() {},
    clearRun() {},
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return snapshot;
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {
      return run;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      transcriptCalls += 1;
      return true;
    },
    emitSyntheticModelSpan() {
      syntheticCalls += 1;
    },
    emitTranscriptToolSpans() {
      toolReplayCalls += 1;
    },
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
    hasReplayWatermark() {
      return false;
    },
    markReplayWatermark() {
      watermarkMarked += 1;
    },
  });

  handler({
    type: "message.processed",
    sessionKey: "s1",
    ts: 1000,
    channel: "chat",
    outcome: "completed",
  });

  assert.equal(transcriptCalls, 1);
  assert.equal(toolReplayCalls, 1);
  assert.equal(syntheticCalls, 0);
  assert.equal(watermarkMarked, 1);
});

test("message.processed finalizes active trace without replaying stale transcript", () => {
  let transcriptCalls = 0;
  let toolReplayCalls = 0;
  let syntheticCalls = 0;
  const lifecycleCalls = [];
  let syncCalls = 0;
  let skillCalls = 0;
  let logAttrs;
  const run = {
    runId: "run-new",
    runIds: new Set(["run-new"]),
    ctx: { ctx: "run" },
    modelCtx: { ctx: "model" },
    messageQueuedTs: 2_000,
  };
  const snapshot = {
    sessionFile: "session.jsonl",
    mtimeMs: 1,
    runId: "run-old",
    lastUserTs: 1_000,
    lastAssistantTs: 1_500,
    lastAssistantText: "old answer",
    lastRunAssistantTurns: [{ startedAt: 1_200, endedAt: 1_500 }],
    lastRunToolCalls: [{ startedAt: 1_250, endedAt: 1_400 }],
  };

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsMessageProcessedCounter: { add() {} },
      diagnosticsMessageDurationMs: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {},
    getRoot() {
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    getRun() {
      return run;
    },
    ensureUserSpan() {
      return run;
    },
    syncRootFromRun() {
      syncCalls += 1;
    },
    endRun() {},
    endRoot() {},
    clearRun() {},
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return snapshot;
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog(_evt, attrs) {
      logAttrs = attrs;
    },
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans(evt, options) {
      lifecycleCalls.push({ evt, options });
      return run;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {
      skillCalls += 1;
    },
    emitTranscriptModelSpans() {
      transcriptCalls += 1;
      return true;
    },
    emitSyntheticModelSpan() {
      syntheticCalls += 1;
    },
    emitTranscriptToolSpans() {
      toolReplayCalls += 1;
    },
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
    hasReplayWatermark() {
      return false;
    },
  });

  handler({
    type: "message.processed",
    sessionKey: "s1",
    ts: 3_000,
    channel: "chat",
    outcome: "completed",
  });

  assert.equal(transcriptCalls, 0);
  assert.equal(toolReplayCalls, 0);
  assert.equal(syntheticCalls, 0);
  assert.equal(skillCalls, 0);
  assert.equal(lifecycleCalls.length, 1);
  assert.equal(lifecycleCalls[0].options.snapshot, undefined);
  assert.equal(lifecycleCalls[0].options.outputPreview, undefined);
  assert.equal(syncCalls, 1);
  assert.equal(run.pendingFinalOutcome, "completed");
  assert.equal(logAttrs["openclaw.output.preview"], undefined);
  assert.equal(logAttrs["openclaw.provider"], undefined);
});

test("message.processed does not synthesize replay traces for incomplete snapshots without an active trace", () => {
  let transcriptCalls = 0;
  let toolReplayCalls = 0;
  let syntheticCalls = 0;
  let lifecycleCalls = 0;
  const snapshot = {
    sessionFile: "session.jsonl",
    mtimeMs: 1,
    runId: "run-live",
    runCompleted: false,
    lastUserTs: 2_000,
    lastAssistantTs: 2_500,
    lastAssistantText: "partial answer",
    lastRunAssistantTurns: [],
    lastRunToolCalls: [],
  };

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsMessageProcessedCounter: { add() {} },
      diagnosticsMessageDurationMs: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {},
    getRoot() {
      return undefined;
    },
    getRun() {
      return undefined;
    },
    ensureUserSpan() {
      return undefined;
    },
    syncRootFromRun() {},
    endRun() {},
    endRoot() {},
    clearRun() {},
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return snapshot;
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {
      lifecycleCalls += 1;
      return { ctx: { ctx: "run" }, modelCtx: { ctx: "model" } };
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      transcriptCalls += 1;
      return false;
    },
    emitSyntheticModelSpan() {
      syntheticCalls += 1;
    },
    emitTranscriptToolSpans() {
      toolReplayCalls += 1;
    },
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
    hasReplayWatermark() {
      return false;
    },
  });

  handler({
    type: "message.processed",
    sessionKey: "s1",
    ts: 3_000,
    channel: "chat",
    outcome: "completed",
  });

  assert.equal(transcriptCalls, 0);
  assert.equal(toolReplayCalls, 0);
  assert.equal(syntheticCalls, 0);
  assert.equal(lifecycleCalls, 1);
});

test("message.processed replays completed transcript snapshots even without an active trace", () => {
  let transcriptCalls = 0;
  let toolReplayCalls = 0;
  let lifecycleCalls = 0;
  const snapshot = {
    sessionFile: "session.jsonl",
    mtimeMs: 1,
    runId: "run-123",
    runCompleted: true,
    lastAssistantText: "final answer",
    lastRunAssistantTurns: [{ startedAt: 1, endedAt: 2 }],
  };

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsMessageProcessedCounter: { add() {} },
      diagnosticsMessageDurationMs: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {},
    getRoot() {
      return undefined;
    },
    getRun() {
      return undefined;
    },
    ensureUserSpan() {
      return undefined;
    },
    syncRootFromRun() {},
    endRun() {},
    endRoot() {},
    clearRun() {},
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return snapshot;
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {
      lifecycleCalls += 1;
      return { ctx: { ctx: "run" }, modelCtx: { ctx: "model" } };
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      transcriptCalls += 1;
      return true;
    },
    emitSyntheticModelSpan() {},
    emitTranscriptToolSpans() {
      toolReplayCalls += 1;
    },
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
    hasReplayWatermark() {
      return false;
    },
    markReplayWatermark() {},
  });

  handler({
    type: "message.processed",
    sessionKey: "s1",
    ts: 1000,
    channel: "chat",
    outcome: "completed",
  });

  assert.equal(transcriptCalls, 1);
  assert.equal(toolReplayCalls, 1);
  assert.equal(lifecycleCalls, 1);
});

test("message.processed does not replay stale snapshots while a new trace is active", () => {
  let transcriptCalls = 0;
  let syntheticCalls = 0;
  const lifecycleCalls = [];
  let syncCalls = 0;
  let finalizedCalls = 0;
  let skillCalls = 0;
  const run = {
    runId: "run-new",
    runIds: new Set(["run-new"]),
    ctx: { ctx: "run" },
    modelCtx: { ctx: "model" },
    mainStartTs: 350,
    messageQueuedTs: 350,
  };

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsMessageProcessedCounter: { add() {} },
      diagnosticsMessageDurationMs: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {},
    getRoot() {
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    getRun() {
      return run;
    },
    ensureUserSpan() {
      return run;
    },
    syncRootFromRun() {
      syncCalls += 1;
    },
    endRun() {
      throw new Error("not expected");
    },
    endRoot() {
      throw new Error("not expected");
    },
    clearRun() {
      throw new Error("not expected");
    },
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        runId: "run-old",
        runCompleted: true,
        lastUserTs: 360,
        lastAssistantTs: 100,
        lastAssistantText: "旧回答",
        lastRunAssistantTurns: [{ startedAt: 90, endedAt: 100 }],
      };
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans(evt, options) {
      lifecycleCalls.push({ evt, options });
      return run;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {
      skillCalls += 1;
    },
    emitTranscriptModelSpans() {
      transcriptCalls += 1;
      return true;
    },
    emitSyntheticModelSpan() {
      syntheticCalls += 1;
    },
    emitTranscriptToolSpans() {},
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
    hasReplayWatermark() {
      return false;
    },
    markReplayWatermark() {
      finalizedCalls += 1;
    },
  });

  handler({
    type: "message.processed",
    sessionKey: "s1",
    ts: 360,
    channel: "chat",
    outcome: "completed",
  });

  assert.equal(transcriptCalls, 0);
  assert.equal(syntheticCalls, 0);
  assert.equal(skillCalls, 0);
  assert.equal(lifecycleCalls.length, 1);
  assert.equal(lifecycleCalls[0].options.snapshot, undefined);
  assert.equal(lifecycleCalls[0].options.outputPreview, undefined);
  assert.equal(syncCalls, 1);
  assert.equal(run.pendingFinalOutcome, "completed");
  assert.equal(finalizedCalls, 0);
});

test("session.state processing requests lifecycle shell spans", () => {
  const lifecycleCalls = [];
  const run = {
    ctx: { ctx: "run" },
    modelCtx: { ctx: "model" },
  };

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsSessionStateCounter: { add() {} },
      diagnosticsQueueDepth: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {},
    getRoot() {
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    getRun() {
      return run;
    },
    ensureUserSpan() {
      return run;
    },
    syncRootFromRun() {},
    endRun() {},
    endRoot() {},
    clearRun() {},
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        lastAssistantText: "final answer",
        lastAssistantThinking: "step one\nstep two",
        lastProvider: "openai",
        lastModel: "gpt-5",
      };
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan(...args) {
      lifecycleCalls.push({ type: "runtime", args });
    },
    ensureRuntimeLifecycleSpans(evt, options) {
      lifecycleCalls.push({ type: "lifecycle", evt, options });
      return run;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      return false;
    },
    emitSyntheticModelSpan() {},
    emitTranscriptToolSpans() {},
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
  });

  handler({
    type: "session.state",
    sessionKey: "s1",
    ts: 1000,
    state: "processing",
  });

  assert.equal(lifecycleCalls.length, 1);
  assert.equal(lifecycleCalls[0].type, "lifecycle");
  assert.equal(lifecycleCalls[0].evt.ts, 1000);
  assert.equal(lifecycleCalls[0].options.processingStartTs, 1000);
});

test("session.state processing backfills trace start from transcript snapshot", () => {
  const rootCalls = [];
  const runCalls = [];
  const userCalls = [];
  const lifecycleCalls = [];
  const run = {
    ctx: { ctx: "run" },
    modelCtx: { ctx: "model" },
    mainStartTs: 360_000,
    messageQueuedTs: 900,
    orchestrationCursorTs: 360_000,
  };

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsSessionStateCounter: { add() {} },
      diagnosticsQueueDepth: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {},
    getRoot(evt) {
      rootCalls.push(evt.ts);
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    getRun(evt) {
      runCalls.push(evt.ts);
      return run;
    },
    ensureUserSpan(evt) {
      userCalls.push(evt.ts);
      return run;
    },
    syncRootFromRun() {},
    endRun() {},
    endRoot() {},
    clearRun() {},
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        runId: "run-fresh",
        lastUserTs: 900,
        lastRunAssistantTurns: [{ startedAt: 950, endedAt: 980 }],
        lastRunToolCalls: [{ startedAt: 960 }],
      };
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans(evt, options) {
      lifecycleCalls.push({ evt, options });
      return run;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      return false;
    },
    emitSyntheticModelSpan() {},
    emitTranscriptToolSpans() {},
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
  });

  handler({
    type: "session.state",
    sessionKey: "s1",
    ts: 1000,
    state: "processing",
  });

  assert.equal(rootCalls[0], 900);
  assert.equal(userCalls[0], 900);
  assert.equal(runCalls.at(-1), 900);
  assert.equal(run.mainStartTs, 900);
  assert.equal(run.orchestrationCursorTs, 1000);
  assert.equal(lifecycleCalls[0].evt.ts, 900);
  assert.equal(lifecycleCalls[0].options.startTsHint, 900);
  assert.equal(lifecycleCalls[0].options.processingStartTs, 1000);
  assert.equal(lifecycleCalls[0].options.snapshot.runId, "run-fresh");
});

test("session.state processing ignores stale transcript snapshots from an older request", () => {
  const rootCalls = [];
  const runCalls = [];
  const userCalls = [];
  const lifecycleCalls = [];
  const run = {
    ctx: { ctx: "run" },
    modelCtx: { ctx: "model" },
    mainStartTs: 360_000,
    orchestrationCursorTs: 360_000,
  };

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsSessionStateCounter: { add() {} },
      diagnosticsQueueDepth: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {},
    getRoot(evt) {
      rootCalls.push(evt.ts);
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    getRun(evt) {
      runCalls.push(evt.ts);
      return run;
    },
    ensureUserSpan(evt) {
      userCalls.push(evt.ts);
      return run;
    },
    syncRootFromRun() {},
    endRun() {},
    endRoot() {},
    clearRun() {},
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        runId: "run-old",
        lastUserTs: 100,
        lastRunAssistantTurns: [{ startedAt: 150, endedAt: 200 }],
        lastRunToolCalls: [{ startedAt: 160 }],
      };
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans(evt, options) {
      lifecycleCalls.push({ evt, options });
      return run;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      return false;
    },
    emitSyntheticModelSpan() {},
    emitTranscriptToolSpans() {},
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
  });

  handler({
    type: "session.state",
    sessionKey: "s1",
    ts: 360_000,
    state: "processing",
  });

  assert.equal(rootCalls[0], 360_000);
  assert.equal(userCalls[0], 360_000);
  assert.equal(runCalls.at(-1), 360_000);
  assert.equal(run.mainStartTs, 360_000);
  assert.equal(lifecycleCalls[0].evt.ts, 360_000);
  assert.equal(lifecycleCalls[0].options.startTsHint, 360_000);
  assert.equal(lifecycleCalls[0].options.snapshot, undefined);
});

test("session.state processing strips stale snapshot runId while keeping backfill metadata", () => {
  const lifecycleCalls = [];
  const run = {
    ctx: { ctx: "run" },
    modelCtx: { ctx: "model" },
    mainStartTs: 1_000,
    messageQueuedTs: 1_000,
    orchestrationCursorTs: 1_000,
  };

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsSessionStateCounter: { add() {} },
      diagnosticsQueueDepth: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {},
    getRoot() {
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    getRun() {
      return run;
    },
    ensureUserSpan() {
      return run;
    },
    syncRootFromRun() {},
    endRun() {},
    endRoot() {},
    clearRun() {},
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        runId: "run-old",
        lastChannel: "webchat",
        lastUserTs: 900,
        lastRunAssistantTurns: [{ startedAt: 930, endedAt: 950 }],
        lastRunToolCalls: [{ startedAt: 940 }],
      };
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans(evt, options) {
      lifecycleCalls.push({ evt, options });
      return run;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      return false;
    },
    emitSyntheticModelSpan() {},
    emitTranscriptToolSpans() {},
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
  });

  handler({
    type: "session.state",
    sessionKey: "s1",
    ts: 1_200,
    state: "processing",
  });

  assert.equal(lifecycleCalls[0].evt.ts, 1_000);
  assert.equal(lifecycleCalls[0].options.startTsHint, 1_000);
  assert.equal(lifecycleCalls[0].options.snapshot.lastChannel, "webchat");
  assert.equal(lifecycleCalls[0].options.snapshot.runId, undefined);
});

test("session.state processing never backfills earlier than the queued message start", () => {
  const rootCalls = [];
  const runCalls = [];
  const userCalls = [];
  const lifecycleCalls = [];
  const run = {
    ctx: { ctx: "run" },
    modelCtx: { ctx: "model" },
    mainStartTs: 1_778_235_063_227,
    orchestrationCursorTs: 1_778_235_063_227,
    messageQueuedTs: 1_778_235_063_227,
  };

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsSessionStateCounter: { add() {} },
      diagnosticsQueueDepth: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {},
    getRoot(evt) {
      rootCalls.push(evt.ts);
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    getRun(evt) {
      runCalls.push(evt.ts);
      return run;
    },
    ensureUserSpan(evt) {
      userCalls.push(evt.ts);
      return run;
    },
    syncRootFromRun() {},
    endRun() {},
    endRoot() {},
    clearRun() {},
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        lastUserTs: 1_778_234_484_027,
        lastRunAssistantTurns: [{ startedAt: 1_778_234_786_024, endedAt: 1_778_234_795_229 }],
        lastRunToolCalls: [{ startedAt: 1_778_234_788_249 }],
      };
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans(evt, options) {
      lifecycleCalls.push({ evt, options });
      return run;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      return false;
    },
    emitSyntheticModelSpan() {},
    emitTranscriptToolSpans() {},
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
  });

  handler({
    type: "session.state",
    sessionKey: "s1",
    ts: 1_778_235_063_316,
    state: "processing",
  });

  assert.equal(rootCalls[0], 1_778_235_063_227);
  assert.equal(userCalls[0], 1_778_235_063_227);
  assert.equal(runCalls.at(-1), 1_778_235_063_227);
  assert.equal(run.mainStartTs, 1_778_235_063_227);
  assert.equal(lifecycleCalls[0].evt.ts, 1_778_235_063_227);
  assert.equal(lifecycleCalls[0].options.startTsHint, 1_778_235_063_227);
  assert.equal(lifecycleCalls[0].options.processingStartTs, 1_778_235_063_316);
});

test("session.state idle skips duplicate replay after the transcript has already been finalized", () => {
  let transcriptCalls = 0;
  let syntheticCalls = 0;
  let lifecycleCalls = 0;
  let endRunCalls = 0;
  let endRootCalls = 0;
  let clearRunCalls = 0;

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsSessionStateCounter: { add() {} },
      diagnosticsQueueDepth: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {},
    getRoot() {
      return undefined;
    },
    getRun() {
      return undefined;
    },
    ensureUserSpan() {
      return undefined;
    },
    syncRootFromRun() {},
    endRun() {
      endRunCalls += 1;
    },
    endRoot() {
      endRootCalls += 1;
    },
    clearRun() {
      clearRunCalls += 1;
    },
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        lastAssistantText: "final answer",
        lastRunAssistantTurns: [{ startedAt: 1, endedAt: 2 }],
      };
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {
      lifecycleCalls += 1;
      return undefined;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      transcriptCalls += 1;
      return true;
    },
    emitSyntheticModelSpan() {
      syntheticCalls += 1;
    },
    emitTranscriptToolSpans() {},
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
    hasReplayWatermark() {
      return true;
    },
    markReplayWatermark() {},
  });

  handler({
    type: "session.state",
    sessionKey: "s1",
    ts: 1000,
    state: "idle",
  });

  assert.equal(transcriptCalls, 0);
  assert.equal(syntheticCalls, 0);
  assert.equal(lifecycleCalls, 0);
  assert.equal(endRunCalls, 0);
  assert.equal(endRootCalls, 0);
  assert.equal(clearRunCalls, 0);
});

test("session.state idle skips stale transcript snapshots from an older request when no active trace exists", () => {
  let transcriptCalls = 0;
  let syntheticCalls = 0;
  let lifecycleCalls = 0;
  let endRunCalls = 0;
  let endRootCalls = 0;
  let clearRunCalls = 0;

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsSessionStateCounter: { add() {} },
      diagnosticsQueueDepth: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {},
    getRoot() {
      return undefined;
    },
    getRun() {
      return undefined;
    },
    ensureUserSpan() {
      return undefined;
    },
    syncRootFromRun() {},
    endRun() {
      endRunCalls += 1;
    },
    endRoot() {
      endRootCalls += 1;
    },
    clearRun() {
      clearRunCalls += 1;
    },
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        runId: "run-old",
        runCompleted: true,
        runFinalStatus: "success",
        lastAssistantText: "old answer",
        lastAssistantTs: 1,
        lastRunAssistantTurns: [{ startedAt: 1, endedAt: 2 }],
      };
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {
      lifecycleCalls += 1;
      return undefined;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      transcriptCalls += 1;
      return true;
    },
    emitSyntheticModelSpan() {
      syntheticCalls += 1;
    },
    emitTranscriptToolSpans() {},
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
    hasReplayWatermark() {
      return false;
    },
    markReplayWatermark() {},
  });

  handler({
    type: "session.state",
    sessionKey: "s1",
    sessionId: "sid-1",
    ts: 1000 + (6 * 60 * 1000),
    state: "idle",
  });

  assert.equal(transcriptCalls, 0);
  assert.equal(syntheticCalls, 0);
  assert.equal(lifecycleCalls, 0);
  assert.equal(endRunCalls, 0);
  assert.equal(endRootCalls, 0);
  assert.equal(clearRunCalls, 0);
});

test("session.state idle closes active trace without replaying stale transcript", () => {
  let transcriptCalls = 0;
  let syntheticCalls = 0;
  let toolReplayCalls = 0;
  const lifecycleCalls = [];
  const endRunCalls = [];
  const endRootCalls = [];
  let clearRunCalls = 0;
  let watermarkCalls = 0;
  const run = {
    runId: "run-new",
    runIds: new Set(["run-new"]),
    ctx: { ctx: "run" },
    modelCtx: { ctx: "model" },
    messageQueuedTs: 2_000,
    pendingFinalOutcome: "completed",
  };

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsSessionStateCounter: { add() {} },
      diagnosticsQueueDepth: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {},
    getRoot() {
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    getRun() {
      return run;
    },
    ensureUserSpan() {
      return run;
    },
    syncRootFromRun() {},
    endRun(_evt, attrs) {
      endRunCalls.push(attrs);
    },
    endRoot(_evt, attrs) {
      endRootCalls.push(attrs);
    },
    clearRun() {
      clearRunCalls += 1;
    },
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        runId: "run-old",
        runCompleted: true,
        runFinalStatus: "success",
        lastChannel: "old-channel",
        lastAssistantText: "old answer",
        lastAssistantTs: 1_500,
        lastRunAssistantTurns: [{ startedAt: 1_200, endedAt: 1_500 }],
        lastRunToolCalls: [{ startedAt: 1_250, endedAt: 1_400 }],
      };
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans(evt, options) {
      lifecycleCalls.push({ evt, options });
      return run;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      transcriptCalls += 1;
      return true;
    },
    emitSyntheticModelSpan() {
      syntheticCalls += 1;
    },
    emitTranscriptToolSpans() {
      toolReplayCalls += 1;
    },
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
    hasReplayWatermark() {
      return false;
    },
    markReplayWatermark() {
      watermarkCalls += 1;
    },
  });

  handler({
    type: "session.state",
    sessionKey: "s1",
    sessionId: "sid-1",
    ts: 3_000,
    state: "idle",
  });

  assert.equal(transcriptCalls, 0);
  assert.equal(toolReplayCalls, 0);
  assert.equal(syntheticCalls, 0);
  assert.equal(lifecycleCalls.length, 1);
  assert.equal(lifecycleCalls[0].evt.channel, undefined);
  assert.equal(lifecycleCalls[0].options.snapshot, undefined);
  assert.equal(lifecycleCalls[0].options.outputPreview, undefined);
  assert.equal(endRunCalls.length, 1);
  assert.equal(endRootCalls.length, 1);
  assert.equal(endRunCalls[0].final_status, "completed");
  assert.equal(endRootCalls[0].final_status, "completed");
  assert.equal(clearRunCalls, 1);
  assert.equal(watermarkCalls, 0);
});

test("session.state idle falls back to completed final_status when message.processed never arrived", () => {
  const endRunCalls = [];
  const endRootCalls = [];
  const run = {
    runId: "run-123",
    ctx: { ctx: "run" },
    modelCtx: { ctx: "model" },
  };

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsSessionStateCounter: { add() {} },
      diagnosticsQueueDepth: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {},
    getRoot() {
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    getRun() {
      return run;
    },
    ensureUserSpan() {
      return run;
    },
    syncRootFromRun() {},
    endRun(_evt, attrs) {
      endRunCalls.push(attrs);
    },
    endRoot(_evt, attrs) {
      endRootCalls.push(attrs);
    },
    clearRun() {},
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        runCompleted: true,
        lastAssistantText: "final answer",
        lastRunAssistantTurns: [{ startedAt: 1, endedAt: 2 }],
      };
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {
      return run;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      return true;
    },
    emitSyntheticModelSpan() {},
    emitTranscriptToolSpans() {},
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
    hasReplayWatermark() {
      return false;
    },
    markReplayWatermark() {},
  });

  handler({
    type: "session.state",
    sessionKey: "s1",
    sessionId: "sid-1",
    ts: 1000,
    state: "idle",
  });

  assert.equal(endRunCalls.length, 1);
  assert.equal(endRootCalls.length, 1);
  assert.equal(endRunCalls[0].final_status, "completed");
  assert.equal(endRootCalls[0].final_status, "completed");
  assert.equal(endRunCalls[0].state, "idle");
  assert.equal(endRootCalls[0].state, "idle");
});

test("session.state idle prefers trajectory final status over idle", () => {
  const endRunCalls = [];
  const endRootCalls = [];
  const run = {
    runId: "run-123",
    ctx: { ctx: "run" },
    modelCtx: { ctx: "model" },
  };

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsSessionStateCounter: { add() {} },
      diagnosticsQueueDepth: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {},
    getRoot() {
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    getRun() {
      return run;
    },
    ensureUserSpan() {
      return run;
    },
    syncRootFromRun() {},
    endRun(_evt, attrs) {
      endRunCalls.push(attrs);
    },
    endRoot(_evt, attrs) {
      endRootCalls.push(attrs);
    },
    clearRun() {},
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        runCompleted: true,
        runFinalStatus: "success",
        lastAssistantText: "final answer",
        lastRunAssistantTurns: [{ startedAt: 1, endedAt: 2 }],
      };
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {
      return run;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      return true;
    },
    emitSyntheticModelSpan() {},
    emitTranscriptToolSpans() {},
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
    hasReplayWatermark() {
      return false;
    },
    markReplayWatermark() {},
  });

  handler({
    type: "session.state",
    sessionKey: "s1",
    sessionId: "sid-1",
    ts: 1000,
    state: "idle",
  });

  assert.equal(endRunCalls[0].final_status, "completed");
  assert.equal(endRootCalls[0].final_status, "completed");
});

test("session.state idle leaves final_status empty when no business outcome is available", () => {
  const endRunCalls = [];
  const endRootCalls = [];
  const run = {
    runId: "run-123",
    ctx: { ctx: "run" },
    modelCtx: { ctx: "model" },
  };

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsSessionStateCounter: { add() {} },
      diagnosticsQueueDepth: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {},
    getRoot() {
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    getRun() {
      return run;
    },
    ensureUserSpan() {
      return run;
    },
    syncRootFromRun() {},
    endRun(_evt, attrs) {
      endRunCalls.push(attrs);
    },
    endRoot(_evt, attrs) {
      endRootCalls.push(attrs);
    },
    clearRun() {},
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        runCompleted: false,
        lastAssistantText: "final answer",
        lastRunAssistantTurns: [{ startedAt: 1, endedAt: 2 }],
      };
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {
      return run;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      return true;
    },
    emitSyntheticModelSpan() {},
    emitTranscriptToolSpans() {},
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
    hasReplayWatermark() {
      return false;
    },
    markReplayWatermark() {},
  });

  handler({
    type: "session.state",
    sessionKey: "s1",
    sessionId: "sid-1",
    ts: 1000,
    state: "idle",
  });

  assert.equal(endRunCalls[0].final_status, undefined);
  assert.equal(endRootCalls[0].final_status, undefined);
  assert.equal(endRunCalls[0].state, "idle");
  assert.equal(endRootCalls[0].state, "idle");
});

test("model.usage emits llm span and preserves model context", () => {
  const childCalls = [];
  const run = {
    ctx: { ctx: "run" },
  };

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsTokensCounter: { add() {} },
      diagnosticsCostUsdCounter: { add() {} },
      diagnosticsRunDurationMs: { record() {} },
      diagnosticsContextTokens: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {},
    getRoot() {
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    getRun() {
      return run;
    },
    ensureUserSpan() {
      return run;
    },
    syncRootFromRun() {},
    endRun() {},
    endRoot() {},
    clearRun() {},
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return undefined;
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan(name, evt, attrs, durationMs, parentCtx) {
      const span = createFakeSpan(name);
      childCalls.push({ name, evt, attrs, durationMs, parentCtx, span });
      return {
        span,
        root: undefined,
        effectiveDurationMs: durationMs ?? 0,
        startTime: new Date((evt.ts ?? 0) - (durationMs ?? 0)),
        endTime: new Date(evt.ts ?? 0),
      };
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {
      return run;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      return false;
    },
    emitSyntheticModelSpan() {},
    emitTranscriptToolSpans() {},
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
  });

  handler({
    type: "model.usage",
    sessionKey: "s1",
    sessionId: "sid-1",
    ts: 1000,
    channel: "chat",
    provider: "openai",
    model: "gpt-5",
    usage: { input: 12, output: 34, cacheRead: 6400, total: 6446 },
    durationMs: 400,
  });

  assert.equal(childCalls[0].name, "llm");
  assert.equal(childCalls[0].attrs["span.kind"], "model");
  assert.equal(childCalls[0].attrs["openclaw.model"], "gpt-5");
  assert.equal(childCalls[0].attrs["llm.model"], "gpt-5");
  assert.equal(childCalls[0].attrs["openclaw.tokens.cache_read"], 6400);
  assert.equal(childCalls[0].attrs["openclaw.tokens.total"], 46);
  assert.equal(childCalls[0].attrs["llm.total_tokens"], undefined);
  assert.equal(childCalls[0].span.status.code, "OK");
  assert.equal(childCalls[0].span.ended, true);
  assert.equal(run.modelStartTs, 600);
  assert.equal(run.modelCtx.span.name, "llm");
});

test("model.usage uses snapshot sessionId for gen_ai agent token metrics when event sessionId is missing", () => {
  const tokenRecords = [];
  const agentOperationCounts = [];
  const agentOperationDurations = [];
  const run = {
    ctx: { ctx: "run" },
  };

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsTokensCounter: { add() {} },
      diagnosticsCostUsdCounter: { add() {} },
      diagnosticsRunDurationMs: { record() {} },
      diagnosticsContextTokens: { record() {} },
      genAiAgentTokenUsage: {
        record(value, attrs) {
          tokenRecords.push({ value, attrs });
        },
      },
      genAiAgentOperationCount: {
        add(value, attrs) {
          agentOperationCounts.push({ value, attrs });
        },
      },
      genAiAgentOperationDuration: {
        record(value, attrs) {
          agentOperationDurations.push({ value, attrs });
        },
      },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {},
    getRoot() {
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    getRun() {
      return run;
    },
    ensureUserSpan() {
      return run;
    },
    syncRootFromRun() {},
    endRun() {},
    endRoot() {},
    clearRun() {},
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return { sessionId: "sid-from-snapshot" };
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan(name, evt, attrs, durationMs, parentCtx) {
      const span = createFakeSpan(name);
      return {
        span,
        root: undefined,
        effectiveDurationMs: durationMs ?? 0,
        startTime: new Date((evt.ts ?? 0) - (durationMs ?? 0)),
        endTime: new Date(evt.ts ?? 0),
      };
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {
      return run;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      return false;
    },
    emitSyntheticModelSpan() {},
    emitTranscriptToolSpans() {},
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
  });

  handler({
    type: "model.usage",
    sessionKey: "s1",
    ts: 1000,
    channel: "chat",
    provider: "openai",
    model: "gpt-5",
    usage: { input: 12, output: 34, total: 46 },
    durationMs: 400,
  });

  assert.equal(tokenRecords.length, 3);
  assert.equal(tokenRecords[0].attrs.session_id, "sid-from-snapshot");
  assert.equal(tokenRecords[1].attrs.session_id, "sid-from-snapshot");
  assert.equal(tokenRecords[2].attrs.session_id, "sid-from-snapshot");
  assert.equal(tokenRecords[0].attrs.token_type, "input");
  assert.equal(tokenRecords[1].attrs.token_type, "output");
  assert.equal(tokenRecords[2].attrs.token_type, "total");
  assert.equal(agentOperationCounts.length, 1);
  assert.equal(agentOperationCounts[0].value, 1);
  assert.equal(agentOperationCounts[0].attrs.operation_name, "model");
  assert.equal(agentOperationCounts[0].attrs.session_id, "sid-from-snapshot");
  assert.equal(agentOperationDurations.length, 1);
  assert.equal(agentOperationDurations[0].value, 400);
  assert.equal(agentOperationDurations[0].attrs.operation_name, "model");
  assert.equal(agentOperationDurations[0].attrs.session_id, "sid-from-snapshot");
});

test("message.queued rotates a completed active run before starting the next request", () => {
  const oldRun = {
    ctx: { ctx: "old-run" },
    mainStartTs: 1000,
    modelEndTs: 1500,
    modelSpanEmitted: true,
    aggregate: { modelCalls: 1 },
    usedToolNames: new Set(["web_search"]),
    pendingFinalOutcome: "completed",
  };
  const newRun = {
    ctx: { ctx: "new-run" },
  };
  let cleared = false;
  let beginCalls = 0;
  const endRunCalls = [];
  const endRootCalls = [];

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsMessageQueuedCounter: { add() {} },
      diagnosticsQueueDepth: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {
      beginCalls += 1;
    },
    getRoot() {
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    getRun() {
      return cleared ? undefined : oldRun;
    },
    ensureUserSpan() {
      return newRun;
    },
    syncRootFromRun() {},
    endRun(evt, attrs) {
      endRunCalls.push({ evt, attrs });
    },
    endRoot(evt, attrs) {
      endRootCalls.push({ evt, attrs });
    },
    clearRun() {
      cleared = true;
    },
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return undefined;
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {
      return undefined;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      return false;
    },
    emitSyntheticModelSpan() {},
    emitTranscriptToolSpans() {},
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
  });

  handler({
    type: "message.queued",
    sessionKey: "s1",
    sessionId: "sid-1",
    ts: 2000,
    channel: "chat",
    source: "feishu",
  });

  assert.equal(endRunCalls.length, 1);
  assert.equal(endRootCalls.length, 1);
  assert.equal(beginCalls, 1);
  assert.equal(endRunCalls[0].evt.ts, 1999);
  assert.equal(endRootCalls[0].evt.ts, 1999);
});

test("message.queued rotates an active run that only reached terminal lifecycle spans", () => {
  const oldRun = {
    ctx: { ctx: "old-run" },
    mainStartTs: 1000,
    orchestrationCursorTs: 1000,
    modelSpanEmitted: false,
    aggregate: { modelCalls: 0 },
    usedToolNames: new Set(),
    channelEgressEmitted: true,
    pendingFinalOutcome: "completed",
  };
  const newRun = {
    ctx: { ctx: "new-run" },
  };
  let cleared = false;
  let beginCalls = 0;
  const endRunCalls = [];
  const endRootCalls = [];

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsMessageQueuedCounter: { add() {} },
      diagnosticsQueueDepth: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {
      beginCalls += 1;
    },
    getRoot() {
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    getRun() {
      return cleared ? undefined : oldRun;
    },
    ensureUserSpan() {
      return newRun;
    },
    syncRootFromRun() {},
    endRun(evt, attrs) {
      endRunCalls.push({ evt, attrs });
    },
    endRoot(evt, attrs) {
      endRootCalls.push({ evt, attrs });
    },
    clearRun() {
      cleared = true;
    },
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return undefined;
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {
      return undefined;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      return false;
    },
    emitSyntheticModelSpan() {},
    emitTranscriptToolSpans() {},
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
  });

  handler({
    type: "message.queued",
    sessionKey: "s1",
    sessionId: "sid-1",
    ts: 2000,
    channel: "chat",
    source: "feishu",
  });

  assert.equal(endRunCalls.length, 1);
  assert.equal(endRootCalls.length, 1);
  assert.equal(beginCalls, 1);
  assert.equal(endRunCalls[0].evt.ts, 1999);
  assert.equal(endRootCalls[0].evt.ts, 1999);
});

test("message.queued rotates an active run once session processing has started", () => {
  const oldRun = {
    ctx: { ctx: "old-run" },
    mainStartTs: 1000,
    orchestrationCursorTs: 1500,
    modelSpanEmitted: false,
    aggregate: { modelCalls: 0 },
    usedToolNames: new Set(),
    sessionProcessingEmitted: true,
  };
  const newRun = {
    ctx: { ctx: "new-run" },
  };
  let cleared = false;
  let beginCalls = 0;
  const endRunCalls = [];
  const endRootCalls = [];

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsMessageQueuedCounter: { add() {} },
      diagnosticsQueueDepth: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {
      beginCalls += 1;
    },
    getRoot() {
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    getRun() {
      return cleared ? undefined : oldRun;
    },
    ensureUserSpan() {
      return newRun;
    },
    syncRootFromRun() {},
    endRun(evt, attrs) {
      endRunCalls.push({ evt, attrs });
    },
    endRoot(evt, attrs) {
      endRootCalls.push({ evt, attrs });
    },
    clearRun() {
      cleared = true;
    },
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return undefined;
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {
      return undefined;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      return false;
    },
    emitSyntheticModelSpan() {},
    emitTranscriptToolSpans() {},
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
  });

  handler({
    type: "message.queued",
    sessionKey: "s1",
    sessionId: "sid-1",
    ts: 2000,
    channel: "chat",
    source: "feishu",
  });

  assert.equal(endRunCalls.length, 1);
  assert.equal(endRootCalls.length, 1);
  assert.equal(beginCalls, 1);
  assert.equal(endRunCalls[0].evt.ts, 1999);
  assert.equal(endRootCalls[0].evt.ts, 1999);
});

test("message.queued reuses the current trace when execution has not started yet", () => {
  const pendingRun = {
    ctx: { ctx: "pending-run" },
    mainStartTs: 1000,
    modelSpanEmitted: false,
    aggregate: { modelCalls: 0 },
    usedToolNames: new Set(),
  };
  let beginCalls = 0;
  let endRunCalls = 0;
  let endRootCalls = 0;

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsMessageQueuedCounter: { add() {} },
      diagnosticsQueueDepth: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {
      beginCalls += 1;
    },
    getRoot() {
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    getRun() {
      return pendingRun;
    },
    ensureUserSpan() {
      return pendingRun;
    },
    syncRootFromRun() {},
    endRun() {
      endRunCalls += 1;
    },
    endRoot() {
      endRootCalls += 1;
    },
    clearRun() {},
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return undefined;
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {
      return undefined;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      return false;
    },
    emitSyntheticModelSpan() {},
    emitTranscriptToolSpans() {},
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
  });

  handler({
    type: "message.queued",
    sessionKey: "s1",
    sessionId: "sid-1",
    ts: 2000,
    channel: "chat",
    source: "feishu",
  });

  assert.equal(beginCalls, 0);
  assert.equal(endRunCalls, 0);
  assert.equal(endRootCalls, 0);
  assert.equal(pendingRun.messageQueuedTs, 2000);
});

test("message.queued skips internal heartbeat requests", () => {
  let beginCalls = 0;
  let ensureUserCalls = 0;

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsMessageQueuedCounter: { add() {} },
      diagnosticsQueueDepth: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {
      beginCalls += 1;
    },
    getRoot() {
      throw new Error("not expected");
    },
    getRun() {
      return undefined;
    },
    ensureUserSpan() {
      ensureUserCalls += 1;
      return undefined;
    },
    syncRootFromRun() {},
    endRun() {},
    endRoot() {},
    clearRun() {},
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        lastUserText: "[OpenClaw heartbeat poll]",
      };
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {
      throw new Error("not expected");
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      return false;
    },
    emitSyntheticModelSpan() {},
    emitTranscriptToolSpans() {},
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
  });

  handler({
    type: "message.queued",
    sessionKey: "s1",
    sessionId: "sid-1",
    ts: 2000,
    channel: "chat",
    source: "feishu",
  });

  assert.equal(beginCalls, 0);
  assert.equal(ensureUserCalls, 0);
});

test("message.queued skips internal heartbeat requests when only sessionId is present", () => {
  let beginCalls = 0;
  let ensureUserCalls = 0;

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsMessageQueuedCounter: { add() {} },
      diagnosticsQueueDepth: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {
      beginCalls += 1;
    },
    getRoot() {
      throw new Error("not expected");
    },
    getRun() {
      return undefined;
    },
    ensureUserSpan() {
      ensureUserCalls += 1;
      return undefined;
    },
    syncRootFromRun() {},
    endRun() {},
    endRoot() {},
    clearRun() {},
    updateAggregateTokens() {},
    loadSessionSnapshot(sessionKey) {
      if (sessionKey === "agent:main:dashboard:resolved-user") {
        return {
          sessionFile: "session.jsonl",
          mtimeMs: 1,
          lastUserText: "[OpenClaw heartbeat poll]",
        };
      }
      return undefined;
    },
    resolveSessionKey(evt) {
      return evt.sessionId === "sid-1" ? "agent:main:dashboard:resolved-user" : undefined;
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {
      throw new Error("not expected");
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      return false;
    },
    emitSyntheticModelSpan() {},
    emitTranscriptToolSpans() {},
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
  });

  handler({
    type: "message.queued",
    sessionId: "sid-1",
    ts: 2000,
    channel: "chat",
    source: "feishu",
  });

  assert.equal(beginCalls, 0);
  assert.equal(ensureUserCalls, 0);
});

test("message.queued keeps runtime continue requests on the active trace", () => {
  const activeRun = {
    ctx: { ctx: "active-run" },
    mainStartTs: 1000,
    modelSpanEmitted: true,
    aggregate: { modelCalls: 1 },
    usedToolNames: new Set(["exec"]),
    messageQueuedTs: undefined,
  };
  let beginCalls = 0;
  let ensureUserCalls = 0;
  let endRunCalls = 0;
  let endRootCalls = 0;

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsMessageQueuedCounter: { add() {} },
      diagnosticsQueueDepth: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {
      beginCalls += 1;
    },
    getRoot() {
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    getRun() {
      return activeRun;
    },
    ensureUserSpan() {
      ensureUserCalls += 1;
      return activeRun;
    },
    syncRootFromRun() {},
    endRun() {
      endRunCalls += 1;
    },
    endRoot() {
      endRootCalls += 1;
    },
    clearRun() {},
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        lastUserText: "Continue the OpenClaw runtime event.",
      };
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {
      return undefined;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      return false;
    },
    emitSyntheticModelSpan() {},
    emitTranscriptToolSpans() {},
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
  });

  handler({
    type: "message.queued",
    sessionKey: "s1",
    sessionId: "sid-1",
    ts: 2000,
    channel: "chat",
    source: "runtime",
  });

  assert.equal(beginCalls, 0);
  assert.equal(ensureUserCalls, 0);
  assert.equal(endRunCalls, 0);
  assert.equal(endRootCalls, 0);
  assert.equal(activeRun.messageQueuedTs, 2000);
});

test("message.processed skips internal heartbeat requests", () => {
  let lifecycleCalls = 0;
  let transcriptModelCalls = 0;

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      diagnosticsMessageProcessedCounter: { add() {} },
      diagnosticsMessageDurationMs: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {},
    getRoot() {
      return undefined;
    },
    getRun() {
      return undefined;
    },
    ensureUserSpan() {
      return undefined;
    },
    syncRootFromRun() {},
    endRun() {},
    endRoot() {},
    clearRun() {},
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        lastAssistantText: "HEARTBEAT_OK",
      };
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    emitDiagnosticLog() {},
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {
      lifecycleCalls += 1;
      return undefined;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      transcriptModelCalls += 1;
      return false;
    },
    emitSyntheticModelSpan() {},
    emitTranscriptToolSpans() {},
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
  });

  handler({
    type: "message.processed",
    sessionKey: "s1",
    ts: 1000,
    channel: "chat",
    messageId: 1,
    chatId: 2,
    outcome: "completed",
    durationMs: 900,
  });

  assert.equal(lifecycleCalls, 0);
  assert.equal(transcriptModelCalls, 0);
});

test("queue lane diagnostics only emit metrics and logs without standalone spans", () => {
  let childSpanCalls = 0;
  let dequeueMetricCalls = 0;
  let queueWaitMetricCalls = 0;
  let diagnosticLogCalls = 0;

  const handler = createDiagnosticEventHandler({
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
    instruments: {
      genAiRuntimeQueueDequeueCount: {
        add() {
          dequeueMetricCalls += 1;
        },
      },
      genAiRuntimeQueueDepth: { record() {} },
      genAiRuntimeQueueWait: {
        record() {
          queueWaitMetricCalls += 1;
        },
      },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
    beginRequestTrace() {},
    getRoot() {
      return undefined;
    },
    getRun() {
      return undefined;
    },
    ensureUserSpan() {
      return undefined;
    },
    syncRootFromRun() {},
    endRun() {},
    endRoot() {},
    clearRun() {},
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return undefined;
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      childSpanCalls += 1;
      return {
        span: createFakeSpan("queue"),
        root: undefined,
        effectiveDurationMs: 0,
        startTime: new Date(1000),
        endTime: new Date(1000),
      };
    },
    emitDiagnosticLog() {
      diagnosticLogCalls += 1;
    },
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {
      return undefined;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
    emitTranscriptModelSpans() {
      return false;
    },
    emitSyntheticModelSpan() {},
    emitTranscriptToolSpans() {},
    emitFallbackThinkingSpan() {},
    annotateToolLoop() {
      return false;
    },
  });

  handler({
    type: "queue.lane.dequeue",
    ts: 1000,
    lane: "default",
    queueSize: 3,
    waitMs: 42,
  });

  assert.equal(childSpanCalls, 0);
  assert.equal(dequeueMetricCalls, 1);
  assert.equal(queueWaitMetricCalls, 1);
  assert.equal(diagnosticLogCalls, 1);
});
