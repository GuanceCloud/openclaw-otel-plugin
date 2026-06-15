# GenAI Trace Tag 说明

## 说明

- 本文档只描述当前 **trace / span / event / log** 已落地可用的字段
- 不展开历史映射
- `app_name`、`app_id` 保留原名，不并入 `gen_ai.*`

## AI Agent 说明

- 这里的 `AI Agent` 指能够基于上下文、模型、技能、工具和会话状态持续完成任务的执行主体
- 在 OpenClaw 里，`agent` 不是单次模型调用，而是围绕一次用户消息组织上下文、决策、工具调用和结果返回的运行单元
- 当前 trace 里，`AI Agent` 的主要观测边界是：
  - `openclaw_request`：一条用户消息对应的一次完整请求
  - `agent_run`：这次请求里的 agent 主执行窗口
  - `llm`：agent 在执行过程中发起的一次模型调用
  - `skill:* / tool:*`：agent 在执行过程中使用的能力与外部操作
- 因此：
  - `llm` 不等于 `agent`
  - `agent_run` 才是最接近 `AI Agent execution` 的 span
  - 多轮 `llm`、`tool:*`、`skill:*` 共同构成一次 agent 执行

## 最终 Span 规范

### 保留的 Span

- `openclaw_request`
- `channel_ingress`
- `dispatch_queue`
- `agent_run`
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

### `agent_run`

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
  - 表示一条 `openclaw_request` / `agent_run` 最终的业务结果
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

- trace 的 span / event / log tag 现在统一使用 canonical 字段
- `gen_ai.*` 双写 alias 已移除；做 trace / metrics 关联时，直接使用下表字段
- Resource 级字段也统一使用 canonical 字段

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

| 字段 | 描述 |
| --- | --- |
| `skill_call_id` | skill call 标识 |
| `skill_name` | skill 名称 |
| `skill_type` | skill 类型 |
| `skill_source` | skill 来源 |
