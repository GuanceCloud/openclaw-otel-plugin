import test from "node:test";
import assert from "node:assert/strict";

import { resolveOtelPluginConfig } from "../dist/src/config.js";
import { buildOtelResourceAttrs } from "../dist/src/otel-bootstrap.js";

test("resolveOtelPluginConfig keeps openclaw as the default agent runtime resource attribute", () => {
  const config = resolveOtelPluginConfig({});

  assert.deepEqual(config.resourceAttributes, {
    agent_runtime: "openclaw",
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
    agent_runtime: "openclaw",
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
    agent_runtime: "hermes",
    agent_name: "fixed-agent",
    agent_id: "agent-01",
    team: "platform",
  });
});

test("resolveOtelPluginConfig accepts legacy gen_ai resource keys but normalizes them to canonical tags", () => {
  const config = resolveOtelPluginConfig({
    resourceAttributes: {
      "gen_ai.agent_runtime": "hermes",
      "gen_ai.agent_name": "legacy-agent",
      "gen_ai.agent_id": "agent-02",
      "gen_ai.agent_version": "2026.5.11",
      "gen_ai.runtime_environment": "prod",
    },
  });

  assert.deepEqual(config.resourceAttributes, {
    agent_runtime: "hermes",
    agent_name: "legacy-agent",
    agent_id: "agent-02",
    agent_version: "2026.5.11",
    runtime_environment: "prod",
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

test("resolveOtelPluginConfig keeps trace payload debug off by default and accepts the debug switch", () => {
  const disabledConfig = resolveOtelPluginConfig({});
  const enabledConfig = resolveOtelPluginConfig({
    tracePayloadDebugEnabled: true,
  });

  assert.equal(disabledConfig.tracePayloadDebugEnabled, false);
  assert.equal(enabledConfig.tracePayloadDebugEnabled, true);
});

test("buildOtelResourceAttrs keeps agent identity on spans only", () => {
  const config = resolveOtelPluginConfig({
    serviceName: "openclaw-otel-plugin",
    resourceAttributes: {
      team: "platform",
      agent_runtime: "openclaw",
      agent_id: "configured-agent-id",
      agent_name: "configured-agent-name",
    },
  });

  const attrs = buildOtelResourceAttrs(config, {
    runtimeEnvironment: "main",
    openclawVersion: "2026.5.28",
    agentId: "runtime-agent-id",
    agentName: "runtime-agent-name",
  });

  assert.deepEqual(attrs, {
    "service.name": "openclaw-otel-plugin",
    agent_runtime: "openclaw",
    agent_version: "2026.5.28",
    runtime_environment: "main",
    team: "platform",
  });
  assert.equal(attrs.agent_id, undefined);
  assert.equal(attrs.agent_name, undefined);
});
