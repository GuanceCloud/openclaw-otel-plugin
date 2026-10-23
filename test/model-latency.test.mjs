import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import otlp from "@opentelemetry/otlp-transformer/build/src/generated/root.js";
import { createDiagnosticEventHandler } from "../dist/src/diagnostic-event-handler.js";
import { startOtelBootstrap } from "../dist/src/otel-bootstrap.js";
import { resolveOtelPluginConfig } from "../dist/src/config.js";

function harness(instruments) {
  const records = { first: [], token: [], count: [], usage: [] };
  const run = { runId: "run", ctx: {}, span: {}, mainStartTs: 1000 };
  const handler = createDiagnosticEventHandler({
    instruments: instruments ?? {
      genAiClientTimeToFirstChunk: { record: (...args) => records.first.push(args) },
      genAiClientTimePerOutputToken: { record: (...args) => records.token.push(args) },
      genAiAgentOperationCount: { add: (...args) => records.count.push(args) },
      genAiClientTokenUsage: { record: (...args) => records.usage.push(args) },
    },
    SpanStatusCode: { OK: 1, ERROR: 2 },
    cleanupExpiredRoots() {}, getRun: () => run, getRoot: () => undefined,
    enrichWithTranscript: (_key, attrs) => attrs,
    updateAggregateTokens() {}, emitModelTurnDebugLog() {},
    createChildSpan(_name, evt) {
      return { span: { setStatus() {}, end() {} }, effectiveDurationMs: evt.durationMs,
        startTime: new Date(evt.ts - evt.durationMs), endTime: new Date(evt.ts) };
    },
  });
  const call = { sessionKey: "session", sessionId: "sid", runId: "run", callId: "call",
    provider: "p", model: "m", ts: 2000, durationMs: 1000, timeToFirstByteMs: 200,
    usage: { input: 5, output: 101 } };
  const start = (extra = {}) => handler({ ...call, type: "model.call.started", ts: 1000, ...extra });
  const progress = (extra = {}) => handler({ ...call, type: "run.progress",
    reason: "model_call:stream_progress", ts: 1200, ...extra });
  const end = (extra = {}) => handler({ ...call, type: "model.call.completed", ...extra });
  return { handler, records, start, progress, end };
}

test("per-token estimate uses one successful streamed call and canonical low-cardinality tags", () => {
  const { records, start, progress, end } = harness();
  start(); progress(); end(); end();
  assert.deepEqual(records.token, [[0.008, {
    agent_runtime: "openclaw", operation_name: "chat", provider_name: "p", request_model: "m", status: "ok",
  }]]);
  assert.equal(records.first[0][0], 0.2);
  assert.equal(records.count.length, 1);
});

for (const extra of [
  { usage: undefined }, ...[0, 1, -1, 1.5, NaN, Infinity, "101"].map((output) => ({ usage: { output } })),
  ...[undefined, null, -1, NaN, Infinity, 1001, "200"].map((timeToFirstByteMs) => ({ timeToFirstByteMs })),
  ...[-1, NaN, Infinity].map((durationMs) => ({ durationMs })),
  { observationUnit: "turn" }, { type: "model.call.error" },
]) {
  test(`per-token estimate skips invalid or ineligible observations: ${JSON.stringify(extra)}`, () => {
    const { records, start, progress, end } = harness();
    start(); progress(); end(extra);
    assert.equal(records.token.length, 0);
  });
}

test("two output tokens use one interval, and first-chunk boundaries remain valid for observed streams", () => {
  for (const first of [0, 200, 1000]) {
    const { records, start, progress, end } = harness();
    start(); progress(); end({ timeToFirstByteMs: first, usage: { output: 2 } });
    assert.equal(records.token[0][0], (1000 - first) / 1000);
  }
});

test("unknown streaming paths and final-result-only calls never generate estimated zero latency", () => {
  for (const first of [200, 1000]) {
    const { records, start, end } = harness();
    start(); end({ timeToFirstByteMs: first });
    assert.equal(records.token.length, 0);
    assert.equal(records.first.length, 1);
    assert.equal(records.count.length, 1);
  }
});

test("progress must match the active call's session, run, reason and time window", () => {
  for (const extra of [{ sessionKey: "other" }, { runId: "other" }, { reason: "model_call:semantic_result" },
    { ts: 999 }, { ts: 2001 }, { ts: NaN }]) {
    const { records, start, progress, end } = harness();
    start(); progress(extra); end();
    assert.equal(records.token.length, 0);
  }
  const { records, progress, start, end } = harness();
  progress(); start(); end();
  assert.equal(records.token.length, 0);
});

test("overlapping calls cannot inherit each other's streaming evidence", () => {
  const { records, start, progress, end } = harness();
  start(); progress(); start({ callId: "overlap" }); progress();
  end(); progress(); end({ callId: "overlap" });
  assert.equal(records.token.length, 0);
  assert.equal(records.count.length, 2);
  start({ callId: "next" }); progress(); end({ callId: "next" });
  assert.equal(records.token.length, 1);
});

