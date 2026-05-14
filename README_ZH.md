# openclaw-otel-plugin

[English](./README.md)
[变更记录](./CHANGELOG.md)

`openclaw-otel-plugin` 用于把 OpenClaw 的运行时事件和诊断事件导出到任意兼容 `OTLP HTTP/protobuf` 的接收端。它会把会话过程整理成 trace，上报当前推荐的 `gen_ai.*` 指标，并可选地把 diagnostics 事件同步为 OTEL logs。

## 导出内容

### Traces

- 按单条用户消息生成的 root span：固定命名为 `openclaw_request`
- 按单条用户消息生成的 run span：固定命名为 `agent_run`
- 运行时生命周期 span，例如 `channel_ingress`、`dispatch_queue`、`session_processing`、`runtime_orchestration`、`channel_egress`
- 模型 span：固定命名为 `llm`
- Skill 汇总 span，例如 `skill:<name>`
- Skill 调用 span，例如 `skill_call:<name>`
- Tool span，例如 `tool:<name>`
- 诊断类 span，例如 webhook、session 健康和 tool loop 相关事件

Trace 说明：

- 一条入站用户消息对应一条 trace
- `message.processed` 会优先按 transcript 回放完整 turn；后续 `session.state idle` 只作为 fallback 收尾
- transcript 回放会按 assistant turn 逐个产出 `llm`，多工具会话会显示成 `model -> tool -> model` 循环，而不是一个超长模型 span

### Metrics

当前推荐使用的指标命名空间：

- `gen_ai.client.*`
- `gen_ai.agent.*`
- `gen_ai.runtime.*`

常用指标包括：

- `gen_ai.client.operation.duration`（OTEL 原生指标名）
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

指标边界说明：

- `gen_ai.client.*` 保留给 OTEL 原生 client 语义；插件不再向这里写自定义 token 或 operation 指标
- OpenClaw 自定义的模型 token 和 model / tool / skill operation 指标统一写到 `gen_ai.agent.token.usage` 与 `gen_ai.agent.operation.*`

完整指标清单见 [docs/gen-ai-metrics.md](./docs/gen-ai-metrics.md)。

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

推荐直接安装 release 包，不要求目标机器具备 Node.js 构建环境。
安装脚本现在会自动把插件注册到 `~/.openclaw/openclaw.json`，并且可以在安装时顺手写入 OTLP endpoint。

构建、打包、源码安装和发布流程见 [BUILDING.md](./BUILDING.md)。

### 方式一：快速安装

```bash
rm -f /tmp/openclaw-otel-plugin-install.sh && \
curl -fsSL -o /tmp/openclaw-otel-plugin-install.sh \
  https://raw.githubusercontent.com/GuanceCloud/openclaw-otel-plugin/main/scripts/install.sh && \
bash /tmp/openclaw-otel-plugin-install.sh latest --endpoint http://127.0.0.1:4318/otel
```

安装观测云 GTrace：

```bash
rm -f /tmp/openclaw-otel-plugin-install.sh && \
curl -fsSL -o /tmp/openclaw-otel-plugin-install.sh \
  https://raw.githubusercontent.com/GuanceCloud/openclaw-otel-plugin/main/scripts/install.sh && \
bash /tmp/openclaw-otel-plugin-install.sh latest \
  --type gtrace \
  --endpoint https://llm-openway.guance.com \
  --x-token agent_xxx \
  --tag env=prod
```

也可以安装指定版本：

```bash
rm -f /tmp/openclaw-otel-plugin-install.sh && \
curl -fsSL -o /tmp/openclaw-otel-plugin-install.sh \
  https://raw.githubusercontent.com/GuanceCloud/openclaw-otel-plugin/main/scripts/install.sh && \
bash /tmp/openclaw-otel-plugin-install.sh v0.6.0 --endpoint http://127.0.0.1:4318/otel
```

如果只是先安装，稍后再补 endpoint：

```bash
rm -f /tmp/openclaw-otel-plugin-install.sh && \
curl -fsSL -o /tmp/openclaw-otel-plugin-install.sh \
  https://raw.githubusercontent.com/GuanceCloud/openclaw-otel-plugin/main/scripts/install.sh && \
bash /tmp/openclaw-otel-plugin-install.sh latest
```

### 方式二：安装本地打包产物

```bash
bash scripts/install.sh ./output/openclaw-otel-plugin-v0.6.0.tar.gz
```

安装本地包时也可以一并写入 endpoint：

```bash
bash scripts/install.sh ./output/openclaw-otel-plugin-v0.6.0.tar.gz --endpoint http://127.0.0.1:4318/otel
```

本地包安装到观测云 GTrace：

```bash
bash scripts/install.sh ./output/openclaw-otel-plugin-v0.6.0.tar.gz \
  --type gtrace \
  --endpoint https://llm-openway.guance.com \
  --x-token agent_xxx \
  --tag env=prod
```

## 升级

升级逻辑和安装一致，默认拉取最新 release 并覆盖安装目录：

```bash
bash scripts/update.sh
```

指定版本升级：

```bash
bash scripts/update.sh v0.6.0
```

如果只想安装文件、不立即重启 gateway：

