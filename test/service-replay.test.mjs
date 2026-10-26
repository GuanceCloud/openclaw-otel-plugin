import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
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
    "idle-before-native", "active-trajectory", "revised-terminal", "independent-turns",
    "sqlite-native", "sqlite-replay", "sqlite-empty-attempt", "sqlite-provider-fallback", "sqlite-provider-fallback-sweep", "sqlite-provider-fallback-artifact",
    "internal-review", "internal-review-id-only", "internal-effects"]) {
    test(`service replay ownership: ${scenario}`, { timeout: 15000 }, async () => {
      const result = await run(scenario);
      try {
        const expected = scenario === "independent-turns" ? 2 : 1;
        const failover = scenario.startsWith("sqlite-provider-fallback");
        const hiddenReview = scenario.startsWith("internal-review");
        const models = failover ? 5 : hiddenReview ? 4 : expected;
        assert.equal(result.roots, expected, JSON.stringify(result));
        assert.equal(result.models, models, JSON.stringify(result));
        const replayOnly = scenario === "sqlite-replay";
        assert.equal(result.nativeModels, replayOnly ? 0 : models, JSON.stringify(result));
        assert.equal(result.operationCount, failover ? 9 : models, JSON.stringify(result));
        assert.equal(result.outputTokens, failover ? 20 : models * 5, JSON.stringify(result));
        assert.equal(result.firstChunkCount, replayOnly ? 0 : models, JSON.stringify(result));
        assert.equal(result.perTokenCount, replayOnly ? 0 : failover ? 4 : models, JSON.stringify(result));
        assert.equal(result.zeroDurationRoots, 0, JSON.stringify(result));
        if (scenario.startsWith("internal-")) {
          const classification = { requestType: "internal_request", category: hiddenReview ? "skill_workshop_review" : "session_effects", internal: true };
          assert(result.classifications.every((value) => JSON.stringify(value) === JSON.stringify(classification)), JSON.stringify(result));
          assert.equal(result.assistants, hiddenReview ? 0 : 1, JSON.stringify(result));
          if (hiddenReview) {
            assert.equal(result.inputTokens, 80, JSON.stringify(result));
            assert.equal(result.hasCapturedContent, false, JSON.stringify(result));
            assert.deepEqual(result.modelDurationsMs, [3974, 4395, 5143, 38381], JSON.stringify(result));
            assert.equal(result.invalidModelOrToolParents, 0, JSON.stringify(result));
            assert.equal(result.invalidModelOrToolTimes, 0, JSON.stringify(result));
          } else {
            assert.deepEqual(result.rootInputs, ["identical input"], JSON.stringify(result));
            assert.deepEqual(result.rootOutputs, ["answer"], JSON.stringify(result));
          }
        }
        if (failover) {
          assert.equal(result.rootOutputs[0], "answer-3", JSON.stringify(result));
          assert.equal(result.primaryErrorOutput, undefined, JSON.stringify(result));
          assert.equal(result.inputTokens, 80, JSON.stringify(result));
          assert.equal(result.tools, 4, JSON.stringify(result));
          assert.deepEqual(result.operationStatuses, { error: 1, ok: 8 }, JSON.stringify(result));
          assert.equal(result.invalidModelOrToolParents, 0, JSON.stringify(result));
          assert.equal(result.invalidModelOrToolTimes, 0, JSON.stringify(result));
          assert.deepEqual(result.modelDurationsMs, [40, 40, 40, 40, 40], JSON.stringify(result));
        }
        if (scenario.startsWith("sqlite-")) {
          assert.deepEqual(result.rootInputs, ["identical input"], JSON.stringify(result));
          assert.equal(result.historicalModels, 0, JSON.stringify(result));
          assert.equal(result.oneMsModels, 0, JSON.stringify(result));
        }
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
  const hiddenReview = workerScenario.startsWith("internal-review"), internalEffects = workerScenario === "internal-effects";
  const sessionKey = hiddenReview ? "agent:main:internal-session-effects:skill-workshop-review_fixture-hash"
    : internalEffects ? "agent:main:internal-session-effects:fixture" : "agent:main:replay-test";
  const sessionId = hiddenReview ? "internal-session-effects-skill-workshop-review_fixture-hash" : "replay-session";
  const start = Date.now() - (hiddenReview ? 60000 : 500);
  const line = (value) => JSON.stringify(value) + "\n";
  if (workerScenario !== "restart-revised") {
    fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify(hiddenReview ? {} : {
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
  const sqliteMode = workerScenario.startsWith("sqlite-");
  let database, sequence = 0;
  const writeMessage = (value) => {
    fs.appendFileSync(file, line(value));
    if (database) {
      const raw = JSON.stringify(value), compressed = value.message?.role === "user";
      database.prepare("INSERT INTO transcript_events VALUES(?,?,?,?)").run(sessionId, sequence,
        compressed ? null : raw, compressed ? zstdCompressSync(Buffer.from(raw)) : null);
      database.prepare("INSERT INTO session_transcript_active_events VALUES(?,?,?)").run(sessionId, sequence, sequence);
      sequence++;
    }
  };
  if (sqliteMode) {
    const dbDir = path.join(stateDir, "agents/main/agent"); fs.mkdirSync(dbDir, { recursive: true });
    database = new DatabaseSync(path.join(dbDir, "openclaw-agent.sqlite"));
    database.exec(`CREATE TABLE session_nodes(session_key TEXT,current_session_id TEXT,entry_json TEXT,updated_at INTEGER);
      CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT,event_zstd BLOB);
      CREATE TABLE session_transcript_active_events(session_id TEXT,active_position INTEGER,event_seq INTEGER);`);
    database.prepare("INSERT INTO session_nodes VALUES(?,?,?,?)").run(sessionKey, sessionId, "{}", start);
    writeMessage({ type: "message", timestamp: start - 3600000,
      message: { role: "user", content: "historical question", idempotencyKey: "historical:user" } });
    for (let i = 0; i < 3; i++) writeMessage({ type: "message", timestamp: start - 3500000 + i * 100,
      message: { role: "assistant", content: [{ type: "text", text: "historical answer" }],
        provider: "p", model: "m", stopReason: "stop", usage: { input: 100, output: 50 } } });
    const replayDir = path.join(stateDir, "plugins/openclaw-otel-plugin"); fs.mkdirSync(replayDir, { recursive: true });
    fs.writeFileSync(path.join(replayDir, "replay-finalization-state.json"), JSON.stringify({ version: 1,
      sessions: { [sessionKey]: { finalizedRunIds: ["historical"], updatedAt: start } } }));
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
  let transcriptUpdated, agentEvent;
  const service = createOtelPluginService(resolveOtelPluginConfig({
    endpoint: `http://127.0.0.1:${server.address().port}`, flushIntervalMs: 1000,
    tracePayloadDebugEnabled: true,
  }), { events: { onAgentEvent(listener) { agentEvent = listener; return () => {}; }, onSessionTranscriptUpdate(listener) { transcriptUpdated = listener; return () => {}; } } });
  const event = async (value) => {
    globalThis.__replayTestDiagnostic({ ...(workerScenario === "internal-review-id-only" ? {} : { sessionKey }), sessionId, ...value });
    await new Promise((resolve) => setImmediate(resolve));
  };
  await service.start({ stateDir, logger: { info: (value) => logs.push(value), error: (value) => logs.push(value) } });
  try {
    if (hiddenReview) {
      const runId = "skill-workshop-review:fixture";
      await event({ type: "session.state", runId, ts: start, state: "processing", prevState: "idle", reason: "run_started" });
      let ts = start + 220;
      for (const [i, durationMs] of [5143, 3974, 38381, 4395].entries()) {
        const callId = `${runId}:model:${i + 1}`;
        await event({ type: "model.call.started", runId, callId, ts, provider: "p", model: "m" });
        await event({ type: "run.progress", runId, ts: ts + 100, reason: "model_call:stream_progress" });
        ts += durationMs;
        await event({ type: "model.call.completed", runId, callId, ts, provider: "p", model: "m",
          durationMs, timeToFirstByteMs: 100, usage: { input: 20, output: 5 } });
        ts += 500;
      }
      await event({ type: "session.state", runId, ts, state: "idle", prevState: "processing", reason: "run_completed" });
    } else if (workerScenario !== "restart-revised") {
      for (let index = 0; index < (workerScenario === "independent-turns" ? 2 : 1); index++) {
        const runId = `run-${index}`, ts = start + index * 300;
        fs.appendFileSync(trajectory, line({ type: "session.started", runId, sourceSeq: index * 10 + 1, ts }));
        writeMessage({ type: "message", timestamp: ts, message: {
          role: "user", content: "identical input", idempotencyKey: runId + ":user",
        } });
        const queued = { type: "message.queued", ts, messageId: `message-${index}`, channel: "test" };
        const processing = { type: "session.state", ts: ts + 1, state: "processing", prevState: "idle", reason: "run_started" };
        if (workerScenario !== "processing-duplicate") await event(queued);
        await event(processing);
        if (workerScenario.startsWith("sqlite-provider-fallback")) {
          database.exec("CREATE TABLE trajectory_runtime_events(session_id TEXT,seq INTEGER,run_id TEXT,event_json TEXT)");
          let trajectorySeq = 0;
          const state = (type, time, data = {}) => database.prepare("INSERT INTO trajectory_runtime_events VALUES(?,?,?,?)")
            .run(sessionId, trajectorySeq++, runId, JSON.stringify({ type, runId, ts: time, sourceSeq: trajectorySeq, data }));
          state("session.started", ts + 1);
          await event({ type: "model.call.started", ts: ts + 10, runId, callId: "primary", provider: "primary", model: "unsupported" });
          state("session.ended", ts + 51, { status: "error" });
          if (workerScenario.endsWith("-artifact")) state("trace.artifacts", ts + 51, { finalStatus: "error" });
          await event({ type: "model.call.error", ts: ts + 50, runId, callId: "primary", provider: "primary", model: "unsupported",
            durationMs: 40, timeToFirstByteMs: 10, observationUnit: "turn", usage: { input: 0, output: 0 } });
          agentEvent({ sessionKey, sessionId, runId, stream: "assistant", ts: ts + 51, data: { text: "historical answer" } });
          if (!workerScenario.endsWith("-artifact")) await event({ type: "session.state", ts: ts + 52, state: "idle", prevState: "processing", reason: "run_completed" });
          await new Promise((resolve) => setTimeout(resolve, 1100));
          state("session.started", ts + 80);
          await event({ ...processing, ts: ts + 80 });
          let toolIndex = 0;
          for (let call = 0; call < 4; call++) {
            const callStart = ts + 100 + call * 100, callId = `${runId}:model:${call + 1}`;
            await event({ type: "model.call.started", ts: callStart, runId, callId, provider: "backup", model: "model" });
            await event({ type: "run.progress", ts: callStart + 10, runId, reason: "model_call:stream_progress" });
            writeMessage({ type: "message", timestamp: callStart + 39, message: { role: "assistant", provider: "backup", model: "model",
              content: [{ type: "text", text: `answer-${call}` }], stopReason: call === 3 ? "stop" : "toolUse", usage: { input: 20, output: 5 } } });
            await event({ type: "model.call.completed", ts: callStart + 40, runId, callId, provider: "backup", model: "model",
              durationMs: 40, timeToFirstByteMs: 10, usage: { input: 20, output: 5 } });
            for (let tool = 0; tool < (call === 0 ? 2 : call < 3 ? 1 : 0); tool++) {
              const toolCallId = `tool-${toolIndex++}`;
              for (const [phase, delta] of [["start", 45], ["result", 55]]) agentEvent({ sessionKey, sessionId, runId, ts: callStart + delta,
                stream: "tool", data: { name: "exec", toolCallId, phase, args: { command: "fixture" }, result: phase === "result" ? "done" : undefined } });
            }
          }
          if (workerScenario.endsWith("-sweep")) {
            await event({ type: "session.state", ts: ts + 450, state: "idle", prevState: "processing", reason: "run_completed" });
          }
          state("trace.artifacts", ts + 460, { finalStatus: "success" });
          if (workerScenario.endsWith("-sweep")) await new Promise((resolve) => setTimeout(resolve, 1100));
          else await event({ type: "session.state", ts: ts + 460, state: "idle", prevState: "processing", reason: "run_completed" });
          continue;
        }
        if (workerScenario === "sqlite-empty-attempt") {
          await event({ type: "session.state", ts: ts + 2, state: "idle", prevState: "processing", reason: "run_completed" });
          await event({ ...processing, ts: ts + 4 });
        }
        if (workerScenario !== "sqlite-replay") await event({ type: "model.call.started", runId, callId: "call", ts: ts + 10, provider: "p", model: "m" });
        await event({ type: "run.progress", runId, reason: "model_call:stream_progress", ts: ts + 20 });
        const answer = (delta = 0, text = "answer") => {
          writeMessage({ type: "message", timestamp: ts + 100 + delta, message: {
            role: "assistant", provider: "p", model: "m", content: [{ type: "text", text }],
            stopReason: "stop", usage: { input: 20, output: 5 },
          } }); transcriptUpdated({ sessionFile: file });
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
        if (workerScenario !== "sqlite-replay") await event({ type: "model.call.completed", runId, callId: "call", provider: "p", model: "m",
          ts: ts + 100, durationMs: 90, timeToFirstByteMs: 10, usage: { input: 20, output: 5 } });
        if (!earlyTranscript) answer();
        if (workerScenario !== "idle-before-native") await event(idle);
        if (workerScenario === "queued-duplicate") { await event(queued); await event(idle); }
        if (workerScenario === "processing-duplicate") { await event(processing); await event(idle); }
        if (workerScenario === "revised-terminal") answer(30, "late revised answer");
      }
    }
  } finally {
    await service.stop(); database?.close(); await new Promise((resolve) => server.close(resolve));
  }
  const spans = batches.traces.flatMap((b) => b.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
  const latest = new Map();
  for (const b of batches.metrics) for (const r of b.resourceMetrics) for (const s of r.scopeMetrics)
    for (const m of s.metrics) latest.set(m.name, m);
  const attrs = (p) => Object.fromEntries((p.attributes ?? []).map((a) => [a.key, Object.values(a.value)[0]]));
  const operationCount = (latest.get("gen_ai.agent.operation.count")?.sum.dataPoints ?? [])
    .reduce((n, p) => n + (p.asDouble ?? p.asInt ?? 0), 0);
  const outputTokens = (latest.get("gen_ai.client.token.usage")?.histogram.dataPoints ?? [])
    .filter((p) => attrs(p)["gen_ai.token.type"] === "output").reduce((n, p) => n + p.sum, 0);
  const inputTokens = (latest.get("gen_ai.client.token.usage")?.histogram.dataPoints ?? [])
    .filter((p) => attrs(p)["gen_ai.token.type"] === "input").reduce((n, p) => n + p.sum, 0);
  const operationStatuses = {};
  for (const point of latest.get("gen_ai.agent.operation.count")?.sum.dataPoints ?? []) {
    const status = attrs(point).status;
    operationStatuses[status] = (operationStatuses[status] ?? 0) + (point.asDouble ?? point.asInt ?? 0);
  }
  const roots = spans.filter((s) => s.name === "invoke_agent");
  const operations = spans.filter((s) => s.name === "llm" || s.name.startsWith("tool:"));
  const id = (value) => Buffer.from(value ?? []).toString("hex");
  const parent = (span) => roots.find((root) => id(root.spanId) === id(span.parentSpanId) && id(root.traceId) === id(span.traceId));
  const invalidTimes = operations.filter((span) => {
    const root = parent(span);
    return root && (span.startTimeUnixNano < root.startTimeUnixNano || span.endTimeUnixNano > root.endTimeUnixNano
      || span.endTimeUnixNano <= span.startTimeUnixNano);
  }).map((span) => ({ name: span.name, start: span.startTimeUnixNano, end: span.endTimeUnixNano,
    rootStart: parent(span).startTimeUnixNano, rootEnd: parent(span).endTimeUnixNano }));
  process.stdout.write(JSON.stringify({ stateDir, scenario: workerScenario,
    classifications: spans.map((s) => ({ requestType: attrs(s).request_type, category: attrs(s).request_category, internal: attrs(s).is_internal_request })),
    assistants: spans.filter((s) => s.name === "assistant").length,
    hasCapturedContent: spans.some((s) => ["input_preview", "output_preview", "gen_ai.input.messages", "gen_ai.output.messages"].some((k) => attrs(s)[k] !== undefined)),
    inputTokens, operationStatuses,
    tools: spans.filter((s) => s.name.startsWith("tool:")).length,
    modelDurationsMs: spans.filter((s) => s.name === "llm").map((s) => Math.round((s.endTimeUnixNano - s.startTimeUnixNano) / 1000000)).sort((a, b) => a - b),
    invalidModelOrToolParents: operations.filter((span) => !parent(span)).length,
    invalidModelOrToolTimes: invalidTimes.length, invalidTimes,
    roots: spans.filter((s) => s.name === "invoke_agent").length,
    rootOutputs: spans.filter((s) => s.name === "invoke_agent").map((s) => attrs(s).output_preview),
    primaryErrorOutput: spans.filter((s) => s.name === "llm" && attrs(s).provider_name === "primary").map((s) => attrs(s).output_preview)[0],
    rootInputs: spans.filter((s) => s.name === "invoke_agent").map((s) => attrs(s).input_preview),
    historicalModels: spans.filter((s) => s.name === "llm" && attrs(s).output_preview === "historical answer").length,
    oneMsModels: spans.filter((s) => s.name === "llm" && s.endTimeUnixNano - s.startTimeUnixNano <= 1000000).length,
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
