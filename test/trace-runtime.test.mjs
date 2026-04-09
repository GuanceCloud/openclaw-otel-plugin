import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeTerminalSpanAttrs,
  resolveOtelUrl,
  shouldCloseForSessionState,
  shouldCreateRootForSessionState,
  shouldSyncRootForSessionState,
  stripAnsiEscapeCodes,
} from "../src/trace-runtime.js";

test("resolveOtelUrl appends traces path when endpoint is not signal-qualified", () => {
  assert.equal(
    resolveOtelUrl("https://collector.example.com/base", "v1/traces"),
    "https://collector.example.com/base/v1/traces",
  );
});

test("resolveOtelUrl keeps trace endpoint with query string unchanged", () => {
  assert.equal(
    resolveOtelUrl("https://collector.example.com/v1/traces?timeout=30s", "v1/traces"),
    "https://collector.example.com/v1/traces?timeout=30s",
  );
});

test("resolveOtelUrl keeps trace endpoint with fragment unchanged", () => {
  assert.equal(
    resolveOtelUrl("https://collector.example.com/v1/traces#frag", "v1/traces"),
    "https://collector.example.com/v1/traces#frag",
  );
});

test("resolveOtelUrl appends a custom trace path", () => {
  assert.equal(
    resolveOtelUrl("https://collector.example.com/base", "v1/llms"),
    "https://collector.example.com/base/v1/llms",
  );
});

test("resolveOtelUrl keeps a custom signal endpoint unchanged", () => {
  assert.equal(
    resolveOtelUrl("https://collector.example.com/v1/llms?timeout=30s", "/v1/llms"),
    "https://collector.example.com/v1/llms?timeout=30s",
  );
});

test("stripAnsiEscapeCodes removes terminal escape sequences from previews", () => {
  assert.equal(stripAnsiEscapeCodes("hello \u001b[118;1:3mbug\u001b[0m world"), "hello bug world");
});

test("normalizeTerminalSpanAttrs stores terminal session state under final_* keys", () => {
  assert.deepEqual(
    normalizeTerminalSpanAttrs({
      "openclaw.state": "idle",
      "openclaw.reason": "run_completed",
      "openclaw.outcome": "completed",
      trace_id: "abc123",
    }),
    {
      "openclaw.final_state": "idle",
      "openclaw.final_reason": "run_completed",
      "openclaw.outcome": "completed",
    },
  );
});

test("session.state waiting keeps root open and only syncs", () => {
  assert.equal(shouldCreateRootForSessionState("waiting"), true);
  assert.equal(shouldSyncRootForSessionState("waiting"), true);
  assert.equal(shouldCloseForSessionState("waiting"), false);
});

test("session.state processing keeps root open without closing", () => {
  assert.equal(shouldCreateRootForSessionState("processing"), true);
  assert.equal(shouldSyncRootForSessionState("processing"), false);
  assert.equal(shouldCloseForSessionState("processing"), false);
});

test("session.state idle is the only closing state", () => {
  assert.equal(shouldCreateRootForSessionState("idle"), false);
  assert.equal(shouldSyncRootForSessionState("idle"), false);
  assert.equal(shouldCloseForSessionState("idle"), true);
});
