# GenAI 指标说明

## 说明

当前插件的指标体系处于 **dual-publish** 阶段：

- 老指标 `openclaw.*` 继续上报，用于兼容已有看板和监控器
- 新指标 `gen_ai.*` 并行上报，作为后续标准口径
- 当前阶段 **只调整命名和 tags，不调整单位**

单位约束：

- 所有 duration / wait / age 相关直方图当前仍然使用 `ms`
- 这是一项兼容策略，不代表已经完全对齐官方 `GenAI` semconv 单位建议

## Tag 约定

### 通用短 tag

新 `gen_ai.*` 指标统一使用短 tag，不再使用过长的 `gen_ai_*` tag 名。

常用 tag：

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

### Tag 说明

| tag | 含义 |
| --- | --- |
| `operation_name` | 操作类型，当前主要为 `chat`、`execute_tool` |
| `provider_name` | 模型提供方，例如 `volcengine-plan` |
| `request_model` | 请求模型名 |
| `response_model` | 响应模型名，当前通常与 `request_model` 相同 |
| `token_type` | token 口径，当前为 `input` / `output` / `total` |
| `channel` | 消息来源通道，例如 `feishu` |
| `session_id` | OpenClaw session ID |
| `session_key` | OpenClaw session key |
| `session_state` | session 状态，例如 `idle` / `processing` |
| `outcome` | 结果原因，例如 `completed` / `error` / `timeout` |
| `queue_name` | 队列 lane 名称 |
| `webhook_name` | webhook / update 类型 |
| `skill_name` | skill 名称 |
| `skill_source` | skill 来源，当前为 `runtime` / `transcript` |
| `tool_name` | tool 名称 |
| `tool_result_status` | tool 执行结果状态 |

## 推荐使用的新指标

以下为当前推荐的新口径指标。看板、监控器、DQL 应优先使用这一组。

### GenAI Client

| 指标名 | 兼容旧指标 | 类型 | 单位 | tags | 描述 |
| --- | --- | --- | --- | --- | --- |
| `gen_ai.client.token.usage` | `openclaw.tokens` | Counter | 保持当前 | `operation_name`, `provider_name`, `request_model`, `response_model`, `token_type` | 模型 token 用量。当前主要双写 `input` / `output`。 |
| `gen_ai.client.operation.duration` | `openclaw.run.duration_ms` | Histogram | `ms` | `operation_name=chat`, `provider_name`, `request_model`, `response_model`, `outcome` | 模型请求耗时。 |
| `gen_ai.client.operation.duration` | `openclaw.tool.duration` | Histogram | `ms` | `operation_name=execute_tool`, `tool_name`, `skill_name`, `outcome`, `tool_result_status` | 工具执行耗时。 |

### GenAI Agent

| 指标名 | 兼容旧指标 | 类型 | 单位 | tags | 描述 |
| --- | --- | --- | --- | --- | --- |
| `gen_ai.agent.request.count` | `openclaw.requests` | Counter | - | `channel`, `provider_name`, `request_model`, `session_state`, `outcome` | Agent request 总数。 |
| `gen_ai.agent.request.duration` | `openclaw.request.duration` | Histogram | `ms` | `channel`, `provider_name`, `request_model`, `session_state`, `outcome` | Agent request 总耗时。 |
| `gen_ai.agent.session.token.usage` | `openclaw.session.tokens.input` / `openclaw.session.tokens.output` / `openclaw.session.tokens.total` | Counter | 保持当前 | `session_id`, `session_key`, `provider_name`, `request_model`, `token_type` | Session 级 token 聚合值，由 active session 周期扫描产生。 |
| `gen_ai.agent.session.trace.count` | `openclaw.session.traces` | Counter | - | `session_id`, `session_key`, `provider_name`, `request_model` | Session 级 trace 计数，由 active session 周期扫描产生。 |
| `gen_ai.agent.skill.activation.count` | `openclaw.skill.activations` | Counter | - | `skill_name`, `skill_source` | Skill 激活次数。 |

### GenAI Runtime

