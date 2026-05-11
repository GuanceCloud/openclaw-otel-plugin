import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSessionSnapshotStore } from "../dist/src/session-store.js";

test("session store reads sessions index from agents/main and extracts invoked skills", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-otel-plugin-"));
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  const workspaceSkillsDir = path.join(stateDir, "workspace", "skills");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceSkillsDir, "monitor"), { recursive: true });
  fs.mkdirSync(path.join(workspaceSkillsDir, "dql"), { recursive: true });

  const sessionFile = path.join(sessionsDir, "s1.jsonl");
  fs.writeFileSync(
    path.join(sessionsDir, "sessions.json"),
    JSON.stringify({
      s1: {
        sessionFile,
        sessionId: "session-1",
        skillsSnapshot: {
          resolvedSkills: [
            { name: "monitor", description: "生成监控器" },
            { name: "dql", description: "校验 DQL" },
          ],
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(workspaceSkillsDir, "monitor", "SKILL.md"),
    "---\nname: monitor\ndescription: 生成监控器\n---\n",
  );
  fs.writeFileSync(
    path.join(workspaceSkillsDir, "dql", "SKILL.md"),
    "---\nname: dql\ndescription: 校验 DQL\n---\n",
  );

  const lines = [
    {
      type: "session",
      cwd: "/home/liurui/.openclaw/workspace",
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-monitor",
            name: "read",
            arguments: {
              path: "~/.openclaw/workspace/skills/monitor/SKILL.md",
            },
          },
          {
            type: "toolCall",
            id: "call-dql",
            name: "exec",
            arguments: {
              command: "cd /home/liurui/.openclaw/workspace/skills/dql && ./bin/dqlcheck --file /tmp/demo.dql",
            },
          },
        ],
      },
    },
  ];
  fs.writeFileSync(
    sessionFile,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );

  const store = createSessionSnapshotStore(stateDir);
  store.refreshSessionsIndex();
  const snapshot = store.loadSessionSnapshot("s1");

  assert.ok(snapshot);
  assert.deepEqual(snapshot.invokedSkillNames?.sort(), ["dql", "monitor"]);
  assert.deepEqual(snapshot.toolCallSkillNamesById, {
    "call-monitor": "monitor",
    "call-dql": "dql",
  });
  assert.deepEqual(snapshot.lastRunAssistantTurns, [
    {
      startedAt: undefined,
      endedAt: undefined,
      provider: undefined,
      model: undefined,
      inputPreview: undefined,
      thinking: undefined,
      text: undefined,
      outputPreview: "toolCall:read,exec",
      outputKind: "tool_call",
    },
  ]);
});

test("session store keeps invoked skills scoped to the latest run only", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-otel-plugin-"));
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  const workspaceSkillsDir = path.join(stateDir, "workspace", "skills");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceSkillsDir, "dashboard"), { recursive: true });

  const sessionFile = path.join(sessionsDir, "s1b.jsonl");
  fs.writeFileSync(
    path.join(sessionsDir, "sessions.json"),
    JSON.stringify({
      s1b: {
        sessionFile,
        sessionId: "session-1b",
        skillsSnapshot: {
          resolvedSkills: [
            { name: "dashboard", description: "生成观测云 Dashboard" },
          ],
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(workspaceSkillsDir, "dashboard", "SKILL.md"),
    "---\nname: dashboard\ndescription: 生成观测云 Dashboard\n---\n",
  );

  const lines = [
    {
      type: "message",
      timestamp: "2026-05-08T09:00:00.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "做个 dashboard" }],
      },
    },
    {
      type: "message",
      timestamp: "2026-05-08T09:00:05.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-dashboard",
            name: "write",
            arguments: {
              path: "/home/liurui/dashboard/mysql.json",
            },
          },
        ],
      },
    },
    {
      type: "message",
      timestamp: "2026-05-08T09:01:00.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "古风美文美句10条" }],
      },
    },
    {
      type: "message",
      timestamp: "2026-05-08T09:01:10.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "第一句，山中何事，松花酿酒。" }],
      },
    },
  ];
  fs.writeFileSync(
    sessionFile,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );

  const store = createSessionSnapshotStore(stateDir);
  store.refreshSessionsIndex();
  const snapshot = store.loadSessionSnapshot("s1b");

  assert.ok(snapshot);
  assert.deepEqual(snapshot.invokedSkillNames, []);
  assert.deepEqual(snapshot.toolCallSkillNamesById, {});
  assert.deepEqual(snapshot.lastRunAssistantTurns, [
    {
      startedAt: Date.parse("2026-05-08T09:01:00.000Z"),
      endedAt: Date.parse("2026-05-08T09:01:10.000Z"),
      provider: undefined,
      model: undefined,
      inputPreview: "古风美文美句10条",
      thinking: undefined,
      text: "第一句，山中何事，松花酿酒。",
      outputPreview: "第一句，山中何事，松花酿酒。",
      outputKind: "text",
    },
  ]);
});

