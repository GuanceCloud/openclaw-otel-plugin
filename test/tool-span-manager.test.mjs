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
  run.runId = "run-1";
  run.runIds = new Set(["run-1"]);
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
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {},
    emitModelTurnDebugLog() {},
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
  assert.equal(skillSummarySpan.options.attributes.run_id, "run-1");
  assert.equal(skillCallSpan.options.attributes.run_id, "run-1");
  assert.equal(toolSpan.options.attributes.run_id, "run-1");

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
  run.runId = "run-transcript-tool";
  run.runIds = new Set(["run-transcript-tool"]);
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
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {},
    emitModelTurnDebugLog() {},
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
  run.runId = "run-transcript-tool";
  run.runIds = new Set(["run-transcript-tool"]);
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
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {},
    emitModelTurnDebugLog() {},
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

test("dashboard workspace paths infer the dashboard skill span", () => {
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
  run.runId = "run-transcript-tool";
  run.runIds = new Set(["run-transcript-tool"]);
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
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {},
    emitModelTurnDebugLog() {},
  });

  manager.handleAgentEvent({
    sessionKey: "s1",
    ts: 2000,
    stream: "tool",
    data: {
      name: "write",
      toolCallId: "call-dashboard",
      phase: "start",
      args: {
        path: "/home/liurui/dashboard/guance/mysql_dashboard_complete.json",
      },
    },
  });

  const skillSummarySpan = spans.find((span) => span.name === "skill:dashboard");
  const skillCallSpan = spans.find((span) => span.name === "skill_call:dashboard");
  const toolSpan = spans.find((span) => span.name === "tool:write");

  assert.ok(skillSummarySpan);
  assert.ok(skillCallSpan);
  assert.ok(toolSpan);
  assert.equal(toolSpan.parentCtx.span.name, skillCallSpan.name);
});

test("dashboard edit tools create a skill call span and preserve skill attrs", () => {
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
  run.runId = "run-transcript-tool";
  run.runIds = new Set(["run-transcript-tool"]);
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
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {},
    emitModelTurnDebugLog() {},
  });

  manager.handleAgentEvent({
    sessionKey: "s1",
    ts: 2000,
    stream: "tool",
    data: {
      name: "edit",
      toolCallId: "call-dashboard-edit",
      phase: "start",
      args: {
        path: "/home/liurui/dashboard/guance/gen_dba_pro.py",
        edits: [{ oldText: "a", newText: "b" }],
      },
    },
  });

  const skillSummarySpan = spans.find((span) => span.name === "skill:dashboard");
  const skillCallSpan = spans.find((span) => span.name === "skill_call:dashboard");
  const toolSpan = spans.find((span) => span.name === "tool:edit");

  assert.ok(skillSummarySpan);
  assert.ok(skillCallSpan);
  assert.ok(toolSpan);
  assert.equal(toolSpan.parentCtx.span.name, skillCallSpan.name);
  assert.equal(skillSummarySpan.options.attributes.skill_name, "dashboard");
  assert.equal(skillCallSpan.options.attributes.skill_name, "dashboard");
  assert.equal(toolSpan.options.attributes.skill_name, "dashboard");
});

test("tool and skill spans backfill session attrs from the snapshot", () => {
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
        sessionId: "sess-1",
        lastChannel: "cli",
        mtimeMs: 1,
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
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {},
    emitModelTurnDebugLog() {},
  });

  manager.handleAgentEvent({
    sessionKey: "agent:runtime:scope:target",
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
    sessionKey: "agent:runtime:scope:target",
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

  assert.equal(skillSummarySpan.options.attributes.session_id, "sess-1");
  assert.equal(skillSummarySpan.options.attributes.session_key, "agent:runtime:scope:target");
  assert.equal(skillSummarySpan.options.attributes.channel, "cli");
  assert.equal(skillSummarySpan.options.attributes["gen_ai.session_id"], undefined);
  assert.equal(skillSummarySpan.options.attributes["gen_ai.agent_channel"], undefined);

  assert.equal(skillCallSpan.attributes.session_id, "sess-1");
  assert.equal(skillCallSpan.attributes.session_key, "agent:runtime:scope:target");
  assert.equal(skillCallSpan.attributes.channel, "cli");
  assert.equal(skillCallSpan.attributes["gen_ai.session_id"], undefined);
  assert.equal(skillCallSpan.attributes["gen_ai.agent_channel"], undefined);

  assert.equal(toolSpan.attributes.session_id, "sess-1");
  assert.equal(toolSpan.attributes.session_key, "agent:runtime:scope:target");
  assert.equal(toolSpan.attributes.channel, "cli");
  assert.equal(toolSpan.attributes["gen_ai.session_id"], undefined);
  assert.equal(toolSpan.attributes["gen_ai.agent_channel"], undefined);
});

