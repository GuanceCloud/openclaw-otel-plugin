# openclaw-otel-plugin

[中文说明](./README_ZH.md)
[Changelog](./CHANGELOG.md)

`openclaw-otel-plugin` exports OpenClaw runtime and diagnostics data to any OTLP HTTP/protobuf receiver. It turns session activity into traces, emits the current recommended `gen_ai.*` metrics, and can optionally mirror diagnostics events to OTEL logs.

## What It Exports

### Traces

- A request-scoped root span named `openclaw_request`
- A request-scoped run span named `agent_run`
- Runtime lifecycle spans such as `channel_ingress`, `dispatch_queue`, `session_processing`, `runtime_orchestration`, and `channel_egress`
- Model spans named `llm`
- Skill summary spans such as `skill:<name>`
- Skill call spans such as `skill_call:<name>`
- Tool spans such as `tool:<name>`
- Diagnostic spans for webhook, session health, and tool-loop related events

Trace notes:

- One inbound user message maps to one trace
- `message.processed` replays transcript turns first; trailing `session.state idle` only acts as a fallback close path
- Transcript replay emits one `llm` per assistant turn so multi-tool sessions show `model -> tool -> model` loops instead of one oversized model span

### Metrics

Recommended metric namespaces:

- `gen_ai.client.*`
- `gen_ai.agent.*`
- `gen_ai.runtime.*`

Common metrics include:

- `gen_ai.client.operation.duration` (OTEL-native metric name)
- `gen_ai.agent.token.usage`
- `gen_ai.agent.request.count`
- `gen_ai.agent.request.duration`
- `gen_ai.agent.operation.count`
- `gen_ai.agent.operation.duration`
- `gen_ai.agent.session.token.input`
- `gen_ai.agent.session.token.output`
- `gen_ai.agent.session.token.total`
- `gen_ai.agent.session.trace.count`
- `gen_ai.agent.skill.activation.count`
- `gen_ai.runtime.message.*`
- `gen_ai.runtime.queue.*`
- `gen_ai.runtime.session.*`
- `gen_ai.runtime.webhook.*`

Metric boundary notes:

- `gen_ai.client.*` is reserved for OTEL-native client semantics; the plugin no longer writes custom token or operation metrics there.
- OpenClaw custom model token and model/tool/skill operation metrics are reported under `gen_ai.agent.token.usage` and `gen_ai.agent.operation.*`.

See [docs/gen-ai-metrics.md](./docs/gen-ai-metrics.md) for the full metric catalog.

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

Use the GTrace skill for managed installation. The release output keeps `install.sh` as the single OSS install/upgrade entrypoint used by the skill and manual release delivery; it works for both first-time installs and upgrades without relying on a previous `/tmp` copy, and accepts either `OSS_ENDPOINT=...` or `--oss-endpoint ...` for custom OSS roots. For a standard OTLP receiver, follow the source-install path from [BUILDING.md](./BUILDING.md) and then configure `~/.openclaw/openclaw.json` manually.

Upgrade notes:

- If the plugin is already installed, `install.sh` reuses the existing `~/.openclaw/openclaw.json` values for `endpoint`, `headers.X-Token`, install type, and plugin load path whenever those arguments are omitted.
- In practice, upgrading to `latest` or a pinned version usually does not require repeating `--endpoint`, `--x-token`, or `--type`.

For build, packaging, source install, and release workflow, see [BUILDING.md](./BUILDING.md).

### GTrace

If your agent environment already has the `$openclaw-gtrace-install` skill, use the skill as the recommended quick-install path.

Prompt template:

```text
Use $openclaw-gtrace-install to install the OpenClaw OTEL plugin.

Parameters:
OSS_ENDPOINT=<your GTrace OSS endpoint>
DATAWAY_ENDPOINT=<your GTrace Dataway endpoint>
VERSION=latest
X_TOKEN=<your token>
TAGS=env=prod

Requirements:
- do not print X_TOKEN
- verify the install after completion
- if installation fails, return the failed step, the key error, and the next suggestion
```

To install a specific version, change `VERSION` to `v0.6.7` or another published tag.

If you want to install files first and fill the config later, add:

```text
NO_CONFIG=true
```

If you want to skip the immediate gateway restart, add:

```text
NO_RESTART=true
```

For a standard OTLP receiver, complete the source install first, then use the manual configuration example below.

## Configure

The manual JSON example below uses a standard OTLP HTTP/protobuf receiver.

Manual configuration is only needed when:

- you installed with `--no-config`
- you want to customize advanced fields

Minimal example in `~/.openclaw/openclaw.json`:

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
          "flushIntervalMs": 30000,
          "rootSpanTtlMs": 600000,
          "resourceAttributes": {
            "agent_runtime": "openclaw",
            "env": "prod"
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
| `flushIntervalMs` | `30000` | Metrics export interval |
| `rootSpanTtlMs` | `600000` | Closes stale root/run spans after inactivity |
| `resourceAttributes` | `{ "agent_runtime": "openclaw" }` | Fixed OTEL resource attributes; every `--tag key=value` is merged here |

Compatibility fields still accepted:

- `globalTags`: compatibility alias merged into `resourceAttributes`

Resource attributes are resolved in this order:

- runtime metadata discovered from OpenClaw state, when available
- resolved config resource attributes, including the default `agent_runtime`, compatibility fields, and explicit `resourceAttributes`

Runtime metadata may contribute:

- `agent_version`
- `runtime_environment`

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
            "agent_runtime": "openclaw",
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
- Root and run spans are intentionally separate. The root span models the inbound request envelope, while `agent_run` models the agent execution lifecycle.
- When fine-grained runtime events are missing, the plugin can replay transcript state to backfill `thinking`, model, and tool spans.
- The plugin periodically scans active sessions on the `flushIntervalMs` cadence (default `30s`); session metrics are emitted as scan-time deltas and carry `session_id` as a metric tag.
- `gen_ai.agent.session.token.*` and `gen_ai.agent.session.trace.count` represent session-level cumulative totals instead of being tied to individual run completion.
- `gen_ai.agent.session.token.*` is accumulated from runtime `model.usage` events first, so it does not depend on transcript `message.usage` being persisted.
- Skill attribution prefers runtime tool identity, then falls back to session skill snapshots, transcript content, and local skill catalogs under `~/.openclaw/workspace/skills`
- Transcript-derived skill spans prefer actually invoked skills over merely mentioned skills
- If no skill identity can be inferred, the plugin will keep tool spans without fabricating a generic skill span.
- Tool loop diagnostics are attached to the active tool span when possible; critical loops mark the tool span as error
- Canonical query fields such as `session_id`, `session_key`, `tool_name`, `tool_call_id`, `provider_name`, and `request_model` are emitted for easier querying

## Common Issues

### No data exported

- Check receiver reachability
- Check `endpoint` and signal paths
- Check auth headers
- Check whether the plugin entry is enabled
- Check `gateway.log` for `enabled`, `succeeded`, or `failed` exporter lines
- When debugging trace parent/child links or missing `run_id`, enable `tracePayloadDebugEnabled=true` to log the full trace export payload before OTLP export

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
- `globalTags`
- `resourceAttributes`
