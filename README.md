# openclaw-otel-plugin

`openclaw-otel-plugin` is an OpenClaw observability export plugin. It converts OpenClaw diagnostic events into session-oriented traces, exports supplemental metrics, and reports them to any OpenTelemetry-compatible receiver via `OTLP HTTP/protobuf`.

## Features

- Exports root traces such as `openclaw_request`
- Exports runtime traces such as `main`, `user_message`, and `assistant_message`
- Exports model-, skill-, and tool-related spans
- Exports diagnostic spans such as `openclaw.session.stuck`
- Adds OpenClaw-specific attributes to make troubleshooting easier in tracing platforms
- Exports supplemental metrics such as request count, request duration, tool calls, tool errors, tool duration, skill activations, and model calls
- Mirrors the latest built-in OpenClaw diagnostics metrics such as `openclaw.tokens`, `openclaw.cost.usd`, `openclaw.message.queued`, and `openclaw.queue.depth`

## Requirements

- OpenClaw `2026.3.23+`
- Node.js `22.x`
- A working OTLP HTTP/protobuf receiver
- Default example endpoint: `http://localhost:4317`

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
          "endpoint": "http://localhost:4317",
          "tracePath": "v1/traces",
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
- Traces are exported to `endpoint + / + tracePath`
- Metrics are exported to `/otel/v1/metrics`

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
[otel-plugin] trace exporter enabled (http/protobuf) -> http://localhost:4317/v1/traces
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
- Whether the plugin is enabled in `openclaw.json`
- Whether `gateway.log` contains the exporter enabled log line

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
- `serviceName`
- `resourceAttributes`
- `flushIntervalMs`
- `rootSpanTtlMs`

## Repository Structure

- `index.ts`: plugin entry
- `src/config.ts`: config parsing
- `src/service.ts`: trace and metrics generation/export logic
- `src/trace-runtime.js`: runtime helper functions
- `openclaw.plugin.json`: plugin manifest
- `test/trace-runtime.test.mjs`: runtime tests

## Todo

- Add and consolidate `channel` traces
- Refine protocol-level structure and compatibility
