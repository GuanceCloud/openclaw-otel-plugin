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

test("message.processed prefers transcript replay and marks replay watermark", () => {
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

test("model.usage emits model_request span and preserves model context", () => {
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
    usage: { input: 12, output: 34, total: 46 },
    durationMs: 400,
  });

  assert.equal(childCalls[0].name, "model_request");
  assert.equal(childCalls[0].attrs["span.kind"], "model");
  assert.equal(childCalls[0].attrs["llm.model"], "gpt-5");
  assert.equal(childCalls[0].span.status.code, "OK");
  assert.equal(childCalls[0].span.ended, true);
  assert.equal(run.modelStartTs, 600);
  assert.equal(run.modelCtx.span.name, "model_request");
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
      diagnosticsQueueLaneDequeueCounter: {
        add() {
          dequeueMetricCalls += 1;
        },
      },
      diagnosticsQueueDepth: { record() {} },
      diagnosticsQueueWaitMs: {
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
