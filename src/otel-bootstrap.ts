import { createRequire } from "node:module";
import type { OtelPluginConfig } from "./config.js";
import type { MetricInstruments, OtelBootstrapResult } from "./service-types.js";
import { resolveOtelUrl } from "./trace-runtime.js";

export async function startOtelBootstrap(config: OtelPluginConfig): Promise<OtelBootstrapResult> {
  const require = createRequire(import.meta.url);
  const { context, metrics, trace, SpanKind, SpanStatusCode } = require("@opentelemetry/api");
  const { OTLPMetricExporter } = require("@opentelemetry/exporter-metrics-otlp-proto");
  const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-proto");
  const { resourceFromAttributes } = require("@opentelemetry/resources");
  const { NodeSDK } = require("@opentelemetry/sdk-node");
  const { PeriodicExportingMetricReader } = require("@opentelemetry/sdk-metrics");
  const {
    ParentBasedSampler,
    TraceIdRatioBasedSampler,
  } = require("@opentelemetry/sdk-trace-base");
  const { ATTR_SERVICE_NAME } = require("@opentelemetry/semantic-conventions");

  const traceExporter = new OTLPTraceExporter({
    url: resolveOtelUrl(config.endpoint, config.tracePath),
    ...(config.headers ? { headers: config.headers } : {}),
  });
  const metricExporter = new OTLPMetricExporter({
    url: resolveOtelUrl(config.endpoint, "v1/metrics"),
    ...(config.headers ? { headers: config.headers } : {}),
  });

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    ...(config.resourceAttributes ?? {}),
  });

  const sdk = new NodeSDK({
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
    sdk,
    context,
    trace,
    tracer,
    SpanKind,
    SpanStatusCode,
    instruments,
  };
}
