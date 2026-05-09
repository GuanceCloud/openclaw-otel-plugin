export type OtelPluginConfig = {
  enabled: boolean;
  endpoint: string;
  tracePath: string;
  metricsPath: string;
  logsEnabled: boolean;
  logsPath: string;
  protocol: "http/protobuf";
  serviceName: string;
  headers?: Record<string, string>;
  sampleRate?: number;
  flushIntervalMs: number;
  rootSpanTtlMs: number;
  tracePayloadDebugEnabled: boolean;
  tracePayloadDebugTraceIds?: string[];
  resourceAttributes?: Record<string, string | number | boolean>;
};

const DEFAULT_ENDPOINT = "http://127.0.0.1:9529/otel";
const DEFAULT_TRACE_PATH = "v1/traces";
const DEFAULT_METRICS_PATH = "v1/metrics";
const DEFAULT_LOGS_PATH = "v1/logs";
const DEFAULT_AGENT_RUNTIME = "openclaw";
const DEFAULT_SERVICE_NAME = "openclaw-otel-plugin";
const DEFAULT_FLUSH_INTERVAL_MS = 30000;
const DEFAULT_ROOT_SPAN_TTL_MS = 10 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringMap(
  value: unknown,
): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const mapped = Object.fromEntries(
    Object.entries(record)
      .filter(([, item]) => typeof item === "string" && item.trim())
      .map(([key, item]) => [key, String(item).trim()]),
  );
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const mapped = value
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => String(item).trim());
  return mapped.length > 0 ? mapped : undefined;
}

function asResourceAttributes(
  value: unknown,
): Record<string, string | number | boolean> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const mapped = Object.fromEntries(
    Object.entries(record).filter(
      ([, item]) =>
        typeof item === "string" || typeof item === "number" || typeof item === "boolean",
    ),
  ) as Record<string, string | number | boolean>;
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function normalizeEndpoint(endpoint: string | undefined): string {
  const trimmed = endpoint?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : DEFAULT_ENDPOINT;
}

function normalizeSignalPath(path: string | undefined, fallback: string): string {
  const trimmed = path?.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.replace(/^\/+/, "").replace(/\/+$/, "") || fallback;
}

function normalizeNonEmptyString(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function normalizeRate(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (value < 0 || value > 1) {
    return undefined;
  }
  return value;
}

function normalizeMs(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1000, Math.floor(value));
}

function flattenGenAiResourceKey(key: string): string {
  if (!key.startsWith("gen_ai.")) {
    return key;
  }
  const suffix = key.slice("gen_ai.".length);
  return `gen_ai.${suffix.replaceAll(".", "_")}`;
}

function resolveResourceAttributes(
  raw: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const merged = {
    "gen_ai.agent_runtime": DEFAULT_AGENT_RUNTIME,
    ...(asResourceAttributes(raw.globalTags) ?? {}),
    ...(asResourceAttributes(raw.resourceAttributes) ?? {}),
  } as Record<string, string | number | boolean>;
  for (const [key, value] of Object.entries({ ...merged })) {
    if (!key.startsWith("gen_ai.") || value === undefined || value === "") {
      continue;
    }
    const flattened = flattenGenAiResourceKey(key);
    if (flattened === key) {
      continue;
    }
    if (!(flattened in merged)) {
      merged[flattened] = value;
    }
    delete merged[key];
  }
  if (
    merged.agent_runtime !== undefined
    && (
      merged["gen_ai.agent_runtime"] === undefined
      || merged["gen_ai.agent_runtime"] === DEFAULT_AGENT_RUNTIME
    )
  ) {
    merged["gen_ai.agent_runtime"] = merged.agent_runtime;
  }
  if (merged["gen_ai.agent_id"] === undefined && merged.agent_id !== undefined) {
    merged["gen_ai.agent_id"] = merged.agent_id;
  }
  if (merged["gen_ai.agent_name"] === undefined && merged.agent_name !== undefined) {
    merged["gen_ai.agent_name"] = merged.agent_name;
  }
  if (merged["gen_ai.agent_version"] === undefined && merged.agent_version !== undefined) {
    merged["gen_ai.agent_version"] = merged.agent_version;
  }
  if (merged["gen_ai.runtime_environment"] === undefined && merged.runtime_environment !== undefined) {
    merged["gen_ai.runtime_environment"] = merged.runtime_environment;
  }
  delete merged.agent_runtime;
  delete merged.agent_id;
  delete merged.agent_name;
  delete merged.agent_version;
  delete merged.runtime_environment;
  return merged;
}

export function resolveOtelPluginConfig(rawConfig: unknown): OtelPluginConfig {
  const raw = asRecord(rawConfig) ?? {};
  return {
    enabled: raw.enabled !== false,
    endpoint: normalizeEndpoint(typeof raw.endpoint === "string" ? raw.endpoint : undefined),
    tracePath: normalizeSignalPath(typeof raw.tracePath === "string" ? raw.tracePath : undefined, DEFAULT_TRACE_PATH),
    metricsPath: normalizeSignalPath(
      typeof raw.metricsPath === "string" ? raw.metricsPath : undefined,
      DEFAULT_METRICS_PATH,
    ),
    logsEnabled: raw.logsEnabled === true,
    logsPath: normalizeSignalPath(
      typeof raw.logsPath === "string" ? raw.logsPath : undefined,
      DEFAULT_LOGS_PATH,
    ),
    protocol: "http/protobuf",
    serviceName:
      typeof raw.serviceName === "string" && raw.serviceName.trim()
        ? raw.serviceName.trim()
        : DEFAULT_SERVICE_NAME,
    headers: asStringMap(raw.headers),
    sampleRate: normalizeRate(raw.sampleRate),
    flushIntervalMs: normalizeMs(raw.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS),
    rootSpanTtlMs: normalizeMs(raw.rootSpanTtlMs, DEFAULT_ROOT_SPAN_TTL_MS),
    tracePayloadDebugEnabled: raw.tracePayloadDebugEnabled === true,
    tracePayloadDebugTraceIds: asStringArray(raw.tracePayloadDebugTraceIds),
    resourceAttributes: resolveResourceAttributes(raw),
  };
}
