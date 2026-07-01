import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

test("skill file reads create a nested Skill tool span", () => {
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
  const skillToolSpan = spans.find((span) => span.name === "tool:Skill");
  const skillSpan = spans.find((span) => span.name === "skill:monitor");

  assert.ok(skillToolSpan);
  assert.ok(skillSpan);
  assert.equal(skillSpan.parentCtx.span.name, skillToolSpan.name);
  assert.equal(skillToolSpan.options.attributes.run_id, "run-1");
  assert.equal(skillSpan.options.attributes.run_id, "run-1");
  assert.equal(skillToolSpan.options.attributes.agent_id, undefined);
  assert.equal(skillSpan.options.attributes.agent_name, undefined);
  assert.equal(skillToolSpan.options.attributes.tool_name, "Skill");
  assert.equal(skillToolSpan.options.attributes.tool_original_name, "read");

  manager.endToolSpan(
    { sessionKey: "s1", ts: 2200 },
    "read",
    "call-1",
    { result: { ok: true } },
  );

  assert.equal(skillSpan.ended, true);
  assert.equal(skillSpan.attributes.skill_result_status, "completed");
  assert.equal(skillToolSpan.attributes.skill_result_status, "completed");
});

test("skill spans load description from SKILL.md when snapshot metadata is missing", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-skill-span-"));
  try {
    const skillDir = path.join(tmpDir, "workspace", "skills", "monitor");
    fs.mkdirSync(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(skillFile, [
      "---",
      "name: monitor",
      "description: 生成监控器",
      "version: 1.2.3",
      "---",
      "",
      "从指标生成观测云监控器。",
    ].join("\n"));

    const spans = [];
    const tracer = createFakeTracer(spans);
    const trace = {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    };
    const run = createRunState({ active: true }, 1000, 1000);
    run.span = createFakeSpan("run");
    run.ctx = { ctx: "run" };

    const manager = createToolSpanManager({
      tracer,
      trace,
      SpanKind: { INTERNAL: "internal", CLIENT: "client" },
      SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
      instruments: {},
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

    manager.ensureToolSpan(
      { sessionKey: "s1", ts: 2000 },
      "read",
      "call-1",
      {
        "openclaw.tool.target": skillFile,
        "openclaw.tool.command": `cat ${skillFile}`,
      },
    );

    const skillSpan = spans.find((span) => span.name === "skill:monitor");
    assert.ok(skillSpan);
    assert.equal(skillSpan.options.attributes["skill.description"], "生成监控器");
    assert.equal(skillSpan.options.attributes["gen_ai.skill.description"], "生成监控器");
    assert.equal(skillSpan.options.attributes["gen_ai.skill.version"], "1.2.3");

    manager.endToolSpan(
      { sessionKey: "s1", ts: 2200 },
      "read",
      "call-1",
      { result: { ok: true } },
    );

    assert.equal(skillSpan.attributes["skill.description"], "生成监控器");
    assert.equal(skillSpan.attributes["gen_ai.skill.description"], "生成监控器");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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

  const skillToolSpan = spans.find((span) => span.name === "tool:Skill");
  const skillSpan = spans.find((span) => span.name === "skill:monitor");

  assert.ok(skillToolSpan);
  assert.ok(skillSpan);
  assert.equal(skillSpan.parentCtx.span.name, skillToolSpan.name);
  assert.equal(skillSpan.ended, true);
});

test("tool lifecycle events no longer export redundant event_tool_* attributes", () => {
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
  run.runId = "run-tool-events";
  run.runIds = new Set(["run-tool-events"]);
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
      genAiClientOperationDuration: { record() {} },
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
    ensureRuntimeLifecycleSpans() {
      return run;
    },
    emitModelTurnDebugLog() {},
  });

  manager.handleAgentEvent({
    sessionKey: "s1",
    sessionId: "session-1",
    ts: 2000,
    stream: "tool",
    data: {
      name: "web_search",
      toolCallId: "call-1",
      phase: "start",
      args: { query: "a股 午盘" },
    },
  });

  manager.handleAgentEvent({
    sessionKey: "s1",
    sessionId: "session-1",
    ts: 2100,
    stream: "tool",
    data: {
      name: "web_search",
      toolCallId: "call-1",
      phase: "update",
      partialResult: { summary: "中间结果" },
    },
  });

  manager.handleAgentEvent({
    sessionKey: "s1",
    sessionId: "session-1",
    ts: 2200,
    stream: "tool",
    data: {
      name: "web_search",
      toolCallId: "call-1",
      phase: "result",
      result: { status: "ok", items: [] },
    },
  });

  const toolSpan = spans.find((span) => span.name === "tool:web_search");
  assert.ok(toolSpan);
  assert.equal(toolSpan.options.attributes.agent_runtime, undefined);
  assert.deepEqual(
    toolSpan.events.map((event) => event.eventName),
    ["tool.update", "tool.result"],
  );
  for (const event of toolSpan.events) {
    assert.equal(event.attrs, undefined);
  }
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

  const skillToolSpan = spans.find((span) => span.name === "tool:Skill");
  const skillSpan = spans.find((span) => span.name === "skill:dql");

  assert.ok(skillToolSpan);
  assert.ok(skillSpan);
  assert.equal(skillSpan.parentCtx.span.name, skillToolSpan.name);
  assert.equal(skillToolSpan.options.attributes.tool_original_name, "exec");
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
        path: "/home/liurui/dashboard/gtrace/mysql_dashboard_complete.json",
      },
    },
  });

  const skillToolSpan = spans.find((span) => span.name === "tool:Skill");
  const skillSpan = spans.find((span) => span.name === "skill:dashboard");

  assert.ok(skillToolSpan);
  assert.ok(skillSpan);
  assert.equal(skillSpan.parentCtx.span.name, skillToolSpan.name);
  assert.equal(skillToolSpan.options.attributes.tool_original_name, "write");
});

