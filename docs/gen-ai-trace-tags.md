# GenAI Trace Tag 说明

## 说明

- 本文档只描述当前 **trace / span / event / log** 已落地可用的字段
- 不展开历史映射
- `app_name`、`app_id` 保留原名，不并入 `gen_ai.*`
- 当前输出采用双写过渡：保留短字段用于兼容既有查询，同时新增官方 OpenTelemetry GenAI 点分字段
- 字段变更关系见 [gen-ai-field-mapping.md](./gen-ai-field-mapping.md)

## AI Agent 说明

- 这里的 `AI Agent` 指能够基于上下文、模型、技能、工具和会话状态持续完成任务的执行主体
- 在 OpenClaw 里，`agent` 不是单次模型调用，而是围绕一次用户消息组织上下文、决策、工具调用和结果返回的运行单元
- 当前 trace 里，`AI Agent` 的主要观测边界是：
  - `openclaw_request`：一条用户消息对应的一次完整请求
  - `invoke_agent`：这次请求里的 agent 主执行窗口
  - `llm`：agent 在执行过程中发起的一次模型调用
  - `skill:* / skill_call:* / tool:*`：agent 在执行过程中使用的能力层与外部操作
- 因此：
  - `llm` 不等于 `agent`
  - `invoke_agent` 才是最接近 `AI Agent execution` 的 span
  - 多轮 `llm`、`tool:*`、`skill:*` 共同构成一次 agent 执行

## Skill 语义边界

- 当前代码把 OpenClaw `skill` 定义为 **agent 执行中的能力层 / orchestration context**，不是一次独立的模型调用
- skill 相关 span 分成两层：
  - `skill:<name>`：本轮请求内某个 skill 的汇总 span
  - `skill_call:<name>`：某次实际 skill 调用的执行 span
- 当 tool 能归因到某个 skill 时，父子关系为：
  - `invoke_agent -> skill:<name> -> skill_call:<name> -> tool:<name>`
- `skill:<name>` 主要表达“本轮 agent 用到了哪个能力”
- `skill_call:<name>` 主要表达“这次具体的能力调用窗口”
- `tool:<name>` 仍然表示最终落到外部操作 / 本地执行 / MCP 调用的那一步
- transcript 回放时，如果只能确认“这个 skill 被使用过”，会补 `skill:<name>`；只有能和具体 tool call 对上时，才会落 `skill_call:<name>`
- 如果无法可靠推断 skill 身份，插件只保留 `tool:*`，不会凭空制造泛化 skill span
- 截至当前 OpenTelemetry GenAI 语义，`skill` 仍没有稳定的一等标准字段
- 当前实现因此分三层表达同一组 skill 语义：
  - 兼容短字段：`skill_name`、`skill_call_id`、`skill_source`、`skill_type`
  - 推荐 trace 字段：`skill.name`、`skill.description`、`skill.path`、`skill.source.type`、`skill_result_status`
  - 项目扩展字段：`gen_ai.skill1.*`
- skill / skill_call / tool 的 GenAI operation 仍统一映射到 `gen_ai.operation.name=execute_tool`

## 最终 Span 规范

### 保留的 Span

- `openclaw_request`
- `channel_ingress`
- `dispatch_queue`
- `invoke_agent`
- `session_processing`
- `runtime_orchestration`
- `llm`
- `skill:*`
- `skill_call:*`
- `tool:*`
- `channel_egress`

### 不单独拆出的流程节点

- `Decision Router`
- `Skill Result`
- `Tool Result`
- `Final Answer`
- `Logging & Persist`

说明：

- 这些节点当前通过已有 span 的走向、属性或结果来表达，不额外创建独立 span
- `Final Answer` 由最后一个 `llm` 与 `channel_egress` 共同表示
- `Decision Router` 由 `llm` 之后进入 `skill/tool/finish` 的分支体现

### 设计边界

- 一条用户消息对应一条 trace
- 只保留对排障稳定且有价值的 span
- 能用属性表达的，不单独拆 span
- 能从前后关系推断的，不单独拆 span
- 如需继续细分，优先在 `runtime_orchestration` 内增加 phase，而不是新增更多顶层 span

## 核心 Span

### `openclaw_request`

表示“一条用户消息对应的一次完整请求”。

用途：

- 作为整条 trace 的 root span
- 表示从消息进入 OpenClaw 到本轮处理完成的总窗口
- 承载整轮请求级汇总信息，例如：
  - session 关联
  - 最终状态
  - 汇总输出
  - 会话创建/更新时间

### `invoke_agent`

表示“一次 agent 实际执行窗口”。

用途：

- 作为 `openclaw_request` 下的主执行 span
- 承载本轮模型调用、工具调用、skill 调用的父级上下文
- 汇总本轮 run 维度的信息，例如：
  - 使用到的 tools / skills
  - token 汇总
  - 最终执行结果

