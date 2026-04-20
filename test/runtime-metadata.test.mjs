import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveConfiguredAgents, resolveRuntimeMetadata } from "../dist/src/session-store.js";

test("resolveRuntimeMetadata reads runtime environment and agent name from the active agent directory", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-meta-"));
  const sessionsDir = path.join(stateDir, "agents", "coder", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify({
      agents: {
        list: [
          {
            id: "coder",
            name: "Coder Agent",
          },
        ],
      },
    }),
  );
  fs.writeFileSync(
    path.join(sessionsDir, "sessions.json"),
    JSON.stringify({
      "agent:coder:main": {
        sessionId: "s1",
        sessionFile: "/tmp/s1.jsonl",
      },
    }),
  );

  const metadata = resolveRuntimeMetadata(stateDir);

  assert.equal(metadata.runtimeEnvironment, "main");
  assert.equal(metadata.agentId, "coder");
  assert.equal(metadata.agentName, "Coder Agent");
  assert.ok(typeof metadata.openclawVersion === "string" && metadata.openclawVersion.length > 0);
});

test("resolveRuntimeMetadata does not pin agent_name when multiple agent directories exist", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-meta-multi-"));
  const mainSessionsDir = path.join(stateDir, "agents", "main", "sessions");
  const coderSessionsDir = path.join(stateDir, "agents", "coder", "sessions");
  fs.mkdirSync(mainSessionsDir, { recursive: true });
  fs.mkdirSync(coderSessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(mainSessionsDir, "sessions.json"),
    JSON.stringify({
      "agent:main:main": {
        sessionId: "s1",
        sessionFile: "/tmp/main.jsonl",
      },
    }),
  );
  fs.writeFileSync(
    path.join(coderSessionsDir, "sessions.json"),
    JSON.stringify({
      "agent:coder:main": {
        sessionId: "s2",
        sessionFile: "/tmp/coder.jsonl",
      },
    }),
  );

  const metadata = resolveRuntimeMetadata(stateDir);

  assert.equal(metadata.agentId, undefined);
  assert.equal(metadata.agentName, undefined);
  assert.equal(metadata.runtimeEnvironment, undefined);
  assert.ok(typeof metadata.openclawVersion === "string" && metadata.openclawVersion.length > 0);
});

test("resolveConfiguredAgents reads ids and names from openclaw.json", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-config-"));
  fs.writeFileSync(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify({
      agents: {
        list: [
          { id: "main", name: "智能路由", default: true },
          { id: "coder", name: "coder" },
        ],
      },
    }),
  );

  assert.deepEqual(resolveConfiguredAgents(stateDir), [
    { id: "main", name: "智能路由", isDefault: true },
    { id: "coder", name: "coder", isDefault: false },
  ]);
});
