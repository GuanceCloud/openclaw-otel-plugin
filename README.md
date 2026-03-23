# openclaw-otel-plugin

`openclaw-otel-plugin` is an OpenClaw trace export plugin. It converts OpenClaw diagnostic events into session-oriented traces and reports them to any OpenTelemetry-compatible receiver via `OTLP HTTP/protobuf`.

## Features

- Exports root traces such as `openclaw_request`
- Exports runtime traces such as `main`, `user_message`, and `assistant_message`
- Exports model- and skill-related spans
- Exports diagnostic events such as `openclaw.session.stuck`
- Adds OpenClaw-specific attributes to make troubleshooting easier in tracing platforms

## Requirements

- OpenClaw `2026.3.12+`
- Node.js `22.x`
- A working OTLP HTTP/protobuf receiver
- Default example endpoint: `http://localhost:4317`

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
[openclaw-otel-plugin] trace exporter enabled (http/protobuf) -> http://localhost:4317/v1/traces
```

Then send a test message in OpenClaw and query in your tracing platform with:

- `service = openclaw-otel-plugin`
- Latest `trace_id`

## Trace Notes

- Main trace hierarchy is `openclaw_request -> user_message -> main -> skill:* -> tool:* / provider:model -> assistant_message`
- Tool execution exports independent `tool:<name>` spans with attributes such as `openclaw.tool.call_id` and `openclaw.tool.outcome`
- `openclaw.session.stuck` is currently reported as a diagnostic alert and is no longer marked as an error
- Skill identification combines session metadata, transcript content, and local skill data under `~/.openclaw/workspace/skills`

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
- Whether the skill name or description appears in transcript / reasoning / output
- Whether the gateway has been restarted after adding a local skill

### 3. Configuration not taking effect

Plugin custom config must be placed under:

```text
plugins.entries.openclaw-otel-plugin.config
```

Do not place these fields directly at the plugin entry top level:

- `endpoint`
- `serviceName`
- `resourceAttributes`
- `flushIntervalMs`
- `rootSpanTtlMs`

## Repository Structure

- `index.ts`: plugin entry
- `src/config.ts`: config parsing
- `src/service.ts`: trace generation and export logic
- `src/trace-runtime.js`: runtime helper functions
- `openclaw.plugin.json`: plugin manifest
- `test/trace-runtime.test.mjs`: runtime tests

## Todo

- Add and consolidate `channel` traces
- Add and export `OpenClaw` metrics
- Refine protocol-level structure and compatibility
