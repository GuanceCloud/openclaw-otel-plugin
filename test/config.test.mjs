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

test("resolveOtelPluginConfig accepts custom metrics and logs paths", () => {
  const config = resolveOtelPluginConfig({
    metricsPath: "/v1/write/otel-metrics/",
    logsPath: "/v1/write/otel-logs/",
  });

  assert.equal(config.metricsPath, "v1/write/otel-metrics");
  assert.equal(config.logsPath, "v1/write/otel-logs");
  assert.equal(config.logsEnabled, false);
});

test("resolveOtelPluginConfig keeps logs disabled by default and allows enabling it", () => {
  const disabledConfig = resolveOtelPluginConfig({});
  const enabledConfig = resolveOtelPluginConfig({
    logsEnabled: true,
  });

  assert.equal(disabledConfig.logsEnabled, false);
  assert.equal(enabledConfig.logsEnabled, true);
});