test("failed attempts do not pass stream evidence to retries, while all attempts retain metrics", () => {
  const { records, start, progress, end } = harness();
  start(); progress(); end({ type: "model.call.error" });
  start({ callId: "retry" }); end({ callId: "retry" });
  assert.equal(records.token.length, 0);
  start({ callId: "retry-stream" }); progress(); end({ callId: "retry-stream" });
  assert.equal(records.token.length, 1);
  assert.deepEqual(records.count.map(([, attrs]) => attrs.status), ["error", "ok", "ok"]);
  assert.equal(records.usage.length, 6);
});

test("reused call IDs retain every retry and duplicate old terminals cannot consume the next stream", () => {
  const { records, start, progress, end } = harness();
  start(); progress(); end({ type: "model.call.error" });
  start({ ts: 2100 });
  end({ type: "model.call.error" }); // Duplicate of the previous attempt.
  progress({ ts: 2400 });
  end({ ts: 3100, timeToFirstByteMs: 300 });
  end({ ts: 3100, timeToFirstByteMs: 300 });
  assert.deepEqual(records.count.map(([, attrs]) => attrs.status), ["error", "ok"]);
  assert.deepEqual(records.first.map(([value]) => value), [0.2, 0.3]);
  assert.deepEqual(records.token.map(([value]) => value), [0.007]);
  assert.equal(records.usage.length, 4);
});

test("missing first chunk skips only timing metrics; duplicates do not restore a second sample", () => {
  const { records, start, progress, end } = harness();
  start(); progress(); end({ timeToFirstByteMs: undefined }); end({ timeToFirstByteMs: undefined });
  assert.equal(records.token.length, 0);
  assert.equal(records.first.length, 0);
  assert.equal(records.count.length, 1);
  assert.equal(records.usage.length, 2);
});

test("stream tracking overflow skips uncertain samples without losing operation metrics", () => {
  const { records, start, progress, end } = harness();
  for (let index = 0; index <= 1000; index++) start({ callId: `call-${index}` });
  progress(); end();
  assert.equal(records.token.length, 0);
  assert.equal(records.count.length, 1);
});

test("native metric deduplication survives the per-run timing-cache limit", () => {
  const { records, end } = harness();
  for (let index = 0; index <= 1000; index++) end({ callId: `call-${index}`, timeToFirstByteMs: undefined });
  end({ callId: "call-1000", timeToFirstByteMs: undefined });
  assert.equal(records.count.length, 1001);
  assert.equal(records.usage.length, 2002);
});

test("expired stream evidence does not produce a latency estimate", (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const { records, start, progress, end } = harness();
  start(); progress();
  now += 60 * 60 * 1000;
  end();
  assert.equal(records.token.length, 0);
  assert.equal(records.count.length, 1);
});

test("derived and first-chunk histograms retain seconds, sum/count and buckets over OTLP", { timeout: 10000 }, async () => {
  const exported = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === "/otel/v1/metrics") {
      exported.push(otlp.opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest.decode(Buffer.concat(chunks)));
    }
    res.writeHead(200, { "content-type": "application/x-protobuf" });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let bootstrap;
  try {
    bootstrap = await startOtelBootstrap(resolveOtelPluginConfig({
      endpoint: `http://127.0.0.1:${server.address().port}/otel`, flushIntervalMs: 60000,
    }));
    const { start, progress, end } = harness(bootstrap.instruments);
    start(); progress(); end(); end();
    start({ callId: "second", ts: 2000 });
    progress({ ts: 2400 });
    end({ callId: "second", ts: 3000, timeToFirstByteMs: 400 });
    start({ callId: "failed", ts: 3000 });
    progress({ ts: 3200 });
    end({ callId: "failed", type: "model.call.error", ts: 4000 });
    await bootstrap.sdk.shutdown();
    bootstrap = undefined;
    const all = exported.flatMap((request) => request.resourceMetrics.flatMap((resource) =>
      resource.scopeMetrics.flatMap((scope) => scope.metrics)));
    const token = all.find((metric) => metric.name === "gen_ai.client.operation.time_per_output_token");
    assert.equal(token.unit, "s");
    assert.equal(token.histogram.dataPoints.length, 1);
    const point = token.histogram.dataPoints[0];
    assert.equal(Number(point.count), 2);
    assert.ok(Math.abs(point.sum - 0.014) < 1e-12);
    assert.equal(point.bucketCounts.reduce((total, count) => total + Number(count), 0), 2);
    assert.ok(point.explicitBounds.includes(0.005));
    const status = (point) => point.attributes.find((attr) => attr.key === "status")?.value.stringValue;
    assert.equal(status(point), "ok");
    const first = all.find((metric) => metric.name === "gen_ai.client.operation.time_to_first_chunk");
    const success = first.histogram.dataPoints.find((point) => status(point) === "ok");
    assert.ok(Math.abs(success.sum / Number(success.count) - 0.3) < 1e-12);
    assert.equal(Number(first.histogram.dataPoints.find((point) => status(point) === "error").count), 1);
    for (const metric of all) {
      for (const point of metric.histogram?.dataPoints ?? metric.sum?.dataPoints ?? []) {
        if (status(point) !== undefined) assert.ok(["ok", "error"].includes(status(point)));
      }
    }
  } finally {
    if (bootstrap) await bootstrap.sdk.shutdown();
    await new Promise((resolve) => server.close(resolve));
  }
});
