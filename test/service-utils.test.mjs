import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSessionMetricAttrs,
  computeSessionMetricDelta,
  extractToolResultStatus,
  resolveIngressLifecycleWindows,
  resolveSessionSpanName,
  resolveSpanWindow,
  resolveSessionMetricTotals,
  stringAttrs,
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
    "openclaw.tokens.input": 12,
    "openclaw.tokens.output": 34,
    "openclaw.tokens.total": 46,
    "openclaw.tool.call_id": "call-1",
    "openclaw.tool.name": "read",
    "openclaw.tool.target": "/tmp/demo.txt",
    "openclaw.tool.outcome": "completed",
    "openclaw.tool.phase": "result",
    "openclaw.tool.loop.level": "critical",
    "openclaw.skill.call_id": "skill-call-1",
    "openclaw.skill.name": "monitor",
    "openclaw.skill.kind": "call",
    "openclaw.skill.source": "runtime",
    "openclaw.outcome": "completed",
  });

  assert.equal(attrs.session_id, "session-1");
  assert.equal(attrs.session_key, "agent:main:feishu:direct:ou_8f4b1d1bb3cd1cedf6003669dea4b2bf");
  assert.equal(attrs.session_namespace, "agent");
  assert.equal(attrs.session_agent, "main");
  assert.equal(attrs.session_channel, "feishu");
  assert.equal(attrs.session_scope, "direct");
  assert.equal(attrs.session_channel_target, "ou_8f4b1d1bb3cd1cedf6003669dea4b2bf");
  assert.equal(attrs.channel, "webchat");
  assert.equal(attrs.session_cwd, "/tmp/workspace");
  assert.equal(attrs.model_provider, "doubao");
  assert.equal(attrs.model_name, "ark-code-latest");
  assert.equal(attrs.input_tokens, 12);
  assert.equal(attrs.output_tokens, 34);
  assert.equal(attrs.total_tokens, 46);
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

  assert.equal(attrs.session_key, "agent:coder:main");
  assert.equal(attrs.session_agent, "coder");
  assert.equal(attrs.session_channel, "main");
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
