# GenAI Trace Tag 说明

## 说明

- 本文档只描述当前 **trace / span / event / log** 已落地可用的字段
- 不展开历史映射
- `app_name`、`app_id` 保留原名，不并入 `gen_ai.*`

## 最终 Span 规范

### 保留的 Span

- `openclaw_request`
- `channel_ingress`
- `dispatch_queue`
- `agent_run`
- `session_processing`
- `runtime_orchestration`
- `model_request`
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
- `Final Answer` 由最后一个 `model_request` 与 `channel_egress` 共同表示
- `Decision Router` 由 `model_request` 之后进入 `skill/tool/finish` 的分支体现

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

### `model_request`

表示“一次模型请求”。

用途：

- 对应一次大模型调用
- 记录这次模型调用的：
  - provider
  - request model / response model
  - 输入预览
  - 输出预览
  - token 使用量

## Resource 级字段

| 字段 | 描述 |
| --- | --- |
| `gen_ai.agent_id` | agent 标识 |
| `gen_ai.agent_name` | agent 名称 |
| `gen_ai.agent_runtime` | agent runtime 名称，当前为 `openclaw` |
| `gen_ai.agent_version` | agent / runtime 版本 |
| `gen_ai.runtime_environment` | 当前运行环境 |
| `app_name` | 业务应用名称 |
| `app_id` | 业务应用标识 |

## Span 通用字段

| 字段 | 描述 |
| --- | --- |
| `gen_ai.agent_channel` | 当前消息所属通道，例如 `feishu` |
| `gen_ai.session_id` | session id |
| `gen_ai.session_key` | session key |
| `gen_ai.session_namespace` | session namespace |
| `gen_ai.session_agent` | session 归属 agent |
| `gen_ai.session_channel` | session 归属 channel |
| `gen_ai.session_scope` | session scope |
| `gen_ai.session_channel_target` | session 渠道目标 |
| `gen_ai.session_cwd` | session 当前工作目录 |
| `gen_ai.session_create_at` | session 创建时间，当前推荐主字段 |
| `gen_ai.session_created_at` | session 元数据中的原始 `createdAt` |
| `gen_ai.session_updated_at` | session 最近更新时间 |
| `gen_ai.session_chat_type` | 会话类型，例如 `direct` |
| `gen_ai.session_file` | session 落盘文件路径 |
| `gen_ai.origin_provider` | 消息来源提供方，例如 `feishu` |
| `gen_ai.origin_surface` | 消息入口面，例如 `feishu` |
| `gen_ai.state` | 当前状态 |
| `gen_ai.prev_state` | 前一状态 |
| `gen_ai.reason` | 状态变化或结束原因 |
| `gen_ai.queue_depth` | 当前关联队列深度 |
| `gen_ai.runtime_phase` | 当前 runtime 阶段 |
| `gen_ai.final_status` | 最终状态 |

## Model 相关字段

| 字段 | 描述 |
| --- | --- |
| `gen_ai.provider_name` | 模型提供方 |
| `gen_ai.request_model` | 请求模型名 |
| `gen_ai.response_model` | 响应模型名 |
| `gen_ai.input_preview` | 输入预览 |
| `gen_ai.input_length` | 输入长度 |
| `gen_ai.output_preview` | 输出预览 |
| `gen_ai.output_length` | 输出长度 |
| `gen_ai.output_summary` | 输出摘要 / 思考摘要 |
| `gen_ai.output_text_length` | 最终文本长度 |
| `gen_ai.output_kind` | 输出类型，例如 `text`、`tool_call` |
| `gen_ai.usage_input_tokens` | 输入 token 数 |
| `gen_ai.usage_output_tokens` | 输出 token 数 |
| `gen_ai.usage_total_tokens` | 总 token 数 |
| `gen_ai.usage_cache_read_input_tokens` | cache read token 数 |
| `gen_ai.usage_cache_write_input_tokens` | cache write token 数 |

## Tool 相关字段

| 字段 | 描述 |
| --- | --- |
| `gen_ai.tool_call_id` | tool call 标识 |
| `gen_ai.tool_name` | tool 名称 |
| `gen_ai.tool_target` | tool 操作目标 |
| `gen_ai.tool_command` | tool 执行命令 |
| `gen_ai.tool_outcome` | tool 执行结果 |
| `gen_ai.tool_phase` | tool 当前阶段 |
| `gen_ai.tool_loop_level` | tool loop 检测等级 |
| `gen_ai.tool_targets` | 本轮汇总的多个 tool target |
| `gen_ai.tool_commands` | 本轮汇总的多个 tool command |
| `gen_ai.tool_result_statuses` | 本轮汇总的多个 tool result status |
| `gen_ai.tool_arg_keys` | tool 参数 key 汇总 |
| `gen_ai.tool_args_preview` | tool 参数预览 |
| `gen_ai.tool_meta_preview` | tool 元数据预览 |
| `gen_ai.tool_result_preview` | tool 结果预览 |
| `gen_ai.tool_result_status` | tool 结果状态 |
| `gen_ai.tool_count` | tool 数量 |

## Skill 相关字段

| 字段 | 描述 |
| --- | --- |
| `gen_ai.skill_call_id` | skill call 标识 |
| `gen_ai.skill_name` | skill 名称 |
| `gen_ai.skill_type` | skill 类型 |
| `gen_ai.skill_source` | skill 来源 |
| `gen_ai.skills` | 本轮汇总的 skill 列表 |
| `gen_ai.skill_count` | skill 数量 |