### `llm`

表示“一次模型请求”。

用途：

- 对应一次大模型调用
- 记录这次模型调用的：
  - provider
  - request model / response model
  - 输入预览
  - 输出预览
  - token 使用量

### `skill:<name>`

表示“本轮 agent 请求里，某个 skill 被激活并参与执行”。

用途：

- 作为 `invoke_agent` 下的能力层汇总 span
- 汇总一个 skill 在本轮请求内的存在与持续时间
- 表达 skill 来源，例如：
  - `runtime`
  - `transcript`
- 作为 `skill_call:<name>` 和相关 `tool:*` 的父级上下文

补充说明：

- 同一个 skill 在同一轮请求里默认只保留一个 `skill:<name>` 汇总 span
- 该 span 代表“这个能力被用到了”，不是某一次具体 tool 调用

### `skill_call:<name>`

表示“一次具体的 skill 调用窗口”。

用途：

- 作为 `skill:<name>` 下的子 span
- 按具体 `tool_call_id` 记录一次 skill 调用
- 承载本次 skill 调用关联的：
  - `skill_call_id`
  - `tool_call_id`
  - `tool_name`

补充说明：

- 当前 `skill_call:<name>` 和具体 `tool_call_id` 一一对应
- 一次 skill 可能触发多个 tool call，因此同一个 `skill:<name>` 下可能出现多个 `skill_call:<name>`
- skill call 完成后会单独计入 `gen_ai.agent.operation.*`，其 `operation_name=skill`

## 状态字段说明

- `status`
  - 表示当前 span 自身的执行状态
  - 用于判断某个具体 span 是否报错
  - 例如 `tool:*`、`llm`、`channel_egress` 是否执行失败

  当前推荐按以下语义理解：

  | 值 | 含义 |
  | --- | --- |
  | `ok` | 当前 span 执行成功 |
  | `error` | 当前 span 执行失败 |
  | `unset` / 空 | 当前 span 没有显式设置状态 |

- `final_status`
  - 表示一条 `openclaw_request` / `invoke_agent` 最终的业务结果
  - 用于判断一次 agent 请求最终是成功完成、超时、取消还是被后续消息顶替

使用建议：

- 看链路技术错误：优先看 `status`
- 看一次 agent 请求最终结局：优先看 `final_status`

### `final_status` 结果语义

建议按以下语义使用：

| 值 | 含义 |
| --- | --- |
| `completed` | 本轮 agent 请求正常完成，并已形成最终结果 |
| `error` | 本轮 agent 请求最终失败，未形成有效结果 |
| `timeout` | 本轮 agent 请求因超时结束 |
| `cancelled` | 本轮 agent 请求被主动取消 |
| `superseded` | 本轮 agent 请求被后续新消息顶替，不再继续执行 |

补充说明：

- `completed` 不要求所有子 span 都没有错误；只要 agent 最终成功产出结果即可
- `error` 表示从业务结果看本轮失败，不等同于某个单独 `tool:*` 或 `llm` 的 `status = error`
- `superseded` 常见于同一会话里新消息到来，旧请求被提前收尾

## Resource 级字段

| 字段 | 描述 |
| --- | --- |
| `agent_runtime` | agent runtime 名称，当前为 `openclaw` |
| `agent_version` | agent / runtime 版本 |
| `runtime_environment` | 当前运行环境 |
| `app_name` | 业务应用名称 |
| `app_id` | 业务应用标识 |

## Span 通用字段

说明：

- trace 的 span / event / log tag 现在同时输出兼容短字段和官方 `gen_ai.*` 点分字段
- 旧版扁平 `gen_ai_session_id` / `gen_ai.session_id` 这类 alias 不再恢复
- Resource 级字段继续使用 `agent_runtime`、`agent_version`、`runtime_environment` 等短字段

