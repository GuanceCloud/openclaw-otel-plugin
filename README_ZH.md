# openclaw-otel-plugin

[English](./README.md)
[变更记录](./CHANGELOG.md)

`openclaw-otel-plugin` 用于把 OpenClaw 的运行时和诊断数据导出到 OTLP HTTP/protobuf 接收端。它会输出 traces、当前推荐的 `gen_ai.*` metrics，以及可选的 OTEL logs。

## 环境要求

- OpenClaw `2026.3.23+`
- Node.js `22.x`
- 一个可用的 OTLP HTTP/protobuf 接收端

## 安装

`install.sh` 是唯一的 OSS 安装/升级入口，首次安装和升级都使用它。

### GTrace

```bash
curl -fsSL https://<你的-oss-root>/openclaw-otel-plugin/install.sh -o /tmp/openclaw-otel-plugin-install.sh
chmod +x /tmp/openclaw-otel-plugin-install.sh

OSS_ENDPOINT=https://<你的-oss-root> \
/tmp/openclaw-otel-plugin-install.sh latest \
  --type gtrace \
  --endpoint http://<dataway-host> \
  --x-token <client_token> \
  --tag env=prod
```

### 标准 OTLP

```bash
curl -fsSL https://<你的-oss-root>/openclaw-otel-plugin/install.sh -o /tmp/openclaw-otel-plugin-install.sh
chmod +x /tmp/openclaw-otel-plugin-install.sh

OSS_ENDPOINT=https://<你的-oss-root> \
/tmp/openclaw-otel-plugin-install.sh latest \
  --type otlp \
  --endpoint http://127.0.0.1:4318/otel \
  --tag env=prod
```

### 源码安装

源码安装、构建、打包和发布流程见 [BUILDING.md](./BUILDING.md)。

## 升级

如果插件已经安装，`install.sh` 会自动复用现有 `~/.openclaw/openclaw.json` 里的：

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

正常启动时应看到：

```text
[otel-plugin] trace exporter enabled (http/protobuf) -> ...
[otel-plugin] metric exporter enabled (http/protobuf) -> ...
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
