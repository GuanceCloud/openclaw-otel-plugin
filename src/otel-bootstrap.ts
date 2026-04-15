import { createRequire } from "node:module";
import type { OtelPluginConfig } from "./config.js";
import type { MetricInstruments, OtelBootstrapResult, RuntimeMetadata } from "./service-types.js";
import { resolveOtelUrl } from "./trace-runtime.js";

type OtelLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
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

function withExportLogging<T extends { export: (items: any, callback: (result: any) => void) => void }>(
  exporter: T,
  options: {
    signal: "trace" | "metric" | "log";
    url: string;
    logger?: OtelLogger;
  },
): T {
  const originalExport = exporter.export.bind(exporter);
  exporter.export = (items: any, callback: (result: any) => void) => {
    const startedAt = Date.now();
    const itemCount = countExportItems(options.signal, items);
    try {
      originalExport(items, (result: any) => {
        const durationMs = Date.now() - startedAt;
        const suffix = ` -> ${options.url} (${durationMs}ms${
          itemCount === undefined ? "" : `, items=${itemCount}`
        })`;
        if (result?.code === 0) {
          options.logger?.info?.(`[otel-plugin] ${options.signal} export succeeded${suffix}`);
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
    skillActivationCounter: meter.createCounter("openclaw.skill.activations", {
      description: "Total OpenClaw skill activations observed by the plugin",
    }),
    modelCallCounter: meter.createCounter("openclaw.model.calls", {
      description: "Total OpenClaw model usage events observed by the plugin",
    }),
    diagnosticsTokensCounter: meter.createCounter("openclaw.tokens", {
      description: "Model token usage emitted from OpenClaw diagnostics events",
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
    diagnosticsSessionStateCounter: meter.createCounter("openclaw.session.state", {
      description: "Session state transitions emitted from OpenClaw diagnostics events",
    }),
    diagnosticsSessionStuckCounter: meter.createCounter("openclaw.session.stuck", {
      description: "Stuck session detections emitted from OpenClaw diagnostics events",
    }),
    diagnosticsSessionStuckAgeMs: meter.createHistogram("openclaw.session.stuck_age_ms", {
      description: "Age in milliseconds for stuck sessions emitted from OpenClaw diagnostics events",
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
