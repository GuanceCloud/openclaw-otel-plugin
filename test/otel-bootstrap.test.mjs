import test from "node:test";
import assert from "node:assert/strict";

import { RootBufferedTraceSpanProcessor } from "../dist/src/otel-bootstrap.js";

function createSpan({
  traceId,
  spanId,
  parentSpanId,
  name,
  startTime,
  endTime,
}) {
  return {
    name,
    kind: 0,
    spanContext: () => ({
      traceId,
      spanId,
      traceFlags: 1,
    }),
    parentSpanContext: parentSpanId ? { spanId: parentSpanId } : undefined,
    startTime: [Math.floor(startTime / 1000), (startTime % 1000) * 1_000_000],
    endTime: [Math.floor(endTime / 1000), (endTime % 1000) * 1_000_000],
    status: { code: 1 },
    attributes: {},
    links: [],
    events: [],
    duration: [0, 0],
    ended: true,
    resource: {
      asyncAttributesPending: false,
    },
    instrumentationScope: {
      name: "test",
      version: "1",
    },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

test("RootBufferedTraceSpanProcessor waits for the root span before exporting a trace", async () => {
  const exports = [];
  const exporter = {
    export(spans, callback) {
      exports.push(spans.map((span) => span.name));
      callback({ code: 0 });
    },
    shutdown: async () => {},
  };
  const processor = new RootBufferedTraceSpanProcessor(exporter);

  processor.onEnd(createSpan({
    traceId: "trace-1",
    spanId: "child-1",
    parentSpanId: "root-1",
    name: "session_processing",
    startTime: 2_000,
    endTime: 2_100,
  }));
  processor.onEnd(createSpan({
    traceId: "trace-1",
    spanId: "child-2",
    parentSpanId: "root-1",
    name: "llm",
    startTime: 2_100,
    endTime: 2_300,
  }));

  assert.equal(exports.length, 0);

  processor.onEnd(createSpan({
    traceId: "trace-1",
    spanId: "root-1",
    name: "openclaw_request",
    startTime: 1_900,
    endTime: 2_400,
  }));

  await processor.forceFlush();

  assert.equal(exports.length, 1);
  assert.deepEqual(exports[0], [
    "openclaw_request",
    "session_processing",
    "llm",
  ]);
});

test("RootBufferedTraceSpanProcessor forceFlush exports incomplete traces once", async () => {
  const exports = [];
  const exporter = {
    export(spans, callback) {
      exports.push(spans.map((span) => span.name));
      callback({ code: 0 });
    },
    shutdown: async () => {},
  };
  const processor = new RootBufferedTraceSpanProcessor(exporter);

  processor.onEnd(createSpan({
    traceId: "trace-2",
    spanId: "child-1",
    parentSpanId: "root-2",
    name: "session_processing",
    startTime: 2_000,
    endTime: 2_100,
  }));

  await processor.forceFlush();
  await processor.forceFlush();

  assert.deepEqual(exports, [["session_processing"]]);
});

test("RootBufferedTraceSpanProcessor exports buffered child attribute patches before root ends", async () => {
  const exports = [];
  const exporter = {
    export(spans, callback) {
      exports.push(spans);
      callback({ code: 0 });
    },
    shutdown: async () => {},
  };
  const processor = new RootBufferedTraceSpanProcessor(exporter);
  const child = createSpan({
    traceId: "trace-3",
    spanId: "child-1",
    parentSpanId: "root-3",
    name: "channel_ingress",
    startTime: 2_000,
    endTime: 2_050,
  });

  processor.onEnd(child);
  child.attributes.run_id = "run-3";

  processor.onEnd(createSpan({
    traceId: "trace-3",
    spanId: "root-3",
    name: "openclaw_request",
    startTime: 1_900,
    endTime: 2_400,
  }));

  await processor.forceFlush();

  assert.equal(exports.length, 1);
  const exportedChild = exports[0].find((span) => span.name === "channel_ingress");
  assert.equal(exportedChild.attributes.run_id, "run-3");
});
