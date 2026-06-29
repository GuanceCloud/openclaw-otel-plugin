# GTrace 数据协议

## 概述

GTrace 是在标准 OTLP 基础上扩展的 telemetry 数据上报协议。通过 HTTP 接收端收集 trace 和 metric 数据，用于构建 Agent / AI 应用的可观测管线。

核心特点：

- 数据格式兼容 OTLP/Protobuf，可直接使用标准 OpenTelemetry SDK
- 使用自定义 HTTP 路径区分信号
- 通过自定义 Header 传递鉴权和配置信息
- 不限制 agent runtime，任何语言/框架的 agent 均可接入

## 信号路径

GTrace 按信号类型使用不同的 HTTP POST 路径：

| 信号     | 路径                         | 说明                         |
| -------- | ---------------------------- | ---------------------------- |
| Traces   | `v1/write/otel-llm`          | 接收 OTLP trace 数据 (protobuf) |
| Metrics  | `v1/write/otel-metrics`      | 接收 OTLP metric 数据 (protobuf) |
| Logs     | `v1/write/otel-logs`         | 接收 OTLP log 数据 (protobuf)，可选 |

完整 URL：`<DATAWAY_ENDPOINT>/<path>`，例如 `https://dataway.example.com/v1/write/otel-llm`。

## HTTP Headers

### 必需

| Header         | 说明        |
| -------------- | ----------- |
| `Content-Type` | `application/x-protobuf` |
| `X-Token`      | 鉴权令牌，值为 `client_token` |
| `to_headless`  | 必须为 `true`；表示 headless 模式 |

## 数据格式

