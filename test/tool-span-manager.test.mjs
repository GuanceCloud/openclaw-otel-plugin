import test from "node:test";
import assert from "node:assert/strict";

import { createToolSpanManager } from "../dist/src/tool-span-manager.js";
import { createRunState } from "../dist/src/service-utils.js";

function createFakeSpan(name) {
  return {
    name,
    attributes: {},
    events: [],
    status: undefined,
    ended: false,
    endTime: undefined,
    setAttributes(attrs) {
      Object.assign(this.attributes, attrs);
    },
    addEvent(eventName, attrs) {
      this.events.push({ eventName, attrs });
    },
    setStatus(status) {
      this.status = status;
    },
    end(endTime) {
      this.ended = true;
      this.endTime = endTime;
    },
  };
}

function createFakeTracer(spans) {
  return {
    startSpan(name, options, parentCtx) {
      const span = createFakeSpan(name);
      span.options = options;
      span.parentCtx = parentCtx;
      spans.push(span);
      return span;
    },
  };
}

test("skill tool calls create a dedicated skill call span", () => {
  const spans = [];
  const tracer = createFakeTracer(spans);
  const trace = {
    setSpan(ctx, span) {
      return { ctx, span };
    },
  };
  const rootSpan = createFakeSpan("root");
  const runSpan = createFakeSpan("run");
  const run = createRunState({ active: true }, 1000, 1000);
  run.span = runSpan;
  run.ctx = { ctx: "run" };

  const manager = createToolSpanManager({
    tracer,
    trace,
    SpanKind: { INTERNAL: "internal", CLIENT: "client" },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    instruments: {
      skillActivationCounter: { add() {} },
      toolCallCounter: { add() {} },
      toolErrorCounter: { add() {} },
      toolDuration: { record() {} },
    },
    getRun() {
      return run;
    },
    getRoot() {
      return { span: rootSpan, ctx: { ctx: "root" } };
    },
    ensureUserSpan() {
      return run;
    },
    loadSessionSnapshot() {
      return undefined;
    },
    enrichWithTranscript(_sessionKey, attrs) {
      return attrs;
    },
    createChildSpan() {
      throw new Error("not expected");
    },
    eventTimestamp(evt) {
      return new Date(evt.ts ?? 1000);
    },
    setLatestAssistantText() {},
  });

  const tool = manager.ensureToolSpan(
    { sessionKey: "s1", ts: 2000 },
    "skill_creator",
    "call-1",
  );

  assert.ok(tool);
  const skillSummarySpan = spans.find((span) => span.name === "skill:skill-creator");
  const skillCallSpan = spans.find((span) => span.name === "skill_call:skill-creator");
  const toolSpan = spans.find((span) => span.name === "tool:skill_creator");

  assert.ok(skillSummarySpan);
  assert.ok(skillCallSpan);
  assert.ok(toolSpan);
  assert.equal(toolSpan.parentCtx.span.name, skillCallSpan.name);

  manager.endToolSpan(
    { sessionKey: "s1", ts: 2200 },
    "skill_creator",
    "call-1",
    { result: { ok: true } },
  );

  assert.equal(skillCallSpan.ended, true);
  assert.equal(run.skillInvocationSpans.size, 0);
});
