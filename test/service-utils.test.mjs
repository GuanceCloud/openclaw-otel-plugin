import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildGenAiAgentTokenMetricAttrs,
  buildGenAiAgentRequestMetricAttrs,
  buildGenAiAgentSkillMetricAttrs,
  buildGenAiAgentSessionMetricAttrs,
  buildRunScopeAttrs,
  buildTranscriptReplayEvent,
  buildGenAiClientModelMetricAttrs,
  buildGenAiClientSkillMetricAttrs,
  buildGenAiClientToolMetricAttrs,
  buildToolAttrs,
  buildGenAiRuntimeMessageMetricAttrs,
  buildGenAiRuntimeQueueMetricAttrs,
  buildGenAiRuntimeSessionMetricAttrs,
  buildGenAiRuntimeWebhookMetricAttrs,
  buildSessionMetricAttrs,
  computeSessionMetricDelta,
  extractToolResultStatus,
  loadSnapshotForEvent,
  resolveAgentIdentity,
  readReplayFinalizationState,
  resolveRequestClassification,
  rememberRunId,
  resolveUsageTokenTotals,
  resolveReplayFinalizationStateFile,
  resolveIngressLifecycleWindows,
  resolveSessionSpanName,
  resolveSpanWindow,
  resolveSessionMetricTotals,
  stringAttrs,
  traceAttrs,
  writeReplayFinalizationState,
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

test("buildTranscriptReplayEvent carries snapshot runId into replay events", () => {
  const evt = buildTranscriptReplayEvent("agent:main:chat:direct:user-1", {
    sessionId: "session-1",
    runId: "run-123",
    lastAssistantTs: 1710000000000,
    lastChannel: "chat",
  });

  assert.deepEqual(evt, {
    sessionKey: "agent:main:chat:direct:user-1",
    sessionId: "session-1",
    runId: "run-123",
    ts: 1710000000000,
    channel: "chat",
  });
});

test("rememberRunId keeps the first run_id and accumulates later run ids", () => {
  const state = {};

  assert.equal(rememberRunId(state, "run-1"), true);
  assert.equal(rememberRunId(state, "run-2"), true);
  assert.equal(rememberRunId(state, "run-2"), false);

  assert.equal(state.runId, "run-1");
  assert.deepEqual(Array.from(state.runIds ?? []), ["run-1", "run-2"]);
});

test("resolveUsageTokenTotals keeps cache tokens separate from llm total tokens", () => {
  assert.deepEqual(
    resolveUsageTokenTotals({
      input: 504,
      output: 93,
      cacheRead: 64640,
      cacheWrite: 0,
      totalTokens: 65237,
    }),
    {
      inputTokens: 504,
      outputTokens: 93,
      cacheReadTokens: 64640,
      cacheWriteTokens: 0,
      totalTokens: 597,
    },
  );
});

test("resolveRequestClassification marks runtime continue prompts as internal requests", () => {
  assert.deepEqual(
    resolveRequestClassification({
      lastUserText: "Continue the OpenClaw runtime event.",
    }),
    {
      requestType: "internal_request",
      requestCategory: "runtime_continue",
      isInternalRequest: true,
    },
  );
});

test("resolveRequestClassification marks heartbeat probes as internal requests", () => {
  assert.deepEqual(
    resolveRequestClassification({
      lastUserText: "[OpenClaw heartbeat poll]",
      lastAssistantText: "HEARTBEAT_OK",
    }),
    {
      requestType: "internal_request",
      requestCategory: "heartbeat",
      isInternalRequest: true,
    },
  );
});

test("loadSnapshotForEvent resolves snapshots through sessionId when sessionKey is absent", () => {
  const calls = [];
  const snapshot = { sessionId: "sid-1", lastUserText: "delete folder" };

  const resolved = loadSnapshotForEvent(
    { sessionId: "sid-1" },
    (sessionKey) => {
      calls.push(sessionKey);
      return sessionKey === "agent:main:dashboard:test-user" ? snapshot : undefined;
    },
    (evt) => evt.sessionId === "sid-1" ? "agent:main:dashboard:test-user" : undefined,
  );

  assert.equal(resolved, snapshot);
  assert.deepEqual(calls, ["agent:main:dashboard:test-user"]);
});

