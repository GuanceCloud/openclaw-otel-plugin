import test from "node:test";
import assert from "node:assert/strict";

import { resolveOtelPluginConfig } from "../dist/src/config.js";

test("resolveOtelPluginConfig keeps openclaw as the default GenAI agent runtime resource attribute", () => {
  const config = resolveOtelPluginConfig({});

  assert.deepEqual(config.resourceAttributes, {
    "gen_ai.agent_runtime": "openclaw",
  });
});

test("resolveOtelPluginConfig folds globalTags into resourceAttributes", () => {
  const config = resolveOtelPluginConfig({
    globalTags: {
      team: "apm",
      enabled: true,
      priority: 3,
    },
  });

  assert.deepEqual(config.resourceAttributes, {
    "gen_ai.agent_runtime": "openclaw",
    team: "apm",
    enabled: true,
    priority: 3,
  });
});

test("resolveOtelPluginConfig lets resourceAttributes override default runtime fields", () => {
  const config = resolveOtelPluginConfig({
    globalTags: {
      team: "apm",
      agent_name: "legacy-agent",
    },
    resourceAttributes: {
      team: "platform",
      agent_runtime: "hermes",
      agent_name: "fixed-agent",
      agent_id: "agent-01",
    },
  });

  assert.deepEqual(config.resourceAttributes, {
    "gen_ai.agent_runtime": "hermes",
    "gen_ai.agent_name": "fixed-agent",
    "gen_ai.agent_id": "agent-01",
    team: "platform",
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

test("resolveOtelPluginConfig uses 30s as the default metrics export interval", () => {
  const config = resolveOtelPluginConfig({});

  assert.equal(config.flushIntervalMs, 30000);
});

test("resolveOtelPluginConfig keeps trace payload debug off by default and accepts trace filters", () => {
  const disabledConfig = resolveOtelPluginConfig({});
  const enabledConfig = resolveOtelPluginConfig({
    tracePayloadDebugEnabled: true,
    tracePayloadDebugTraceIds: [
      "41be47bf1ca76b47b61c29d60a264141",
      " ",
      1,
      "f91670351eda5ece35abcba411ee1a75",
    ],
  });

  assert.equal(disabledConfig.tracePayloadDebugEnabled, false);
  assert.equal(disabledConfig.tracePayloadDebugTraceIds, undefined);
  assert.equal(enabledConfig.tracePayloadDebugEnabled, true);
  assert.deepEqual(enabledConfig.tracePayloadDebugTraceIds, [
    "41be47bf1ca76b47b61c29d60a264141",
    "f91670351eda5ece35abcba411ee1a75",
  ]);
});
