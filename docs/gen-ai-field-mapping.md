# GenAI 字段变更关系

## 说明

本表描述当前输出字段与 OpenTelemetry GenAI semantic conventions 的对齐关系。

- trace / span / event / log 继续保留短字段，便于兼容既有查询
- 同时新增官方点分字段，例如 `gen_ai.provider.name`
- 指标名保持现有 `gen_ai.agent.*` / `gen_ai.runtime.*` 插件口径，指标 tags 同样保留短字段并新增官方字段
- duration 类插件指标继续使用 `ms`
- 敏感或体积较大的官方 opt-in 内容字段只使用当前已有 preview 构造，不输出原始全量内容

官方参考：

- <https://github.com/open-telemetry/semantic-conventions-genai/tree/main/docs/gen-ai>
- <https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md>
- <https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md>
- <https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md>

## Trace / Span 字段

| 兼容短字段 | 新增官方字段 | 适用对象 | 说明 |
| --- | --- | --- | --- |
| `operation_name` / `span.kind` / `runtime_phase` | `gen_ai.operation.name` | model / agent / tool / skill / planning span，相关指标 tag | 官方 operation 名。当前映射见下方 operation 表。 |
| span error status | `error.type` | 错误 span | 当前输出低基数 `error`，错误详情仍放在 OTEL span status message。 |
| `provider_name` | `gen_ai.provider.name` | `llm`、`agent_run`、request 汇总、model token/operation 指标 | 模型或 Agent 调用的 GenAI provider。 |
| `request_model` | `gen_ai.request.model` | `llm`、`agent_run`、request 汇总、model token/operation 指标 | 请求模型名。 |
| `response_model` | `gen_ai.response.model` | `llm`、model token/operation 指标 | 响应模型名；没有独立响应模型时沿用请求模型。 |
| `session_id` | `gen_ai.conversation.id` | 带 session 关联的 span / metric | OpenClaw session id 对应官方 conversation id。 |
| `usage_input_tokens` | `gen_ai.usage.input_tokens` | `llm`、`agent_run`、request 汇总 span | 输入 token 数。 |
| `usage_output_tokens` | `gen_ai.usage.output_tokens` | `llm`、`agent_run`、request 汇总 span | 输出 token 数。 |
| `usage_cache_read_input_tokens` | `gen_ai.usage.cache_read.input_tokens` | `llm`、`agent_run`、request 汇总 span | provider cache read input token 数。 |
| `usage_cache_write_input_tokens` | `gen_ai.usage.cache_creation.input_tokens` | `llm`、`agent_run`、request 汇总 span | provider cache creation / write input token 数。 |
| `input_preview` | `gen_ai.input.messages` | 模型 / Agent 相关 span | 使用已脱敏、截断后的 preview 构造 JSON 字符串，形如 `[{role:"user",parts:[{type:"text",content:"..."}]}]`。 |
| `output_preview`、`output_summary`、`output_kind` | `gen_ai.output.messages` | 模型 / Agent 相关 span | 使用已脱敏、截断后的 preview / summary 构造 JSON 字符串；`output_kind=tool_call` 且有 tool 身份时输出 `tool_call` part。 |
| `tool_name` | `gen_ai.tool.name` | `tool:*` span、tool operation 指标 | tool 名称。 |
| `tool_call_id` | `gen_ai.tool.call.id` | `tool:*` span | tool call 标识。 |
| `tool_args_preview` | `gen_ai.tool.call.arguments` | `tool:*` span | tool 参数预览；当前为字符串 preview。 |
| `tool_result_preview` | `gen_ai.tool.call.result` | `tool:*` span | tool 结果预览；当前为字符串 preview。 |
| `token_type` | `gen_ai.token.type` | token 相关指标 | token 类型。当前插件 session 总量仍可能输出兼容值 `total`。 |
| `output_kind=text` | `gen_ai.output.type=text` | 模型 / egress 相关 span | 仅当值符合官方枚举时输出，`tool_call` 仍保留在 `output_kind`。 |
| `agent_version` | `gen_ai.agent.version` | 显式带 agent version 的 span / log attrs | 与 resource 级 `agent_version` 保持兼容。 |

## Operation 映射

| 当前字段 / 场景 | 官方 `gen_ai.operation.name` | 说明 |
| --- | --- | --- |
| `operation_name=model` 或 `span.kind=model` | `chat` | 一次模型 chat / completion 调用。 |
| `operation_name=tool` 或 `span.kind=tool` | `execute_tool` | tool 执行。 |
| `operation_name=skill` | `execute_tool` | 当前 skill 调用按工具执行能力对齐。 |
| `span.kind=agent` | `invoke_agent` | `agent_run` 表示一次 agent 主执行窗口。 |
| `span.kind=request` | `invoke_workflow` | `openclaw_request` 表示一次用户消息触发的完整工作流。 |
| `runtime_phase=agent_plan` | `plan` | `runtime_orchestration` 中的规划阶段。 |

## Metric Tag 关系

| 指标范围 | 保留短 tag | 新增官方 tag | 说明 |
| --- | --- | --- | --- |
| model request / operation | `provider_name`、`request_model`、`response_model` | `gen_ai.provider.name`、`gen_ai.request.model`、`gen_ai.response.model` | 适用于 `gen_ai.agent.token.usage`、`gen_ai.agent.operation.*`、request/session 聚合指标。 |
| token metrics | `token_type` | `gen_ai.token.type` | 官方枚举是 `input` / `output`；插件兼容 session 总量时可能保留 `total`。 |
| operation metrics | `operation_name` | `gen_ai.operation.name` | `model/tool/skill` 保留为兼容短值，官方字段使用 `chat/execute_tool`。 |
| session correlation | `session_id` | `gen_ai.conversation.id` | 与 trace/span 的 conversation id 对齐。 |
| tool metrics | `tool_name` | `gen_ai.tool.name` | tool operation 维度。 |

## 未改动项

- `agent_runtime`、`agent_version`、`runtime_environment` 继续作为 resource / 查询兼容字段。
- `session_key`、`run_id`、`run_ids`、`channel`、`final_status`、`request_type`、`request_category` 等 OpenClaw 运行时字段没有官方一一对应字段，继续保留短字段。
- `gen_ai.system_instructions`、`gen_ai.tool.definitions`、`gen_ai.request.*` 采样参数、`server.address`、`server.port` 等字段当前没有稳定上游来源，因此不凭空生成。
- 旧 `openclaw.*` 指标双写不恢复；如果平台仍能查询到旧指标，通常来自历史数据。
