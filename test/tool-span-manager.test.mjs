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

test("skill file reads create a dedicated skill call span", () => {
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
    "read",
    "call-1",
    {
      "openclaw.tool.target": "/home/liurui/.openclaw/workspace/skills/monitor/SKILL.md",
      "openclaw.tool.command": "cat /home/liurui/.openclaw/workspace/skills/monitor/SKILL.md",
    },
  );

  assert.ok(tool);
  const skillSummarySpan = spans.find((span) => span.name === "skill:monitor");
  const skillCallSpan = spans.find((span) => span.name === "skill_call:monitor");
  const toolSpan = spans.find((span) => span.name === "tool:read");

  assert.ok(skillSummarySpan);
  assert.ok(skillCallSpan);
  assert.ok(toolSpan);
  assert.equal(toolSpan.parentCtx.span.name, skillCallSpan.name);

  manager.endToolSpan(
    { sessionKey: "s1", ts: 2200 },
    "read",
    "call-1",
    { result: { ok: true } },
  );

  assert.equal(skillCallSpan.ended, true);
  assert.equal(run.skillInvocationSpans.size, 0);
});

test("tool events from skill file reads create skill spans through the event handler", () => {
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

  manager.handleAgentEvent({
    sessionKey: "s1",
    ts: 2000,
    stream: "tool",
    data: {
      name: "read",
      toolCallId: "call-1",
      phase: "start",
      args: {
        path: "/home/liurui/.openclaw/workspace/skills/monitor/SKILL.md",
      },
    },
  });

  manager.handleAgentEvent({
    sessionKey: "s1",
    ts: 2200,
    stream: "tool",
    data: {
      name: "read",
      toolCallId: "call-1",
      phase: "result",
      result: { ok: true },
    },
  });

  const skillSummarySpan = spans.find((span) => span.name === "skill:monitor");
  const skillCallSpan = spans.find((span) => span.name === "skill_call:monitor");
  const toolSpan = spans.find((span) => span.name === "tool:read");

  assert.ok(skillSummarySpan);
  assert.ok(skillCallSpan);
  assert.ok(toolSpan);
  assert.equal(toolSpan.parentCtx.span.name, skillCallSpan.name);
  assert.equal(skillCallSpan.ended, true);
  assert.equal(run.skillInvocationSpans.size, 0);
});

test("exec commands inside a skill directory create the matching skill span", () => {
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

  manager.handleAgentEvent({
    sessionKey: "s1",
    ts: 2000,
    stream: "tool",
    data: {
      name: "exec",
      toolCallId: "call-2",
      phase: "start",
      args: {
        command: "cd /home/liurui/.openclaw/workspace/skills/dql && ls -la bin/",
      },
    },
  });

  const skillSummarySpan = spans.find((span) => span.name === "skill:dql");
  const skillCallSpan = spans.find((span) => span.name === "skill_call:dql");
  const toolSpan = spans.find((span) => span.name === "tool:exec");

  assert.ok(skillSummarySpan);
  assert.ok(skillCallSpan);
  assert.ok(toolSpan);
  assert.equal(toolSpan.parentCtx.span.name, skillCallSpan.name);
});

test("tool events use transcript tool call mappings when runtime args are absent", () => {
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
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        toolCallSkillNamesById: {
          "call-monitor": "monitor",
          "call-dql": "dql",
        },
      };
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

  manager.handleAgentEvent({
    sessionKey: "s1",
    ts: 2000,
    stream: "tool",
    data: {
      name: "read",
      toolCallId: "call-monitor",
      phase: "start",
    },
  });

  manager.handleAgentEvent({
    sessionKey: "s1",
    ts: 2100,
    stream: "tool",
    data: {
      name: "exec",
      toolCallId: "call-dql",
      phase: "start",
    },
  });

  const skillSummaryNames = spans.filter((span) => span.name.startsWith("skill:")).map((span) => span.name).sort();
  const skillCallNames = spans.filter((span) => span.name.startsWith("skill_call:")).map((span) => span.name).sort();

  assert.deepEqual(skillSummaryNames, ["skill:dql", "skill:monitor"]);
  assert.deepEqual(skillCallNames, ["skill_call:dql", "skill_call:monitor"]);
});