test("tool completion records separate tool and skill agent operation metrics", () => {
  const spans = [];
  const durationRecords = [];
  const agentOperationCounts = [];
  const agentOperationDurations = [];
  const tracer = createFakeTracer(spans);
  const trace = {
    setSpan(ctx, span) {
      return { ctx, span };
    },
  };
  const run = createRunState({ ctx: "root" }, 1000, 1000);
  run.span = createFakeSpan("agent_run");
  run.ctx = { ctx: "run" };

  const manager = createToolSpanManager({
    tracer,
    trace,
    SpanKind: { INTERNAL: "internal", CLIENT: "client" },
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    instruments: {
      skillActivationCounter: { add() {} },
      genAiAgentSkillActivationCount: { add() {} },
      toolCallCounter: { add() {} },
      toolErrorCounter: { add() {} },
      toolDuration: { record() {} },
      genAiAgentOperationCount: {
        add(value, attrs) {
          agentOperationCounts.push({ value, attrs });
        },
      },
      genAiAgentOperationDuration: {
        record(value, attrs) {
          agentOperationDurations.push({ value, attrs });
          durationRecords.push({ value, attrs });
        },
      },
    },
    getRun() {
      return run;
    },
    getRoot() {
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    ensureUserSpan() {
      return run;
    },
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        sessionId: "sid-1",
        lastModel: "gpt-5",
        toolCallSkillNamesById: {
          "call-1": "dashboard",
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
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {
      return run;
    },
    emitModelTurnDebugLog() {},
  });

  manager.handleAgentEvent({
    sessionKey: "s1",
    sessionId: "sid-1",
    ts: 1000,
    stream: "tool",
    data: {
      name: "exec",
      toolCallId: "call-1",
      phase: "start",
    },
  });

  manager.handleAgentEvent({
    sessionKey: "s1",
    sessionId: "sid-1",
    ts: 1500,
    stream: "tool",
    data: {
      name: "exec",
      toolCallId: "call-1",
      phase: "result",
      result: { status: "completed" },
      meta: { status: "completed" },
    },
  });

  const simplified = durationRecords.map(({ value, attrs }) => ({
    value,
    operation_name: attrs.operation_name,
    tool_name: attrs.tool_name,
    skill_name: attrs.skill_name,
    model_name: attrs.model_name,
    outcome: attrs.outcome,
  }));
  assert.deepEqual(simplified, [
    {
      value: 380,
      operation_name: "tool",
      tool_name: "exec",
      skill_name: "dashboard",
      model_name: "gpt-5",
      outcome: "completed",
    },
    {
      value: 380,
      operation_name: "skill",
      tool_name: undefined,
      skill_name: "dashboard",
      model_name: undefined,
      outcome: "completed",
    },
  ]);
  assert.deepEqual(
    agentOperationCounts.map(({ value, attrs }) => ({
      value,
      operation_name: attrs.operation_name,
      tool_name: attrs.tool_name,
      skill_name: attrs.skill_name,
    })),
    [
      { value: 1, operation_name: "tool", tool_name: "exec", skill_name: "dashboard" },
      { value: 1, operation_name: "skill", tool_name: undefined, skill_name: "dashboard" },
    ],
  );
  assert.deepEqual(
    agentOperationDurations.map(({ value, attrs }) => ({
      value,
      operation_name: attrs.operation_name,
      tool_name: attrs.tool_name,
      skill_name: attrs.skill_name,
    })),
    [
      { value: 380, operation_name: "tool", tool_name: "exec", skill_name: "dashboard" },
      { value: 380, operation_name: "skill", tool_name: undefined, skill_name: "dashboard" },
    ],
  );
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
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {},
    emitModelTurnDebugLog() {},
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

test("transcript tool calls can be replayed into tool spans", () => {
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
  run.runId = "run-transcript-tool";
  run.runIds = new Set(["run-transcript-tool"]);
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
        lastRunToolCalls: [
          {
            callId: "call-1",
            name: "exec",
            args: { command: "cat /tmp/demo.txt" },
            result: { status: "completed" },
            meta: { status: "completed" },
            startedAt: 2000,
            endedAt: 2300,
          },
        ],
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
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {},
    emitModelTurnDebugLog() {},
  });

  manager.emitTranscriptToolSpans({ sessionKey: "s1", ts: 2400 });

  const toolSpan = spans.find((span) => span.name === "tool:exec");
  assert.ok(toolSpan);
  assert.equal(toolSpan.ended, true);
  assert.equal(toolSpan.options.startTime.getTime(), 2000);
  assert.equal(toolSpan.endTime.getTime(), 2300);
  assert.equal(toolSpan.options.attributes.run_id, "run-transcript-tool");
  assert.equal(run.usedToolNames.has("exec"), true);
});

test("synthetic model span creates a run when transcript metadata exists", () => {
  const spans = [];
  const durationRecords = [];
  const tokenRecords = [];
  const agentOperationCounts = [];
  const agentOperationDurations = [];
  const tracer = createFakeTracer(spans);
  const trace = {
    setSpan(ctx, span) {
      return { ctx, span };
    },
  };
  const rootSpan = createFakeSpan("root");
  let run;
  const getRunCalls = [];

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
          durationRecords.push({ value, attrs });
        },
      },
    },
    getRun(evt, createIfMissing = false) {
      getRunCalls.push(createIfMissing);
      if (!run && createIfMissing) {
        run = createRunState({ ctx: "root" }, evt.ts ?? 1000, evt.ts ?? 1000);
        run.runId = "run-synthetic";
        run.runIds = new Set(["run-synthetic"]);
        run.span = createFakeSpan("agent_run");
        run.ctx = { ctx: "run" };
      }
      return run;
    },
    getRoot() {
      return { span: rootSpan, ctx: { ctx: "root" } };
    },
    ensureUserSpan() {
      throw new Error("not expected");
    },
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        lastUserTs: 1000,
        lastAssistantTs: 4000,
        sessionId: "sid-1",
        lastProvider: "openai",
        lastModel: "gpt-5",
        lastAssistantUsage: {
          input: 12,
          output: 34,
          cacheRead: 5,
          cacheWrite: 7,
          totalTokens: 46,
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
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {},
    emitModelTurnDebugLog() {},
  });

  manager.emitSyntheticModelSpan({
    sessionKey: "s1",
    ts: 5000,
    durationMs: 900,
  });

  const modelSpan = spans.find((span) => span.name === "llm");
  assert.ok(modelSpan);
  assert.deepEqual(getRunCalls, [true, false]);
  assert.equal(modelSpan.options.kind, "client");
  assert.equal(modelSpan.options.attributes["span.kind"], "model");
  assert.equal(modelSpan.options.attributes.usage_input_tokens, 12);
  assert.equal(modelSpan.options.attributes.usage_output_tokens, 34);
  assert.equal(modelSpan.options.attributes.usage_total_tokens, 46);
  assert.equal(modelSpan.options.attributes.usage_cache_read_input_tokens, 5);
  assert.equal(modelSpan.options.attributes.usage_cache_write_input_tokens, 7);
  assert.equal(modelSpan.options.attributes.usage_cache_total_tokens, 12);
  assert.equal(modelSpan.options.attributes.run_id, "run-synthetic");
  assert.equal(modelSpan.options.attributes["llm.input_tokens"], undefined);
  assert.equal(modelSpan.parentCtx.ctx, "run");
  assert.equal(modelSpan.status.code, "OK");
  assert.equal(run.modelSpanEmitted, true);
  assert.equal(run.modelSpan, modelSpan);
  assert.equal(run.mainStartTs, 1000);
  assert.equal(run.modelStartTs, 1240);
  assert.equal(run.modelEndTs, 4000);
  assert.equal(durationRecords.length, 1);
  assert.equal(durationRecords[0].value, 2760);
  assert.equal(durationRecords[0].attrs.operation_name, "model");
  assert.equal(durationRecords[0].attrs.provider_name, "openai");
  assert.equal(durationRecords[0].attrs.request_model, "gpt-5");
  assert.equal(durationRecords[0].attrs.session_id, "sid-1");
  assert.deepEqual(
    tokenRecords.map(({ value, attrs }) => ({
      value,
      token_type: attrs.token_type,
      request_model: attrs.request_model,
      session_id: attrs.session_id,
    })),
    [
      { value: 12, token_type: "input", request_model: "gpt-5", session_id: "sid-1" },
      { value: 34, token_type: "output", request_model: "gpt-5", session_id: "sid-1" },
      { value: 46, token_type: "total", request_model: "gpt-5", session_id: "sid-1" },
    ],
  );
  assert.deepEqual(
    agentOperationCounts.map(({ value, attrs }) => ({
      value,
      operation_name: attrs.operation_name,
      request_model: attrs.request_model,
      session_id: attrs.session_id,
    })),
    [
      { value: 1, operation_name: "model", request_model: "gpt-5", session_id: "sid-1" },
    ],
  );
  assert.deepEqual(
    agentOperationDurations.map(({ value, attrs }) => ({
      value,
      operation_name: attrs.operation_name,
      request_model: attrs.request_model,
      session_id: attrs.session_id,
    })),
    [
      { value: 2760, operation_name: "model", request_model: "gpt-5", session_id: "sid-1" },
    ],
  );
});

