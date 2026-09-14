import test from "node:test";
import assert from "node:assert/strict";

import { createDiagnosticEventHandler } from "../dist/src/diagnostic-event-handler.js";

test("first-chunk timing records per-call seconds without root events or cross-run timing", () => {
  const records = [];
  const events = [];
  const run = { runId: "run-1", span: { addEvent: (...args) => events.push(args) } };
  const handler = createDiagnosticEventHandler({
    instruments: { genAiClientTimeToFirstChunk: { record: (...args) => records.push(args) } },
    cleanupExpiredRoots() {},
    getRun: () => run,
  });
  const call = {
    type: "model.call.completed", runId: "run-1", callId: "call-1",
    sessionId: "session-1", provider: "openai", model: "model-a",
    ts: 5000, durationMs: 2000, timeToFirstByteMs: 250,
  };
  handler(call);
  handler(call);
  handler({ ...call, callId: "retry", type: "model.call.error", timeToFirstByteMs: 0 });
  handler({ ...call, runId: "run-2" });
  assert.deepEqual(records.map(([value]) => value), [0.25, 0, 0.25]);
  assert.deepEqual(records[0][1], {
    agent_runtime: "openclaw", operation_name: "chat", provider_name: "openai",
    request_model: "model-a", status: "completed",
  });
  assert.equal(records[1][1].status, "error");
  assert.equal(events.length, 0);
  assert.equal(run.modelCallTimings.size, 2);
  assert.equal(run.modelCallTimings.get("call-1").firstChunkSeconds, 0.25);
  assert.equal(run.modelCallTimings.get("retry").firstChunkSeconds, 0);
});

test("first-chunk timing ignores absent or invalid observations and start events", () => {
  const records = [];
  const handler = createDiagnosticEventHandler({
    instruments: { genAiClientTimeToFirstChunk: { record: (...args) => records.push(args) } },
    cleanupExpiredRoots() {},
    getRun: () => undefined,
  });
  const call = {
    type: "model.call.error", runId: "run", callId: "call",
    provider: "openai", model: "model-a", durationMs: 1000, ts: 2000,
  };
  for (const timeToFirstByteMs of [undefined, null, -1, NaN, Infinity, 1001, "200"]) {
    handler({ ...call, timeToFirstByteMs });
  }
  for (const durationMs of [undefined, NaN, Infinity, -1]) {
    handler({ ...call, timeToFirstByteMs: 100, durationMs });
  }
  handler({ ...call, callId: undefined, timeToFirstByteMs: 100 });
  handler({ ...call, type: "model.call.started" });
  assert.equal(records.length, 0);
  handler({ ...call, timeToFirstByteMs: 100 });
  assert.equal(records.length, 1);
  assert.equal(records[0][0], 0.1);
});

test("first-chunk timing accepts a secondary run ID owned by the active trace", () => {
  const records = [];
  const run = { runId: "primary", runIds: new Set(["primary", "native"]), span: { addEvent() {} } };
  const handler = createDiagnosticEventHandler({
    instruments: { genAiClientTimeToFirstChunk: { record: (...args) => records.push(args) } },
    cleanupExpiredRoots() {}, getRun: () => run, emitModelTurnDebugLog() {},
  });
  handler({ type: "model.call.completed", runId: "native", callId: "call", provider: "openai", model: "m",
    ts: 2000, durationMs: 1000, timeToFirstByteMs: 200 });
  assert.equal(records.length, 1);
  assert.equal(run.modelCallTimings.get("call").firstChunkSeconds, 0.2);
});

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