test("session store aggregates session token totals and trace count", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-otel-plugin-"));
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  const sessionFile = path.join(sessionsDir, "s2.jsonl");
  fs.writeFileSync(
    path.join(sessionsDir, "sessions.json"),
    JSON.stringify({
      s2: {
        sessionFile,
        sessionId: "session-2",
        modelProvider: "doubao",
        model: "ark-code-latest",
      },
    }),
  );
  const lines = [
    {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "first" }],
        timestamp: 1000,
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        timestamp: 1300,
        usage: {
          input: 11,
          output: 7,
          cacheRead: 2,
          cacheWrite: 1,
          totalTokens: 18,
        },
      },
    },
    {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "second" }],
        timestamp: 2000,
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        timestamp: 2600,
        usage: {
          input: 13,
          output: 5,
          totalTokens: 18,
        },
      },
    },
  ];
  fs.writeFileSync(
    sessionFile,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );

  const store = createSessionSnapshotStore(stateDir);
  store.refreshSessionsIndex();
  const snapshot = store.loadSessionSnapshot("s2");

  assert.ok(snapshot);
  assert.deepEqual(snapshot.sessionUsageTotals, {
    input: 24,
    output: 12,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: 36,
  });
  assert.equal(snapshot.traceCount, 2);
  assert.equal(snapshot.lastUserTs, 2000);
  assert.equal(snapshot.lastAssistantTs, 2600);
  assert.deepEqual(snapshot.lastRunAssistantTurns, [
    {
      startedAt: 2000,
      endedAt: 2600,
      provider: undefined,
      model: undefined,
      inputPreview: "second",
      thinking: undefined,
      text: undefined,
      outputPreview: undefined,
      outputKind: undefined,
    },
  ]);
  assert.deepEqual(snapshot.lastAssistantUsage, {
    input: 13,
    output: 5,
    cacheRead: undefined,
    cacheWrite: undefined,
    totalTokens: 18,
  });
});

test("session store derives cumulative total tokens from input and output when transcript totalTokens is a context snapshot", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-otel-plugin-"));
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  const sessionFile = path.join(sessionsDir, "s2-context-total.jsonl");
  fs.writeFileSync(
    path.join(sessionsDir, "sessions.json"),
    JSON.stringify({
      s2c: {
        sessionFile,
        sessionId: "session-2c",
      },
    }),
  );
  const lines = [
    {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "first" }],
        timestamp: 1000,
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        timestamp: 1300,
        usage: {
          input: 11,
          output: 7,
          totalTokens: 1800,
        },
      },
    },
    {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "second" }],
        timestamp: 2000,
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        timestamp: 2600,
        usage: {
          input: 13,
          output: 5,
          totalTokens: 2400,
        },
      },
    },
  ];
  fs.writeFileSync(
    sessionFile,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );

  const store = createSessionSnapshotStore(stateDir);
  store.refreshSessionsIndex();
  const snapshot = store.loadSessionSnapshot("s2c");

  assert.ok(snapshot);
  assert.deepEqual(snapshot.sessionUsageTotals, {
    input: 24,
    output: 12,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 36,
  });
  assert.deepEqual(snapshot.lastAssistantUsage, {
    input: 13,
    output: 5,
    cacheRead: undefined,
    cacheWrite: undefined,
    totalTokens: 2400,
  });
});

test("session store prefers line timestamps for assistant turns", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-otel-plugin-"));
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  const sessionFile = path.join(sessionsDir, "s3.jsonl");
  fs.writeFileSync(
    path.join(sessionsDir, "sessions.json"),
    JSON.stringify({
      s3: {
        sessionFile,
        sessionId: "session-3",
      },
    }),
  );

  const lines = [
    {
      type: "message",
      timestamp: "2026-05-07T04:57:01.370Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "中国股市下午资金动向" }],
        timestamp: 1778129821366,
      },
    },
    {
      type: "message",
      timestamp: "2026-05-07T04:57:10.380Z",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "先搜索资金流向" }],
        timestamp: 1778129821377,
      },
    },
  ];
  fs.writeFileSync(
    sessionFile,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );

  const store = createSessionSnapshotStore(stateDir);
  store.refreshSessionsIndex();
  const snapshot = store.loadSessionSnapshot("s3");

  assert.ok(snapshot);
  assert.equal(snapshot.lastUserTs, Date.parse("2026-05-07T04:57:01.370Z"));
  assert.equal(snapshot.lastAssistantTs, Date.parse("2026-05-07T04:57:10.380Z"));
  assert.deepEqual(snapshot.lastRunAssistantTurns, [
    {
      startedAt: Date.parse("2026-05-07T04:57:01.370Z"),
      endedAt: Date.parse("2026-05-07T04:57:10.380Z"),
      provider: undefined,
      model: undefined,
      inputPreview: "中国股市下午资金动向",
      thinking: "先搜索资金流向",
      text: undefined,
      outputPreview: undefined,
      outputKind: undefined,
    },
  ]);
});

test("session store reads session create time from trajectory", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-otel-plugin-"));
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  const sessionFile = path.join(sessionsDir, "s4.jsonl");
  const trajectoryFile = path.join(sessionsDir, "s4.trajectory.jsonl");
  fs.writeFileSync(
    path.join(sessionsDir, "sessions.json"),
    JSON.stringify({
      s4: {
        sessionFile,
        sessionId: "session-4",
      },
    }),
  );
  fs.writeFileSync(
    trajectoryFile,
    `${JSON.stringify({
      type: "session.started",
      ts: "2026-05-07T05:49:08.061Z",
    })}\n`,
  );
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "message",
      timestamp: "2026-05-07T05:49:08.112Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    })}\n`,
  );

  const store = createSessionSnapshotStore(stateDir);
  store.refreshSessionsIndex();
  const snapshot = store.loadSessionSnapshot("s4");

  assert.ok(snapshot);
  assert.equal(snapshot.createdAt, Date.parse("2026-05-07T05:49:08.061Z"));
});