test("transcript replay backfills run start from transcript timestamps", () => {
  const spans = [];
  const tracer = createFakeTracer(spans);
  const trace = {
    setSpan(ctx, span) {
      return { ctx, span };
    },
  };
  const rootSpan = createFakeSpan("root");
  let run;

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
    getRun(evt, createIfMissing = false) {
      if (!run && createIfMissing) {
        run = createRunState({ ctx: "root" }, evt.ts ?? 1000, evt.ts ?? 1000);
        run.runId = "run-2";
        run.runIds = new Set(["run-2"]);
        run.span = createFakeSpan("agent_run");
        run.ctx = { ctx: "run" };
      }
      return run;
    },
    getRoot() {
      return { span: rootSpan, ctx: { ctx: "root" } };
    },
    ensureUserSpan() {
      throw new Error("not expected");
    },
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        lastUserTs: 1000,
        lastRunToolCalls: [
          {
            callId: "call-1",
            name: "exec",
            args: { command: "cat /tmp/demo.txt" },
            result: { status: "completed" },
            meta: { status: "completed" },
            startedAt: 2000,
            endedAt: 2300,
          },
        ],
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
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {},
    emitModelTurnDebugLog() {},
  });

  manager.emitTranscriptToolSpans({ sessionKey: "s1", ts: 10000 });

  const toolSpan = spans.find((span) => span.name === "tool:exec");
  assert.ok(toolSpan);
  assert.equal(run.mainStartTs, 1000);
  assert.equal(toolSpan.options.startTime.getTime(), 2000);
  assert.equal(toolSpan.endTime.getTime(), 2300);
});

