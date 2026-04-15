import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveRuntimeMetadata } from "../dist/src/session-store.js";

test("resolveRuntimeMetadata reads runtime environment and agent name from sessions index", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-meta-"));
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, "sessions.json"),
    JSON.stringify({
      "agent:main:feishu:direct:ou_8f4b1d1bb3cd1cedf6003669dea4b2bf": {
        sessionId: "s1",
        sessionFile: "/tmp/s1.jsonl",
      },
    }),
  );

  const metadata = resolveRuntimeMetadata(stateDir);

  assert.equal(metadata.runtimeEnvironment, "main");
  assert.equal(metadata.agentName, "feishu");
  assert.ok(typeof metadata.openclawVersion === "string" && metadata.openclawVersion.length > 0);
});
