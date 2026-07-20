# openclaw-otel-plugin

[English](./README.md)
[变更记录](./CHANGELOG.md)

`openclaw-otel-plugin` 用于把 OpenClaw 的运行时和诊断数据导出到 OTLP HTTP/protobuf 接收端。它会输出 traces、当前推荐的 `gen_ai.workflow.duration` / `gen_ai.client.*` metrics，以及可选的 OTEL logs。

## 环境要求

- OpenClaw `2026.3.23+`
- Node.js `22.x`
- 一个可用的 OTLP HTTP/protobuf 接收端

## 安装

Linux/macOS 使用 `install.sh`，Windows 使用 `install.ps1`；二者都支持首次安装和升级。

### GTrace

```bash
curl -fsSL https://<你的-oss-root>/openclaw-otel-plugin/install.sh -o /tmp/openclaw-otel-plugin-install.sh
chmod +x /tmp/openclaw-otel-plugin-install.sh

OSS_ENDPOINT=https://<你的-oss-root> \
/tmp/openclaw-otel-plugin-install.sh latest \
  --type gtrace \
  --endpoint http://<dataway-host> \
  --x-token <client_token> \
  --tag 'agent_id=<你的_agent_id>' \
  --tag 'agent_name=<你的_agent_name>'
```

### 标准 OTLP

```bash
curl -fsSL https://<你的-oss-root>/openclaw-otel-plugin/install.sh -o /tmp/openclaw-otel-plugin-install.sh
chmod +x /tmp/openclaw-otel-plugin-install.sh

OSS_ENDPOINT=https://<你的-oss-root> \
/tmp/openclaw-otel-plugin-install.sh latest \
  --type otlp \
  --endpoint http://127.0.0.1:4318/otel \
  --tag 'agent_id=<你的_agent_id>' \
  --tag 'agent_name=<你的_agent_name>'
```

### Windows PowerShell

从 GitHub Release 安装 prerelease 时必须指定准确版本；GitHub 的 `releases/latest` 不会指向 prerelease。下面的执行策略调整仅对当前 PowerShell 窗口生效，关闭窗口后自动恢复：

```powershell
$version = "v0.7.1-rc"
$releaseBase = "https://github.com/GuanceCloud/openclaw-otel-plugin/releases/download/$version"
$installer = "$env:TEMP\openclaw-otel-plugin-install.ps1"

Invoke-WebRequest "$releaseBase/install.ps1" -OutFile $installer
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
Unblock-File $installer

& $installer `
  "$releaseBase/openclaw-otel-plugin-$version.tar.gz" `
  -Type gtrace `
  -Endpoint "http://<dataway-host>" `
  -XToken "<client_token>" `
  -Tag @(
    "agent_id=<你的_agent_id>",
    "agent_name=<你的_agent_name>"
  )
```

使用 OSS 时，将安装器下载地址改为 `https://<你的-oss-root>/openclaw-otel-plugin/install.ps1`，并以 `latest -OssEndpoint "https://<你的-oss-root>"` 作为安装器的前两个参数。不要把真实 token、`agent_id` 或 `agent_name` 写入文档、脚本仓库或问题记录。

### 源码安装

源码安装、构建、打包和发布流程见 [BUILDING.md](./BUILDING.md)。

## 升级

如果插件已经安装，安装器会自动复用现有配置，并保留已有的 `config.enabled` 开关值：

- `endpoint`
- `headers.X-Token`
- 安装类型
- 插件加载路径

常用参数：

- `--no-config`：只安装文件，不写配置
- `--no-restart`：跳过立即重启 gateway

## 配置

只有在下面这些场景才需要手动配置：

- 安装时使用了 `--no-config`
- 需要自定义 header 或非默认路由

`~/.openclaw/openclaw.json` 最小示例：

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

关键字段：

- `enabled`（`config` 内）：插件 telemetry 总开关；`true` 时注册 hook 并上报 traces/metrics，`false` 时不注册 hook、不启动 exporter，也不上报数据
- `endpoint`：接收端基础地址
- `tracePath`：trace 写入路径
- `metricsPath`：metrics 写入路径
- `logsEnabled`：是否开启 OTEL logs
- `logsPath`：logs 写入路径
- `headers`：统一 HTTP Header
- `resourceAttributes`：固定 OTEL resource attributes

兼容字段仍然支持：

- `globalTags`：会被合并进 `resourceAttributes`

## 验证

查看 gateway 日志：

```bash
tail -n 50 ~/.openclaw/logs/gateway.log
```

Windows PowerShell 可使用：

```powershell
Get-Content "$HOME\.openclaw\logs\gateway.log" -Tail 50
```

正常启动时应看到：

```text
[otel-plugin] trace exporter enabled (http/protobuf) -> ...
[otel-plugin] metric exporter enabled (http/protobuf) -> ...
```

当 `config.enabled` 为 `false` 时应看到：

```text
[otel-plugin] disabled by config; hooks and telemetry exporters were not started
```

如果开启了日志导出，还应看到：

```text
[otel-plugin] log exporter enabled (http/protobuf) -> ...
[otel-plugin] trace export succeeded -> ...
[otel-plugin] metric export succeeded -> ...
```

## 文档

- 构建与发布：[BUILDING.md](./BUILDING.md)
- 指标清单：[docs/gen-ai-metrics.md](./docs/gen-ai-metrics.md)
- Trace 字段：[docs/gen-ai-trace-tags.md](./docs/gen-ai-trace-tags.md)
- 字段映射：[docs/gen-ai-field-mapping.md](./docs/gen-ai-field-mapping.md)