| 指标名 | 兼容旧指标 | 类型 | 单位 | tags | 描述 |
| --- | --- | --- | --- | --- | --- |
| `gen_ai.runtime.message.queued.count` | `openclaw.message.queued` | Counter | - | `channel`, `source` | 消息进入处理链路的次数。 |
| `gen_ai.runtime.message.processed.count` | `openclaw.message.processed` | Counter | - | `channel`, `outcome` | 消息处理完成次数。 |
| `gen_ai.runtime.message.duration` | `openclaw.message.duration_ms` | Histogram | `ms` | `channel`, `outcome` | 单条消息处理耗时。 |
| `gen_ai.runtime.queue.enqueue.count` | `openclaw.queue.lane.enqueue` | Counter | - | `queue_name`, `outcome` | 队列入队次数。 |
| `gen_ai.runtime.queue.dequeue.count` | `openclaw.queue.lane.dequeue` | Counter | - | `queue_name`, `outcome` | 队列出队次数。 |
| `gen_ai.runtime.queue.depth` | `openclaw.queue.depth` | Histogram | 保持当前 | `queue_name`, `outcome` | 队列深度。 |
| `gen_ai.runtime.queue.wait` | `openclaw.queue.wait_ms` | Histogram | `ms` | `queue_name`, `outcome` | 队列等待时长。 |
| `gen_ai.runtime.session.state.count` | `openclaw.session.state` | Counter | - | `session_state`, `outcome` | Session 状态迁移次数。 |
| `gen_ai.runtime.session.stuck.count` | `openclaw.session.stuck` | Counter | - | `session_state`, `outcome` | Stuck session 检测次数。 |
| `gen_ai.runtime.session.stuck.age` | `openclaw.session.stuck_age_ms` | Histogram | `ms` | `session_state`, `outcome` | Stuck session 年龄。 |
| `gen_ai.runtime.webhook.received.count` | `openclaw.webhook.received` | Counter | - | `channel`, `webhook_name` | Webhook 接收次数。 |
| `gen_ai.runtime.webhook.error.count` | `openclaw.webhook.error` | Counter | - | `channel`, `webhook_name` | Webhook 错误次数。 |
| `gen_ai.runtime.webhook.duration` | `openclaw.webhook.duration_ms` | Histogram | `ms` | `channel`, `webhook_name` | Webhook 处理耗时。 |

## 兼容旧指标

以下旧指标仍会继续上报，但后续查询不建议优先依赖它们。

### 旧主线指标

| 指标名 | 类型 | 单位 | 常见 tags | 描述 | 建议 |
| --- | --- | --- | --- | --- | --- |
| `openclaw.requests` | Counter | - | `channel`, `provider`, `model`, `final_state`, `outcome` | Request 总数 | 迁移到 `gen_ai.agent.request.count` |
| `openclaw.request.duration` | Histogram | `ms` | `channel`, `provider`, `model`, `final_state`, `outcome` | Request 总耗时 | 迁移到 `gen_ai.agent.request.duration` |
| `openclaw.session.tokens.input` | Counter | 保持当前 | `session_id`, `session_key`, `model_provider`, `model_name` | Session 输入 token | 迁移到 `gen_ai.agent.session.token.usage` |
| `openclaw.session.tokens.output` | Counter | 保持当前 | `session_id`, `session_key`, `model_provider`, `model_name` | Session 输出 token | 迁移到 `gen_ai.agent.session.token.usage` |
| `openclaw.session.tokens.total` | Counter | 保持当前 | `session_id`, `session_key`, `model_provider`, `model_name` | Session 总 token | 迁移到 `gen_ai.agent.session.token.usage` |
| `openclaw.session.traces` | Counter | - | `session_id`, `session_key`, `model_provider`, `model_name` | Session trace 计数 | 迁移到 `gen_ai.agent.session.trace.count` |
| `openclaw.tool.duration` | Histogram | `ms` | `tool_name`, `skill_name`, `tool_outcome`, `tool_result_status` | Tool 执行耗时 | 迁移到 `gen_ai.client.operation.duration` |
| `openclaw.skill.activations` | Counter | - | `skill_name`, `skill_source` | Skill 激活次数 | 迁移到 `gen_ai.agent.skill.activation.count` |
| `openclaw.tokens` | Counter | 保持当前 | `channel`, `provider`, `model`, `openclaw.tokens.input/output/total` | 模型 token 诊断计数 | 迁移到 `gen_ai.client.token.usage` |
| `openclaw.run.duration_ms` | Histogram | `ms` | `channel`, `provider`, `model` | 模型请求耗时 | 迁移到 `gen_ai.client.operation.duration` |
| `openclaw.message.queued` | Counter | - | `channel`, `source` | 消息入队次数 | 迁移到 `gen_ai.runtime.message.queued.count` |
| `openclaw.message.processed` | Counter | - | `channel`, `outcome` | 消息处理完成次数 | 迁移到 `gen_ai.runtime.message.processed.count` |
| `openclaw.message.duration_ms` | Histogram | `ms` | `channel`, `outcome` | 消息处理耗时 | 迁移到 `gen_ai.runtime.message.duration` |
| `openclaw.queue.lane.enqueue` | Counter | - | `lane`, `outcome` | 队列入队次数 | 迁移到 `gen_ai.runtime.queue.enqueue.count` |
| `openclaw.queue.lane.dequeue` | Counter | - | `lane`, `outcome` | 队列出队次数 | 迁移到 `gen_ai.runtime.queue.dequeue.count` |
| `openclaw.queue.depth` | Histogram | 保持当前 | `lane`, `outcome` | 队列深度 | 迁移到 `gen_ai.runtime.queue.depth` |
| `openclaw.queue.wait_ms` | Histogram | `ms` | `lane`, `outcome` | 队列等待时长 | 迁移到 `gen_ai.runtime.queue.wait` |
| `openclaw.session.state` | Counter | - | `state`, `reason` | Session 状态迁移次数 | 迁移到 `gen_ai.runtime.session.state.count` |
| `openclaw.session.stuck` | Counter | - | `state`, `reason` | Stuck session 检测次数 | 迁移到 `gen_ai.runtime.session.stuck.count` |
| `openclaw.session.stuck_age_ms` | Histogram | `ms` | `state`, `reason` | Stuck session 年龄 | 迁移到 `gen_ai.runtime.session.stuck.age` |
| `openclaw.webhook.received` | Counter | - | `channel`, `webhook` | Webhook 接收次数 | 迁移到 `gen_ai.runtime.webhook.received.count` |
| `openclaw.webhook.error` | Counter | - | `channel`, `webhook` | Webhook 错误次数 | 迁移到 `gen_ai.runtime.webhook.error.count` |
| `openclaw.webhook.duration_ms` | Histogram | `ms` | `channel`, `webhook` | Webhook 处理耗时 | 迁移到 `gen_ai.runtime.webhook.duration` |

