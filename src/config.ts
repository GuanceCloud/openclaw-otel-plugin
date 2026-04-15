export type OtelPluginConfig = {
  enabled: boolean;
  endpoint: string;
  tracePath: string;
  metricsPath: string;
  logsEnabled: boolean;
  logsPath: string;
  agentProvider: string;
  globalTags?: Record<string, string | number | boolean>;
  protocol: "http/protobuf";
  serviceName: string;
  headers?: Record<string, string>;
  sampleRate?: number;
  flushIntervalMs: number;
  rootSpanTtlMs: number;
  resourceAttributes?: Record<string, string | number | boolean>;
};

const DEFAULT_ENDPOINT = "http://127.0.0.1:9529/otel";
const DEFAULT_TRACE_PATH = "v1/traces";
const DEFAULT_METRICS_PATH = "v1/metrics";
const DEFAULT_LOGS_PATH = "v1/logs";
const DEFAULT_AGENT_PROVIDER = "openclaw";
const DEFAULT_SERVICE_NAME = "openclaw-otel-plugin";
const DEFAULT_FLUSH_INTERVAL_MS = 15000;
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
    agentProvider: normalizeNonEmptyString(
      typeof raw.agentProvider === "string" ? raw.agentProvider : undefined,
      DEFAULT_AGENT_PROVIDER,
    ),
    globalTags: asResourceAttributes(raw.globalTags),
    protocol: "http/protobuf",
    serviceName:
      typeof raw.serviceName === "string" && raw.serviceName.trim()
        ? raw.serviceName.trim()
        : DEFAULT_SERVICE_NAME,
    headers: asStringMap(raw.headers),
    sampleRate: normalizeRate(raw.sampleRate),
    flushIntervalMs: normalizeMs(raw.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS),
    rootSpanTtlMs: normalizeMs(raw.rootSpanTtlMs, DEFAULT_ROOT_SPAN_TTL_MS),
    resourceAttributes: asResourceAttributes(raw.resourceAttributes),
  };
}
