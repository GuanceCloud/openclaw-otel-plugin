# openclaw-otel-plugin

[中文说明](./README_ZH.md)

`openclaw-otel-plugin` exports OpenClaw runtime and diagnostics data to any OTLP HTTP/protobuf receiver. It turns session activity into traces, adds plugin-level metrics, mirrors built-in OpenClaw diagnostics metrics, and can optionally mirror diagnostics events to OTEL logs.

## What It Exports

### Traces

- A session-scoped root span. When `sessionKey` or `sessionId` is available, that value is used as the span name; otherwise it falls back to `openclaw_request`
- A session-scoped run span. When `sessionKey` or `sessionId` is available, that value is used as the span name; otherwise it falls back to `main`
- Runtime spans such as `user_message` and `assistant_message`
- Model spans such as `<provider>/<model>`
- Skill summary spans such as `skill:<name>`
- Skill call spans such as `skill_call:<name>`
- Tool spans such as `tool:<name>`
- Diagnostic spans such as `openclaw.session.stuck`, `openclaw.webhook.received`, `openclaw.webhook.processed`, `openclaw.webhook.error`, `queue.lane.enqueue`, `queue.lane.dequeue`, `diagnostic.heartbeat`, and `tool.loop`

### Metrics

Plugin-added metrics:

- `openclaw.requests`
- `openclaw.request.duration`
- `openclaw.tool.calls`
- `openclaw.tool.errors`
- `openclaw.tool.duration`
- `openclaw.skill.activations`
- `openclaw.model.calls`

Mirrored diagnostics metrics:

- `openclaw.tokens`
- `openclaw.cost.usd`
- `openclaw.run.duration_ms`
- `openclaw.context.tokens`
- `openclaw.webhook.received`
- `openclaw.webhook.error`
- `openclaw.webhook.duration_ms`
- `openclaw.message.queued`
- `openclaw.message.processed`
- `openclaw.message.duration_ms`
- `openclaw.queue.lane.enqueue`
- `openclaw.queue.lane.dequeue`
- `openclaw.queue.depth`
- `openclaw.queue.wait_ms`
- `openclaw.session.state`
- `openclaw.session.stuck`
- `openclaw.session.stuck_age_ms`
- `openclaw.run.attempt`

### Logs

When `logsEnabled=true`, the plugin mirrors diagnostics events to OTEL logs, including:

- `session.state`
- `run.attempt`
- `message.queued`
- `model.usage`
- `message.processed`
- `webhook.received`
- `webhook.processed`
- `webhook.error`
- `session.stuck`
- `queue.lane.enqueue`
- `queue.lane.dequeue`
- `diagnostic.heartbeat`
- `tool.loop`

## Requirements

- OpenClaw `2026.3.23+`
- Node.js `22.x`
- An OTLP HTTP/protobuf receiver

Compatibility notes:

- This repository is adapted to the post-`2026.3.23` OpenClaw plugin entrypoint changes
- It is validated against locally installed OpenClaw `2026.3.23-2`
- Older OpenClaw versions should be upgraded first

## Install

```bash
cd ~/.openclaw/extensions
git clone https://github.com/GuanceDemo/openclaw-otel-plugin.git
cd openclaw-otel-plugin
npm install
npm run build
```

## Configure

Add the plugin to `~/.openclaw/openclaw.json`:

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
          "endpoint": "http://127.0.0.1:4318/otel",
          "tracePath": "v1/traces",
          "metricsPath": "v1/metrics",
          "logsEnabled": false,
          "logsPath": "v1/logs",
          "headers": {
            "Authorization": "Bearer <token>"
          },
          "sampleRate": 1,
          "serviceName": "openclaw-otel-plugin",
          "flushIntervalMs": 15000,
          "rootSpanTtlMs": 600000,
          "resourceAttributes": {
            "agent_provider": "openclaw",
            "env": "prod",
            "app_name":"openclaw-agent",
	          "app_id":"999999990000000000iuui"
          }
        }
      }
    }
  }
}
```

### Config Reference

| Field | Default | Notes |
| --- | --- | --- |
| `endpoint` | `http://127.0.0.1:4318/otel` | Receiver base URL. Trailing `/` is removed automatically |
| `tracePath` | `v1/traces` | Trace route appended to `endpoint` |
| `metricsPath` | `v1/metrics` | Metrics route appended to `endpoint` |
| `logsEnabled` | `false` | Logs are exported only when explicitly enabled |
| `logsPath` | `v1/logs` | Logs route appended to `endpoint` |
| `protocol` | `http/protobuf` | The only supported protocol |
| `serviceName` | `openclaw-otel-plugin` | Exported as OTEL `service.name` |
| `headers` | unset | Fixed HTTP headers applied to traces, metrics, and logs |
| `sampleRate` | unset | Optional root sampler ratio in `[0, 1]` |
| `flushIntervalMs` | `15000` | Metrics export interval |
| `rootSpanTtlMs` | `600000` | Closes stale root/run spans after inactivity |
| `resourceAttributes` | `{ "agent_provider": "openclaw" }` | Fixed OTEL resource attributes |

