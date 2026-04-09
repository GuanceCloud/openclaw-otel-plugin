import test from "node:test";
import assert from "node:assert/strict";

import { createToolSpanManager } from "../dist/src/tool-span-manager.js";
import { createRunState } from "../dist/src/service-utils.js";

function createFakeSpan(name) {
  return {
    name,
    attributes: {},
    setAttributes(attrs) {
      Object.assign(this.attributes, attrs);
    },
    setStatus() {},
    end() {},
    addEvent() {},
  };
}

test("transcript skill spans use invoked skills instead of mentioned skills", () => {
  const spans = [];
  const run = createRunState({ active: true }, 1000, 1000);
  run.span = createFakeSpan("run");
  run.ctx = { ctx: "run" };
  const manager = createToolSpanManager({
    tracer: {
      startSpan(name) {
        const span = createFakeSpan(name);
        spans.push(span);
        return span;
      },
    },
    trace: {
      setSpan(ctx, span) {
        return { ctx, span };
      },
    },
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
      return { span: createFakeSpan("root"), ctx: { ctx: "root" } };
    },
    ensureUserSpan() {
      return undefined;
    },
    loadSessionSnapshot() {
      return {
        sessionFile: "session.jsonl",
        mtimeMs: 1,
        mentionedSkillNames: ["monitor"],
        invokedSkillNames: ["dql"],
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

  manager.ensureTranscriptSkillSpans({ sessionKey: "s1", ts: 2000 });

  assert.deepEqual(
    spans.map((span) => span.name),
    ["skill:dql"],
  );
});
