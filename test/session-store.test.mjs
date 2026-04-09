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
});