```bash
bash scripts/update.sh latest --no-restart
```

## 配置

如果安装时已经传了 `--endpoint`，脚本会自动写入最小可用配置。
如果安装时传了 `--type gtrace`，脚本还会自动写入观测云专用的 OTLP 路径和请求头。

只有在下面这些场景才需要手动配置：

- 安装时没有填写 endpoint
- 需要补充高级配置
- 安装时使用了 `--no-config`

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

`--type gtrace` 自动写入示例：

```json
{
  "plugins": {
    "entries": {
      "openclaw-otel-plugin": {
        "config": {
          "endpoint": "https://llm-openway.guance.com",
          "tracePath": "v1/write/otel-llm",
          "metricsPath": "v1/write/otel-metrics",
          "logsEnabled": false,
          "logsPath": "v1/write/otel-logs",
          "headers": {
            "X-Token": "agent_xxx",
            "to_headless": "true"
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

### 配置项说明

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `endpoint` | `http://127.0.0.1:4318/otel` | 接收端基础地址，结尾多余 `/` 会被自动去掉 |
| `type` | 未设置 | 当值为 `gtrace` 时，安装脚本要求必须传入 `endpoint` 和 `X-Token`，并自动写入观测云专用 OTLP 路径 |
| `tracePath` | `v1/traces` | trace 写入路径，会追加到 `endpoint` 后面 |
| `metricsPath` | `v1/metrics` | metrics 写入路径，会追加到 `endpoint` 后面 |
| `logsEnabled` | `false` | 只有显式开启后才导出 OTEL logs |
| `logsPath` | `v1/logs` | logs 写入路径，会追加到 `endpoint` 后面 |
| `protocol` | `http/protobuf` | 当前唯一支持的协议 |
| `serviceName` | `openclaw-otel-plugin` | 会作为 OTEL `service.name` 导出 |
| `headers` | 未设置 | 对 traces、metrics、logs 统一附加的 HTTP Header |
| `headers.X-Token` | 未设置 | `--type gtrace` 时必填 |
| `sampleRate` | 未设置 | 可选采样率，取值范围 `[0, 1]` |
| `flushIntervalMs` | `30000` | metrics 周期导出间隔 |
| `rootSpanTtlMs` | `600000` | root/run span 长时间无活动后自动收尾 |
| `resourceAttributes` | `{ "agent_runtime": "openclaw" }` | 固定 OTEL resource attributes；每个 `--tag key=value` 都会合并到这里。`type=gtrace` 时会默认移除 `app_name` 和 `app_id` |

兼容字段仍然支持：

- `globalTags`：会被折叠合并进 `resourceAttributes`

resource attributes 合并顺序：

- 从 OpenClaw 状态目录解析出的运行时元数据（如果能识别）
- 解析后的配置资源属性，其中包含默认 `agent_runtime`、兼容字段，以及显式配置的 `resourceAttributes`

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

说明：

- `endpoint` 只写协议、域名和端口
- Dataway 写入路由放在 `tracePath`、`metricsPath`、`logsPath`
- 要导出 diagnostics logs 时必须设置 `logsEnabled=true`
- `headers.X-Token` 应使用 Dataway `client_token`

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
- root 和 run 是两层有意分开的会话级 span：前者表示请求入口，后者表示 `agent_run` 执行生命周期
- 当运行时缺少细粒度事件时，插件会回放 transcript 状态来补 `thinking`、model 和 tool spans
- 插件会在启动后开始对激活中的 session 做周期扫描，按 `flushIntervalMs` 周期继续扫描，默认周期是 `30s`；session 指标按扫描结果增量上报，并带上 `session_id` tag
- `gen_ai.agent.session.token.*` 和 `gen_ai.agent.session.trace.count` 统计的是 session 级累计值，不再绑定单次 run 结束时机
- `gen_ai.agent.session.token.*` 的累计值优先来自运行时 `model.usage` 事件，不依赖 transcript 中的 `message.usage` 是否落盘
- Skill 归因优先使用运行时 tool 身份，其次回退到会话技能快照、transcript 内容和 `~/.openclaw/workspace/skills` 下的本地技能目录
- transcript 推导 skill 时，优先使用“实际调用过的 skill”，而不是只在文本里提到过的 skill
- 如果无法推导出 skill 身份，插件会保留 tool spans，但不会凭空制造一个通用 skill span
- `tool.loop` 事件如果能命中活跃 tool span，会直接回写到该 tool span；`critical` 级别会把 tool span 标记为 error
- 导出时统一使用 canonical 查询字段，例如 `session_id`、`session_key`、`tool_name`、`tool_call_id`、`provider_name`、`request_model`

## 常见问题

### 没有数据上报

- 检查接收端是否可达
- 检查 `endpoint` 和各信号路径是否正确
- 检查鉴权 Header
- 检查插件条目是否启用
- 检查 `gateway.log` 中是否出现 exporter 的 `enabled`、`succeeded`、`failed` 日志
- 如果要排查 trace 父子关系或 `run_id` 缺失，开启 `tracePayloadDebugEnabled=true`，让插件在 OTLP 导出前打印完整 trace payload

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
- `globalTags`
- `resourceAttributes`
