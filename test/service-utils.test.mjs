import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGenAiAgentRequestMetricAttrs,
  buildGenAiAgentSkillMetricAttrs,
  buildGenAiAgentSessionMetricAttrs,
  buildGenAiClientModelMetricAttrs,
  buildGenAiRuntimeMessageMetricAttrs,
  buildGenAiRuntimeQueueMetricAttrs,
  buildGenAiRuntimeSessionMetricAttrs,
  buildGenAiRuntimeWebhookMetricAttrs,
  buildSessionMetricAttrs,
  computeSessionMetricDelta,
  extractToolResultStatus,
  resolveIngressLifecycleWindows,
  resolveSessionSpanName,
  resolveSpanWindow,
  resolveSessionMetricTotals,
  stringAttrs,
  traceAttrs,
} from "../dist/src/service-utils.js";

test("resolveSpanWindow backfills start time from event end time", () => {
  const { startTime, endTime, effectiveDurationMs } = resolveSpanWindow(2000, 300);

  assert.equal(startTime.getTime(), 1700);
  assert.equal(endTime.getTime(), 2000);
  assert.equal(effectiveDurationMs, 300);
});

test("resolveSpanWindow keeps instant events at the same timestamp", () => {
  const { startTime, endTime, effectiveDurationMs } = resolveSpanWindow(2000);

  assert.equal(startTime.getTime(), 2000);
  assert.equal(endTime.getTime(), 2000);
  assert.equal(effectiveDurationMs, undefined);
});

test("resolveSessionSpanName prefers session_key over fallback names", () => {
  assert.equal(
    resolveSessionSpanName({ sessionKey: "agent:coder:main" }, "main"),
    "agent:coder:main",
  );
  assert.equal(
    resolveSessionSpanName({ sessionId: "session-1" }, "main"),
    "session-1",
  );
  assert.equal(
    resolveSessionSpanName({}, "main"),
    "main",
  );
});

test("resolveIngressLifecycleWindows emits a queue window when processing starts much later", () => {
  const windows = resolveIngressLifecycleWindows(1000, 4000);

  assert.deepEqual(windows, {
    ingressEndTs: 1120,
    queueStartTs: 1120,
    queueEndTs: 4000,
  });
});

test("resolveIngressLifecycleWindows keeps only a short ingress window when processing is immediate", () => {
  const windows = resolveIngressLifecycleWindows(1000, 1080);

  assert.deepEqual(windows, {
    ingressEndTs: 1080,
  });
});

