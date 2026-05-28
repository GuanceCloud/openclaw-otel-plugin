import { context, metrics, trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { OtelPluginConfig } from "./config.js";
import type { MetricInstruments, OtelBootstrapResult, RuntimeMetadata } from "./service-types.js";
import { resolveOtelUrl } from "./trace-runtime.js";

type OtelLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type TracePayloadDebugOptions = {
  enabled: boolean;
};

function compactResourceAttrs(
  attrs: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(attrs).filter(([, value]) => value !== undefined && value !== ""),
  ) as Record<string, string | number | boolean>;
}

function formatExportError(error: unknown): string {
  if (!error) {
    return "unknown";
  }
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

function countExportItems(signal: "trace" | "metric", items: unknown): number | undefined {
  if (Array.isArray(items)) {
    return items.length;
  }
  if (signal !== "metric" || !items || typeof items !== "object") {
    return undefined;
  }
  const resourceMetrics = (items as { resourceMetrics?: unknown }).resourceMetrics;
  if (!Array.isArray(resourceMetrics)) {
    return undefined;
  }
  let count = 0;
  for (const resourceMetric of resourceMetrics) {
    const scopeMetrics = (resourceMetric as { scopeMetrics?: unknown }).scopeMetrics;
    if (!Array.isArray(scopeMetrics)) {
      continue;
    }
    for (const scopeMetric of scopeMetrics) {
      const metrics = (scopeMetric as { metrics?: unknown }).metrics;
      if (Array.isArray(metrics)) {
        count += metrics.length;
      }
    }
  }
  return count;
}

function hrTimeToUnixMs(value: unknown): number | undefined {
  if (!Array.isArray(value) || value.length < 2) {
    return undefined;
  }
  const seconds = Number(value[0]);
  const nanos = Number(value[1]);
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) {
    return undefined;
  }
  return Math.floor((seconds * 1_000) + (nanos / 1_000_000));
}

function collectTracePayloadSummary(
  items: unknown,
  debugOptions?: TracePayloadDebugOptions,
): {
  traceIds: string[];
  spans: Array<Record<string, string | number | boolean | undefined>>;
} | undefined {
  if (!debugOptions?.enabled || !Array.isArray(items) || items.length === 0) {
    return undefined;
  }
  const spans = items
    .map((item) => {
      const spanContext = typeof (item as { spanContext?: unknown }).spanContext === "function"
        ? ((item as { spanContext: () => { traceId?: string; spanId?: string } }).spanContext())
        : (item as { spanContext?: { traceId?: string; spanId?: string } }).spanContext;
      const traceId = spanContext?.traceId;
      if (!traceId) {
        return undefined;
      }
      const parent = (item as { parentSpanContext?: { spanId?: string } }).parentSpanContext;
      const resourceAttrs = (item as { resource?: { attributes?: Record<string, unknown> } }).resource?.attributes ?? {};
      const attrs = (item as { attributes?: Record<string, unknown> }).attributes ?? {};
      const summary = {
        trace_id: traceId,
        span_id: spanContext?.spanId,
        parent_id: parent?.spanId ?? "0",
        run_id: typeof attrs.run_id === "string" ? String(attrs.run_id) : undefined,
        resource: String((item as { name?: unknown }).name ?? ""),
        service: typeof resourceAttrs["service.name"] === "string"
          ? String(resourceAttrs["service.name"])
          : undefined,
        start_time: hrTimeToUnixMs((item as { startTime?: unknown }).startTime),
        end_time: hrTimeToUnixMs((item as { endTime?: unknown }).endTime),
        session_id: typeof attrs.session_id === "string" ? String(attrs.session_id) : undefined,
        session_key: typeof attrs.session_key === "string" ? String(attrs.session_key) : undefined,
        agent_runtime: typeof attrs.agent_runtime === "string"
          ? String(attrs.agent_runtime)
          : typeof resourceAttrs.agent_runtime === "string"
            ? String(resourceAttrs.agent_runtime)
            : undefined,
        agent_version: typeof attrs.agent_version === "string"
          ? String(attrs.agent_version)
          : typeof resourceAttrs.agent_version === "string"
            ? String(resourceAttrs.agent_version)
            : undefined,
        runtime_environment: typeof attrs.runtime_environment === "string"
          ? String(attrs.runtime_environment)
          : typeof resourceAttrs.runtime_environment === "string"
            ? String(resourceAttrs.runtime_environment)
            : undefined,
      };
      return summary;
    })
    .filter(Boolean) as Array<Record<string, string | number | boolean | undefined>>;
  if (spans.length === 0) {
    return undefined;
  }
  const traceIds = Array.from(new Set(spans.map((span) => String(span.trace_id))));
  return { traceIds, spans };
}

