import test from "node:test";
import assert from "node:assert/strict";

import { resolveOtelPluginConfig } from "../dist/src/config.js";

test("resolveOtelPluginConfig keeps openclaw as the default agent_provider resource attribute", () => {
  const config = resolveOtelPluginConfig({});

  assert.deepEqual(config.resourceAttributes, {
    agent_provider: "openclaw",
  });
});

test("resolveOtelPluginConfig keeps agentProvider as a compatibility alias", () => {
  const config = resolveOtelPluginConfig({
    agentProvider: "custom-agent",
  });

  assert.deepEqual(config.resourceAttributes, {
    agent_provider: "custom-agent",
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
    agent_provider: "openclaw",
    team: "apm",
    enabled: true,
    priority: 3,
  });
});

test("resolveOtelPluginConfig lets resourceAttributes override compatibility fields", () => {
  const config = resolveOtelPluginConfig({
    agentProvider: "legacy-provider",
    globalTags: {
      team: "apm",
      agent_name: "legacy-agent",
    },
    resourceAttributes: {
      team: "platform",
      agent_provider: "resource-provider",
      agent_name: "fixed-agent",
      "agent.id": "agent-01",
    },
  });

  assert.deepEqual(config.resourceAttributes, {
    agent_provider: "resource-provider",
    team: "platform",
    agent_name: "fixed-agent",
    "agent.id": "agent-01",
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