## 当前仅保留旧口径、不进入新主线的指标

| 指标名 | 类型 | 单位 | 常见 tags | 描述 | 处理方式 |
| --- | --- | --- | --- | --- | --- |
| `openclaw.model.calls` | Counter | - | 无固定 tags，随 run 聚合输出 | 模型调用次数 | 暂不迁移，后续建议由 `gen_ai.client.operation.duration` 聚合推导 |
| `openclaw.tool.calls` | Counter | - | `tool_name`, `skill_name` | Tool 调用次数 | 暂不迁移，后续建议由 `gen_ai.client.operation.duration` 聚合推导 |
| `openclaw.tool.errors` | Counter | - | `tool_name`, `skill_name`, `tool_outcome`, `tool_result_status` | Tool 错误次数 | 暂不迁移，后续建议由状态聚合推导 |
| `openclaw.run.attempt` | Counter | - | `attempt`, `channel`, `source` 等事件属性 | Run attempt 诊断计数 | 不进入 `gen_ai.*` 主指标体系 |
| `openclaw.cost.usd` | Counter | 保持当前 | `channel`, `provider`, `model` | 模型成本 | 当前未纳入本轮 `gen_ai.*` 迁移 |
| `openclaw.context.tokens` | Histogram | 保持当前 | `channel`, `provider`, `model` | 上下文 token 数 | 当前未纳入本轮 `gen_ai.*` 迁移 |

## 使用建议

1. 新看板、新监控器、新 DQL 优先使用 `gen_ai.*`
2. 旧看板在迁移完成前继续兼容 `openclaw.*`
3. 如果做模型成本与性能分析，优先使用：
   - `gen_ai.client.token.usage`
   - `gen_ai.client.operation.duration`
4. 如果做 agent / session 观察，优先使用：
   - `gen_ai.agent.request.count`
   - `gen_ai.agent.request.duration`
   - `gen_ai.agent.session.token.usage`
   - `gen_ai.agent.session.trace.count`
5. 如果做 runtime 健康分析，优先使用：
   - `gen_ai.runtime.message.*`
   - `gen_ai.runtime.queue.*`
   - `gen_ai.runtime.session.*`
   - `gen_ai.runtime.webhook.*`

## 代码入口

- [src/otel-bootstrap.ts](../src/otel-bootstrap.ts)
- [src/service.ts](../src/service.ts)
- [src/diagnostic-event-handler.ts](../src/diagnostic-event-handler.ts)
- [src/tool-span-manager.ts](../src/tool-span-manager.ts)
- [src/service-utils.ts](../src/service-utils.ts)
