# GenAI 指标说明

## 说明

本文档只描述当前插件会主动上报的推荐指标：

- `gen_ai.workflow.duration`
- `gen_ai.client.operation.duration`
- `gen_ai.client.token.usage`

当前指标体系对齐 OpenTelemetry GenAI 原生命名，指标 tag 优先使用 `gen_ai.*` 点分字段。为方便和 trace / session 查询关联，指标仍保留少量非官方字段，例如 `session_id`、`skill_name`、`skill_source`、`tool_result_status`。

旧 `gen_ai.agent.*`、`gen_ai.runtime.*`、session token / trace、runtime queue / webhook / session health 指标已停止上报。如果平台里还能看到这些指标，通常来自历史数据点。

## 指标清单

| 指标名 | 类型 | 单位 | tags | 描述 |
| --- | --- | --- | --- | --- |
| `gen_ai.workflow.duration` | Histogram | `s` | `session_id`, `gen_ai.conversation.id`, `final_status` | 一次 OpenClaw 用户请求 / workflow 的端到端耗时。 |
| `gen_ai.client.operation.duration` | Histogram | `s` | 模型调用：`gen_ai.operation.name=chat`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `session_id`, `gen_ai.conversation.id`；tool 调用：`gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `session_id`, `gen_ai.conversation.id`, `skill_name`, `tool_result_status`；skill 调用：`gen_ai.operation.name=skill`, `gen_ai.skill.name`, `session_id`, `gen_ai.conversation.id`, `skill_name`, `skill_source`, `tool_result_status` | GenAI client operation 耗时，覆盖模型调用、tool 执行以及作为特殊 tool 处理的 skill 执行窗口。 |
| `gen_ai.client.token.usage` | Histogram | `{token}` | `gen_ai.operation.name=chat`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.token.type`, `session_id`, `gen_ai.conversation.id` | 模型输入 / 输出 token 用量。当前只上报 `gen_ai.token.type=input` 和 `gen_ai.token.type=output`。 |

## Tag 说明

| tag | 含义 |
| --- | --- |
| `gen_ai.operation.name` | operation 名。模型调用为 `chat`，tool 执行为 `execute_tool`，skill 执行为插件扩展值 `skill`。 |
| `gen_ai.provider.name` | 模型提供方。 |
| `gen_ai.request.model` | 请求模型名。 |
| `gen_ai.response.model` | 响应模型名；当前没有独立响应模型时沿用请求模型。 |
| `gen_ai.token.type` | token 类型。当前只上报 `input` / `output`。 |
| `gen_ai.tool.name` | tool 名称，用于 `gen_ai.operation.name=execute_tool` 的 operation duration。 |
| `gen_ai.skill.name` | skill 名称，用于 `gen_ai.operation.name=skill` 的 operation duration。 |
| `gen_ai.conversation.id` | session / conversation 关联 ID，当前与 `session_id` 保持一致。 |
| `session_id` | OpenClaw session ID，用于和 trace / logs 侧 canonical 字段关联。 |
| `final_status` | workflow 最终状态，例如 `completed`、`error`、`timeout`、`cancelled`、`superseded`。 |
| `skill_name` | skill 名称，当前用于 tool / skill operation duration。 |
| `skill_source` | skill 来源，当前主要为 `runtime` / `transcript`。 |
| `tool_result_status` | tool / skill 执行结果状态。 |

## 迁移说明

| 旧指标 | 当前替代方式 |
| --- | --- |
| `gen_ai.agent.request.duration` | 使用 `gen_ai.workflow.duration`。单位从 `ms` 改为 `s`。 |
| `gen_ai.agent.operation.duration` | 使用 `gen_ai.client.operation.duration`。单位从 `ms` 改为 `s`，operation 类型通过 `gen_ai.operation.name` 区分。 |
| `gen_ai.agent.token.usage` | 使用 `gen_ai.client.token.usage`，只查询 `gen_ai.token.type=input/output`。 |
| `gen_ai.agent.request.count`、`gen_ai.agent.operation.count` | 当前不再上报 count 指标；需要次数时按 duration / token 指标点数或 trace 聚合。 |
| `gen_ai.agent.session.*` | 当前不再上报 session 聚合指标；会话级分析优先使用 `session_id` 关联 trace / logs / 当前指标。 |
| `gen_ai.runtime.*` | 当前不再上报 runtime 健康类 metrics；runtime 细节保留在 trace / logs 中。 |

## 使用建议

1. 端到端耗时看 `gen_ai.workflow.duration`。
2. 模型、tool、skill 执行耗时看 `gen_ai.client.operation.duration`，按 `gen_ai.operation.name`、`gen_ai.tool.name`、`gen_ai.skill.name`、`gen_ai.request.model` 切分。
3. 对能识别为 skill 的调用，trace 侧结构为 `llm -> tool:Skill -> skill:<name>`；指标侧会分别记录 `gen_ai.operation.name=execute_tool` / `gen_ai.tool.name=Skill` 和 `gen_ai.operation.name=skill` / `gen_ai.skill.name=<name>`。
4. Token 消耗看 `gen_ai.client.token.usage`，按 `gen_ai.token.type=input/output` 切分。
5. 单会话排查优先使用 `session_id` 或 `gen_ai.conversation.id` 关联 metrics、traces 和 logs。

## 代码入口

- [src/otel-bootstrap.ts](../src/otel-bootstrap.ts)
- [src/service.ts](../src/service.ts)
- [src/diagnostic-event-handler.ts](../src/diagnostic-event-handler.ts)
- [src/tool-span-manager.ts](../src/tool-span-manager.ts)
- [src/service-utils.ts](../src/service-utils.ts)