test("stringAttrs maps openclaw fields to canonical aliases", () => {
  const attrs = stringAttrs({
    "openclaw.sessionId": "session-1",
    "openclaw.sessionKey": "agent:main:feishu:direct:ou_8f4b1d1bb3cd1cedf6003669dea4b2bf",
    "openclaw.channel": "webchat",
    "openclaw.session.cwd": "/tmp/workspace",
    "openclaw.provider": "doubao",
    "openclaw.model": "ark-code-latest",
    "openclaw.input.preview": "user asks for dashboard",
    "openclaw.input.length": 23,
    "openclaw.output.preview": "toolCall:exec",
    "openclaw.output.length": 11,
    output_summary: "planning summary",
    output_text_length: 16,
    "openclaw.tokens.input": 12,
    "openclaw.tokens.output": 34,
    "openclaw.tokens.total": 46,
    "openclaw.tool.call_id": "call-1",
    "openclaw.tool.name": "read",
    "openclaw.tool.target": "/tmp/demo.txt",
    "openclaw.tool.command": "cat /tmp/demo.txt",
    "openclaw.tool.outcome": "completed",
    "openclaw.tool.phase": "result",
    "openclaw.tool.loop.level": "critical",
    "openclaw.skill.call_id": "skill-call-1",
    "openclaw.skill.name": "monitor",
    "openclaw.skill.kind": "call",
    "openclaw.skill.source": "runtime",
    "openclaw.outcome": "completed",
    "openclaw.output.kind": "tool_call",
  });

  assert.equal(attrs.agent_runtime, "openclaw");
  assert.equal(attrs.session_id, "session-1");
  assert.equal(attrs.session_key, "agent:main:feishu:direct:ou_8f4b1d1bb3cd1cedf6003669dea4b2bf");
  assert.equal(attrs.sessionId, undefined);
  assert.equal(attrs.sessionKey, undefined);
  assert.equal(attrs["gen_ai.agent_runtime"], "openclaw");
  assert.equal(attrs["gen_ai.session_id"], "session-1");
  assert.equal(attrs["gen_ai.session_key"], "agent:main:feishu:direct:ou_8f4b1d1bb3cd1cedf6003669dea4b2bf");
  assert.equal(attrs["gen_ai.session_namespace"], "agent");
  assert.equal(attrs["gen_ai.session_agent"], "main");
  assert.equal(attrs["gen_ai.session_channel"], "feishu");
  assert.equal(attrs["gen_ai.session_scope"], "direct");
  assert.equal(attrs["gen_ai.session_channel_target"], "ou_8f4b1d1bb3cd1cedf6003669dea4b2bf");
  assert.equal(attrs["gen_ai.agent_channel"], "webchat");
  assert.equal(attrs["gen_ai.session_cwd"], "/tmp/workspace");
  assert.equal(attrs.channel, "webchat");
  assert.equal(attrs.session_cwd, "/tmp/workspace");
  assert.equal(attrs["gen_ai.provider_name"], "doubao");
  assert.equal(attrs["gen_ai.request_model"], "ark-code-latest");
  assert.equal(attrs["gen_ai.response_model"], "ark-code-latest");
  assert.equal(attrs["gen_ai.input_preview"], "user asks for dashboard");
  assert.equal(attrs["gen_ai.input_length"], 23);
  assert.equal(attrs["gen_ai.output_preview"], "toolCall:exec");
  assert.equal(attrs["gen_ai.output_length"], 11);
  assert.equal(attrs["gen_ai.output_summary"], "planning summary");
  assert.equal(attrs["gen_ai.output_text_length"], 16);
  assert.equal(attrs["gen_ai.usage_input_tokens"], 12);
  assert.equal(attrs["gen_ai.usage_output_tokens"], 34);
  assert.equal(attrs["gen_ai.usage_total_tokens"], 46);
  assert.equal(attrs["input.preview"], undefined);
  assert.equal(attrs["output.preview"], undefined);
  assert.equal(attrs.output_summary, undefined);
  assert.equal(attrs["llm.provider"], undefined);
  assert.equal(attrs["llm.model"], undefined);
  assert.equal(attrs["llm.input_tokens"], undefined);
  assert.equal(attrs["gen_ai.output_kind"], "tool_call");
  assert.equal(attrs["gen_ai.tool_call_id"], "call-1");
  assert.equal(attrs["gen_ai.tool_name"], "read");
  assert.equal(attrs["gen_ai.tool_target"], "/tmp/demo.txt");
  assert.equal(attrs["gen_ai.tool_command"], "cat /tmp/demo.txt");
  assert.equal(attrs["gen_ai.tool_outcome"], "completed");
  assert.equal(attrs["gen_ai.tool_phase"], "result");
  assert.equal(attrs["gen_ai.tool_loop_level"], "critical");
  assert.equal(attrs["gen_ai.skill_call_id"], "skill-call-1");
  assert.equal(attrs["gen_ai.skill_name"], "monitor");
  assert.equal(attrs["gen_ai.skill_type"], "call");
  assert.equal(attrs["gen_ai.skill_source"], "runtime");
  assert.equal(attrs["gen_ai.final_status"], "completed");
  assert.equal(attrs.tool_call_id, "call-1");
  assert.equal(attrs.tool_name, "read");
  assert.equal(attrs.tool_phase, "result");
  assert.equal(attrs.tool_loop_level, "critical");
  assert.equal(attrs.tool_target, "/tmp/demo.txt");
  assert.equal(attrs.tool_outcome, "completed");
  assert.equal(attrs.skill_call_id, "skill-call-1");
  assert.equal(attrs.skill_name, "monitor");
  assert.equal(attrs.skill_type, "call");
  assert.equal(attrs.skill_source, "runtime");
  assert.equal(attrs["skill.call_id"], "skill-call-1");
  assert.equal(attrs["skill.name"], "monitor");
  assert.equal(attrs["skill.kind"], "call");
  assert.equal(attrs["skill.source"], "runtime");
  assert.equal(attrs.final_status, "completed");
  assert.equal("openclaw.sessionId" in attrs, false);
  assert.equal("openclaw.session.cwd" in attrs, false);
  assert.equal("openclaw.tool.call_id" in attrs, false);
  assert.equal("skill.call_id" in attrs, true);
});