test("native first response is exported as a standard llm tag before span end", () => {
  const children = [];
  let deferred;
  const rootSpan = createFakeSpan("invoke_agent");
  const run = { runId: "r", span: rootSpan, ctx: "run", mainStartTs: 1000 };
  const handler = createDiagnosticEventHandler({
    instruments: {}, SpanStatusCode: { OK: 1 }, SeverityNumber: { INFO: 9 },
    trace: { setSpan: (_ctx, span) => span },
    cleanupExpiredRoots() {}, getRun: () => run,
    loadSessionSnapshot: () => undefined,
    enrichWithTranscript: (_key, attrs) => attrs,
    updateAggregateTokens() {}, ensureRuntimeLifecycleSpans: () => run,
    getActiveSkillCtx: () => undefined,
    emitDiagnosticLog() {}, emitModelTurnDebugLog() {}, emitRuntimeOrchestrationSpan() {},
    deferNativeModelSpanEnd(options) { deferred = options; },
    createChildSpan(name, evt, attrs, durationMs, parentCtx) {
      const span = createFakeSpan(name);
      children.push({ name, attrs, durationMs, parentCtx, span });
      return { span, effectiveDurationMs: durationMs, startTime: new Date(evt.ts - durationMs), endTime: new Date(evt.ts) };
    },
  });
  handler({ type: "model.call.completed", sessionKey: "s", runId: "r", callId: "c", provider: "p", model: "m",
    ts: 2000, durationMs: 1000, timeToFirstByteMs: 250, usage: { input: 1, output: 2 } });
  handler({ type: "model.usage", sessionKey: "s", provider: "p", model: "m", ts: 2000,
    durationMs: 1000, usage: { input: 1, output: 2 } });
  assert.equal(children.length, 1);
  assert.equal(children[0].name, "llm");
  assert.equal(children[0].attrs["gen_ai.response.time_to_first_chunk"], 0.25);
  assert.equal(children[0].attrs.time_to_first_chunk_ms, undefined);
  assert.equal(children[0].durationMs, 1000);
  assert.equal(children[0].parentCtx, "run");
  assert.equal(deferred.rootSpan, rootSpan);
  assert.ok(deferred);
  assert.equal(children[0].span.ended, false);
  deferred.finalize();
  assert.equal(children[0].span.ended, true);
});

test("native model calls stay under the live request and suppress the later aggregate llm", () => {
  const children = [];
  const aggregateEvents = [];
  const run = { runId: "run-1", ctx: "invoke-agent", mainStartTs: 1000 };
  const handler = createDiagnosticEventHandler({
    instruments: { genAiClientTimeToFirstChunk: { record() {} } },
    SpanStatusCode: { OK: 1, ERROR: 2 }, SeverityNumber: { INFO: 9 },
    trace: { setSpan: (_ctx, span) => span },
    cleanupExpiredRoots() {}, getRun: () => run, getRoot: () => ({ span: createFakeSpan("root") }),
    loadSessionSnapshot: () => undefined, enrichWithTranscript: (_key, attrs) => attrs,
    updateAggregateTokens: (evt) => aggregateEvents.push(evt),
    ensureRuntimeLifecycleSpans() { throw new Error("aggregate model.usage must not create a lifecycle span"); },
    createChildSpan(name, evt, attrs, durationMs, parentCtx) {
      const span = createFakeSpan(name);
      children.push({ name, attrs, durationMs, parentCtx, span });
      return { span, effectiveDurationMs: durationMs, startTime: new Date(evt.ts - durationMs), endTime: new Date(evt.ts) };
    },
    emitDiagnosticLog() {}, emitModelTurnDebugLog() {}, emitRuntimeOrchestrationSpan() {},
  });

  for (const [index, timeToFirstByteMs] of [3588, 1544, 2957].entries()) {
    handler({
      type: "model.call.completed", sessionKey: "session-key", sessionId: "session-id",
      runId: "run-1", callId: `call-${index + 1}`, provider: "volcengine-plan", model: "ark-code-latest",
      ts: 10_000 + index * 10_000, durationMs: 5_000, timeToFirstByteMs,
      usage: { input: 10 + index, output: 2 },
    });
  }
  handler({
    type: "model.usage", sessionKey: "session-key", sessionId: "session-id",
    provider: "volcengine-plan", model: "ark-code-latest", ts: 30_100, durationMs: 29_100,
    usage: { input: 33, output: 6 },
  });

  assert.equal(children.length, 3);
  assert.deepEqual(children.map((child) => child.parentCtx), ["invoke-agent", "invoke-agent", "invoke-agent"]);
  assert.deepEqual(
    children.map((child) => child.attrs["gen_ai.response.time_to_first_chunk"]),
    [3.588, 1.544, 2.957],
  );
  assert.equal(aggregateEvents.length, 3);
});