test("resolveAgentIdentity uses configured names and runtime fallback with one priority chain", () => {
  assert.deepEqual(
    resolveAgentIdentity({
      sessionKey: "agent:main:dashboard:user-1",
      snapshot: {
        agentId: "snapshot-agent",
        agentName: "Snapshot Agent",
      },
      configuredAgentById: new Map([
        ["main", { id: "main", name: "Dashboard Agent" }],
      ]),
      runtimeMetadata: {
        agentId: "runtime-agent",
        agentName: "Runtime Agent",
      },
    }),
    {
      agentId: "main",
      agentName: "Dashboard Agent",
    },
  );

  assert.deepEqual(
    resolveAgentIdentity({
      snapshot: {
        agentId: "snapshot-agent",
        agentName: "Snapshot Agent",
      },
      runtimeMetadata: {
        agentId: "runtime-agent",
        agentName: "Runtime Agent",
      },
    }),
    {
      agentId: "snapshot-agent",
      agentName: "Snapshot Agent",
    },
  );

  assert.deepEqual(
    resolveAgentIdentity({
      runtimeMetadata: {
        agentId: "runtime-agent",
        agentName: "Runtime Agent",
      },
      attrs: {
        agent_id: "explicit-agent",
        agent_name: "Explicit Agent",
      },
    }),
    {
      agentId: "explicit-agent",
      agentName: "Explicit Agent",
    },
  );
});

test("buildRunScopeAttrs preserves the primary run_id and exposes the run_ids summary", () => {
  const attrs = buildRunScopeAttrs(
    "run-1",
    new Set(["run-1", "run-2"]),
    "run-3",
    ["run-2", "run-4"],
  );

  assert.deepEqual(attrs, {
    run_id: "run-1",
    run_ids: "run-1,run-2,run-3,run-4",
  });
});

test("replay finalization state survives restart-style reloads", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-replay-state-"));
  const stateFile = resolveReplayFinalizationStateFile(stateDir);
  const entries = new Map([
    ["agent:main:main", { watermark: "session-1|1|2|3", runId: "run-1", updatedAt: 200 }],
    ["agent:main:chat", { watermark: "session-2|4|5|6", updatedAt: 100 }],
  ]);

  writeReplayFinalizationState(stateFile, entries);
  const restored = readReplayFinalizationState(stateFile);

  assert.equal(restored.get("agent:main:main")?.watermark, "session-1|1|2|3");
  assert.equal(restored.get("agent:main:main")?.runId, "run-1");
  assert.equal(restored.get("agent:main:chat")?.watermark, "session-2|4|5|6");
  assert.equal(restored.get("agent:main:chat")?.runId, undefined);
});