test("transcript model spans are replayed per assistant turn", () => {
  const spans = [];
  const durationRecords = [];
  const tokenRecords = [];
  const agentOperationCounts = [];
  const agentOperationDurations = [];
  const tracer = createFakeTracer(spans);
  const trace = {
    setSpan(ctx, span) {
      return { ctx, span };
    },
  };
  const rootSpan = createFakeSpan("root");
  let run;

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
          durationRecords.push({ value, attrs });
        },
      },
    },
    getRun(evt, createIfMissing = false) {
      if (!run && createIfMissing) {
        run = createRunState({ ctx: "root" }, evt.ts ?? 1000, evt.ts ?? 1000);
        run.runId = "run-2";
        run.runIds = new Set(["run-2"]);
        run.span = createFakeSpan("agent_run");
        run.ctx = { ctx: "run" };
      }
      return run;
    },
    getRoot() {
      return { span: rootSpan, ctx: { ctx: "root" } };
    },
    ensureUserSpan() {
      throw new Error("not expected");
    },
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        lastUserTs: 1000,
        sessionId: "sid-1",
        lastChannel: "chat",
        lastProvider: "openai",
        lastModel: "gpt-5",
        lastRunAssistantTurns: [
          {
            startedAt: 1000,
            endedAt: 2000,
            provider: "openai",
            model: "gpt-5",
            usage: {
              input: 11,
              output: 7,
              totalTokens: 18,
            },
            inputPreview: "first question",
            thinking: "first reasoning",
            text: "first answer",
            outputPreview: "first answer",
            outputKind: "text",
          },
          {
            startedAt: 2300,
            endedAt: 2600,
            provider: "openai",
            model: "gpt-5",
            usage: {
              input: 13,
              output: 5,
              totalTokens: 18,
            },
            inputPreview: "{\"status\":\"ok\"}",
            thinking: "second reasoning",
            text: "second answer",
            outputPreview: "second answer",
            outputKind: "text",
          },
        ],
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
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {},
    emitModelTurnDebugLog() {},
  });

  const emitted = manager.emitTranscriptModelSpans({ sessionKey: "s1", ts: 3000 });

  assert.equal(emitted, true);
  assert.equal(run.mainStartTs, 1000);
  const modelSpans = spans.filter((span) => span.name === "llm");
  assert.equal(modelSpans.length, 2);
  assert.equal(spans.some((span) => span.name === "thinking"), false);
  assert.equal(modelSpans[0].options.startTime.getTime(), 1000);
  assert.equal(modelSpans[0].endTime.getTime(), 2000);
  assert.equal(modelSpans[0].options.attributes.input_preview, "first question");
  assert.equal(modelSpans[0].options.attributes.output_preview, "first answer");
  assert.equal(modelSpans[0].options.attributes.output_summary, "first reasoning");
  assert.equal(modelSpans[0].options.attributes.usage_input_tokens, 11);
  assert.equal(modelSpans[0].options.attributes.usage_output_tokens, 7);
  assert.equal(modelSpans[0].options.attributes.usage_total_tokens, 18);
  assert.equal(modelSpans[0].options.attributes.run_id, "run-2");
  assert.equal(modelSpans[1].options.startTime.getTime(), 2300);
  assert.equal(modelSpans[1].endTime.getTime(), 2600);
  assert.equal(modelSpans[1].options.attributes.input_preview, "{\"status\":\"ok\"}");
  assert.equal(modelSpans[1].options.attributes.output_preview, "second answer");
  assert.equal(modelSpans[1].options.attributes.output_summary, "second reasoning");
  assert.equal(modelSpans[1].options.attributes.usage_input_tokens, 13);
  assert.equal(modelSpans[1].options.attributes.usage_output_tokens, 5);
  assert.equal(modelSpans[1].options.attributes.usage_total_tokens, 18);
  assert.equal(modelSpans[1].options.attributes.run_id, "run-2");
  assert.equal(run.span.attributes.usage_input_tokens, 24);
  assert.equal(run.span.attributes.usage_output_tokens, 12);
  assert.equal(run.span.attributes.usage_total_tokens, 36);
  assert.equal(rootSpan.attributes.usage_input_tokens, 24);
  assert.equal(rootSpan.attributes.usage_output_tokens, 12);
  assert.equal(rootSpan.attributes.usage_total_tokens, 36);
  assert.equal(durationRecords.length, 2);
  assert.deepEqual(
    durationRecords.map(({ value, attrs }) => ({
      value,
      operation_name: attrs.operation_name,
      provider_name: attrs.provider_name,
      request_model: attrs.request_model,
      session_id: attrs.session_id,
    })),
    [
      {
        value: 1000,
        operation_name: "model",
        provider_name: "openai",
        request_model: "gpt-5",
        session_id: "sid-1",
      },
      {
        value: 300,
        operation_name: "model",
        provider_name: "openai",
        request_model: "gpt-5",
        session_id: "sid-1",
      },
    ],
  );
  assert.deepEqual(
    tokenRecords.map(({ value, attrs }) => ({
      value,
      token_type: attrs.token_type,
      request_model: attrs.request_model,
      session_id: attrs.session_id,
    })),
    [
      { value: 11, token_type: "input", request_model: "gpt-5", session_id: "sid-1" },
      { value: 7, token_type: "output", request_model: "gpt-5", session_id: "sid-1" },
      { value: 18, token_type: "total", request_model: "gpt-5", session_id: "sid-1" },
      { value: 13, token_type: "input", request_model: "gpt-5", session_id: "sid-1" },
      { value: 5, token_type: "output", request_model: "gpt-5", session_id: "sid-1" },
      { value: 18, token_type: "total", request_model: "gpt-5", session_id: "sid-1" },
    ],
  );
  assert.deepEqual(
    agentOperationCounts.map(({ value, attrs }) => ({
      value,
      operation_name: attrs.operation_name,
      request_model: attrs.request_model,
      session_id: attrs.session_id,
    })),
    [
      { value: 1, operation_name: "model", request_model: "gpt-5", session_id: "sid-1" },
      { value: 1, operation_name: "model", request_model: "gpt-5", session_id: "sid-1" },
    ],
  );
  assert.deepEqual(
    agentOperationDurations.map(({ value, attrs }) => ({
      value,
      operation_name: attrs.operation_name,
      request_model: attrs.request_model,
      session_id: attrs.session_id,
    })),
    [
      { value: 1000, operation_name: "model", request_model: "gpt-5", session_id: "sid-1" },
      { value: 300, operation_name: "model", request_model: "gpt-5", session_id: "sid-1" },
    ],
  );
});