test("late model usage after transcript replay does not duplicate trace or metrics", () => {
  const lifecycleCalls = [];
  const aggregateEvents = [];
  const tokenRecords = [];
  const handler = createDiagnosticEventHandler({
    instruments: {
      genAiClientTokenUsage: { record: (...args) => tokenRecords.push(args) },
      genAiAgentOperationDuration: { record() {} },
      genAiAgentOperationCount: { add() {} },
    },
    SpanStatusCode: { OK: 1 },
    SeverityNumber: { INFO: 9 },
    cleanupExpiredRoots() {},
    getRun() { return undefined; },
    getRoot() { return undefined; },
    loadSessionSnapshot() {
      return {
        sessionKey: "agent:main:main",
        sessionId: "session-1",
        runCompleted: true,
        lastUserTs: 1000,
        lastAssistantTs: 2000,
        lastAssistantText: "done",
      };
    },
    hasReplayWatermark() { return true; },
    updateAggregateTokens(event) { aggregateEvents.push(event); },
    enrichWithTranscript(_key, attrs) { return attrs; },
    ensureRuntimeLifecycleSpans(...args) { lifecycleCalls.push(args); },
    emitDiagnosticLog() {},
  });

  handler({
    type: "model.usage",
    sessionKey: "agent:main:main",
    sessionId: "session-1",
    provider: "openai",
    model: "gpt-5.5",
    ts: 2000,
    durationMs: 1000,
    usage: { input: 3, output: 2 },
  });

  assert.equal(lifecycleCalls.length, 0);
  assert.equal(aggregateEvents.length, 0);
  assert.deepEqual(tokenRecords, []);
});

test("message.processed emits assistant span but not standalone thinking span", () => {
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
    syncTranscriptSkillSummary() {},
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
    ["assistant"],
  );
  assert.equal(childCalls[0].parentCtx.ctx, "run");
});

test("message.processed emits terminal assistant even before transcript output is available", () => {
  const childCalls = [];
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
    syncTranscriptSkillSummary() {},
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
  assert.deepEqual(childCalls.map((call) => call.name), ["assistant"]);
  assert.deepEqual(Object.keys(lifecycleCalls[0].options).sort(), [
    "createIfMissing",
    "outcome",
    "outputLength",
    "outputPreview",
    "snapshot",
  ]);
  assert.equal(lifecycleCalls[0].options.outcome, "completed");
});

test("message.processed keeps the active trace open for later transcript growth", () => {
  const childCalls = [];
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
    syncTranscriptSkillSummary() {},
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
  assert.deepEqual(childCalls.map((call) => call.name), ["assistant"]);
});