test("replay finalization state keeps only the newest completed sessions", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-replay-state-prune-"));
  const stateFile = resolveReplayFinalizationStateFile(stateDir);
  const entries = new Map();
  for (let index = 0; index < 2050; index += 1) {
    entries.set(`agent:main:${index}`, {
      watermark: `session-${index}`,
      runId: `run-${index}`,
      updatedAt: index,
    });
  }

  writeReplayFinalizationState(stateFile, entries);
  const restored = readReplayFinalizationState(stateFile);

  assert.equal(restored.size, 2048);
  assert.equal(restored.has("agent:main:0"), false);
  assert.equal(restored.has("agent:main:1"), false);
  assert.equal(restored.get("agent:main:2049")?.runId, "run-2049");
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
    "openclaw.tokens.cache_read": 5,
    "openclaw.tokens.cache_write": 7,
    "openclaw.tool.call_id": "call-1",
    "openclaw.tool.name": "read",
    "openclaw.tool.target": "/tmp/demo.txt",
    "openclaw.tool.command": "cat /tmp/demo.txt",
    "openclaw.tool.provider": "mcp",
    "openclaw.tool.namespace": "owl",
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
  assert.equal(attrs.session_namespace, "agent");
  assert.equal(attrs.session_agent, "main");
  assert.equal(attrs.session_channel, "feishu");
  assert.equal(attrs.session_scope, "direct");
  assert.equal(attrs.session_channel_target, "ou_8f4b1d1bb3cd1cedf6003669dea4b2bf");
  assert.equal(attrs.channel, "webchat");
  assert.equal(attrs.session_cwd, "/tmp/workspace");
  assert.equal(attrs.provider_name, "doubao");
  assert.equal(attrs.request_model, "ark-code-latest");
  assert.equal(attrs.response_model, "ark-code-latest");
  assert.equal(attrs.input_preview, "user asks for dashboard");
  assert.equal(attrs.input_length, 23);
  assert.equal(attrs.output_preview, "toolCall:exec");
  assert.equal(attrs.output_length, 11);
  assert.equal(attrs.output_summary, "planning summary");
  assert.equal(attrs.output_text_length, 16);
  assert.equal(attrs.usage_input_tokens, 12);
  assert.equal(attrs.usage_output_tokens, 34);
  assert.equal(attrs.usage_total_tokens, 46);
  assert.equal(attrs.usage_cache_read_input_tokens, 5);
  assert.equal(attrs.usage_cache_write_input_tokens, 7);
  assert.equal(attrs.usage_cache_total_tokens, 12);
  assert.equal(attrs.output_kind, "tool_call");
  assert.equal(attrs.tool_call_id, "call-1");
  assert.equal(attrs.tool_name, "read");
  assert.equal(attrs.tool_command, "cat /tmp/demo.txt");
  assert.equal(attrs.tool_target, "/tmp/demo.txt");
  assert.equal(attrs.tool_provider, "mcp");
  assert.equal(attrs.tool_namespace, "owl");
  assert.equal(attrs.tool_outcome, "completed");
  assert.equal(attrs.tool_phase, "result");
  assert.equal(attrs.tool_loop_level, "critical");
  assert.equal(attrs.skill_call_id, "skill-call-1");
  assert.equal(attrs.skill_name, "monitor");
  assert.equal(attrs.skill_type, "call");
  assert.equal(attrs.skill_source, "runtime");
  assert.equal(attrs.final_status, "completed");
  assert.equal(attrs.sessionId, undefined);
  assert.equal(attrs.sessionKey, undefined);
  assert.equal(attrs["gen_ai.agent_runtime"], undefined);
  assert.equal(attrs["gen_ai.session_id"], undefined);
  assert.equal(attrs["gen_ai.session_key"], undefined);
  assert.equal(attrs["gen_ai.agent_channel"], undefined);
  assert.equal(attrs["gen_ai.provider_name"], undefined);
  assert.equal(attrs["gen_ai.tool_name"], undefined);
  assert.equal(attrs["gen_ai.skill_name"], undefined);
  assert.equal(attrs["gen_ai.final_status"], undefined);
  assert.equal(attrs["input.preview"], undefined);
  assert.equal(attrs["output.preview"], undefined);
  assert.equal(attrs["llm.provider"], undefined);
  assert.equal(attrs["llm.model"], undefined);
  assert.equal(attrs["llm.input_tokens"], undefined);
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

  assert.equal(attrs.agent_runtime, "openclaw");
  assert.equal(attrs.session_key, "agent:coder:main");
  assert.equal(attrs.session_agent, "coder");
  assert.equal(attrs.session_channel, "main");
  assert.equal(attrs["gen_ai.session_key"], undefined);
});

test("stringAttrs restores agent_runtime when upstream spreads an undefined value", () => {
  const attrs = stringAttrs({
    agent_runtime: undefined,
    agent_version: "2026.5.7",
  });

  assert.equal(attrs.agent_runtime, "openclaw");
  assert.equal(attrs.agent_version, "2026.5.7");
});