test("transcript model replay skips turns already covered by runtime model usage", () => {
  const spans = [];
  const durationRecords = [];
  const tokenRecords = [];
  const agentOperationCounts = [];
  const agentOperationDurations = [];
  const tracer = createFakeTracer(spans);
  const trace = {
    setSpan(ctx, span) {
      return { ctx, span };
    },
  };
  const rootSpan = createFakeSpan("root");
  const run = createRunState({ ctx: "root" }, 1000, 1000);
  run.span = createFakeSpan("agent_run");
  run.ctx = { ctx: "run" };
  run.modelSpanEmitted = true;
  run.aggregate.inputTokens = 11;
  run.aggregate.outputTokens = 7;
  run.aggregate.totalTokens = 18;
  run.aggregate.modelCalls = 1;
  run.aggregate.lastProvider = "openai";
  run.aggregate.lastModel = "gpt-5";

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
          durationRecords.push({ value, attrs });
        },
      },
    },
    getRun() {
      return run;
    },
    getRoot() {
      return { span: rootSpan, ctx: { ctx: "root" } };
    },
    ensureUserSpan() {
      throw new Error("not expected");
    },
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        lastUserTs: 1000,
        sessionId: "sid-1",
        lastChannel: "chat",
        lastProvider: "openai",
        lastModel: "gpt-5",
        lastRunAssistantTurns: [
          {
            startedAt: 1000,
            endedAt: 2000,
            provider: "openai",
            model: "gpt-5",
            usage: {
              input: 11,
              output: 7,
              totalTokens: 18,
            },
            inputPreview: "first question",
            thinking: "first reasoning",
            text: "first answer",
            outputPreview: "first answer",
            outputKind: "text",
          },
          {
            startedAt: 2300,
            endedAt: 2600,
            provider: "openai",
            model: "gpt-5",
            usage: {
              input: 13,
              output: 5,
              totalTokens: 18,
            },
            inputPreview: "{\"status\":\"ok\"}",
            thinking: "second reasoning",
            text: "second answer",
            outputPreview: "second answer",
            outputKind: "text",
          },
        ],
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
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {},
    emitModelTurnDebugLog() {},
  });

  const emitted = manager.emitTranscriptModelSpans({ sessionKey: "s1", ts: 3000 });

  assert.equal(emitted, true);
  const modelSpans = spans.filter((span) => span.name === "llm");
  assert.equal(modelSpans.length, 1);
  assert.equal(modelSpans[0].options.startTime.getTime(), 2300);
  assert.equal(modelSpans[0].endTime.getTime(), 2600);
  assert.equal(modelSpans[0].options.attributes.usage_input_tokens, 13);
  assert.equal(modelSpans[0].options.attributes.usage_output_tokens, 5);
  assert.equal(modelSpans[0].options.attributes.usage_total_tokens, 18);
  assert.equal(run.aggregate.inputTokens, 24);
  assert.equal(run.aggregate.outputTokens, 12);
  assert.equal(run.aggregate.totalTokens, 36);
  assert.equal(run.aggregate.modelCalls, 2);
  assert.equal(run.transcriptAssistantTurnsEmitted, 2);
  assert.equal(run.span.attributes.usage_input_tokens, 24);
  assert.equal(run.span.attributes.usage_output_tokens, 12);
  assert.equal(run.span.attributes.usage_total_tokens, 36);
  assert.equal(rootSpan.attributes.usage_input_tokens, 24);
  assert.equal(rootSpan.attributes.usage_output_tokens, 12);
  assert.equal(rootSpan.attributes.usage_total_tokens, 36);
  assert.deepEqual(
    tokenRecords.map(({ value, attrs }) => ({
      value,
      token_type: attrs.token_type,
      request_model: attrs.request_model,
      session_id: attrs.session_id,
    })),
    [
      { value: 13, token_type: "input", request_model: "gpt-5", session_id: "sid-1" },
      { value: 5, token_type: "output", request_model: "gpt-5", session_id: "sid-1" },
      { value: 18, token_type: "total", request_model: "gpt-5", session_id: "sid-1" },
    ],
  );
  assert.deepEqual(
    agentOperationCounts.map(({ value, attrs }) => ({
      value,
      operation_name: attrs.operation_name,
      request_model: attrs.request_model,
      session_id: attrs.session_id,
    })),
    [
      { value: 1, operation_name: "model", request_model: "gpt-5", session_id: "sid-1" },
    ],
  );
  assert.deepEqual(
    agentOperationDurations.map(({ value, attrs }) => ({
      value,
      operation_name: attrs.operation_name,
      request_model: attrs.request_model,
      session_id: attrs.session_id,
    })),
    [
      { value: 300, operation_name: "model", request_model: "gpt-5", session_id: "sid-1" },
    ],
  );
});