function withExportLogging<T extends { export: (items: any, callback: (result: any) => void) => void }>(
  exporter: T,
  options: {
    signal: "trace" | "metric" | "log";
    url: string;
    logger?: OtelLogger;
    tracePayloadDebug?: TracePayloadDebugOptions;
  },
): T {
  const originalExport = exporter.export.bind(exporter);
  exporter.export = (items: any, callback: (result: any) => void) => {
    const startedAt = Date.now();
    const itemCount = countExportItems(options.signal, items);
    const tracePayloadSummary = options.signal === "trace"
      ? collectTracePayloadSummary(items, options.tracePayloadDebug)
      : undefined;
    try {
      originalExport(items, (result: any) => {
        const durationMs = Date.now() - startedAt;
        const suffix = ` -> ${options.url} (${durationMs}ms${
          itemCount === undefined ? "" : `, items=${itemCount}`
        })`;
        if (result?.code === 0) {
          options.logger?.info?.(`[otel-plugin] ${options.signal} export succeeded${suffix}`);
          if (tracePayloadSummary) {
            try {
              options.logger?.info?.(`[otel-plugin] trace export payload ${JSON.stringify({
                trace_ids: tracePayloadSummary.traceIds,
                span_count: tracePayloadSummary.spans.length,
                spans: tracePayloadSummary.spans,
              })}`);
            } catch {
              options.logger?.info?.("[otel-plugin] trace export payload log failed to serialize");
            }
          }
        } else {
          options.logger?.error?.(
            `[otel-plugin] ${options.signal} export failed${suffix}: ${
              formatExportError(result?.error)
            }`,
          );
        }
        callback(result);
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      options.logger?.error?.(
        `[otel-plugin] ${options.signal} export failed before callback -> ${options.url} (${durationMs}ms): ${
          formatExportError(error)
        }`,
      );
      throw error;
    }
  };
  return exporter;
}

export async function startOtelBootstrap(
  config: OtelPluginConfig,
  runtimeMetadata?: RuntimeMetadata,
  logger?: OtelLogger,
): Promise<OtelBootstrapResult> {

  const traceUrl = resolveOtelUrl(config.endpoint, config.tracePath);
  const metricUrl = resolveOtelUrl(config.endpoint, config.metricsPath);
  const logsUrl = resolveOtelUrl(config.endpoint, config.logsPath);

  const traceExporter = withExportLogging(new OTLPTraceExporter({
    url: traceUrl,
    ...(config.headers ? { headers: config.headers } : {}),
  }), {
    signal: "trace",
    url: traceUrl,
    logger,
    tracePayloadDebug: {
      enabled: config.tracePayloadDebugEnabled,
    },
  });
  const metricExporter = withExportLogging(new OTLPMetricExporter({
    url: metricUrl,
    ...(config.headers ? { headers: config.headers } : {}),
  }), {
    signal: "metric",
    url: metricUrl,
    logger,
  });
  const logExporter = config.logsEnabled
    ? withExportLogging(new OTLPLogExporter({
        url: logsUrl,
        ...(config.headers ? { headers: config.headers } : {}),
      }), {
        signal: "log",
        url: logsUrl,
        logger,
      })
    : undefined;

  const resource = resourceFromAttributes(compactResourceAttrs({
    [ATTR_SERVICE_NAME]: config.serviceName,
    agent_runtime:
      typeof config.resourceAttributes?.agent_runtime === "string"
        ? config.resourceAttributes.agent_runtime
        : "openclaw",
    agent_version: runtimeMetadata?.openclawVersion,
    runtime_environment: runtimeMetadata?.runtimeEnvironment,
    agent_id: runtimeMetadata?.agentId,
    agent_name: runtimeMetadata?.agentName,
    ...(config.resourceAttributes ?? {}),
  }));

  const sdk = new NodeSDK({
    serviceName: config.serviceName,
    resource,
    traceExporter,
    metricReader: new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: config.flushIntervalMs,
    }),
    ...(config.sampleRate !== undefined
      ? {
          sampler: new ParentBasedSampler({
            root: new TraceIdRatioBasedSampler(config.sampleRate),
          }),
        }
      : {}),
  });
  const loggerProvider = config.logsEnabled
    ? new LoggerProvider({
        resource,
        processors: logExporter ? [new BatchLogRecordProcessor(logExporter)] : [],
      })
    : undefined;
  const diagnosticsLogger = loggerProvider?.getLogger("openclaw-otel-plugin");

  await sdk.start();

  const tracer = trace.getTracer("openclaw-otel-plugin");
  const meter = metrics.getMeter("openclaw-otel-plugin");
  const instruments: MetricInstruments = {
    genAiAgentRequestCount: meter.createCounter("gen_ai.agent.request.count", {
      description: "Total GenAI agent requests observed by the plugin",
    }),
    genAiAgentRequestDuration: meter.createHistogram("gen_ai.agent.request.duration", {
      description: "GenAI agent request duration in milliseconds",
      unit: "ms",
    }),
    genAiAgentSessionTokenInput: meter.createCounter("gen_ai.agent.session.token.input", {
      description: "Session-scoped GenAI agent input token usage emitted by periodic session scans",
    }),
    genAiAgentSessionTokenOutput: meter.createCounter("gen_ai.agent.session.token.output", {
      description: "Session-scoped GenAI agent output token usage emitted by periodic session scans",
    }),
    genAiAgentSessionTokenTotal: meter.createCounter("gen_ai.agent.session.token.total", {
      description: "Session-scoped GenAI agent total token usage emitted by periodic session scans",
    }),
    genAiAgentSessionTokenUsage: meter.createCounter("gen_ai.agent.session.token.usage", {
      description: "Session-scoped GenAI agent token usage emitted by periodic session scans",
    }),
    genAiAgentSessionTraceCount: meter.createCounter("gen_ai.agent.session.trace.count", {
      description: "Session-scoped GenAI agent trace count emitted by periodic session scans",
    }),
    genAiAgentOperationCount: meter.createCounter("gen_ai.agent.operation.count", {
      description: "GenAI agent operation count across model, tool, and skill execution",
    }),
    genAiAgentOperationDuration: meter.createHistogram("gen_ai.agent.operation.duration", {
      description: "GenAI agent operation duration in milliseconds across model, tool, and skill execution",
      unit: "ms",
    }),
    genAiAgentSkillActivationCount: meter.createCounter("gen_ai.agent.skill.activation.count", {
      description: "Total GenAI agent skill activations observed by the plugin",
    }),
    genAiAgentTokenUsage: meter.createHistogram("gen_ai.agent.token.usage", {
      description: "GenAI agent model token usage emitted by runtime and transcript replay",
      unit: "{token}",
    }),
    genAiRuntimeWebhookReceivedCount: meter.createCounter("gen_ai.runtime.webhook.received.count", {
      description: "GenAI runtime webhook received events emitted from diagnostics",
    }),
    genAiRuntimeWebhookErrorCount: meter.createCounter("gen_ai.runtime.webhook.error.count", {
      description: "GenAI runtime webhook error events emitted from diagnostics",
    }),
    genAiRuntimeWebhookDuration: meter.createHistogram("gen_ai.runtime.webhook.duration", {
      description: "GenAI runtime webhook processing duration in milliseconds",
      unit: "ms",
    }),
    genAiRuntimeMessageQueuedCount: meter.createCounter("gen_ai.runtime.message.queued.count", {
      description: "GenAI runtime message queued events emitted from diagnostics",
    }),
    genAiRuntimeMessageProcessedCount: meter.createCounter("gen_ai.runtime.message.processed.count", {
      description: "GenAI runtime message processed events emitted from diagnostics",
    }),
    genAiRuntimeMessageDuration: meter.createHistogram("gen_ai.runtime.message.duration", {
      description: "GenAI runtime message processing duration in milliseconds",
      unit: "ms",
    }),
    genAiRuntimeQueueEnqueueCount: meter.createCounter("gen_ai.runtime.queue.enqueue.count", {
      description: "GenAI runtime queue enqueue events emitted from diagnostics",
    }),
    genAiRuntimeQueueDequeueCount: meter.createCounter("gen_ai.runtime.queue.dequeue.count", {
      description: "GenAI runtime queue dequeue events emitted from diagnostics",
    }),
    genAiRuntimeQueueDepth: meter.createHistogram("gen_ai.runtime.queue.depth", {
      description: "GenAI runtime queue depth emitted from diagnostics",
    }),
    genAiRuntimeQueueWait: meter.createHistogram("gen_ai.runtime.queue.wait", {
      description: "GenAI runtime queue wait time in milliseconds",
      unit: "ms",
    }),
    genAiRuntimeSessionStateCount: meter.createCounter("gen_ai.runtime.session.state.count", {
      description: "GenAI runtime session state transitions emitted from diagnostics",
    }),
    genAiRuntimeSessionStuckCount: meter.createCounter("gen_ai.runtime.session.stuck.count", {
      description: "GenAI runtime stuck session detections emitted from diagnostics",
    }),
    genAiRuntimeSessionStuckAge: meter.createHistogram("gen_ai.runtime.session.stuck.age", {
      description: "GenAI runtime stuck session age in milliseconds",
      unit: "ms",
    }),
  };

  return {
    sdk: {
      shutdown: async () => {
        const results = await Promise.allSettled([
          sdk.shutdown(),
          loggerProvider?.shutdown(),
        ]);
        const rejected = results.find((item) => item.status === "rejected");
        if (rejected && rejected.status === "rejected") {
          throw rejected.reason;
        }
      },
    },
    context,
    trace,
    tracer,
    SpanKind,
    SpanStatusCode,
    SeverityNumber,
    diagnosticsLogger,
    instruments,
  };
}