test("stringAttrs parses multi-agent session keys with agent name in the second segment", () => {
  const attrs = stringAttrs({
    "openclaw.sessionKey": "agent:coder:main",
  });

  assert.equal(attrs["gen_ai.agent_runtime"], "openclaw");
  assert.equal(attrs["gen_ai.session_key"], "agent:coder:main");
  assert.equal(attrs["gen_ai.session_agent"], "coder");
  assert.equal(attrs["gen_ai.session_channel"], "main");
});

test("traceAttrs keeps gen_ai context fields while dropping redundant legacy context keys", () => {
  const attrs = traceAttrs({
    agent_id: "main",
    agent_name: "main",
    agent_runtime: "openclaw",
    session_id: "session-1",
    session_key: "agent:main:feishu:direct:user-1",
    channel: "feishu",
    session_cwd: "/tmp/workspace",
    source_app: "feishu",
    entry_point: "feishu",
    tool_call_id: "call-1",
    tool_name: "read",
    tool_target: "/tmp/workspace/demo.txt",
    tool_command: "cat /tmp/workspace/demo.txt",
    tool_outcome: "completed",
    tool_phase: "result",
    tool_loop_level: "critical",
    skill_call_id: "skill-call-1",
    skill_name: "dashboard",
    skill_type: "call",
    skill_source: "runtime",
    final_status: "completed",
    "output.kind": "tool_call",
    app_name: "虾大侠",
    app_id: "app-1",
    agent_version: "2026.5.7",
    runtime_environment: "main",
    state: "processing",
    prevState: "queued",
    reason: "session.state",
    queueDepth: 2,
    "runtime.phase": "pre_model",
    tools: "exec,process",
    tool_count: 2,
    skills: "dashboard",
    "skill.count": 1,
    tool_targets: "/tmp/a,/tmp/b",
    tool_commands: "python3 a.py,python3 b.py",
    tool_result_statuses: "completed,error",
    tool_arg_keys: "path,cmd",
    tool_args_preview: "{\"path\":\"/tmp/a\"}",
    tool_meta_preview: "{\"exitCode\":0}",
    tool_result_preview: "done",
    tool_result_status: "completed",
    "tool.call_id": "call-1",
    "tool.name": "read",
    "tool.target": "/tmp/workspace/demo.txt",
    "tool.command": "cat /tmp/workspace/demo.txt",
    "tool.phase": "result",
    "tool.outcome": "completed",
    session_create_time: 1234567890,
    session_update_time: 3333333333,
    "session.createdAt": 1111111111,
    "session.updatedAt": 2222222222,
    "session.chatType": "direct",
    "session.file": "/tmp/session.jsonl",
  });

  assert.equal(attrs["gen_ai.agent_channel"], "feishu");
  assert.equal(attrs["gen_ai.session_id"], "session-1");
  assert.equal(attrs["gen_ai.session_key"], "agent:main:feishu:direct:user-1");
  assert.equal(attrs["gen_ai.session_cwd"], "/tmp/workspace");
  assert.equal(attrs["gen_ai.origin_provider"], "feishu");
  assert.equal(attrs["gen_ai.origin_surface"], "feishu");
  assert.equal(attrs["gen_ai.tool_call_id"], "call-1");
  assert.equal(attrs["gen_ai.tool_name"], "read");
  assert.equal(attrs["gen_ai.tool_target"], "/tmp/workspace/demo.txt");
  assert.equal(attrs["gen_ai.tool_command"], "cat /tmp/workspace/demo.txt");
  assert.equal(attrs["gen_ai.tool_outcome"], "completed");
  assert.equal(attrs["gen_ai.tool_phase"], "result");
  assert.equal(attrs["gen_ai.tool_loop_level"], "critical");
  assert.equal(attrs["gen_ai.skill_call_id"], "skill-call-1");
  assert.equal(attrs["gen_ai.skill_name"], "dashboard");
  assert.equal(attrs["gen_ai.skill_type"], "call");
  assert.equal(attrs["gen_ai.skill_source"], "runtime");
  assert.equal(attrs["gen_ai.final_status"], "completed");
  assert.equal(attrs["gen_ai.output_kind"], "tool_call");
  assert.equal(attrs["gen_ai.agent_version"], "2026.5.7");
  assert.equal(attrs["gen_ai.runtime_environment"], "main");
  assert.equal(attrs["gen_ai.state"], "processing");
  assert.equal(attrs["gen_ai.prev_state"], "queued");
  assert.equal(attrs["gen_ai.reason"], "session.state");
  assert.equal(attrs["gen_ai.queue_depth"], 2);
  assert.equal(attrs["gen_ai.runtime_phase"], "pre_model");
  assert.equal(attrs["gen_ai.tools"], "exec,process");
  assert.equal(attrs["gen_ai.tool_count"], 2);
  assert.equal(attrs["gen_ai.skills"], "dashboard");
  assert.equal(attrs["gen_ai.skill_count"], 1);
  assert.equal(attrs["gen_ai.tool_targets"], "/tmp/a,/tmp/b");
  assert.equal(attrs["gen_ai.tool_commands"], "python3 a.py,python3 b.py");
  assert.equal(attrs["gen_ai.tool_result_statuses"], "completed,error");
  assert.equal(attrs["gen_ai.tool_arg_keys"], "path,cmd");
  assert.equal(attrs["gen_ai.tool_args_preview"], "{\"path\":\"/tmp/a\"}");
  assert.equal(attrs["gen_ai.tool_meta_preview"], "{\"exitCode\":0}");
  assert.equal(attrs["gen_ai.tool_result_preview"], "done");
  assert.equal(attrs["gen_ai.tool_result_status"], "completed");
  assert.equal(attrs["gen_ai.session_create_at"], 1234567890);
  assert.equal(attrs["gen_ai.session_created_at"], 1111111111);
  assert.equal(attrs["gen_ai.session_updated_at"], 2222222222);
  assert.equal(attrs["gen_ai.session_chat_type"], "direct");
  assert.equal(attrs["gen_ai.session_file"], "/tmp/session.jsonl");
  assert.equal(attrs["gen_ai.agent_id"], undefined);
  assert.equal(attrs["gen_ai.agent_name"], undefined);
  assert.equal(attrs["gen_ai.agent_runtime"], undefined);
  assert.equal(attrs.agent_id, undefined);
  assert.equal(attrs.agent_name, undefined);
  assert.equal(attrs.agent_runtime, undefined);
  assert.equal(attrs.session_id, undefined);
  assert.equal(attrs.session_key, undefined);
  assert.equal(attrs.channel, undefined);
  assert.equal(attrs.session_cwd, undefined);
  assert.equal(attrs.source_app, undefined);
  assert.equal(attrs.entry_point, undefined);
  assert.equal(attrs.tool_call_id, undefined);
  assert.equal(attrs.tool_name, undefined);
  assert.equal(attrs.tool_target, undefined);
  assert.equal(attrs.tool_command, undefined);
  assert.equal(attrs.tool_outcome, undefined);
  assert.equal(attrs.tool_phase, undefined);
  assert.equal(attrs.tool_loop_level, undefined);
  assert.equal(attrs.skill_call_id, undefined);
  assert.equal(attrs.skill_name, undefined);
  assert.equal(attrs.skill_type, undefined);
  assert.equal(attrs.skill_source, undefined);
  assert.equal(attrs["skill.call_id"], undefined);
  assert.equal(attrs["skill.name"], undefined);
  assert.equal(attrs["skill.kind"], undefined);
  assert.equal(attrs["skill.source"], undefined);
  assert.equal(attrs.final_status, undefined);
  assert.equal(attrs["output.kind"], undefined);
  assert.equal(attrs.app_name, "虾大侠");
  assert.equal(attrs.app_id, "app-1");
  assert.equal(attrs.agent_version, undefined);
  assert.equal(attrs.runtime_environment, undefined);
  assert.equal(attrs.state, undefined);
  assert.equal(attrs.prevState, undefined);
  assert.equal(attrs.reason, undefined);
  assert.equal(attrs.queueDepth, undefined);
  assert.equal(attrs["runtime.phase"], undefined);
  assert.equal(attrs.tools, undefined);
  assert.equal(attrs.tool_count, undefined);
  assert.equal(attrs.skills, undefined);
  assert.equal(attrs["skill.count"], undefined);
  assert.equal(attrs.tool_targets, undefined);
  assert.equal(attrs.tool_commands, undefined);
  assert.equal(attrs.tool_result_statuses, undefined);
  assert.equal(attrs.tool_arg_keys, undefined);
  assert.equal(attrs.tool_args_preview, undefined);
  assert.equal(attrs.tool_meta_preview, undefined);
  assert.equal(attrs.tool_result_preview, undefined);
  assert.equal(attrs.tool_result_status, undefined);
  assert.equal(attrs["tool.call_id"], undefined);
  assert.equal(attrs["tool.name"], undefined);
  assert.equal(attrs["tool.target"], undefined);
  assert.equal(attrs["tool.command"], undefined);
  assert.equal(attrs["tool.phase"], undefined);
  assert.equal(attrs["tool.outcome"], undefined);
  assert.equal(attrs.session_create_time, undefined);
  assert.equal(attrs.session_update_time, undefined);
  assert.equal(attrs["session.createdAt"], undefined);
  assert.equal(attrs["session.updatedAt"], undefined);
  assert.equal(attrs["session.chatType"], undefined);
  assert.equal(attrs["session.file"], undefined);
});