test("dashboard edit tools create a nested Skill tool span and preserve skill attrs", () => {
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
        path: "/home/liurui/dashboard/gtrace/gen_dba_pro.py",
        edits: [{ oldText: "a", newText: "b" }],
      },
    },
  });

  const skillToolSpan = spans.find((span) => span.name === "tool:Skill");
  const skillSpan = spans.find((span) => span.name === "skill:dashboard");

  assert.ok(skillToolSpan);
  assert.ok(skillSpan);
  assert.equal(skillSpan.parentCtx.span.name, skillToolSpan.name);
  assert.equal(skillSpan.options.attributes.skill_name, "dashboard");
  assert.equal(skillToolSpan.options.attributes.skill_name, "dashboard");
  assert.equal(skillToolSpan.options.attributes.tool_original_name, "edit");
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
        sessionSkillCatalog: [
          {
            name: "monitor",
            aliases: ["monitor"],
            description: "生成监控器",
            path: "/home/liurui/.openclaw/workspace/skills/monitor/SKILL.md",
            sourceType: "workspace",
            version: "1.2.3",
          },
        ],
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

  const skillToolSpan = spans.find((span) => span.name === "tool:Skill");
  const skillSpan = spans.find((span) => span.name === "skill:monitor");

  assert.ok(skillToolSpan);
  assert.ok(skillSpan);
  assert.equal(skillSpan.parentCtx.span.name, skillToolSpan.name);

  assert.equal(skillSpan.options.attributes.session_id, "sess-1");
  assert.equal(skillSpan.options.attributes.session_key, "agent:runtime:scope:target");
  assert.equal(skillSpan.options.attributes.channel, "cli");
  assert.equal(skillSpan.options.attributes["gen_ai.session_id"], undefined);
  assert.equal(skillSpan.options.attributes["gen_ai.agent_channel"], undefined);

  assert.equal(skillSpan.attributes.session_id, "sess-1");
  assert.equal(skillSpan.attributes.session_key, "agent:runtime:scope:target");
  assert.equal(skillSpan.attributes.channel, "cli");
  assert.equal(skillSpan.attributes["gen_ai.session_id"], undefined);
  assert.equal(skillSpan.attributes["gen_ai.agent_channel"], undefined);

  assert.equal(skillToolSpan.attributes.session_id, "sess-1");
  assert.equal(skillToolSpan.attributes.session_key, "agent:runtime:scope:target");
  assert.equal(skillToolSpan.attributes.channel, "cli");
  assert.equal(skillToolSpan.attributes["gen_ai.session_id"], undefined);
  assert.equal(skillToolSpan.attributes["gen_ai.agent_channel"], undefined);
  assert.equal(skillSpan.attributes["skill.name"], "monitor");
  assert.equal(skillSpan.attributes["skill.description"], "生成监控器");
  assert.equal(skillSpan.attributes["skill.path"], "/home/liurui/.openclaw/workspace/skills/monitor/SKILL.md");
  assert.equal(skillSpan.attributes["skill.source.type"], "workspace");
  assert.equal(skillSpan.attributes.skill_result_status, "completed");
  assert.equal(skillSpan.attributes["gen_ai.skill.name"], "monitor");
  assert.equal(skillSpan.attributes["gen_ai.skill.version"], "1.2.3");
  assert.equal(skillToolSpan.attributes["skill.name"], "monitor");
  assert.equal(skillToolSpan.attributes["skill.description"], "生成监控器");
  assert.equal(skillToolSpan.attributes["skill.path"], "/home/liurui/.openclaw/workspace/skills/monitor/SKILL.md");
  assert.equal(skillToolSpan.attributes["skill.source.type"], "workspace");
  assert.equal(skillToolSpan.attributes.skill_result_status, "completed");
  assert.equal(skillToolSpan.attributes["gen_ai.skill.name"], "monitor");
  assert.equal(skillToolSpan.attributes["gen_ai.skill.version"], "1.2.3");
});