| 字段 | 描述 |
| --- | --- |
| `channel` | 当前消息所属通道，例如 `feishu` |
| `run_id` | OpenClaw 首次观测到的执行标识；同一条用户请求发生内部续跑时不覆盖 |
| `run_ids` | 同一条 trace 内观测到的全部 `run_id`，按首次出现顺序逗号拼接 |
| `session_id` | session id，推荐用于和 metrics 侧字段对齐 |
| `session_key` | session key，推荐主字段 |
| `session_namespace` | session namespace |
| `session_agent` | session 归属 agent |
| `session_channel` | session 归属 channel |
| `session_scope` | session scope |
| `session_channel_target` | session 渠道目标 |
| `session_cwd` | session 当前工作目录 |
| `session_create_at` | session 创建时间，当前推荐主字段 |
| `session_created_at` | session 元数据中的原始 `createdAt` |
| `session_updated_at` | session 最近更新时间 |
| `session_chat_type` | 会话类型，例如 `direct` |
| `session_file` | session 落盘文件路径 |
| `source_app` | 消息来源提供方，例如 `feishu` |
| `entry_point` | 消息入口面，例如 `feishu` |
| `state` | 当前状态 |
| `prev_state` | 前一状态 |
| `reason` | 状态变化或结束原因 |
| `request_type` | 请求大类，默认 `user_request`；内部控制流为 `internal_request` |
| `request_category` | 请求细分类型；例如 `runtime_continue`、`heartbeat` |
| `is_internal_request` | 是否内部请求，便于直接过滤内部控制流 |
| `queue_depth` | 当前关联队列深度 |
| `runtime_phase` | 当前 runtime 阶段 |
| `final_status` | 最终状态，推荐用于和 metrics / 查询侧统一 |
| `replay_source` | 该 trace 是否由回放补齐；当前可能值为 `transcript`、`trajectory` |
| `trace_completeness` | 链路完整度标记；当前 `partial` 表示该 trace 由 replay/backfill 生成，不保证保留完整 runtime 明细 |
| `tools` | 本轮汇总的 tool 列表 |
| `tool_count` | tool 数量 |
| `skills` | 本轮汇总的 skill 列表 |
| `skill_count` | skill 数量 |
| `tool_targets` | 本轮汇总的多个 tool target |
| `tool_commands` | 本轮汇总的多个 tool command |
| `tool_result_statuses` | 本轮汇总的多个 tool result status |
| `tool_arg_keys` | tool 参数 key 汇总 |
| `tool_args_preview` | tool 参数预览 |
| `tool_meta_preview` | tool 元数据预览 |
| `tool_result_preview` | tool 结果预览 |
| `tool_result_status` | tool 结果状态 |

## 官方 GenAI 字段

| 字段 | 描述 |
| --- | --- |
| `gen_ai.operation.name` | 官方 GenAI operation 名，例如 `chat`、`invoke_agent`、`invoke_workflow`、`execute_tool`、`plan`；当前 `tool` 与 `skill` span 都映射为 `execute_tool` |
| `error.type` | 错误 span 的低基数错误类型，当前统一为 `error` |
| `gen_ai.provider.name` | 模型或 Agent 调用的 GenAI provider |
| `gen_ai.request.model` | 请求模型名 |
| `gen_ai.response.model` | 响应模型名；没有独立响应模型时沿用请求模型 |
| `gen_ai.conversation.id` | OpenClaw `session_id` 对应的 conversation id |
| `gen_ai.input.messages` | 使用现有 `input_preview` 构造的官方 input messages JSON 字符串 |
| `gen_ai.output.messages` | 使用现有 `output_preview` / `output_summary` / tool preview 构造的官方 output messages JSON 字符串 |
| `gen_ai.usage.input_tokens` | 输入 token 数 |
| `gen_ai.usage.output_tokens` | 输出 token 数 |
| `gen_ai.usage.cache_read.input_tokens` | cache read input token 数 |
| `gen_ai.usage.cache_creation.input_tokens` | cache creation / write input token 数 |
| `gen_ai.tool.name` | tool 名称 |
| `gen_ai.tool.call.id` | tool call 标识 |
| `gen_ai.tool.call.arguments` | tool 参数 preview，当前为字符串 |
| `gen_ai.tool.call.result` | tool 结果 preview，当前为字符串 |
| `gen_ai.output.type` | 输出类型；当前只在值符合官方枚举时输出 |

补充说明：

- 当前实现没有独立输出官方 `gen_ai.skill.*` 字段
- skill 相关信息当前通过：
  - span 名称：`skill:<name>`、`skill_call:<name>`
  - 推荐 trace 字段：`skill.*`
  - 项目扩展字段：`gen_ai.skill1.*`
  - 兼容字段：`skill_name`、`skill_call_id`、`skill_source`、`skill_type`
  - operation 语义：`gen_ai.operation.name=execute_tool`
  来共同表达

### `request_type` 结果语义

建议按以下语义使用：

| 值 | 含义 |
| --- | --- |
| `user_request` | 普通用户发起的请求 |
| `internal_request` | OpenClaw 内部自动触发的控制流请求 |

补充说明：

- 当前内部请求会进一步通过 `request_category` 区分，例如：
  - `runtime_continue`
  - `heartbeat`
- 需要筛掉非用户可见链路时，优先使用 `is_internal_request = true` 或 `request_type = internal_request`

## Model 相关字段