test("traceAttrs keeps canonical context fields while dropping redundant legacy context keys", () => {
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
    tool_provider: "mcp",
    tool_namespace: "owl",
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
    "runtime.phase": "agent_plan",
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
    "openclaw.session.createdAt": 1234567890,
    "openclaw.session.updatedAt": 2222222222,
    "session.createdAt": 1111111111,
    "session.updatedAt": 2222222222,
    "session.chatType": "direct",
    "session.file": "/tmp/session.jsonl",
  });

  assert.equal(attrs.agent_runtime, undefined);
  assert.equal(attrs.agent_id, "main");
  assert.equal(attrs.agent_name, "main");
  assert.equal(attrs.session_id, "session-1");
  assert.equal(attrs.session_key, "agent:main:feishu:direct:user-1");
  assert.equal(attrs.session_id, "session-1");
  assert.equal(attrs.channel, "feishu");
  assert.equal(attrs.session_cwd, "/tmp/workspace");
  assert.equal(attrs.source_app, "feishu");
  assert.equal(attrs.entry_point, "feishu");
  assert.equal(attrs.provider_name, undefined);
  assert.equal(attrs.request_model, undefined);
  assert.equal(attrs.output_kind, "tool_call");
  assert.equal(attrs.tool_call_id, "call-1");
  assert.equal(attrs.tool_name, "read");
  assert.equal(attrs.tool_target, "/tmp/workspace/demo.txt");
  assert.equal(attrs.tool_command, "cat /tmp/workspace/demo.txt");
  assert.equal(attrs.tool_provider, "mcp");
  assert.equal(attrs.tool_namespace, "owl");
  assert.equal(attrs.tool_outcome, "completed");
  assert.equal(attrs.tool_phase, "result");
  assert.equal(attrs.tool_loop_level, "critical");
  assert.equal(attrs.skill_call_id, "skill-call-1");
  assert.equal(attrs.skill_name, "dashboard");
  assert.equal(attrs.skill_type, "call");
  assert.equal(attrs.skill_source, "runtime");
  assert.equal(attrs["skill.call_id"], undefined);
  assert.equal(attrs["skill.name"], undefined);
  assert.equal(attrs["skill.kind"], undefined);
  assert.equal(attrs["skill.source"], undefined);
  assert.equal(attrs.final_status, "completed");
  assert.equal(attrs.agent_version, undefined);
  assert.equal(attrs.runtime_environment, undefined);
  assert.equal(attrs.state, "processing");
  assert.equal(attrs.prev_state, "queued");
  assert.equal(attrs.reason, "session.state");
  assert.equal(attrs.queue_depth, 2);
  assert.equal(attrs.runtime_phase, "agent_plan");
  assert.equal(attrs.tools, "exec,process");
  assert.equal(attrs.tool_count, 2);
  assert.equal(attrs.skills, "dashboard");
  assert.equal(attrs.skill_count, 1);
  assert.equal(attrs.tool_targets, "/tmp/a,/tmp/b");
  assert.equal(attrs.tool_commands, "python3 a.py,python3 b.py");
  assert.equal(attrs.tool_result_statuses, "completed,error");
  assert.equal(attrs.tool_arg_keys, "path,cmd");
  assert.equal(attrs.tool_args_preview, "{\"path\":\"/tmp/a\"}");
  assert.equal(attrs.tool_meta_preview, "{\"exitCode\":0}");
  assert.equal(attrs.tool_result_preview, "done");
  assert.equal(attrs.tool_result_status, "completed");
  assert.equal(attrs.session_create_at, 1234567890);
  assert.equal(attrs.session_created_at, 1111111111);
  assert.equal(attrs.session_updated_at, 2222222222);
  assert.equal(attrs.session_chat_type, "direct");
  assert.equal(attrs.session_file, "/tmp/session.jsonl");
  assert.equal(attrs.app_name, "虾大侠");
  assert.equal(attrs.app_id, "app-1");
  assert.equal(attrs["output.kind"], undefined);
  assert.equal(attrs.prevState, undefined);
  assert.equal(attrs["gen_ai.session_id"], undefined);
  assert.equal(attrs["gen_ai.tool_name"], undefined);
  assert.equal(attrs["gen_ai.skill_name"], undefined);
  assert.equal(attrs["gen_ai.final_status"], undefined);
  assert.equal(attrs.queueDepth, undefined);
  assert.equal(attrs["runtime.phase"], undefined);
  assert.equal(attrs["skill.count"], undefined);
  assert.equal(attrs["tool.call_id"], undefined);
  assert.equal(attrs["tool.name"], undefined);
  assert.equal(attrs["tool.target"], undefined);
  assert.equal(attrs["tool.command"], undefined);
  assert.equal(attrs["tool.provider"], undefined);
  assert.equal(attrs["tool.namespace"], undefined);
  assert.equal(attrs["tool.phase"], undefined);
  assert.equal(attrs["tool.outcome"], undefined);
  assert.equal(attrs.session_create_time, undefined);
  assert.equal(attrs.session_update_time, undefined);
  assert.equal(attrs["session.createdAt"], undefined);
  assert.equal(attrs["session.updatedAt"], undefined);
  assert.equal(attrs.session_updatedAt, undefined);
  assert.equal(attrs["session.chatType"], undefined);
  assert.equal(attrs["session.file"], undefined);
  assert.equal(attrs["openclaw.session.createdAt"], undefined);
  assert.equal(attrs["openclaw.session.updatedAt"], undefined);
});

