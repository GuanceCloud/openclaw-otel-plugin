import test from "node:test";
import assert from "node:assert/strict";

import { extractToolResultStatus, resolveSpanWindow, stringAttrs } from "../dist/src/service-utils.js";

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

test("stringAttrs maps openclaw fields to canonical aliases", () => {
  const attrs = stringAttrs({
    "openclaw.sessionId": "session-1",
    "openclaw.sessionKey": "agent:main:main",
    "openclaw.channel": "webchat",
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
  assert.equal(attrs.session_key, "agent:main:main");
  assert.equal(attrs.channel, "webchat");
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
  assert.equal(attrs.final_status, "completed");
  assert.equal("openclaw.sessionId" in attrs, false);
  assert.equal("openclaw.tool.call_id" in attrs, false);
  assert.equal("openclaw.skill.call_id" in attrs, false);
});

test("extractToolResultStatus only uses explicit status fields", () => {
  assert.equal(extractToolResultStatus({ details: { status: "blocked" } }), "blocked");
  assert.equal(extractToolResultStatus({ status: "timeout" }), "timeout");
  assert.equal(extractToolResultStatus({ outcome: "error" }), undefined);
  assert.equal(extractToolResultStatus({}), undefined);
});
