import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { createSessionSnapshotStore } from "../dist/src/session-store.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-compressed-transcript-"));
  const dir = path.join(root, "agents/main/agent"); fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "openclaw-agent.sqlite"));
  db.exec(`CREATE TABLE session_nodes(session_key TEXT PRIMARY KEY, current_session_id TEXT, entry_json TEXT, updated_at INTEGER);
    CREATE TABLE transcript_events(session_id TEXT, seq INTEGER, event_json TEXT, event_zstd BLOB, PRIMARY KEY(session_id,seq));
    CREATE TABLE session_transcript_active_events(session_id TEXT,active_position INTEGER,event_seq INTEGER);`);
  db.prepare("INSERT INTO session_nodes VALUES(?,?,?,?)").run("agent:main:test", "session", "{}", 1000);
  let seq = 0;
  const write = (event, { compressed = false, active = true, corrupt = false } = {}) => {
    const raw = JSON.stringify(event), n = seq++;
    db.prepare("INSERT INTO transcript_events VALUES(?,?,?,?)").run("session", n,
      compressed ? null : raw, compressed ? corrupt ? Buffer.from("invalid zstd") : zstdCompressSync(Buffer.from(raw)) : null);
    if (active) db.prepare("INSERT INTO session_transcript_active_events VALUES(?,?,?)").run("session", n, n);
  };
  const user = (text, ts, runId, options) => write({ type: "message", timestamp: ts,
    message: { role: "user", content: text, idempotencyKey: `${runId}:user` } }, options);
  const assistant = (text, ts, options, usage) => write({ type: "message", timestamp: ts,
    message: { role: "assistant", provider: "fixture", model: "model", stopReason: "stop",
      content: [{ type: "text", text }], usage } }, options);
  const store = createSessionSnapshotStore(root); store.refreshSessionsIndex();
  return { root, db, store, user, assistant, snapshot: () => store.loadSessionSnapshot("agent:main:test"),
    close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("compressed user boundaries isolate a later request from historical model calls and delayed receipts", () => {
  const f = fixture(); try {
    f.user("old question", 1000, "old"); f.assistant("old answer", 2000, {}, { input: 90, output: 60 });
    f.user("Exec completed (fixture, code 0)", 2500, "receipt", { compressed: true });
    f.assistant("delayed receipt", 3000, {}, { input: 20, output: 10 });
    f.user("new question", 4000, "new", { compressed: true });
    f.assistant("new answer", 5000, { compressed: true }, { input: 7, output: 3 });
    const s = f.snapshot();
    assert.equal(s.lastUserText, "new question"); assert.equal(s.runId, "new");
    assert.equal(s.lastRunAssistantTurns.length, 1); assert.equal(s.lastRunAssistantTurns[0].startedAt, 4000);
    assert.equal(s.lastRunAssistantTurns[0].usage.output, 3);
    assert.equal(s.lastAssistantText, "new answer"); assert.equal(s.traceCount, 3);
  } finally { f.close(); }
});

test("the SQLite active branch excludes abandoned user and assistant records", () => {
  const f = fixture(); try {
    f.user("current question", 1000, "current", { compressed: true });
    f.assistant("current answer", 2000, {}, { input: 7, output: 3 });
    f.user("abandoned question", 3000, "abandoned", { active: false, compressed: true });
    f.assistant("abandoned answer", 4000, { active: false }, { input: 900, output: 800 });
    const s = f.snapshot(); assert.equal(s.runId, "current"); assert.equal(s.lastAssistantText, "current answer");
    assert.equal(s.lastRunAssistantTurns.length, 1); assert.equal(s.sessionUsageTotals.output, 3);
  } finally { f.close(); }
});

test("an empty active branch does not resurrect historical requests", () => {
  const f = fixture(); try {
    f.user("deleted question", 1000, "deleted", { active: false });
    f.assistant("deleted answer", 2000, { active: false });
    const s = f.snapshot(); assert.equal(s.lastUserText, undefined); assert.equal(s.lastAssistantText, undefined);
    assert.equal(s.runCompleted, false); assert.equal(s.lastRunAssistantTurns.length, 0);
  } finally { f.close(); }
});

test("an unreadable compressed boundary invalidates the snapshot rather than reusing a cached previous request", () => {
  const f = fixture(); try {
    f.user("old question", 1000, "old"); f.assistant("old answer", 2000);
    assert.equal(f.snapshot().lastAssistantText, "old answer");
    f.user("unreadable new question", 3000, "new", { compressed: true, corrupt: true });
    f.assistant("new answer", 4000);
    assert.equal(f.snapshot(), undefined);
  } finally { f.close(); }
});

test("a pending new request does not inherit the preceding answer, usage or completion", () => {
  const f = fixture(); try {
    f.user("old question", 1000, "old"); f.assistant("old answer", 2000, {}, { input: 70, output: 30 });
    f.store.setLatestAssistantText("agent:main:test", "previous live output");
    f.user("pending question", 3000, "pending", { compressed: true });
    const s = f.snapshot(); assert.equal(s.runId, "pending"); assert.equal(s.runCompleted, false);
    for (const k of ["lastAssistantText", "lastAssistantTs", "lastAssistantThinking", "lastAssistantUsage"]) assert.equal(s[k], undefined, k);
    assert.deepEqual(s.lastRunAssistantTurns, []);
  } finally { f.close(); }
});

test("modern contextUsage counts each call's complete input and cache without cumulative subtraction", () => {
  const f = fixture(); try {
    f.user("question", 1000, "run", { compressed: true });
    for (let i = 0; i < 2; i++) f.assistant("answer", 2000 + i * 1000, {}, {
      input: 10, output: 4, cacheRead: 100, cacheWrite: 0,
      contextUsage: { state: "available", promptTokens: 110, totalTokens: 114 },
    });
    const s = f.snapshot(); assert.equal(s.lastRunAssistantTurns.length, 2);
    for (const t of s.lastRunAssistantTurns) { assert.equal(t.usage.promptTokens, 110); assert.equal(t.usage.cacheRead, 100); }
    assert.equal(s.sessionUsageTotals.input, 220); assert.equal(s.sessionUsageTotals.cacheRead, 200);
    assert.equal(s.sessionUsageTotals.output, 8);
  } finally { f.close(); }
});

test("a failed external harness attempt leaves its logical run pending until fallback artifacts arrive", () => {
  const f = fixture(); try {
    f.db.exec("CREATE TABLE trajectory_runtime_events(session_id TEXT,seq INTEGER,run_id TEXT,event_json TEXT)");
    const event = (seq, type, data) => f.db.prepare("INSERT INTO trajectory_runtime_events VALUES(?,?,?,?)")
      .run("session", seq, "run", JSON.stringify({ runId: "run", type, ts: 1000 + seq * 100, sourceSeq: seq, data }));
    f.user("question", 1000, "run", { compressed: true });
    event(0, "session.started", {});event(1, "session.ended", { status: "error" });
    assert.equal(f.snapshot().runTerminalPending, true);assert.equal(f.snapshot().runCompleted, false);
    event(2, "session.started", {});f.assistant("fallback answer", 1500, {}, { input: 20, output: 5 });
    assert.equal(f.snapshot().runCompleted, false, "assistant.stop cannot end a pending harness run");
    event(6, "trace.artifacts", { finalStatus: "success" });
    const s = f.snapshot();assert.equal(s.runCompleted, true);assert.equal(s.runTerminalPending, false);
    assert.equal(s.runCompletedAt, 1600);assert.equal(s.runFinalStatus, "success");
    assert.equal(f.store.loadSessionRunState("agent:main:test", "run").runCompleted, true);
  } finally { f.close(); }
});

test("a standalone native error artifact and an external harness success are terminal", () => {
  const f = fixture(); try {
    f.db.exec("CREATE TABLE trajectory_runtime_events(session_id TEXT,seq INTEGER,run_id TEXT,event_json TEXT)");
    f.user("question", 1000, "run");
    const insert = f.db.prepare("INSERT INTO trajectory_runtime_events VALUES(?,?,?,?)");
    insert.run("session", 0, "run", JSON.stringify({runId:"run",type:"session.started",ts:1000}));
    insert.run("session", 1, "run", JSON.stringify({runId:"run",type:"trace.artifacts",ts:2000,data:{finalStatus:"error"}}));
    assert.equal(f.snapshot().runCompleted, true);assert.equal(f.snapshot().runFinalStatus, "error");
    insert.run("session", 2, "run", JSON.stringify({runId:"run",type:"session.started",ts:3000}));
    assert.equal(f.snapshot().runTerminalPending, true);
    insert.run("session", 3, "run", JSON.stringify({runId:"run",type:"session.ended",ts:4000,data:{status:"success"}}));
    assert.equal(f.snapshot().runCompleted, true);assert.equal(f.snapshot().runCompletedAt, 4000);
  } finally { f.close(); }
});