test("stringAttrs keeps zero-valued token aliases on summary spans", () => {
  const attrs = stringAttrs({
    "openclaw.tokens.input": 0,
    "openclaw.tokens.output": 0,
    "openclaw.tokens.total": 0,
    "openclaw.tokens.cache_read": 0,
    "openclaw.tokens.cache_write": 0,
  });

  assert.equal(attrs.usage_input_tokens, 0);
  assert.equal(attrs.usage_output_tokens, 0);
  assert.equal(attrs.usage_total_tokens, 0);
  assert.equal(attrs.usage_cache_read_input_tokens, 0);
  assert.equal(attrs.usage_cache_write_input_tokens, 0);
});

test("buildToolAttrs infers mcp provider and namespace from explicit metadata", () => {
  const attrs = buildToolAttrs("apm.list", "call-1", {
    args: { query: "slow requests" },
    meta: {
      mcp: {
        serverName: "owl",
      },
    },
  });

  assert.equal(attrs["openclaw.tool.provider"], "mcp");
  assert.equal(attrs["openclaw.tool.namespace"], "owl");
});

test("buildToolAttrs infers bundle mcp identity and underlying mcp tool name", () => {
  const attrs = buildToolAttrs("owl__exec_tool", "call-1", {
    args: {
      tool_name: "owl.data.simple_query",
      parameters: {
        namespace: "T",
      },
    },
  });

  assert.equal(attrs["openclaw.tool.provider"], "mcp");
  assert.equal(attrs["openclaw.tool.namespace"], "owl");
  assert.equal(attrs["openclaw.tool.mcp_name"], "owl.data.simple_query");
  assert.equal(attrs["openclaw.tool.mcp_host"], "owl-mcp.guance.com");
  assert.equal(attrs["openclaw.tool.target"], "owl.data.simple_query");
});

test("buildToolAttrs infers mcp provider and namespace from dotted tool names", () => {
  const attrs = buildToolAttrs("owl.apm.list", "call-1");

  assert.equal(attrs["openclaw.tool.provider"], "mcp");
  assert.equal(attrs["openclaw.tool.namespace"], "owl");
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

  assert.equal(attrs.operation_name, "model");
  assert.equal(attrs.provider_name, "volcengine-plan");
  assert.equal(attrs.request_model, "ark-code-latest");
  assert.equal(attrs.response_model, "ark-code-latest");
  assert.equal(attrs.token_type, "input");
});

test("buildGenAiAgentTokenMetricAttrs uses canonical agent token keys", () => {
  const attrs = buildGenAiAgentTokenMetricAttrs("volcengine-plan", "ark-code-latest", {
    session_id: "session-1",
    token_type: "input",
  });

  assert.equal(attrs.provider_name, "volcengine-plan");
  assert.equal(attrs.request_model, "ark-code-latest");
  assert.equal(attrs.response_model, "ark-code-latest");
  assert.equal(attrs.session_id, "session-1");
  assert.equal(attrs.token_type, "input");
  assert.equal(attrs.operation_name, undefined);
});

test("buildGenAiClientToolMetricAttrs uses tool operation naming", () => {
  const attrs = buildGenAiClientToolMetricAttrs(
    { name: "exec", skillName: "dashboard" },
    "completed",
    "success",
    "session-1",
    "gpt-5",
  );

  assert.equal(attrs.operation_name, "tool");
  assert.equal(attrs.tool_name, "exec");
  assert.equal(attrs.skill_name, "dashboard");
  assert.equal(attrs.model_name, "gpt-5");
  assert.equal(attrs.tool_result_status, "success");
  assert.equal(attrs.session_id, "session-1");
});

test("buildGenAiClientSkillMetricAttrs uses skill operation naming", () => {
  const attrs = buildGenAiClientSkillMetricAttrs(
    "dashboard",
    "completed",
    "session-1",
  );

  assert.equal(attrs.operation_name, "skill");
  assert.equal(attrs.skill_name, "dashboard");
  assert.equal(attrs.skill_source, "runtime");
  assert.equal(attrs.session_id, "session-1");
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
