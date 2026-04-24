# openclaw-otel-plugin

[English](./README.md)

`openclaw-otel-plugin` 用于把 OpenClaw 的运行时事件和诊断事件导出到任意兼容 `OTLP HTTP/protobuf` 的接收端。它会把会话过程整理成 trace，补充插件侧 metrics，镜像 OpenClaw 内建 diagnostics metrics，并可选地把 diagnostics 事件同步为 OTEL logs。

## 导出内容

### Traces

- 会话级 root span：有 `sessionKey` 或 `sessionId` 时直接用它作为 span 名称，否则回退为 `openclaw_request`
- 会话级 run span：有 `sessionKey` 或 `sessionId` 时直接用它作为 span 名称，否则回退为 `main`
- 运行时 span，例如 `user_message`、`assistant_message`
- 模型 span，例如 `<provider>/<model>`
- Skill 汇总 span，例如 `skill:<name>`
- Skill 调用 span，例如 `skill_call:<name>`
- Tool span，例如 `tool:<name>`
- 诊断 span，例如 `openclaw.session.stuck`、`openclaw.webhook.received`、`openclaw.webhook.processed`、`openclaw.webhook.error`、`queue.lane.enqueue`、`queue.lane.dequeue`、`diagnostic.heartbeat`、`tool.loop`

### Metrics

插件补充指标：

- `openclaw.requests`
- `openclaw.request.duration`
- `openclaw.tool.calls`
- `openclaw.tool.errors`
- `openclaw.tool.duration`
- `openclaw.skill.activations`
- `openclaw.model.calls`

镜像 diagnostics 指标：

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

当 `logsEnabled=true` 时，插件会把以下 diagnostics 事件镜像到 OTEL logs：

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

## 环境要求

- OpenClaw `2026.3.23+`
- Node.js `22.x`
- 一个可用的 `OTLP HTTP/protobuf` 接收端

兼容性说明：

- 当前仓库已适配 OpenClaw `2026.3.23` 之后的插件入口变更
- 已在本机安装的 OpenClaw `2026.3.23-2` 上验证
- 更早版本建议先升级再使用

## 安装

```bash
cd ~/.openclaw/extensions
git clone https://github.com/GuanceDemo/openclaw-otel-plugin.git
cd openclaw-otel-plugin
npm install
npm run build
```

## 配置

在 `~/.openclaw/openclaw.json` 中加入：

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

### 配置项说明

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `endpoint` | `http://127.0.0.1:4318/otel` | 接收端基础地址，结尾多余 `/` 会被自动去掉 |
| `tracePath` | `v1/traces` | trace 写入路径，会追加到 `endpoint` 后面 |
| `metricsPath` | `v1/metrics` | metrics 写入路径，会追加到 `endpoint` 后面 |
| `logsEnabled` | `false` | 只有显式开启后才导出 OTEL logs |
| `logsPath` | `v1/logs` | logs 写入路径，会追加到 `endpoint` 后面 |
| `protocol` | `http/protobuf` | 当前唯一支持的协议 |
| `serviceName` | `openclaw-otel-plugin` | 会作为 OTEL `service.name` 导出 |
| `headers` | 未设置 | 对 traces、metrics、logs 统一附加的 HTTP Header |
| `sampleRate` | 未设置 | 可选采样率，取值范围 `[0, 1]` |
| `flushIntervalMs` | `15000` | metrics 周期导出间隔 |
| `rootSpanTtlMs` | `600000` | root/run span 长时间无活动后自动收尾 |
| `resourceAttributes` | `{ "agent_provider": "openclaw" }` | 固定 OTEL resource attributes |

兼容字段仍然支持：

- `agentProvider`：`resourceAttributes.agent_provider` 的兼容别名
- `globalTags`：会被折叠合并进 `resourceAttributes`

resource attributes 合并顺序：

- 从 OpenClaw 状态目录解析出的运行时元数据（如果能识别）
- 解析后的配置资源属性，其中包含默认 `agent_provider`、兼容字段，以及显式配置的 `resourceAttributes`

运行时元数据可能补充这些字段：

- `agent_version`
- `runtime_environment`
- `agent_id`
- `agent_name`

## Dataway 配置示例

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

说明：

- `endpoint` 只写协议、域名和端口
- Dataway 写入路由放在 `tracePath`、`metricsPath`、`logsPath`
- 要导出 diagnostics logs 时必须设置 `logsEnabled=true`
- `headers.X-Token` 应使用 Dataway `client_token`

## 开发

```bash
npm run build
npm test
openclaw gateway restart
```

本地开发可直接使用：

```bash
npm run dev
```

`npm run dev` 会监听 `index.ts`、`src/` 和 `openclaw.plugin.json`，检测变更后自动重新 build 并重启 gateway。

## 验证

查看网关日志：

```bash
tail -n 50 ~/.openclaw/logs/gateway.log
```

正常启动时应看到：

```text
[otel-plugin] trace exporter enabled (http/protobuf) -> http://127.0.0.1:4318/otel/v1/traces
[otel-plugin] metric exporter enabled (http/protobuf) -> http://127.0.0.1:4318/otel/v1/metrics
[otel-plugin] log exporter disabled
```

如果开启了日志导出：

```text
[otel-plugin] log exporter enabled (http/protobuf) -> http://127.0.0.1:4318/otel/v1/logs
[otel-plugin] trace export succeeded -> ...
[otel-plugin] metric export succeeded -> ...
[otel-plugin] log export succeeded -> ...
```

然后在 OpenClaw 里发一条测试消息，再按以下条件检索：

- `service.name = openclaw-otel-plugin`
- 最新 `trace_id`

## 行为说明

- 插件会从 OpenClaw 会话快照里补齐 session、agent、provider、model，以及输入/输出预览等属性
- Skill 归因优先使用运行时 tool 身份，其次回退到会话技能快照、transcript 内容和 `~/.openclaw/workspace/skills` 下的本地技能目录
- transcript 推导 skill 时，优先使用“实际调用过的 skill”，而不是只在文本里提到过的 skill
- `tool.loop` 事件如果能命中活跃 tool span，会直接回写到该 tool span；`critical` 级别会把 tool span 标记为 error
- 导出时会补一组便于查询的别名字段，例如 `session_id`、`session_key`、`tool_name`、`tool_call_id`、`model_provider`、`model_name`

## 常见问题

### 没有数据上报

- 检查接收端是否可达
- 检查 `endpoint` 和各信号路径是否正确
- 检查鉴权 Header
- 检查插件条目是否启用
- 检查 `gateway.log` 中是否出现 exporter 的 `enabled`、`succeeded`、`failed` 日志

### 没有 logs

- 确认已设置 `logsEnabled=true`
- 确认接收端支持 OTLP logs
- 单独检查 `logsPath` 与 logs 鉴权 Header

### 配置不生效

自定义配置必须放在：

```text
plugins.entries.openclaw-otel-plugin.config
```

不要把这些字段直接写在 `enabled` 同级：

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