test("message.processed emits assistant after transcript replay and marks replay watermark for completed sessions", () => {
  const childCalls = [];
  let transcriptCalls = 0;
  let toolReplayCalls = 0;
  let syntheticCalls = 0;
  let watermarkMarked = 0;
  const rememberedTrajectoryRuns = [];
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
    syncTranscriptSkillSummary() {},
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
    rememberTrajectoryReplayRunId(sessionKey, runId) {
      rememberedTrajectoryRuns.push([sessionKey, runId]);
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
  assert.deepEqual(rememberedTrajectoryRuns, [["s1", "run-123"]]);
  assert.deepEqual(childCalls.map((call) => call.name), ["assistant"]);
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
    syncTranscriptSkillSummary() {
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

test("message.processed discards completed shell traces without model or tool payload", () => {
  let lifecycleCalls = 0;
  let syncCalls = 0;
  let endRunCalls = 0;
  let endRootCalls = 0;
  let discardCalls = 0;
  const run = {
    ctx: { ctx: "run" },
    messageQueuedTs: 2_000,
    mainStartTs: 2_000,
    usedToolNames: new Set(),
    toolSpans: new Map(),
    aggregate: { modelCalls: 0 },
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
      endRunCalls += 1;
    },
    endRoot() {
      endRootCalls += 1;
    },
    clearRun() {},
    discardActiveRequest() {
      discardCalls += 1;
    },
    updateAggregateTokens() {},
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        lastUserTs: 1_000,
        lastAssistantTs: 1_500,
        lastAssistantText: "old answer",
        lastRunAssistantTurns: [{ startedAt: 1_200, endedAt: 1_500 }],
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
      return run;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    syncTranscriptSkillSummary() {},
    emitTranscriptModelSpans() {
      throw new Error("not expected");
    },
    emitSyntheticModelSpan() {
      throw new Error("not expected");
    },
    emitTranscriptToolSpans() {
      throw new Error("not expected");
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

  assert.equal(lifecycleCalls, 1);
  assert.equal(syncCalls, 1);
  assert.equal(discardCalls, 1);
  assert.equal(endRunCalls, 0);
  assert.equal(endRootCalls, 0);
});

test("message.processed does not synthesize replay traces for incomplete snapshots without an active trace", () => {
  const childCalls = [];
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
      lifecycleCalls += 1;
      return { ctx: { ctx: "run" }, modelCtx: { ctx: "model" } };
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    syncTranscriptSkillSummary() {},
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
  assert.deepEqual(childCalls, []);
});

test("message.processed replays completed transcript snapshots even without an active trace", () => {
  const childCalls = [];
  let transcriptCalls = 0;
  let toolReplayCalls = 0;
  let lifecycleCalls = 0;
  const lifecycleEvts = [];
  const rememberedTrajectoryRuns = [];
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
    ensureRuntimeLifecycleSpans(evt) {
      lifecycleCalls += 1;
      lifecycleEvts.push(evt);
      return { ctx: { ctx: "run" }, modelCtx: { ctx: "model" } };
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    syncTranscriptSkillSummary() {},
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
    rememberTrajectoryReplayRunId(sessionKey, runId) {
      rememberedTrajectoryRuns.push([sessionKey, runId]);
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
  assert.deepEqual(rememberedTrajectoryRuns, [["s1", "run-123"]]);
  assert.equal(lifecycleCalls, 1);
  assert.equal(lifecycleEvts[0].runId, "run-123");
  assert.deepEqual(childCalls.map((call) => call.name), ["assistant"]);
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
    syncTranscriptSkillSummary() {
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
    syncTranscriptSkillSummary() {},
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
    syncTranscriptSkillSummary() {},
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
  assert.equal(lifecycleCalls[0].evt.runId, "run-fresh");
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
    syncTranscriptSkillSummary() {},
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
    syncTranscriptSkillSummary() {},
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
    syncTranscriptSkillSummary() {},
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
    syncTranscriptSkillSummary() {},
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

test("session.state idle marks replay-only completed transcript traces", () => {
  const endRunCalls = [];
  const endRootCalls = [];
  let clearRunCalls = 0;
  let transcriptCalls = 0;
  let toolReplayCalls = 0;
  let lifecycleCalls = 0;
  const lifecycleEvts = [];

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
        runId: "run-123",
        runCompleted: true,
        runFinalStatus: "success",
        lastAssistantText: "final answer",
        lastAssistantTs: 2,
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
    ensureRuntimeLifecycleSpans(evt) {
      lifecycleCalls += 1;
      lifecycleEvts.push(evt);
      return undefined;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    syncTranscriptSkillSummary() {},
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
    type: "session.state",
    sessionKey: "s1",
    sessionId: "sid-1",
    ts: 1000,
    state: "idle",
  });

  assert.equal(transcriptCalls, 1);
  assert.equal(toolReplayCalls, 1);
  assert.equal(lifecycleCalls, 1);
  assert.equal(lifecycleEvts[0].runId, "run-123");
  assert.equal(endRunCalls.length, 1);
  assert.equal(endRootCalls.length, 1);
  assert.equal(endRunCalls[0].replay_source, "transcript");
  assert.equal(endRunCalls[0].trace_completeness, "partial");
  assert.equal(endRootCalls[0].replay_source, "transcript");
  assert.equal(endRootCalls[0].trace_completeness, "partial");
  assert.equal(endRunCalls[0].final_status, "completed");
  assert.equal(endRootCalls[0].final_status, "completed");
  assert.equal(clearRunCalls, 1);
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
    syncTranscriptSkillSummary() {},
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
    syncTranscriptSkillSummary() {},
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

test("session.state idle emits assistant when message.processed never arrived", () => {
  const childCalls = [];
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
    syncTranscriptSkillSummary() {},
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
  assert.deepEqual(childCalls.map((call) => call.name), ["assistant"]);
});

test("session.state idle prefers trajectory final status over idle", () => {
  const childCalls = [];
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
    syncTranscriptSkillSummary() {},
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
  assert.deepEqual(childCalls.map((call) => call.name), ["assistant"]);
});

test("session.state idle leaves final_status empty when no business outcome is available", () => {
  const childCalls = [];
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
    syncTranscriptSkillSummary() {},
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
  assert.deepEqual(childCalls.map((call) => call.name), ["assistant"]);
});

test("model.usage emits llm span and preserves model context", () => {
  const childCalls = [];
  const aggregateEvents = [];
  const lifecycleCalls = [];
  const enrichmentSessionKeys = [];
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
    updateAggregateTokens(evt) {
      aggregateEvents.push(evt);
    },
    loadSessionSnapshot() {
      return undefined;
    },
    resolveSessionKey(evt) {
      return evt.sessionId === "sid-1" ? "s1" : evt.sessionKey;
    },
    enrichWithTranscript(sessionKey, attrs) {
      enrichmentSessionKeys.push(sessionKey);
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
    ensureRuntimeLifecycleSpans(evt, options) {
      lifecycleCalls.push({ evt, options });
      return run;
    },
    emitModelTurnDebugLog() {},
    getActiveSkillCtx() {
      return undefined;
    },
    syncTranscriptSkillSummary() {},
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
  assert.equal(childCalls[0].attrs["openclaw.sessionKey"], "s1");
  assert.equal(childCalls[0].attrs["llm.model"], "gpt-5");
  assert.equal(childCalls[0].attrs["openclaw.tokens.cache_read"], 6400);
  assert.equal(childCalls[0].attrs["openclaw.tokens.total"], 46);
  assert.equal(childCalls[0].attrs["llm.total_tokens"], undefined);
  assert.equal(childCalls[0].parentCtx.ctx, "run");
  assert.equal(childCalls[0].span.status.code, "OK");
  assert.equal(childCalls[0].span.ended, true);
  assert.equal(run.modelStartTs, 600);
  assert.equal(run.modelCtx.span.name, "llm");
  assert.equal(aggregateEvents[0].ts, 1000);
  assert.equal(aggregateEvents[0].usage.total, 46);
  assert.equal(lifecycleCalls[0].evt.ts, 1000);
  assert.equal(lifecycleCalls[0].options.startTsHint, 600);
  assert.equal(lifecycleCalls[0].options.processingStartTs, 600);
  assert.deepEqual(enrichmentSessionKeys, ["s1"]);
});

test("model.usage uses snapshot sessionId for gen_ai client metrics when event sessionId is missing", () => {
  const tokenRecords = [];
  const operationDurations = [];
  const agentOperationDurations = [];
  const agentOperationCounts = [];
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
      genAiClientTokenUsage: {
        record(value, attrs) {
          tokenRecords.push({ value, attrs });
        },
      },
      genAiClientOperationDuration: {
        record(value, attrs) {
          operationDurations.push({ value, attrs });
        },
      },
      genAiAgentOperationDuration: {
        record(value, attrs) {
          agentOperationDurations.push({ value, attrs });
        },
      },
      genAiAgentOperationCount: {
        add(value, attrs) {
          agentOperationCounts.push({ value, attrs });
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
    syncTranscriptSkillSummary() {},
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

  assert.equal(tokenRecords.length, 2);
  assert.equal(tokenRecords[0].attrs.session_id, "sid-from-snapshot");
  assert.equal(tokenRecords[1].attrs.session_id, "sid-from-snapshot");
  assert.equal(tokenRecords[0].attrs["gen_ai.token.type"], "input");
  assert.equal(tokenRecords[1].attrs["gen_ai.token.type"], "output");
  assert.equal(tokenRecords[0].attrs["gen_ai.request.model"], "gpt-5");
  assert.equal(tokenRecords[0].attrs["gen_ai.conversation.id"], "sid-from-snapshot");
  assert.equal(operationDurations.length, 1);
  assert.equal(operationDurations[0].value, 0.4);
  assert.equal(operationDurations[0].attrs["gen_ai.operation.name"], "chat");
  assert.equal(operationDurations[0].attrs["gen_ai.request.model"], "gpt-5");
  assert.equal(operationDurations[0].attrs.session_id, "sid-from-snapshot");
  assert.equal(operationDurations[0].attrs.status, "completed");
  assert.equal(agentOperationDurations.length, 1);
  assert.equal(agentOperationDurations[0].value, 400);
  assert.equal(agentOperationDurations[0].attrs["gen_ai.operation.name"], "chat");
  assert.equal(agentOperationDurations[0].attrs.status, "completed");
  assert.equal(agentOperationCounts.length, 1);
  assert.equal(agentOperationCounts[0].value, 1);
  assert.deepEqual(agentOperationCounts[0].attrs, {
    agent_runtime: "openclaw",
    session_id: "sid-from-snapshot",
    "gen_ai.conversation.id": "sid-from-snapshot",
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": "openai",
    "gen_ai.request.model": "gpt-5",
    "gen_ai.response.model": "gpt-5",
    status: "completed",
  });
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
    syncTranscriptSkillSummary() {},
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

test("message.queued rotates an active run with a terminal pending outcome", () => {
  const oldRun = {
    ctx: { ctx: "old-run" },
    mainStartTs: 1000,
    orchestrationCursorTs: 1000,
    modelSpanEmitted: false,
    aggregate: { modelCalls: 0 },
    usedToolNames: new Set(),
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
    syncTranscriptSkillSummary() {},
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
    syncTranscriptSkillSummary() {},
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
    syncTranscriptSkillSummary() {},
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
    syncTranscriptSkillSummary() {},
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
    syncTranscriptSkillSummary() {},
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
    syncTranscriptSkillSummary() {},
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
    syncTranscriptSkillSummary() {},
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

test("queue lane diagnostics only emit logs without standalone spans or runtime metrics", () => {
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
      genAiClientOperationDuration: {
        add() {
          dequeueMetricCalls += 1;
        },
      },
      genAiWorkflowDuration: { record() {} },
      genAiClientTokenUsage: {
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
    syncTranscriptSkillSummary() {},
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
  assert.equal(dequeueMetricCalls, 0);
  assert.equal(queueWaitMetricCalls, 0);
  assert.equal(diagnosticLogCalls, 1);
});