所有信号均使用 [OTLP/HTTP Protobuf](https://opentelemetry.io/docs/specs/otel/protocol/) 格式：

- Traces：`ExportTraceServiceRequest` protobuf message
- Metrics：`ExportMetricsServiceRequest` protobuf message
- Logs：`ExportLogsServiceRequest` protobuf message（可选）

兼容的标准 OTLP exporter 可直接指向 GTrace 路径使用。也可以使用自定义 HTTP client 构造 protobuf payload 并 POST 到对应路径。

## Resource 级属性

Resource 属性附加在所有 span / metric / log 上，用于标识数据来源。建议设置以下属性：

```json
{
  "service.name": "my-agent",
  "agent_runtime": "my-runtime",
  "agent_version": "1.0.0",
  "runtime_environment": "production",
  "deployment.environment": "prod",
  "agent_type": "assistant",
  "agent_source": "builtin"
}
```

GTrace 强制 headless 模式（`to_headless: true` 为必须），`app_name` 和 `app_id` 会被平台侧自动添加，无需设置。

## Span 设计指南

### Span 层级建议

建议按以下层次组织 span 树，具体 span 名可由 agent 自行定义，关键是属性字段保持一致：

```
root_span（一次完整请求，例如一条消息的处理）
├── ingress（接入层）
├── agent_execution（agent 主执行窗口）
│   ├── model_call（模型调用）
│   │   └── model_stream（流式输出）
│   ├── tool_call（工具调用）
│   └── skill_call（能力调用）
└── egress（输出层）
```

### Span 通用属性

建议在 span 上携带以下属性，使用统一的字段名以便平台侧查询和关联：

**会话 / 请求标识：**

| 字段              | 类型   | 说明                             |
| ----------------- | ------ | -------------------------------- |
| `session_id`      | string | 会话标识                         |
| `session_key`     | string | 会话 key                         |
| `channel`         | string | 消息通道，如 `http`、`grpc`     |
| `run_id`          | string | 当前执行标识                     |
| `source_app`      | string | 消息来源                         |
| `entry_point`     | string | 入口面                           |

**状态：**

| 字段              | 类型   | 说明                                                         |
| ----------------- | ------ | ------------------------------------------------------------ |
| `final_status`    | string | 最终业务结果：`completed` / `error` / `timeout` / `cancelled` / `superseded` |
| `state`           | string | 当前状态                                                     |
| `outcome`         | string | 结果状态                                                     |

**请求分类：**

| 字段                  | 类型   | 说明                                         |
| --------------------- | ------ | -------------------------------------------- |
| `request_type`        | string | `user_request` 或 `internal_request`         |
| `request_category`    | string | 请求子类，如 `heartbeat`                     |
| `is_internal_request` | bool   | 是否内部请求                                 |

**汇总字段（建议放在 root 或 agent 执行 span）：**

| 字段                  | 类型   | 说明               |
| --------------------- | ------ | ------------------ |
| `tools`               | string | tool 列表汇总       |
| `tool_count`          | int    | tool 数量           |
| `skills`              | string | skill 列表汇总      |
| `skill_count`         | int    | skill 数量          |
| `queue_depth`         | int    | 队列深度            |

### Model 调用属性

| 字段                          | 类型   | 说明                 |
| ----------------------------- | ------ | -------------------- |
| `provider_name`               | string | 模型提供商           |
| `request_model`               | string | 请求模型名           |
| `response_model`              | string | 响应模型名           |
| `usage_input_tokens`          | int    | 输入 token 数        |
| `usage_output_tokens`         | int    | 输出 token 数        |
| `usage_total_tokens`          | int    | 总 token 数          |
| `usage_cache_read_input_tokens` | int  | cache read token 数  |
| `usage_cache_write_input_tokens` | int | cache write token 数 |
| `input_preview`               | string | 输入预览             |
| `output_preview`              | string | 输出预览             |
| `output_summary`              | string | 输出摘要             |
| `output_kind`                 | string | 输出类型，如 `text`、`tool_call` |

### Tool 调用属性

| 字段                  | 类型   | 说明                        |
| --------------------- | ------ | --------------------------- |
| `tool_call_id`        | string | tool call 标识              |
| `tool_name`           | string | tool 名称                   |
| `tool_provider`       | string | tool 来源，如 `mcp`         |
| `tool_namespace`      | string | tool 命名空间               |
| `tool_outcome`        | string | 执行结果：`completed` / `error` |
| `tool_result_status`  | string | tool 返回的状态字段         |
| `tool_target`         | string | 操作目标                    |
| `tool_command`        | string | 执行命令                    |
| `tool_phase`          | string | 当前阶段                    |

### Skill 调用属性

| 字段              | 类型   | 说明         |
| ----------------- | ------ | ------------ |
| `skill_call_id`   | string | 调用标识     |
| `skill_name`      | string | skill 名称   |
| `skill_type`      | string | skill 类型   |
| `skill_source`    | string | skill 来源   |

## Metric 设计指南

### 命名规范

使用分层命名空间 `<domain>.<category>.<name>`：

- `gen_ai.agent.*` — Agent 执行层指标
- `gen_ai.runtime.*` — 运行时 / 基础设施指标
- `gen_ai.client.*` — 客户端 / 模型调用指标（OTEL 原生）

### 指标清单

**Agent 执行层：**

| 指标名                                 | 类型      | 单位       | 说明                                   |
| -------------------------------------- | --------- | ---------- | -------------------------------------- |
| `gen_ai.agent.request.count`           | Counter   | —          | 请求总数                               |
| `gen_ai.agent.request.duration`        | Histogram | `ms`       | 请求总耗时                             |
| `gen_ai.agent.token.usage`             | Histogram | `{token}`  | 模型 token 用量分布                    |
| `gen_ai.agent.operation.count`         | Counter   | —          | 操作计数（按 `operation_name` 区分 model/tool/skill） |
| `gen_ai.agent.operation.duration`      | Histogram | `ms`       | 操作耗时                               |
| `gen_ai.agent.session.token.input`     | Counter   | `{token}`  | Session 级输入 token 累计              |
| `gen_ai.agent.session.token.output`    | Counter   | `{token}`  | Session 级输出 token 累计              |
| `gen_ai.agent.session.token.total`     | Counter   | `{token}`  | Session 级总 token 累计                |
| `gen_ai.agent.session.trace.count`     | Counter   | —          | Session 级 trace 计数                  |
| `gen_ai.agent.skill.activation.count`  | Counter   | —          | Skill 激活次数                         |

**运行时层：**

| 指标名                                   | 类型      | 单位    | 说明                 |
| ---------------------------------------- | --------- | ------- | -------------------- |
| `gen_ai.runtime.message.queued.count`    | Counter   | —       | 消息入队次数         |
| `gen_ai.runtime.message.processed.count` | Counter   | —       | 消息处理完成次数     |
| `gen_ai.runtime.message.duration`        | Histogram | `ms`    | 消息处理耗时         |
| `gen_ai.runtime.queue.enqueue.count`     | Counter   | —       | 入队次数             |
| `gen_ai.runtime.queue.dequeue.count`     | Counter   | —       | 出队次数             |
| `gen_ai.runtime.queue.depth`             | Histogram | —       | 队列深度             |
| `gen_ai.runtime.queue.wait`              | Histogram | `ms`    | 队列等待时长         |
| `gen_ai.runtime.session.state.count`     | Counter   | —       | Session 状态迁移次数 |

### 通用 Metric Tag

推荐在指标上统一携带以下 tag，并与 span attribute 字段名保持一致：

| tag                 | 说明                                          |
| ------------------- | --------------------------------------------- |
| `agent_runtime`     | Agent 运行时标识                               |
| `operation_name`    | 操作类型：`model` / `tool` / `skill`          |
| `session_id`        | 会话 ID                                       |
| `session_key`       | 会话 key                                       |
| `provider_name`     | 模型提供商                                     |
| `request_model`     | 请求模型名                                     |
| `response_model`    | 响应模型名                                     |
| `token_type`        | Token 类型：`input` / `output` / `total`      |
| `channel`           | 消息通道                                       |
| `outcome`           | 结果状态                                       |
| `tool_name`         | Tool 名称                                      |
| `tool_result_status`| Tool 结果状态                                  |
| `skill_name`        | Skill 名称                                     |
| `skill_source`      | Skill 来源                                     |
| `queue_name`        | 队列名称                                       |

## 接入步骤

1. **配置 OTLP exporter**：将 exporter endpoint 指向 `<DATAWAY_ENDPOINT>`，各信号使用对应的 GTrace 路径。
2. **设置鉴权**：在 HTTP headers 中添加 `X-Token`，值为 `client_token`。
3. **设置 headless 模式**：添加 `to_headless: true` header（必须）。
4. **设置 Resource**：按推荐的 resource 属性设置 `service.name`、`agent_runtime` 等。
5. **创建 spans**：按 span 层级建议和属性字段组织 span 树。
6. **上报 metrics**：按指标命名规范和 tag 设计创建并上报指标。

## SDK 示例

### Node.js

使用 `@opentelemetry/exporter-trace-otlp-http` 和 `@opentelemetry/exporter-metrics-otlp-http`：

```js
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { OTLPMetricExporter } = require("@opentelemetry/exporter-metrics-otlp-http");
const { NodeSDK } = require("@opentelemetry/sdk-node");
const { Resource } = require("@opentelemetry/resources");

const traceExporter = new OTLPTraceExporter({
  url: "https://dataway.example.com/v1/write/otel-llm",
  headers: {
    "X-Token": "<client_token>",
    "to_headless": "true",
  },
});

const metricExporter = new OTLPMetricExporter({
  url: "https://dataway.example.com/v1/write/otel-metrics",
  headers: {
    "X-Token": "<client_token>",
    "to_headless": "true",
  },
});

const sdk = new NodeSDK({
  resource: new Resource({
    "service.name": "my-agent",
    agent_runtime: "my-runtime",
    agent_version: "1.0.0",
  }),
  traceExporter,
  metricReader: new PeriodicExportingMetricReader({ exporter: metricExporter }),
});

sdk.start();
```

### Python

使用 `opentelemetry-exporter-otlp-proto-http`：

```python
from opentelemetry import trace, metrics
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader

headers = {
    "X-Token": "<client_token>",
    "to_headless": "true",
}

resource = Resource.create({
    "service.name": "my-agent",
    "agent_runtime": "my-runtime",
    "agent_version": "1.0.0",
})

trace.set_tracer_provider(TracerProvider(resource=resource))
trace.get_tracer_provider().add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(
        endpoint="https://dataway.example.com/v1/write/otel-llm",
        headers=headers,
    ))
)

metrics.set_meter_provider(MeterProvider(
    resource=resource,
    metric_readers=[
        PeriodicExportingMetricReader(OTLPMetricExporter(
            endpoint="https://dataway.example.com/v1/write/otel-metrics",
            headers=headers,
        ))
    ],
))
```

其他语言的 OpenTelemetry SDK 同理：将 exporter 的 endpoint 指向 GTrace 对应路径并设置鉴权 headers 即可。

## 与标准 OTLP 的差异

| 项目            | 标准 OTLP           | GTrace                          |
| --------------- | ------------------- | ------------------------------- |
| Trace 路径      | `v1/traces`         | `v1/write/otel-llm`             |
| Metrics 路径    | `v1/metrics`        | `v1/write/otel-metrics`         |
| Logs 路径       | `v1/logs`           | `v1/write/otel-logs`            |
| 鉴权            | 无要求或 Bearer     | `X-Token: <client_token>`（必须） |
| Headless 模式   | 无                  | `to_headless: true`（必须）      |
| 数据格式        | OTLP / Protobuf     | 同左，完全兼容                   |

## 字段命名原则

1. 统一使用 `snake_case` 命名
2. 避免 vendor / runtime 前缀，使用通用语义名
3. Agent 身份信息放在 resource 层级
4. 业务 / 会话信息放在 span attribute 层级
5. Metric tag 与 span attribute 字段名保持一致，便于 trace / metric 关联查询
