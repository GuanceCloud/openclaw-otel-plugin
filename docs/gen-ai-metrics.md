# GenAI 指标说明

## 说明

本文档只描述当前推荐使用的 **新指标**：

- `gen_ai.client.*`
- `gen_ai.agent.*`
- `gen_ai.runtime.*`

文档目标是提供可直接用于看板、监控器、DQL 的指标清单，因此仅保留：

- 指标名
- 类型
- 单位
- tags
- 描述

当前单位策略：

- 所有 duration / wait / age 相关直方图仍使用 `ms`
- 当前不展开历史兼容关系，不讨论旧指标映射

## Tag 设计

### 通用 tag

新指标统一使用短 tag 名：

- `agent_runtime`
- `operation_name`
- `provider_name`
- `request_model`
- `response_model`
- `token_type`
- `channel`
- `session_id`
- `session_key`
- `session_state`
- `outcome`
- `queue_name`
- `webhook_name`
- `skill_name`
- `skill_source`
- `tool_name`
- `tool_result_status`
- `source`

### tag 说明

| tag | 含义 |
| --- | --- |
| `agent_runtime` | Agent/runtime 来源标识，当前内置为 `openclaw`，后续可扩展为 `hermes` 等 |
| `operation_name` | 操作类型，当前主要为 `chat`、`execute_tool` |
| `provider_name` | 模型提供方 |
| `request_model` | 请求模型名 |
| `response_model` | 响应模型名 |
| `token_type` | token 类型，当前主要为 `input` / `output` / `total` |
| `channel` | 消息来源通道，例如 `feishu` |
| `session_id` | OpenClaw session ID |
| `session_key` | OpenClaw session key |
| `session_state` | session 当前状态 |
| `outcome` | 结果状态或结束原因 |
| `queue_name` | 队列 lane 名称 |
| `webhook_name` | webhook / update 类型 |
| `skill_name` | skill 名称 |
| `skill_source` | skill 来源，当前主要为 `runtime` / `transcript` |
| `tool_name` | tool 名称 |
| `tool_result_status` | tool 返回状态 |
| `source` | 消息事件来源 |

## 指标清单

### GenAI Client

| 指标名 | 类型 | 单位 | tags | 描述 |
| --- | --- | --- | --- | --- |
| `gen_ai.client.token.usage` | Counter | 保持当前 | `agent_runtime`, `operation_name`, `provider_name`, `request_model`, `response_model`, `session_id`, `token_type` | 模型 token 用量。当前主要上报 `input` / `output`。 |
| `gen_ai.client.operation.duration` | Histogram | `ms` | `agent_runtime`, `operation_name=chat`, `provider_name`, `request_model`, `response_model`, `session_id`, `outcome` | 模型请求耗时。 |
| `gen_ai.client.operation.duration` | Histogram | `ms` | `agent_runtime`, `operation_name=execute_tool`, `session_id`, `tool_name`, `skill_name`, `outcome`, `tool_result_status` | 工具执行耗时。 |

### GenAI Agent

| 指标名 | 类型 | 单位 | tags | 描述 |
| --- | --- | --- | --- | --- |
| `gen_ai.agent.request.count` | Counter | - | `agent_runtime`, `channel`, `session_id`, `provider_name`, `request_model`, `session_state`, `outcome` | Agent request 总数。 |
| `gen_ai.agent.request.duration` | Histogram | `ms` | `agent_runtime`, `channel`, `session_id`, `provider_name`, `request_model`, `session_state`, `outcome` | Agent request 总耗时。 |
| `gen_ai.agent.session.token.usage` | Counter | 保持当前 | `agent_runtime`, `session_id`, `session_key`, `provider_name`, `request_model`, `token_type` | Session 级 token 聚合值，由 active session 周期扫描产生。 |
| `gen_ai.agent.session.trace.count` | Counter | - | `agent_runtime`, `session_id`, `session_key`, `provider_name`, `request_model` | Session 级 trace 计数，由 active session 周期扫描产生。 |
| `gen_ai.agent.skill.activation.count` | Counter | - | `agent_runtime`, `session_id`, `skill_name`, `skill_source` | Skill 激活次数。 |

### GenAI Runtime

| 指标名 | 类型 | 单位 | tags | 描述 |
| --- | --- | --- | --- | --- |
| `gen_ai.runtime.message.queued.count` | Counter | - | `agent_runtime`, `channel`, `session_id`, `source` | 消息进入处理链路的次数。 |
| `gen_ai.runtime.message.processed.count` | Counter | - | `agent_runtime`, `channel`, `session_id`, `outcome` | 消息处理完成次数。 |
| `gen_ai.runtime.message.duration` | Histogram | `ms` | `agent_runtime`, `channel`, `session_id`, `outcome` | 单条消息处理耗时。 |
| `gen_ai.runtime.queue.enqueue.count` | Counter | - | `agent_runtime`, `queue_name`, `session_id`, `outcome` | 队列入队次数。 |
| `gen_ai.runtime.queue.dequeue.count` | Counter | - | `agent_runtime`, `queue_name`, `session_id`, `outcome` | 队列出队次数。 |
| `gen_ai.runtime.queue.depth` | Histogram | 保持当前 | `agent_runtime`, `queue_name`, `session_id`, `outcome` | 队列深度。 |
| `gen_ai.runtime.queue.wait` | Histogram | `ms` | `agent_runtime`, `queue_name`, `session_id`, `outcome` | 队列等待时长。 |
| `gen_ai.runtime.session.state.count` | Counter | - | `agent_runtime`, `session_id`, `session_state`, `outcome` | Session 状态迁移次数。 |
| `gen_ai.runtime.session.stuck.count` | Counter | - | `agent_runtime`, `session_id`, `session_state`, `outcome` | Stuck session 检测次数。 |
| `gen_ai.runtime.session.stuck.age` | Histogram | `ms` | `agent_runtime`, `session_id`, `session_state`, `outcome` | Stuck session 年龄。 |
| `gen_ai.runtime.webhook.received.count` | Counter | - | `agent_runtime`, `channel`, `webhook_name` | Webhook 接收次数。 |
| `gen_ai.runtime.webhook.error.count` | Counter | - | `agent_runtime`, `channel`, `webhook_name` | Webhook 错误次数。 |
| `gen_ai.runtime.webhook.duration` | Histogram | `ms` | `agent_runtime`, `channel`, `webhook_name` | Webhook 处理耗时。 |

## 使用建议

1. 业务分析优先看：
   - `gen_ai.agent.request.count`
   - `gen_ai.agent.request.duration`
2. 模型性能与 token 消耗优先看：
   - `gen_ai.client.token.usage`
   - `gen_ai.client.operation.duration`
3. 会话级分析优先看：
   - `gen_ai.agent.session.token.usage`
   - `gen_ai.agent.session.trace.count`
4. 运行时排队与健康优先看：
   - `gen_ai.runtime.message.*`
   - `gen_ai.runtime.queue.*`
   - `gen_ai.runtime.session.*`
   - `gen_ai.runtime.webhook.*`
5. 需要按单会话排查时，优先使用带 `session_id` 的指标切分。

## 代码入口

- [src/otel-bootstrap.ts](../src/otel-bootstrap.ts)
- [src/service.ts](../src/service.ts)
- [src/diagnostic-event-handler.ts](../src/diagnostic-event-handler.ts)
- [src/tool-span-manager.ts](../src/tool-span-manager.ts)
- [src/service-utils.ts](../src/service-utils.ts)
