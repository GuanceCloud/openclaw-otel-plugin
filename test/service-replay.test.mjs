import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import otlp from "@opentelemetry/otlp-transformer/build/src/generated/root.js";

const workerScenario = process.env.OPENCLAW_REPLAY_TEST_SCENARIO;
const invoke = promisify(execFile);

// Each worker has a real service, disk snapshots, OTel SDK and protobuf receiver.
// Only the host's diagnostic subscription and transcript notification are driven
// by the fixture so event ordering is deterministic without a live model.
if (!workerScenario) {
  async function run(scenario, stateDir) {
    const result = await invoke(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, OPENCLAW_REPLAY_TEST_SCENARIO: scenario,
        ...(stateDir ? { OPENCLAW_REPLAY_TEST_STATE: stateDir } : {}) },
    });
    return JSON.parse(result.stdout);
  }
  for (const scenario of ["queued-duplicate", "processing-duplicate", "transcript-before-native",
    "idle-before-native", "active-trajectory", "revised-terminal", "independent-turns"]) {
    test(`service replay ownership: ${scenario}`, { timeout: 15000 }, async () => {
      const result = await run(scenario);
      try {
        const expected = scenario === "independent-turns" ? 2 : 1;
        assert.equal(result.roots, expected, JSON.stringify(result));
        assert.equal(result.models, expected, JSON.stringify(result));
        assert.equal(result.nativeModels, expected, JSON.stringify(result));
        assert.equal(result.operationCount, expected, JSON.stringify(result));
        assert.equal(result.outputTokens, expected * 5, JSON.stringify(result));
        assert.equal(result.firstChunkCount, expected, JSON.stringify(result));
        assert.equal(result.perTokenCount, expected, JSON.stringify(result));
        assert.equal(result.zeroDurationRoots, 0, JSON.stringify(result));
        if (scenario === "revised-terminal") {
          const restarted = await run("restart-revised", result.stateDir);
          assert.equal(restarted.roots, 0, JSON.stringify(restarted));
          assert.equal(restarted.models, 0, JSON.stringify(restarted));
          assert.equal(restarted.operationCount, 0, JSON.stringify(restarted));
        }
      } finally { fs.rmSync(result.stateDir, { recursive: true, force: true }); }
    });
  }
} else {
  registerHooks({ resolve(specifier, context, next) {
    if (specifier === "openclaw/plugin-sdk/diagnostic-runtime") return {
      shortCircuit: true,
      url: "data:text/javascript,export function onInternalDiagnosticEvent(fn){globalThis.__replayTestDiagnostic=fn;return()=>{delete globalThis.__replayTestDiagnostic;};}",
    };
    return next(specifier, context);
  } });
  const { createOtelPluginService } = await import("../dist/src/service.js");
  const { resolveOtelPluginConfig } = await import("../dist/src/config.js");
  const proto = otlp.opentelemetry.proto;
  const stateDir = process.env.OPENCLAW_REPLAY_TEST_STATE
    ?? fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-service-replay-"));
  const dir = path.join(stateDir, "agents/main/sessions");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "test.jsonl"), trajectory = path.join(dir, "test.trajectory.jsonl");
  const sessionKey = "agent:main:replay-test", sessionId = "replay-session";
  const start = Date.now() - 500;
  const line = (value) => JSON.stringify(value) + "\n";
  if (workerScenario !== "restart-revised") {
    fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify({
      [sessionKey]: { sessionFile: file, sessionId, updatedAt: Date.now() },
    }));
    fs.writeFileSync(file, ""); fs.writeFileSync(trajectory, "");
  } else {
    const indexFile = path.join(dir, "sessions.json");
    const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
    index[sessionKey].updatedAt = Date.now();
    fs.writeFileSync(indexFile, JSON.stringify(index));
    fs.appendFileSync(file, line({ type: "message", timestamp: Date.now(), message: {
      role: "assistant", provider: "p", model: "m", stopReason: "stop",
      content: [{ type: "text", text: "late revised answer" }], usage: { input: 20, output: 5 },
    } }));
  }
  const batches = { traces: [], metrics: [] }, logs = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const kind = req.url === "/v1/traces" ? "traces" : req.url === "/v1/metrics" ? "metrics" : undefined;
    if (kind) {
      const type = kind === "traces" ? proto.collector.trace.v1.ExportTraceServiceRequest
        : proto.collector.metrics.v1.ExportMetricsServiceRequest;
      batches[kind].push(type.toObject(type.decode(Buffer.concat(chunks)), { longs: Number, enums: String }));
    }
    res.writeHead(200, { "content-type": "application/x-protobuf" }); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let transcriptUpdated;
  const service = createOtelPluginService(resolveOtelPluginConfig({
    endpoint: `http://127.0.0.1:${server.address().port}`, flushIntervalMs: 1000,
    tracePayloadDebugEnabled: true,
  }), { events: { onSessionTranscriptUpdate(listener) { transcriptUpdated = listener; return () => {}; } } });
  const event = async (value) => {
    globalThis.__replayTestDiagnostic({ sessionKey, sessionId, ...value });
    await new Promise((resolve) => setImmediate(resolve));
  };
  await service.start({ stateDir, logger: { info: (value) => logs.push(value), error: (value) => logs.push(value) } });
  try {
    if (workerScenario !== "restart-revised") {
      for (let index = 0; index < (workerScenario === "independent-turns" ? 2 : 1); index++) {
        const runId = `run-${index}`, ts = start + index * 300;
        fs.appendFileSync(trajectory, line({ type: "session.started", runId, sourceSeq: index * 10 + 1, ts }));
        fs.appendFileSync(file, line({ type: "message", timestamp: ts, message: {
          role: "user", content: "identical input", idempotencyKey: runId + ":user",
        } }));
        const queued = { type: "message.queued", ts, messageId: `message-${index}`, channel: "test" };
        const processing = { type: "session.state", ts: ts + 1, state: "processing", prevState: "idle", reason: "run_started" };
        if (workerScenario !== "processing-duplicate") await event(queued);
        await event(processing);
        await event({ type: "model.call.started", runId, callId: "call", ts: ts + 10, provider: "p", model: "m" });
        await event({ type: "run.progress", runId, reason: "model_call:stream_progress", ts: ts + 20 });
        const answer = (delta = 0, text = "answer") => {
          fs.appendFileSync(file, line({ type: "message", timestamp: ts + 100 + delta, message: {
            role: "assistant", provider: "p", model: "m", content: [{ type: "text", text }],
            stopReason: "stop", usage: { input: 20, output: 5 },
          } })); transcriptUpdated({ sessionFile: file });
        };
        const idle = { type: "session.state", ts: ts + 120, state: "idle", prevState: "processing", reason: "run_completed" };
        const earlyTranscript = ["transcript-before-native", "idle-before-native", "active-trajectory"].includes(workerScenario);
        if (earlyTranscript) answer();
        if (workerScenario === "idle-before-native") await event(idle);
        if (workerScenario === "active-trajectory") {
          fs.appendFileSync(trajectory, line({ type: "model.completed", runId, sourceSeq: 2, ts: ts + 100,
            provider: "p", modelId: "m", data: { assistantTexts: ["answer"], usage: { input: 20, output: 5 } } })
            + line({ type: "trace.artifacts", runId, sourceSeq: 3, ts: ts + 120, data: { finalStatus: "success" } }));
          await new Promise((resolve) => setTimeout(resolve, 1100));
        }
        await event({ type: "model.call.completed", runId, callId: "call", provider: "p", model: "m",
          ts: ts + 100, durationMs: 90, timeToFirstByteMs: 10, usage: { input: 20, output: 5 } });
        if (!earlyTranscript) answer();
        if (workerScenario !== "idle-before-native") await event(idle);
        if (workerScenario === "queued-duplicate") { await event(queued); await event(idle); }
        if (workerScenario === "processing-duplicate") { await event(processing); await event(idle); }
        if (workerScenario === "revised-terminal") answer(30, "late revised answer");
      }
    }
  } finally {
    await service.stop(); await new Promise((resolve) => server.close(resolve));
  }
  const spans = batches.traces.flatMap((b) => b.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
  const latest = new Map();
  for (const b of batches.metrics) for (const r of b.resourceMetrics) for (const s of r.scopeMetrics)
    for (const m of s.metrics) latest.set(m.name, m);
  const attrs = (p) => Object.fromEntries((p.attributes ?? []).map((a) => [a.key, a.value.stringValue]));
  const operationCount = (latest.get("gen_ai.agent.operation.count")?.sum.dataPoints ?? [])
    .reduce((n, p) => n + (p.asDouble ?? p.asInt ?? 0), 0);
  const outputTokens = (latest.get("gen_ai.client.token.usage")?.histogram.dataPoints ?? [])
    .filter((p) => attrs(p)["gen_ai.token.type"] === "output").reduce((n, p) => n + p.sum, 0);
  process.stdout.write(JSON.stringify({ stateDir, scenario: workerScenario,
    roots: spans.filter((s) => s.name === "invoke_agent").length,
    models: spans.filter((s) => s.name === "llm").length,
    nativeModels: logs.filter((l) => l.includes('"source":"native_model_span"')).length,
    operationCount, outputTokens,
    firstChunkCount: (latest.get("gen_ai.client.operation.time_to_first_chunk")?.histogram.dataPoints ?? [])
      .reduce((n, p) => n + p.count, 0),
    perTokenCount: (latest.get("gen_ai.client.operation.time_per_output_token")?.histogram.dataPoints ?? [])
      .reduce((n, p) => n + p.count, 0),
    zeroDurationRoots: spans.filter((s) => s.name === "invoke_agent" && s.endTimeUnixNano <= s.startTimeUnixNano).length,
  }));
}
