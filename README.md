# openclaw-otel-plugin

[中文说明](./README_ZH.md)
[Changelog](./CHANGELOG.md)

`openclaw-otel-plugin` exports OpenClaw runtime and diagnostics data to an OTLP HTTP/protobuf receiver. It emits traces, the current recommended `gen_ai.workflow.duration` / `gen_ai.client.*` metrics, and optional OTEL logs.

## Requirements

- OpenClaw `2026.3.23+`
- Node.js `22.x`
- An OTLP HTTP/protobuf receiver

## Install

Use `install.sh` on Linux/macOS and `install.ps1` on Windows. Both support first-time installs and upgrades.

### GTrace

```bash
curl -fsSL https://<your-oss-root>/openclaw-otel-plugin/install.sh -o /tmp/openclaw-otel-plugin-install.sh
chmod +x /tmp/openclaw-otel-plugin-install.sh

OSS_ENDPOINT=https://<your-oss-root> \
/tmp/openclaw-otel-plugin-install.sh latest \
  --type gtrace \
  --endpoint http://<dataway-host> \
  --x-token <client_token> \
  --tag 'agent_id=<your_agent_id>' \
  --tag 'agent_name=<your_agent_name>'
```

### Standard OTLP

```bash
curl -fsSL https://<your-oss-root>/openclaw-otel-plugin/install.sh -o /tmp/openclaw-otel-plugin-install.sh
chmod +x /tmp/openclaw-otel-plugin-install.sh

OSS_ENDPOINT=https://<your-oss-root> \
/tmp/openclaw-otel-plugin-install.sh latest \
  --type otlp \
  --endpoint http://127.0.0.1:4318/otel \
  --tag 'agent_id=<your_agent_id>' \
  --tag 'agent_name=<your_agent_name>'
```

### Windows PowerShell

The command matches the Qoder plugin flow and executes the GitHub Release installer in memory, avoiding local `.ps1` execution-policy restrictions:

```powershell
& ([scriptblock]::Create((irm https://github.com/GuanceCloud/openclaw-otel-plugin/releases/latest/download/install-release.ps1))) `
  -Version latest `
  -Type gtrace `
  -Endpoint "http://<dataway-host>" `
  -XToken "<client_token>" `
  -Tag @(
    "agent_id=<your_agent_id>",
    "agent_name=<your_agent_name>"
  )
```

For a pinned version, use `releases/download/vX.Y.Z/install-release.ps1` with `-Version vX.Y.Z`. For OSS delivery, additionally pass `-OssEndpoint "https://<your-oss-root>"`. Never place real tokens, `agent_id`, or `agent_name` values in documentation, source-controlled scripts, or issue reports.

### Source Install

Source install, build, packaging, and release steps are in [BUILDING.md](./BUILDING.md).

## Upgrade

For upgrades, the installer reuses the existing settings below and preserves the existing `config.enabled` value:

- `endpoint`
- `headers.X-Token`
- install type
- plugin load path

Common flags:

- `--no-config`: install files only
- `--no-restart`: skip the immediate gateway restart

## Configure

Manual configuration is only needed when:

- you installed with `--no-config`
- you need custom headers or non-default routes

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
          "enabled": true,
          "endpoint": "http://127.0.0.1:4318/otel",
          "tracePath": "v1/traces",
          "metricsPath": "v1/metrics",
          "logsEnabled": false,
          "logsPath": "v1/logs",
          "headers": {
            "Authorization": "Bearer <token>"
          },
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

Key fields:

- `enabled` (inside `config`): telemetry master switch; `true` registers hooks and exports traces/metrics, while `false` starts no hooks or exporters and sends no telemetry
- `endpoint`: receiver base URL
- `tracePath`: trace route
- `metricsPath`: metrics route
- `logsEnabled`: enable OTEL logs
- `logsPath`: logs route
- `headers`: shared HTTP headers
- `resourceAttributes`: fixed OTEL resource attributes

Compatibility field still accepted:

- `globalTags`: merged into `resourceAttributes`

## Verify

Check gateway logs:

```bash
tail -n 50 ~/.openclaw/logs/gateway.log
```

On Windows PowerShell:

```powershell
Get-Content "$HOME\.openclaw\logs\gateway.log" -Tail 50
```

When `config.enabled` is `false`, expect:

```text
[otel-plugin] disabled by config; hooks and telemetry exporters were not started
```

Expected startup lines:

```text
[otel-plugin] trace exporter enabled (http/protobuf) -> ...
[otel-plugin] metric exporter enabled (http/protobuf) -> ...
```

If logs are enabled, you should also see:

```text
[otel-plugin] log exporter enabled (http/protobuf) -> ...
[otel-plugin] trace export succeeded -> ...
[otel-plugin] metric export succeeded -> ...
```

## Documents

- Build and release: [BUILDING.md](./BUILDING.md)
- Metrics catalog: [docs/gen-ai-metrics.md](./docs/gen-ai-metrics.md)
- Trace tags: [docs/gen-ai-trace-tags.md](./docs/gen-ai-trace-tags.md)
- Field mapping: [docs/gen-ai-field-mapping.md](./docs/gen-ai-field-mapping.md)