test("extractToolResultStatus only uses explicit status fields", () => {
  assert.equal(extractToolResultStatus({ details: { status: "blocked" } }), "blocked");
  assert.equal(extractToolResultStatus({ status: "timeout" }), "timeout");
  assert.equal(extractToolResultStatus({ outcome: "error" }), undefined);
  assert.equal(extractToolResultStatus({}), undefined);
});

test("resolveSessionMetricTotals reads cumulative values from a session snapshot", () => {
  const totals = resolveSessionMetricTotals({
    sessionUsageTotals: {
      input: 40,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 50,
    },
    traceCount: 3,
  });

  assert.deepEqual(totals, {
    inputTokens: 40,
    outputTokens: 10,
    totalTokens: 50,
    traceCount: 3,
  });
});

test("computeSessionMetricDelta only emits monotonic increments for session counters", () => {
  assert.deepEqual(
    computeSessionMetricDelta(
      { inputTokens: 40, outputTokens: 10, totalTokens: 50, traceCount: 3 },
      { inputTokens: 35, outputTokens: 8, totalTokens: 43, traceCount: 2 },
    ),
    { inputTokens: 5, outputTokens: 2, totalTokens: 7, traceCount: 1 },
  );

  assert.deepEqual(
    computeSessionMetricDelta(
      { inputTokens: 12, outputTokens: 4, totalTokens: 16, traceCount: 1 },
      { inputTokens: 20, outputTokens: 9, totalTokens: 29, traceCount: 3 },
    ),
    { inputTokens: 12, outputTokens: 4, totalTokens: 16, traceCount: 1 },
  );
});