test("transcript model replay only appends turns that were not emitted yet", () => {
  const spans = [];
  const tracer = createFakeTracer(spans);
  const trace = {
    setSpan(ctx, span) {
      return { ctx, span };
    },
  };
  let run;
  let snapshotTurns = [
    {
      startedAt: 1000,
      endedAt: 2000,
      provider: "openai",
      model: "gpt-5",
      inputPreview: "first question",
      outputPreview: "first answer",
      outputKind: "text",
    },
  ];

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
    getRun(evt, createIfMissing = false) {
      if (!run && createIfMissing) {
        run = createRunState({ ctx: "root" }, evt.ts ?? 1000, evt.ts ?? 1000);
        run.span = createFakeSpan("agent_run");
        run.ctx = { ctx: "run" };
      }
      return run;
    },
    getRoot() {
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    ensureUserSpan() {
      throw new Error("not expected");
    },
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        lastUserTs: 1000,
        lastProvider: "openai",
        lastModel: "gpt-5",
        lastRunAssistantTurns: snapshotTurns,
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
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {},
    emitModelTurnDebugLog() {},
  });

  assert.equal(manager.emitTranscriptModelSpans({ sessionKey: "s1", ts: 3000 }), true);
  snapshotTurns = [
    ...snapshotTurns,
    {
      startedAt: 2300,
      endedAt: 2600,
      provider: "openai",
      model: "gpt-5",
      inputPreview: "{\"status\":\"ok\"}",
      outputPreview: "second answer",
      outputKind: "text",
    },
  ];
  assert.equal(manager.emitTranscriptModelSpans({ sessionKey: "s1", ts: 4000 }), true);

  const modelSpans = spans.filter((span) => span.name === "llm");
  assert.equal(modelSpans.length, 2);
  assert.equal(run.transcriptAssistantTurnsEmitted, 2);
  assert.equal(modelSpans[0].options.startTime.getTime(), 1000);
  assert.equal(modelSpans[1].options.startTime.getTime(), 2300);
});

