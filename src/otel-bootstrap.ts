import { createRequire } from "node:module";
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
  traceIds?: string[];
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
  const filter = new Set((debugOptions.traceIds ?? []).filter(Boolean));
  const spans = items
    .map((item) => {
      const spanContext = typeof (item as { spanContext?: unknown }).spanContext === "function"
        ? ((item as { spanContext: () => { traceId?: string; spanId?: string } }).spanContext())
        : (item as { spanContext?: { traceId?: string; spanId?: string } }).spanContext;
      const traceId = spanContext?.traceId;
      if (!traceId || (filter.size > 0 && !filter.has(traceId))) {
        return undefined;
      }
      const parent = (item as { parentSpanContext?: { spanId?: string } }).parentSpanContext;
      const resourceAttrs = (item as { resource?: { attributes?: Record<string, unknown> } }).resource?.attributes ?? {};
      const attrs = (item as { attributes?: Record<string, unknown> }).attributes ?? {};
      return {
        trace_id: traceId,
        span_id: spanContext?.spanId,
        parent_id: parent?.spanId ?? "0",
        resource: String((item as { name?: unknown }).name ?? ""),
        service: typeof resourceAttrs["service.name"] === "string"
          ? String(resourceAttrs["service.name"])
          : undefined,
        start_time: hrTimeToUnixMs((item as { startTime?: unknown }).startTime),
        end_time: hrTimeToUnixMs((item as { endTime?: unknown }).endTime),
        session_id: typeof attrs.session_id === "string" ? String(attrs.session_id) : undefined,
        session_key: typeof attrs.session_key === "string" ? String(attrs.session_key) : undefined,
      };
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
  const require = createRequire(import.meta.url);
  const { context, metrics, trace, SpanKind, SpanStatusCode } = require("@opentelemetry/api");
  const { SeverityNumber } = require("@opentelemetry/api-logs");
  const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-proto");
  const { OTLPMetricExporter } = require("@opentelemetry/exporter-metrics-otlp-proto");
  const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-proto");
  const { resourceFromAttributes } = require("@opentelemetry/resources");
  const { BatchLogRecordProcessor, LoggerProvider } = require("@opentelemetry/sdk-logs");
  const { NodeSDK } = require("@opentelemetry/sdk-node");
  const { PeriodicExportingMetricReader } = require("@opentelemetry/sdk-metrics");
  const {
    ParentBasedSampler,
    TraceIdRatioBasedSampler,
  } = require("@opentelemetry/sdk-trace-base");
  const { ATTR_SERVICE_NAME } = require("@opentelemetry/semantic-conventions");

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
      traceIds: config.tracePayloadDebugTraceIds,
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
    requestCounter: meter.createCounter("openclaw.requests", {
      description: "Total OpenClaw requests observed by the plugin",
    }),
    requestDuration: meter.createHistogram("openclaw.request.duration", {
      description: "OpenClaw request duration in milliseconds",
      unit: "ms",
    }),
    genAiAgentRequestCount: meter.createCounter("gen_ai.agent.request.count", {
      description: "Total GenAI agent requests observed by the plugin",
    }),
    genAiAgentRequestDuration: meter.createHistogram("gen_ai.agent.request.duration", {
      description: "GenAI agent request duration in milliseconds",
      unit: "ms",
    }),
    sessionInputTokensCounter: meter.createCounter("openclaw.session.tokens.input", {
      description: "Session-scoped input tokens emitted by periodic session scans",
    }),
    sessionOutputTokensCounter: meter.createCounter("openclaw.session.tokens.output", {
      description: "Session-scoped output tokens emitted by periodic session scans",
    }),
    sessionTotalTokensCounter: meter.createCounter("openclaw.session.tokens.total", {
      description: "Session-scoped total tokens emitted by periodic session scans",
    }),
    sessionTraceCounter: meter.createCounter("openclaw.session.traces", {
      description: "Session trace count emitted by periodic session scans with session_id tagging",
    }),
    genAiAgentSessionTokenUsage: meter.createCounter("gen_ai.agent.session.token.usage", {
      description: "Session-scoped GenAI agent token usage emitted by periodic session scans",
    }),
    genAiAgentSessionTraceCount: meter.createCounter("gen_ai.agent.session.trace.count", {
      description: "Session-scoped GenAI agent trace count emitted by periodic session scans",
    }),
    toolCallCounter: meter.createCounter("openclaw.tool.calls", {
      description: "Total OpenClaw tool calls observed by the plugin",
    }),
    toolErrorCounter: meter.createCounter("openclaw.tool.errors", {
      description: "Total OpenClaw tool call errors observed by the plugin",
    }),
    toolDuration: meter.createHistogram("openclaw.tool.duration", {
      description: "OpenClaw tool call duration in milliseconds",
      unit: "ms",
    }),
    genAiClientOperationDuration: meter.createHistogram("gen_ai.client.operation.duration", {
      description: "GenAI client operation duration in milliseconds",
      unit: "ms",
    }),
    skillActivationCounter: meter.createCounter("openclaw.skill.activations", {
      description: "Total OpenClaw skill activations observed by the plugin",
    }),
    genAiAgentSkillActivationCount: meter.createCounter("gen_ai.agent.skill.activation.count", {
      description: "Total GenAI agent skill activations observed by the plugin",
    }),
    modelCallCounter: meter.createCounter("openclaw.model.calls", {
      description: "Total OpenClaw model usage events observed by the plugin",
    }),
    diagnosticsTokensCounter: meter.createCounter("openclaw.tokens", {
      description: "Model token usage emitted from OpenClaw diagnostics events",
    }),
    genAiClientTokenUsage: meter.createCounter("gen_ai.client.token.usage", {
      description: "GenAI client token usage emitted from OpenClaw diagnostics events",
    }),
    diagnosticsCostUsdCounter: meter.createCounter("openclaw.cost.usd", {
      description: "Model cost in USD emitted from OpenClaw diagnostics events",
    }),
    diagnosticsRunDurationMs: meter.createHistogram("openclaw.run.duration_ms", {
      description: "Model run duration in milliseconds emitted from OpenClaw diagnostics events",
      unit: "ms",
    }),
    diagnosticsContextTokens: meter.createHistogram("openclaw.context.tokens", {
      description: "Context token usage emitted from OpenClaw diagnostics events",
    }),
    diagnosticsWebhookReceivedCounter: meter.createCounter("openclaw.webhook.received", {
      description: "Webhook receive events emitted from OpenClaw diagnostics events",
    }),
    diagnosticsWebhookErrorCounter: meter.createCounter("openclaw.webhook.error", {
      description: "Webhook error events emitted from OpenClaw diagnostics events",
    }),
    diagnosticsWebhookDurationMs: meter.createHistogram("openclaw.webhook.duration_ms", {
      description: "Webhook processing duration in milliseconds emitted from OpenClaw diagnostics events",
      unit: "ms",
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
    diagnosticsMessageQueuedCounter: meter.createCounter("openclaw.message.queued", {
      description: "Message queued events emitted from OpenClaw diagnostics events",
    }),
    diagnosticsMessageProcessedCounter: meter.createCounter("openclaw.message.processed", {
      description: "Message processed events emitted from OpenClaw diagnostics events",
    }),
    diagnosticsMessageDurationMs: meter.createHistogram("openclaw.message.duration_ms", {
      description: "Message processing duration in milliseconds emitted from OpenClaw diagnostics events",
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
    diagnosticsQueueLaneEnqueueCounter: meter.createCounter("openclaw.queue.lane.enqueue", {
      description: "Queue enqueue events emitted from OpenClaw diagnostics events",
    }),
    diagnosticsQueueLaneDequeueCounter: meter.createCounter("openclaw.queue.lane.dequeue", {
      description: "Queue dequeue events emitted from OpenClaw diagnostics events",
    }),
    diagnosticsQueueDepth: meter.createHistogram("openclaw.queue.depth", {
      description: "Queue depth emitted from OpenClaw diagnostics events",
    }),
    diagnosticsQueueWaitMs: meter.createHistogram("openclaw.queue.wait_ms", {
      description: "Queue wait time in milliseconds emitted from OpenClaw diagnostics events",
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
    diagnosticsSessionStateCounter: meter.createCounter("openclaw.session.state", {
      description: "Session state transitions emitted from OpenClaw diagnostics events",
    }),
    genAiRuntimeSessionStateCount: meter.createCounter("gen_ai.runtime.session.state.count", {
      description: "GenAI runtime session state transitions emitted from diagnostics",
    }),
    diagnosticsSessionStuckCounter: meter.createCounter("openclaw.session.stuck", {
      description: "Stuck session detections emitted from OpenClaw diagnostics events",
    }),
    diagnosticsSessionStuckAgeMs: meter.createHistogram("openclaw.session.stuck_age_ms", {
      description: "Age in milliseconds for stuck sessions emitted from OpenClaw diagnostics events",
      unit: "ms",
    }),
    genAiRuntimeSessionStuckCount: meter.createCounter("gen_ai.runtime.session.stuck.count", {
      description: "GenAI runtime stuck session detections emitted from diagnostics",
    }),
    genAiRuntimeSessionStuckAge: meter.createHistogram("gen_ai.runtime.session.stuck.age", {
      description: "GenAI runtime stuck session age in milliseconds",
      unit: "ms",
    }),
    diagnosticsRunAttemptCounter: meter.createCounter("openclaw.run.attempt", {
      description: "Run attempts emitted from OpenClaw diagnostics events",
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