test("buildSessionMetricAttrs prefers runtime model overrides for session metrics", () => {
  const attrs = buildSessionMetricAttrs(
    {
      sessionId: "session-1",
      lastProvider: "snapshot-provider",
      lastModel: "snapshot-model",
    },
    "agent:main:main",
    {
      modelProvider: "runtime-provider",
      modelName: "runtime-model",
    },
  );

  assert.equal(attrs.session_id, "session-1");
  assert.equal(attrs.session_key, "agent:main:main");
  assert.equal(attrs.model_provider, "runtime-provider");
  assert.equal(attrs.model_name, "runtime-model");
});

test("buildGenAiClientModelMetricAttrs uses GenAI semantic-style keys", () => {
  const attrs = buildGenAiClientModelMetricAttrs("volcengine-plan", "ark-code-latest", {
    token_type: "input",
  });

  assert.equal(attrs.operation_name, "chat");
  assert.equal(attrs.provider_name, "volcengine-plan");
  assert.equal(attrs.request_model, "ark-code-latest");
  assert.equal(attrs.response_model, "ark-code-latest");
  assert.equal(attrs.token_type, "input");
});

test("GenAI agent metric builders preserve session and request semantics", () => {
  const requestAttrs = buildGenAiAgentRequestMetricAttrs(
    {
      sessionId: "session-1",
      lastChannel: "feishu",
      lastProvider: "volcengine-plan",
      lastModel: "ark-code-latest",
    },
    {
      "openclaw.state": "idle",
      "openclaw.outcome": "completed",
    },
  );
  const sessionAttrs = buildGenAiAgentSessionMetricAttrs(
    {
      sessionId: "session-1",
      lastProvider: "snapshot-provider",
      lastModel: "snapshot-model",
    },
    "agent:main:main",
    {
      modelProvider: "runtime-provider",
      modelName: "runtime-model",
      tokenType: "total",
    },
  );

  assert.equal(requestAttrs.channel, "feishu");
  assert.equal(requestAttrs.session_id, "session-1");
  assert.equal(requestAttrs.provider_name, "volcengine-plan");
  assert.equal(requestAttrs.request_model, "ark-code-latest");
  assert.equal(requestAttrs.session_state, "idle");
  assert.equal(requestAttrs.outcome, "completed");

  assert.equal(sessionAttrs.session_id, "session-1");
  assert.equal(sessionAttrs.session_key, "agent:main:main");
  assert.equal(sessionAttrs.provider_name, "runtime-provider");
  assert.equal(sessionAttrs.request_model, "runtime-model");
  assert.equal(sessionAttrs.token_type, "total");
});