test("transcript model spans do not inherit session output preview without turn text", () => {
  const spans = [];
  const tracer = createFakeTracer(spans);
  const trace = {
    setSpan(ctx, span) {
      return { ctx, span };
    },
  };
  let run;

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
    getRun(evt, createIfMissing = false) {
      if (!run && createIfMissing) {
        run = createRunState({ ctx: "root" }, evt.ts ?? 1000, evt.ts ?? 1000);
        run.span = createFakeSpan("agent_run");
        run.ctx = { ctx: "run" };
      }
      return run;
    },
    getRoot() {
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    ensureUserSpan() {
      throw new Error("not expected");
    },
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        lastUserTs: 1000,
        lastAssistantText: "final answer",
        lastAssistantThinking: "final reasoning",
        lastProvider: "openai",
        lastModel: "gpt-5",
        lastRunAssistantTurns: [
          {
            startedAt: 1000,
            endedAt: 2000,
            provider: "openai",
            model: "gpt-5",
            inputPreview: "search result payload",
            outputPreview: undefined,
            outputKind: undefined,
          },
        ],
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
    emitRuntimeOrchestrationSpan() {},
    ensureRuntimeLifecycleSpans() {},
    emitModelTurnDebugLog() {},
  });

  manager.emitTranscriptModelSpans({ sessionKey: "s1", ts: 3000 });

  const modelSpan = spans.find((span) => span.name === "llm");
  assert.ok(modelSpan);
  assert.equal(modelSpan.options.attributes.input_preview, "search result payload");
  assert.equal("output_preview" in modelSpan.options.attributes, false);
  assert.equal("output_summary" in modelSpan.options.attributes, false);
});