Compatibility fields still accepted:

- `agentProvider`: compatibility alias for `resourceAttributes.agent_provider`
- `globalTags`: compatibility alias merged into `resourceAttributes`

Resource attributes are resolved in this order:

- runtime metadata discovered from OpenClaw state, when available
- resolved config resource attributes, including the default `agent_provider`, compatibility fields, and explicit `resourceAttributes`

Runtime metadata may contribute:

- `agent_version`
- `runtime_environment`
- `agent_id`
- `agent_name`

## Dataway Example

```json
{
  "plugins": {
    "entries": {
      "openclaw-otel-plugin": {
        "enabled": true,
        "config": {
          "endpoint": "http://<dataway-host>",
          "tracePath": "v1/write/otel-llm",
          "metricsPath": "v1/write/otel-metrics",
          "logsEnabled": true,
          "logsPath": "v1/write/otel-logs",
          "headers": {
            "X-Token": "<your-dataway-client_token>",
            "To-Headless": "true"
          },
          "serviceName": "openclaw-otel-plugin",
          "resourceAttributes": {
            "agent_provider": "openclaw",
            "env": "prod",
            "app_name":"openclaw-agent",
	          "app_id":"999999990000000000iuui"
          }
        }
      }
    }
  }
}
```

Notes:

- Keep `endpoint` as scheme + host + port only
- Put the write routes in `tracePath`, `metricsPath`, and `logsPath`
- `logsEnabled` must be `true` if you want diagnostics logs
- `headers.X-Token` should be a Dataway client token

## Development

```bash
npm run build
npm test
openclaw gateway restart
```

For local development with rebuild + restart:

```bash
npm run dev
```

`npm run dev` watches `index.ts`, `src/`, and `openclaw.plugin.json`, then runs build and gateway restart automatically.

## Verification

Check gateway logs:

```bash
tail -n 50 ~/.openclaw/logs/gateway.log
```

Expected startup logs:

```text
[otel-plugin] trace exporter enabled (http/protobuf) -> http://127.0.0.1:4318/otel/v1/traces
[otel-plugin] metric exporter enabled (http/protobuf) -> http://127.0.0.1:4318/otel/v1/metrics
[otel-plugin] log exporter disabled
```

If logs are enabled:

```text
[otel-plugin] log exporter enabled (http/protobuf) -> http://127.0.0.1:4318/otel/v1/logs
[otel-plugin] trace export succeeded -> ...
[otel-plugin] metric export succeeded -> ...
[otel-plugin] log export succeeded -> ...
```

Then send a test message in OpenClaw and query by:

- `service.name = openclaw-otel-plugin`
- latest `trace_id`

## Behavior Notes

- The plugin enriches spans and logs with session, agent, provider, model, and preview fields derived from OpenClaw session snapshots
- Skill attribution prefers runtime tool identity, then falls back to session skill snapshots, transcript content, and local skill catalogs under `~/.openclaw/workspace/skills`
- Transcript-derived skill spans prefer actually invoked skills over merely mentioned skills
- Tool loop diagnostics are attached to the active tool span when possible; critical loops mark the tool span as error
- Canonical aliases such as `session_id`, `session_key`, `tool_name`, `tool_call_id`, `model_provider`, and `model_name` are emitted for easier querying

## Common Issues

### No data exported

- Check receiver reachability
- Check `endpoint` and signal paths
- Check auth headers
- Check whether the plugin entry is enabled
- Check `gateway.log` for `enabled`, `succeeded`, or `failed` exporter lines

### Logs missing

- Set `logsEnabled=true`
- Make sure the receiver supports OTLP logs
- Check `logsPath` and auth headers separately from trace and metrics routes

### Config not taking effect

Custom fields must live under:

```text
plugins.entries.openclaw-otel-plugin.config
```

Do not place these fields directly beside `enabled`:

- `endpoint`
- `tracePath`
- `metricsPath`
- `logsEnabled`
- `logsPath`
- `headers`
- `sampleRate`
- `serviceName`
- `flushIntervalMs`
- `rootSpanTtlMs`
- `agentProvider`
- `globalTags`
- `resourceAttributes`