test("tool completion records tool and skill client operation durations", () => {
  const spans = [];
  const durationRecords = [];
  const tracer = createFakeTracer(spans);
  const trace = {
    setSpan(ctx, span) {
      return { ctx, span };
    },
  };
  const run = createRunState({ ctx: "root" }, 1000, 1000);
  run.span = createFakeSpan("invoke_agent");
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
      genAiClientOperationDuration: {
        record(value, attrs) {
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
        sessionSkillCatalog: [
          {
            name: "dashboard",
            aliases: ["dashboard"],
            description: "生成 Dashboard",
            path: "/home/liurui/.openclaw/workspace/skills/dashboard/SKILL.md",
            sourceType: "workspace",
            version: "0.4.1",
          },
        ],
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
    operation_name: attrs["gen_ai.operation.name"],
    tool_name: attrs["gen_ai.tool.name"],
    gen_ai_skill_name: attrs["gen_ai.skill.name"],
    skill_name: attrs.skill_name,
    model_name: attrs.model_name,
    outcome: attrs.tool_result_status,
  }));
  assert.deepEqual(simplified, [
    {
      value: 0.38,
      operation_name: "execute_tool",
      tool_name: "Skill",
      gen_ai_skill_name: undefined,
      skill_name: "dashboard",
      model_name: undefined,
      outcome: "completed",
    },
    {
      value: 0.38,
      operation_name: "skill",
      tool_name: undefined,
      gen_ai_skill_name: "dashboard",
      skill_name: "dashboard",
      model_name: undefined,
      outcome: "completed",
    },
  ]);
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
  const skillToolNames = spans.filter((span) => span.name === "tool:Skill").map((span) => span.name).sort();

  assert.deepEqual(skillSummaryNames, ["skill:dql", "skill:monitor"]);
  assert.deepEqual(skillToolNames, ["tool:Skill", "tool:Skill"]);
  for (const skillSpan of spans.filter((span) => span.name.startsWith("skill:"))) {
    assert.equal(skillSpan.parentCtx.span.name, "tool:Skill");
  }
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

test("transcript replay skips tool calls that were already observed from runtime events", () => {
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

  manager.handleAgentEvent({
    sessionKey: "s1",
    ts: 2000,
    stream: "tool",
    data: {
      name: "exec",
      toolCallId: "call-1",
      phase: "start",
      args: { command: "cat /tmp/demo.txt" },
    },
  });

  manager.handleAgentEvent({
    sessionKey: "s1",
    ts: 2300,
    stream: "tool",
    data: {
      name: "exec",
      toolCallId: "call-1",
      phase: "result",
      result: { status: "completed" },
      meta: { status: "completed" },
    },
  });

  manager.emitTranscriptToolSpans({ sessionKey: "s1", ts: 2400 });

  const toolSpans = spans.filter((span) => span.name === "tool:exec");
  assert.equal(toolSpans.length, 1);
  assert.equal(run.transcriptToolCallIds?.has("call-1"), true);
  assert.equal(run.observedToolCallIds?.has("call-1"), true);
});

test("synthetic model span creates a run when transcript metadata exists", () => {
  const spans = [];
  const durationRecords = [];
  const tokenRecords = [];
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
      genAiClientTokenUsage: {
        record(value, attrs) {
          tokenRecords.push({ value, attrs });
        },
      },
      genAiClientOperationDuration: {
        record(value, attrs) {
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
        run.span = createFakeSpan("invoke_agent");
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
          totalTokens: 4600,
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
  assert.equal(durationRecords[0].value, 2.76);
  assert.equal(durationRecords[0].attrs["gen_ai.operation.name"], "chat");
  assert.equal(durationRecords[0].attrs["gen_ai.provider.name"], "openai");
  assert.equal(durationRecords[0].attrs["gen_ai.request.model"], "gpt-5");
  assert.equal(durationRecords[0].attrs.session_id, "sid-1");
  assert.deepEqual(
    tokenRecords.map(({ value, attrs }) => ({
      value,
      token_type: attrs["gen_ai.token.type"],
      request_model: attrs["gen_ai.request.model"],
      session_id: attrs.session_id,
    })),
    [
      { value: 12, token_type: "input", request_model: "gpt-5", session_id: "sid-1" },
      { value: 34, token_type: "output", request_model: "gpt-5", session_id: "sid-1" },
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
        run.span = createFakeSpan("invoke_agent");
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
      genAiClientTokenUsage: {
        record(value, attrs) {
          tokenRecords.push({ value, attrs });
        },
      },
      genAiClientOperationDuration: {
        record(value, attrs) {
          durationRecords.push({ value, attrs });
        },
      },
    },
    getRun(evt, createIfMissing = false) {
      if (!run && createIfMissing) {
        run = createRunState({ ctx: "root" }, evt.ts ?? 1000, evt.ts ?? 1000);
        run.runId = "run-2";
        run.runIds = new Set(["run-2"]);
        run.span = createFakeSpan("invoke_agent");
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
              totalTokens: 1800,
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
              totalTokens: 2400,
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
  assert.equal(modelSpans[0].options.attributes.usage_cache_total_tokens, 0);
  assert.equal(modelSpans[0].options.attributes.run_id, "run-2");
  assert.equal(modelSpans[1].options.startTime.getTime(), 2300);
  assert.equal(modelSpans[1].endTime.getTime(), 2600);
  assert.equal(modelSpans[1].options.attributes.input_preview, "{\"status\":\"ok\"}");
  assert.equal(modelSpans[1].options.attributes.output_preview, "second answer");
  assert.equal(modelSpans[1].options.attributes.output_summary, "second reasoning");
  assert.equal(modelSpans[1].options.attributes.usage_input_tokens, 13);
  assert.equal(modelSpans[1].options.attributes.usage_output_tokens, 5);
  assert.equal(modelSpans[1].options.attributes.usage_total_tokens, 18);
  assert.equal(modelSpans[1].options.attributes.usage_cache_total_tokens, 0);
  assert.equal(modelSpans[1].options.attributes.run_id, "run-2");
  assert.equal(run.span.attributes.usage_input_tokens, undefined);
  assert.equal(run.span.attributes.usage_output_tokens, undefined);
  assert.equal(run.span.attributes.usage_total_tokens, undefined);
  assert.equal(run.span.attributes.usage_cache_total_tokens, undefined);
  assert.equal(run.span.attributes.request_model, undefined);
  assert.equal(run.span.attributes.response_model, undefined);
  assert.equal(run.span.attributes["gen_ai.request.model"], undefined);
  assert.equal(run.span.attributes["gen_ai.response.model"], undefined);
  assert.equal(rootSpan.attributes.usage_input_tokens, undefined);
  assert.equal(rootSpan.attributes.usage_output_tokens, undefined);
  assert.equal(rootSpan.attributes.usage_total_tokens, undefined);
  assert.equal(rootSpan.attributes.request_model, undefined);
  assert.equal(rootSpan.attributes.response_model, undefined);
  assert.equal(rootSpan.attributes["gen_ai.request.model"], undefined);
  assert.equal(rootSpan.attributes["gen_ai.response.model"], undefined);
  assert.equal(durationRecords.length, 2);
  assert.deepEqual(
    durationRecords.map(({ value, attrs }) => ({
      value,
      operation_name: attrs["gen_ai.operation.name"],
      provider_name: attrs["gen_ai.provider.name"],
      request_model: attrs["gen_ai.request.model"],
      session_id: attrs.session_id,
    })),
    [
      {
        value: 1,
        operation_name: "chat",
        provider_name: "openai",
        request_model: "gpt-5",
        session_id: "sid-1",
      },
      {
        value: 0.3,
        operation_name: "chat",
        provider_name: "openai",
        request_model: "gpt-5",
        session_id: "sid-1",
      },
    ],
  );
  assert.deepEqual(
    tokenRecords.map(({ value, attrs }) => ({
      value,
      token_type: attrs["gen_ai.token.type"],
      request_model: attrs["gen_ai.request.model"],
      session_id: attrs.session_id,
    })),
    [
      { value: 11, token_type: "input", request_model: "gpt-5", session_id: "sid-1" },
      { value: 7, token_type: "output", request_model: "gpt-5", session_id: "sid-1" },
      { value: 13, token_type: "input", request_model: "gpt-5", session_id: "sid-1" },
      { value: 5, token_type: "output", request_model: "gpt-5", session_id: "sid-1" },
    ],
  );
});

test("transcript model replay skips turns already covered by runtime model usage", () => {
  const spans = [];
  const durationRecords = [];
  const tokenRecords = [];
  const tracer = createFakeTracer(spans);
  const trace = {
    setSpan(ctx, span) {
      return { ctx, span };
    },
  };
  const rootSpan = createFakeSpan("root");
  const run = createRunState({ ctx: "root" }, 1000, 1000);
  run.span = createFakeSpan("invoke_agent");
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
      genAiClientTokenUsage: {
        record(value, attrs) {
          tokenRecords.push({ value, attrs });
        },
      },
      genAiClientOperationDuration: {
        record(value, attrs) {
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
  assert.equal(modelSpans[0].options.attributes.usage_cache_total_tokens, 0);
  assert.equal(run.aggregate.inputTokens, 24);
  assert.equal(run.aggregate.outputTokens, 12);
  assert.equal(run.aggregate.totalTokens, 36);
  assert.equal(run.aggregate.modelCalls, 2);
  assert.equal(run.transcriptAssistantTurnsEmitted, 2);
  assert.equal(run.span.attributes.usage_input_tokens, undefined);
  assert.equal(run.span.attributes.usage_output_tokens, undefined);
  assert.equal(run.span.attributes.usage_total_tokens, undefined);
  assert.equal(run.span.attributes.request_model, undefined);
  assert.equal(run.span.attributes.response_model, undefined);
  assert.equal(run.span.attributes["gen_ai.request.model"], undefined);
  assert.equal(run.span.attributes["gen_ai.response.model"], undefined);
  assert.equal(rootSpan.attributes.usage_input_tokens, undefined);
  assert.equal(rootSpan.attributes.usage_output_tokens, undefined);
  assert.equal(rootSpan.attributes.usage_total_tokens, undefined);
  assert.equal(rootSpan.attributes.request_model, undefined);
  assert.equal(rootSpan.attributes.response_model, undefined);
  assert.equal(rootSpan.attributes["gen_ai.request.model"], undefined);
  assert.equal(rootSpan.attributes["gen_ai.response.model"], undefined);
  assert.deepEqual(
    tokenRecords.map(({ value, attrs }) => ({
      value,
      token_type: attrs["gen_ai.token.type"],
      request_model: attrs["gen_ai.request.model"],
      session_id: attrs.session_id,
    })),
    [
      { value: 13, token_type: "input", request_model: "gpt-5", session_id: "sid-1" },
      { value: 5, token_type: "output", request_model: "gpt-5", session_id: "sid-1" },
    ],
  );
  assert.deepEqual(
    durationRecords.map(({ value, attrs }) => ({
      value,
      operation_name: attrs["gen_ai.operation.name"],
      request_model: attrs["gen_ai.request.model"],
      session_id: attrs.session_id,
    })),
    [
      { value: 0.3, operation_name: "chat", request_model: "gpt-5", session_id: "sid-1" },
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
        run.span = createFakeSpan("invoke_agent");
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
        run.span = createFakeSpan("invoke_agent");
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
