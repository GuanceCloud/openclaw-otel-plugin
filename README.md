# openclaw-otel-plugin

`openclaw-otel-plugin` is an OpenClaw observability export plugin. It converts OpenClaw diagnostic events into session-oriented traces, exports supplemental metrics and diagnostics logs, and reports them to any OpenTelemetry-compatible receiver via `OTLP HTTP/protobuf`.

## Features

- Exports root traces such as `openclaw_request`
- Exports runtime traces such as `main`, `user_message`, and `assistant_message`
- Exports model-, skill-, and tool-related spans
- Exports diagnostic spans such as `openclaw.session.stuck`
- Adds OpenClaw-specific attributes to make troubleshooting easier in tracing platforms
- Exports supplemental metrics such as request count, request duration, tool calls, tool errors, tool duration, skill activations, and model calls
- Mirrors the latest built-in OpenClaw diagnostics metrics such as `openclaw.tokens`, `openclaw.cost.usd`, `openclaw.message.queued`, and `openclaw.queue.depth`
- Mirrors OpenClaw diagnostics events to OTEL logs such as `session.state`, `message.processed`, and `webhook.error`

## Requirements

- OpenClaw `2026.3.23+`
- Node.js `22.x`
- A working OTLP HTTP/protobuf receiver
- Default example endpoint: `http://localhost:4318`

Compatibility notes:

- This plugin is updated for the post-`2026.3.23` OpenClaw plugin SDK entrypoint changes
- It is verified against locally installed OpenClaw `2026.3.23-2`
- If you use an older OpenClaw version, upgrade first before installing this plugin

## Installation

Clone this repository into your local OpenClaw extension directory:

```bash
cd ~/.openclaw/extensions
git clone https://github.com/GuanceDemo/openclaw-otel-plugin.git
cd openclaw-otel-plugin
npm install
npm run build
```

Notes:

- `npm install`: installs runtime dependencies
- `npm run build`: compiles `index.ts` and `src/*.ts` into `dist/`
- Both steps are required on first install, otherwise the plugin may fail to load

## Configuration

Edit `~/.openclaw/openclaw.json` and add this plugin to:

- `plugins.allow`
- `plugins.load.paths`
- `plugins.entries`

Example configuration:

```json
{
  "plugins": {
    "allow": [
      "openclaw-otel-plugin"
    ],
    "load": {
      "paths": [
        "/Users/yourname/.openclaw/extensions/openclaw-otel-plugin"
      ]
    },
    "entries": {
      "openclaw-otel-plugin": {
        "enabled": true,
        "config": {
          "endpoint": "http://localhost:4318",
          "tracePath": "v1/traces",
          "metricsPath": "v1/write/otel-metrics",
          "logsEnabled": true,
          "logsPath": "v1/write/otel-logs",
          "headers": {
            "Authorization": "Bearer <token>",
            "X-Env": "prod"
          },
          "agentProvider": "openclaw",
          "globalTags": {
            "team": "apm",
            "cluster": "prod-cn"
          },
          "protocol": "http/protobuf",
          "serviceName": "openclaw-otel-plugin",
          "flushIntervalMs": 15000,
          "rootSpanTtlMs": 600000,
          "resourceAttributes": {
            "service.namespace": "openclaw",
            "deployment.environment": "local"
          }
        }
      }
    }
  }
}
```

Notes:

- `flushIntervalMs` is also used as the OTLP metrics export interval
- `tracePath` defaults to `v1/traces` and can be changed to routes such as `v1/llms`
- `metricsPath` defaults to `v1/metrics` and can be changed to custom routes such as `/v1/write/otel-metrics`
- `logsEnabled` is disabled by default; OTEL logs are exported only when explicitly set to `true`
- `logsPath` defaults to `v1/logs` and is used for OpenClaw diagnostics log export; it can be changed to routes such as `/v1/write/otel-logs`
- `headers` can be used to attach fixed HTTP headers to trace, metrics, and logs exports
- `agentProvider` defaults to `openclaw` and is attached to traces and metrics as the global resource tag `agent_provider`
- `globalTags` is for fixed global tags such as team, cluster, or environment markers
- Traces are exported to `endpoint + / + tracePath`
- Metrics are exported to `endpoint + / + metricsPath`
- Logs are exported to `endpoint + / + logsPath`

These global tags are added automatically by default:

- `agent_provider`
- `agent_version`
- `runtime_environment`
- `agent_name`

Tag merge priority:

- automatic tags
- `globalTags`
- `resourceAttributes`

Custom trace route example:

```json
{
  "plugins": {
    "entries": {
      "openclaw-otel-plugin": {
        "enabled": true,
        "config": {
          "endpoint": "http://localhost:4318",
          "tracePath": "v1/llms",
          "agentProvider": "openclaw",
          "globalTags": {
            "team": "apm"
          }
        }
      }
    }
  }
}
```

The configuration above exports traces to:

```text
http://localhost:4318/v1/llms
```

## Restart Gateway

