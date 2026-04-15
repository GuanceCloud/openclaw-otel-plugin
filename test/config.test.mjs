import test from "node:test";
import assert from "node:assert/strict";

import { resolveOtelPluginConfig } from "../dist/src/config.js";

test("resolveOtelPluginConfig uses openclaw as the default agent provider", () => {
  const config = resolveOtelPluginConfig({});

  assert.equal(config.agentProvider, "openclaw");
});

test("resolveOtelPluginConfig allows overriding the agent provider", () => {
  const config = resolveOtelPluginConfig({
    agentProvider: "custom-agent",
  });

  assert.equal(config.agentProvider, "custom-agent");
});

test("resolveOtelPluginConfig accepts fixed global tags", () => {
  const config = resolveOtelPluginConfig({
    globalTags: {
      team: "apm",
      enabled: true,
      priority: 3,
    },
  });

  assert.deepEqual(config.globalTags, {
    team: "apm",
    enabled: true,
    priority: 3,
  });
});

test("resolveOtelPluginConfig accepts otlp headers", () => {
  const config = resolveOtelPluginConfig({
    headers: {
      Authorization: " Bearer token ",
      "X-DataKit-UUID": "datakit-1",
      ignored: "",
      numeric: 1,
    },
  });

  assert.deepEqual(config.headers, {
    Authorization: "Bearer token",
    "X-DataKit-UUID": "datakit-1",
  });
});
