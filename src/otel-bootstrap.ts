import {
  context,
  metrics,
  trace,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
} from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import {
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import type {
  ReadableSpan,
  SpanExporter,
  SpanProcessor,
  Span,
} from "@opentelemetry/sdk-trace-base";
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

type RootBufferedTraceState = {
  spans: ReadableSpan[];
};

function compactResourceAttrs(
  attrs: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(attrs).filter(([, value]) => value !== undefined && value !== ""),
  ) as Record<string, string | number | boolean>;
}

export function buildOtelResourceAttrs(
  config: Pick<OtelPluginConfig, "serviceName" | "resourceAttributes">,
  runtimeMetadata?: RuntimeMetadata,
): Record<string, string | number | boolean> {
  const configuredResourceAttrs = config.resourceAttributes ?? {};

  return compactResourceAttrs({
    [ATTR_SERVICE_NAME]: config.serviceName,
    agent_runtime:
      typeof configuredResourceAttrs.agent_runtime === "string"
        ? configuredResourceAttrs.agent_runtime
        : "openclaw",
    agent_version: runtimeMetadata?.openclawVersion,
    runtime_environment: runtimeMetadata?.runtimeEnvironment,
    ...configuredResourceAttrs,
  });
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

function compareHrTime(
  left: readonly [number, number],
  right: readonly [number, number],
): number {
  if (left[0] !== right[0]) {
    return left[0] - right[0];
  }
  return left[1] - right[1];
}

function compareReadableSpans(left: ReadableSpan, right: ReadableSpan): number {
  const startCompare = compareHrTime(left.startTime, right.startTime);
  if (startCompare !== 0) {
    return startCompare;
  }
  const endCompare = compareHrTime(left.endTime, right.endTime);
  if (endCompare !== 0) {
    return endCompare;
  }
  return left.name.localeCompare(right.name);
}

function isRootReadableSpan(span: ReadableSpan): boolean {
  return !span.parentSpanContext?.spanId;
}

export class RootBufferedTraceSpanProcessor implements SpanProcessor {
  private readonly exporter: SpanExporter;
  private readonly bufferedByTraceId = new Map<string, RootBufferedTraceState>();
  private readonly exportingTraceIds = new Set<string>();
  private readonly pendingExports = new Set<Promise<void>>();
  private shutdownPromise: Promise<void> | undefined;
  private shuttingDown = false;

  constructor(exporter: SpanExporter) {
    this.exporter = exporter;
  }

  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    if (this.shuttingDown) {
      return;
    }
    if ((span.spanContext().traceFlags & TraceFlags.SAMPLED) === 0) {
      return;
    }
    const traceId = span.spanContext().traceId;
    if (!traceId) {
      return;
    }

    const state = this.bufferedByTraceId.get(traceId) ?? { spans: [] };
    state.spans.push(span);
    this.bufferedByTraceId.set(traceId, state);

    if (isRootReadableSpan(span)) {
      this.exportBufferedTrace(traceId);
    }
  }

  async forceFlush(): Promise<void> {
    for (const traceId of Array.from(this.bufferedByTraceId.keys())) {
      this.exportBufferedTrace(traceId);
    }
    await Promise.all(Array.from(this.pendingExports));
    if (typeof this.exporter.forceFlush === "function") {
      await this.exporter.forceFlush();
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.shuttingDown = true;
    this.shutdownPromise = (async () => {
      await this.forceFlush();
      await this.exporter.shutdown();
    })();
    return this.shutdownPromise;
  }

  private exportBufferedTrace(traceId: string): void {
    if (this.exportingTraceIds.has(traceId)) {
      return;
    }
    const state = this.bufferedByTraceId.get(traceId);
    if (!state || state.spans.length === 0) {
      return;
    }
    const spans = state.spans.slice().sort(compareReadableSpans);
    this.bufferedByTraceId.delete(traceId);
    this.exportingTraceIds.add(traceId);

    const pendingExport = this.doExport(spans)
      .finally(() => {
        this.exportingTraceIds.delete(traceId);
        this.pendingExports.delete(pendingExport);
      });
    this.pendingExports.add(pendingExport);
    void pendingExport.catch(() => undefined);
  }

  private async doExport(spans: ReadableSpan[]): Promise<void> {
    await Promise.all(
      spans
        .map((span) => span.resource)
        .filter((resource) => resource?.asyncAttributesPending)
        .map((resource) => resource.waitForAsyncAttributes?.()),
    );

    await new Promise<void>((resolve, reject) => {
      this.exporter.export(spans, (result) => {
        if (result?.code === 0) {
          resolve();
          return;
        }
        reject(result?.error ?? new Error("RootBufferedTraceSpanProcessor export failed"));
      });
    });
  }
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

  const resource = resourceFromAttributes(buildOtelResourceAttrs(config, runtimeMetadata));

  const sdk = new NodeSDK({
    serviceName: config.serviceName,
    resource,
    spanProcessors: [
      new RootBufferedTraceSpanProcessor(traceExporter),
    ],
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