After changing configuration, use the official OpenClaw CLI to restart the gateway service:

```bash
openclaw gateway restart
```

If you changed plugin TypeScript code, rebuild before restarting the gateway:

```bash
npm run build
openclaw gateway restart
```

If you are developing the plugin locally, you can run watch mode to auto-build and restart the gateway on source changes:

```bash
npm run dev
```

Notes:

- `npm run dev` watches `index.ts`, `src/`, and `openclaw.plugin.json`
- On every detected change, it automatically runs `npm run build` and `openclaw gateway restart`

## Verification

Check gateway logs:

```bash
tail -n 50 ~/.openclaw/logs/gateway.log
```

You should see something like:

```text
[otel-plugin] trace exporter enabled (http/protobuf) -> http://localhost:4318/v1/traces
[otel-plugin] metric exporter enabled (http/protobuf) -> http://localhost:4318/v1/write/otel-metrics
[otel-plugin] log exporter disabled
```

If log export is enabled:

```text
[otel-plugin] log exporter enabled (http/protobuf) -> http://localhost:4318/v1/write/otel-logs
[otel-plugin] trace export succeeded -> http://localhost:4318/v1/traces (8ms, items=3)
[otel-plugin] metric export succeeded -> http://localhost:4318/v1/write/otel-metrics (5ms, items=12)
[otel-plugin] log export succeeded -> http://localhost:4318/v1/write/otel-logs (4ms, items=6)
```

If export fails, an error log is also emitted, for example:

```text
[otel-plugin] trace export failed -> http://localhost:4318/v1/traces (13ms, items=2): 401 Unauthorized
[otel-plugin] log export failed -> http://localhost:4318/v1/write/otel-logs (7ms, items=3): 401 Unauthorized
```

Then send a test message in OpenClaw and query in your tracing platform with:

- `service = openclaw-otel-plugin`
- latest `trace_id`

If your receiver supports metrics, you can also query:

- `openclaw.requests`
- `openclaw.request.duration`
- `openclaw.tool.calls`
- `openclaw.tool.errors`
- `openclaw.tool.duration`
- `openclaw.skill.activations`
- `openclaw.model.calls`
- `openclaw.tokens`
- `openclaw.cost.usd`
- `openclaw.run.duration_ms`
- `openclaw.context.tokens`
- `openclaw.webhook.received`
- `openclaw.message.queued`
- `openclaw.message.processed`
- `openclaw.message.duration_ms`
- `openclaw.queue.depth`
- `openclaw.queue.wait_ms`
- `openclaw.session.state`
- `openclaw.session.stuck`
- `openclaw.run.attempt`

If your receiver supports logs, the `otel-logs` route will also contain mirrored OpenClaw diagnostics events such as:

- `session.state`
- `message.queued`
- `model.usage`
- `message.processed`
- `webhook.received`
- `webhook.error`
- `session.stuck`
- `queue.lane.enqueue`

## Trace Notes

- Main trace hierarchy is `openclaw_request -> user_message -> main -> skill:* -> skill_call:* -> tool:* / provider:model -> assistant_message`
- Tool execution exports independent `tool:<name>` spans with attributes such as `openclaw.tool.call_id` and `openclaw.tool.outcome`
- `openclaw.session.stuck` is reported as a diagnostic alert and is not marked as an error
- Skill identification combines session metadata, transcript content, and local skill data under `~/.openclaw/workspace/skills`
- Metrics are split into two groups: plugin-added request/tool/skill/model metrics, and mirrored official `openclaw.*` diagnostics metrics

## FAQ

### 1. No traces received

Check the following in order:

- Whether the OTLP receiver is available
- Whether `endpoint` is configured correctly
- Whether `headers` match the receiver authentication requirements
- Whether the plugin is enabled in `openclaw.json`
- Whether `gateway.log` contains the exporter enabled / export succeeded / export failed log lines
- If validating `otel-logs`, confirm `logsEnabled=true`

### 2. Incomplete skill names

Check:

- Whether the skill exists in session metadata or local workspace skills
- Whether the skill name or description appears in transcript, reasoning, or output
- Whether the gateway has been restarted after adding a local skill

### 3. Configuration not taking effect

Plugin custom config must be placed under:

```text
plugins.entries.openclaw-otel-plugin.config
```

Do not place these fields directly at the plugin entry top level:

- `endpoint`
- `tracePath`
- `metricsPath`
- `logsEnabled`
- `logsPath`
- `headers`
- `agentProvider`
- `globalTags`
- `serviceName`
- `resourceAttributes`
- `flushIntervalMs`
- `rootSpanTtlMs`

## Repository Structure

- `index.ts`: plugin entry
- `src/config.ts`: config parsing
- `src/service.ts`: trace, metrics, and logs generation/export logic
- `src/trace-runtime.js`: runtime helper functions
- `openclaw.plugin.json`: plugin manifest
- `test/trace-runtime.test.mjs`: runtime tests

## Todo

- Add and consolidate `channel` traces
- Refine protocol-level structure and compatibility