test("GenAI runtime and skill metric builders use the new namespaces", () => {
  const skillAttrs = buildGenAiAgentSkillMetricAttrs("dashboard", "runtime", "session-1");
  const messageAttrs = buildGenAiRuntimeMessageMetricAttrs("feishu", "session-1", {
    outcome: "completed",
  });
  const queueAttrs = buildGenAiRuntimeQueueMetricAttrs("main", "session-1", {
    outcome: "dequeue",
  });
  const sessionAttrs = buildGenAiRuntimeSessionMetricAttrs("processing", "waiting_for_tool", "session-1");

  assert.equal(skillAttrs.session_id, "session-1");
  assert.equal(skillAttrs.skill_name, "dashboard");
  assert.equal(skillAttrs.skill_source, "runtime");
  assert.equal(messageAttrs.channel, "feishu");
  assert.equal(messageAttrs.session_id, "session-1");
  assert.equal(messageAttrs.outcome, "completed");
  assert.equal(queueAttrs.queue_name, "main");
  assert.equal(queueAttrs.session_id, "session-1");
  assert.equal(queueAttrs.outcome, "dequeue");
  assert.equal(sessionAttrs.session_id, "session-1");
  assert.equal(sessionAttrs.session_state, "processing");
  assert.equal(sessionAttrs.outcome, "waiting_for_tool");
});

test("GenAI runtime webhook metric builder uses the runtime webhook namespace", () => {
  const attrs = buildGenAiRuntimeWebhookMetricAttrs("feishu", "message");

  assert.equal(attrs.channel, "feishu");
  assert.equal(attrs.webhook_name, "message");
});
