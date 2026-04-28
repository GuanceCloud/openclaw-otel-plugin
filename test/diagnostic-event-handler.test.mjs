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

test("message.processed emits thinking span", () => {
  const childCalls = [];
  const run = {
    ctx: { ctx: "run" },
    modelCtx: { ctx: "model" },
  };

  const handler = createDiagnosticEventHandler({
    instruments: {
      diagnosticsMessageProcessedCounter: { add() {} },
      diagnosticsMessageDurationMs: { record() {} },
    },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    SeverityNumber: { INFO: "INFO", ERROR: "ERROR" },
    cleanupExpiredRoots() {},
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
    getActiveSkillCtx() {
      return undefined;
    },
    ensureTranscriptSkillSpans() {},
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
    ["thinking"],
  );
  assert.equal(childCalls[0].durationMs, 900);
  assert.equal(childCalls[0].evt.ts, 1000);
  assert.equal(childCalls[0].attrs["span.kind"], "thinking");
  assert.equal(childCalls[0].attrs.session_channel, "chat");
  assert.equal(childCalls[0].attrs.output_summary, "step one step two");
  assert.equal(childCalls[0].attrs.output_text_length, "step one\nstep two".length);
  assert.equal(childCalls[0].parentCtx, run.modelCtx);
  assert.equal(childCalls[0].span.status.code, "OK");
  assert.equal(childCalls[0].span.ended, true);
});
