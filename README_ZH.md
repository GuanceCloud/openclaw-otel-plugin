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
curl -fsSL https://github.com/GuanceCloud/openclaw-otel-plugin/releases/latest/download/install-release.sh -o /tmp/openclaw-otel-plugin-install.sh
chmod +x /tmp/openclaw-otel-plugin-install.sh

/tmp/openclaw-otel-plugin-install.sh latest \
  --type gtrace \
  --endpoint http://<dataway-host> \
  --x-token <client_token> \
  --tag 'agent_id=<你的_agent_id>' \
  --tag 'agent_name=<你的_agent_name>'
```

### 标准 OTLP

```bash
curl -fsSL https://github.com/GuanceCloud/openclaw-otel-plugin/releases/latest/download/install-release.sh -o /tmp/openclaw-otel-plugin-install.sh
chmod +x /tmp/openclaw-otel-plugin-install.sh

/tmp/openclaw-otel-plugin-install.sh latest \
  --type otlp \
  --endpoint http://127.0.0.1:4318/otel \
  --tag 'agent_id=<你的_agent_id>' \
  --tag 'agent_name=<你的_agent_name>'
```

### Windows PowerShell

安装命令与 Qoder 插件保持一致，直接在内存中执行 GitHub Release 的安装器，因此不受本机 `.ps1` 执行策略限制：

```powershell
& ([scriptblock]::Create((irm https://github.com/GuanceCloud/openclaw-otel-plugin/releases/latest/download/install-release.ps1))) `
  -Version latest `
  -Type gtrace `
  -Endpoint "http://<dataway-host>" `
  -XToken "<client_token>" `
  -Tag @(
    "agent_id=<你的_agent_id>",
    "agent_name=<你的_agent_name>"
  )
```

安装特定版本时，将 URL 改为 `releases/download/vX.Y.Z/install-release.ps1`，并传入 `-Version vX.Y.Z`。使用 OSS 时额外传入 `-OssEndpoint "https://<你的-oss-root>"`。不要把真实 token、`agent_id` 或 `agent_name` 写入文档、脚本仓库或问题记录。

### 选择发布版本

未设置 `OSS_ENDPOINT` 时，shell 安装器从 GitHub Releases 下载。使用 OSS 时，下载其 `openclaw-otel-plugin/install.sh`，并在执行时设置 `OSS_ENDPOINT=https://<你的-oss-root>`。安装固定 GitHub 版本时，下载 `releases/download/vX.Y.Z/install-release.sh`，并将第一个参数设为 `vX.Y.Z`。

GitHub 的 `latest` 指向正式版。通过 obs-agent-connector 安装本次候选版：

```bash
obs-agent-connector install openclaw \
  --static-base https://github.com/GuanceCloud/openclaw-otel-plugin/releases/download/v0.8.1-rc.3
```

已发布的 RC 安装器会把传入的 `latest` 解析为安装器自身所属的候选版本，因此兼容连接器的现有调用方式。

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

新采集指标的结果维度 `status` 使用 `ok/error`，历史数据可能仍有旧值。首块延迟 Histogram 可通过 `sum / count` 展示平均值。新增 `gen_ai.client.operation.time_per_output_token` Histogram，仅对能唯一确认流式进度的成功原生模型调用，估算非首 Token 平均耗时；缺少流式证据时没有采样。验证及看板聚合口径见 [指标说明](./docs/gen-ai-metrics.md)。

- 构建与发布：[BUILDING.md](./BUILDING.md)
- 指标清单：[docs/gen-ai-metrics.md](./docs/gen-ai-metrics.md)
- Trace 字段：[docs/gen-ai-trace-tags.md](./docs/gen-ai-trace-tags.md)
- 字段映射：[docs/gen-ai-field-mapping.md](./docs/gen-ai-field-mapping.md)