| 字段 | 描述 |
| --- | --- |
| `provider_name` | 模型提供方 |
| `request_model` | 请求模型名 |
| `response_model` | 响应模型名 |
| `input_preview` | 输入预览 |
| `input_length` | 输入长度 |
| `output_preview` | 输出预览 |
| `output_length` | 输出长度 |
| `output_summary` | 输出摘要 / 思考摘要 |
| `output_text_length` | 最终文本长度 |
| `output_kind` | 输出类型，例如 `text`、`tool_call` |
| `usage_input_tokens` | 输入 token 数 |
| `usage_output_tokens` | 输出 token 数 |
| `usage_total_tokens` | 总 token 数 |
| `usage_cache_read_input_tokens` | cache read token 数 |
| `usage_cache_write_input_tokens` | cache write token 数 |
| `usage_cache_total_tokens` | cache read + cache write token 总数 |

## Tool 相关字段

| 字段 | 描述 |
| --- | --- |
| `tool_call_id` | tool call 标识 |
| `tool_name` | tool 名称 |
| `tool_provider` | tool 来源类型，例如 `mcp` |
| `tool_namespace` | tool 命名空间；对 MCP 调用通常表示 server 名 |
| `tool_mcp_name` | 底层真实 MCP tool 名；例如 `owl.data.simple_query` |
| `tool_mcp_host` | MCP server host；例如 `owl-mcp.guance.com` |
| `tool_target` | tool 操作目标 |
| `tool_command` | tool 执行命令 |
| `tool_outcome` | tool 执行结果 |
| `tool_phase` | tool 当前阶段 |
| `tool_loop_level` | tool loop 检测等级 |

补充说明：

- `runtime_orchestration` / `channel_egress` 当前允许携带 `output_summary`
- `runtime` 生命周期 span 仍默认不携带 `input_preview` / `output_preview`
- 与 Agent 计划最相关的 runtime 编排窗口当前统一落在 `runtime_orchestration`，并使用 `runtime_phase=agent_plan` 表达，而不是新增独立 `agent_plan` span
- MCP 调用当前不新增独立 span 类型；仍落在 `tool:*`，通过 `tool_provider=mcp` 与 `tool_namespace=<server>` 区分

## Skill 相关字段

截至 2026-06-26，`skill` 仍没有 OpenTelemetry GenAI 已落地的一等字段。当前插件保留兼容短字段，同时统一补齐 `skill.*` 与项目扩展字段 `gen_ai.skill1.*`。

| 字段 | 含义 | 常见 span |
| --- | --- | --- |
| `skill.name` | skill 名称，来自 `SKILL.md` 所在目录名或 frontmatter `name` | `skill:*`、`skill_call:*`、`tool:*` |
| `skill.description` | skill 描述；优先取 `SKILL.md` frontmatter `description`，没有时回退正文首段 | `skill:*`、`skill_call:*`、`tool:*` |
| `skill.path` | skill 入口文件绝对路径，当前识别到的 `.../SKILL.md` | `skill:*`、`skill_call:*`、`tool:*` |
| `skill_call_id` | skill 对应的 tool call ID，用于把 `skill:*` / `skill_call:*` 与触发它的工具调用关联起来 | `skill:*`、`skill_call:*`、`tool:*` |
| `skill.source.type` | skill 来源类型；当前取值为 `system`、`user`、`workspace` | `skill:*`、`skill_call:*`、`tool:*` |
| `skill_result_status` | skill 结果状态；当前按关联 tool 是否报错映射为 `completed` 或 `error` | `skill:*`、`skill_call:*`、`tool:*` |
| `gen_ai.skill1.name` | skill 名称的 `gen_ai.*` 项目扩展字段 | `skill:*`、`skill_call:*`、`tool:*` |
| `gen_ai.skill1.path` | skill 入口文件绝对路径的 `gen_ai.*` 项目扩展字段 | `skill:*`、`skill_call:*`、`tool:*` |
| `gen_ai.skill1.source.type` | skill 来源类型的 `gen_ai.*` 项目扩展字段 | `skill:*`、`skill_call:*`、`tool:*` |
| `gen_ai.skill1.result_status` | skill 结果状态的 `gen_ai.*` 项目扩展字段 | `skill:*`、`skill_call:*`、`tool:*` |
| `gen_ai.skill1.description` | skill 描述；与 `skill.description` 对齐 | `skill:*`、`skill_call:*`、`tool:*` |
| `gen_ai.skill1.version` | skill 版本；优先取 `SKILL.md` frontmatter `version`，其次取同目录 `package.json.version` | `skill:*`、`skill_call:*`、`tool:*` |

兼容字段仍然保留：

| 字段 | 描述 |
| --- | --- |
| `skill_name` | 兼容短字段；与 `skill.name` 表达同一 skill 身份 |
| `skill_call_id` | 兼容短字段；与上表相同 |
| `skill_source` | 兼容短字段；保留运行期归因来源，当前主要为 `runtime` / `transcript` |
| `skill_type` | 兼容短字段；当前 `skill_call:*` 一般为 `call` |
