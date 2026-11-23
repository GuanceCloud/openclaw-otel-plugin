# GenAI 指标说明

## 说明

本文档只描述当前插件会主动上报的推荐指标：

- `gen_ai.workflow.duration`
- `gen_ai.client.operation.duration`
- `gen_ai.client.operation.time_to_first_chunk`
- `gen_ai.client.operation.time_per_output_token`
- `gen_ai.client.token.usage`
- `gen_ai.agent.operation.count`
- `gen_ai.agent.operation.duration`

当前指标体系对齐 OpenTelemetry GenAI 原生命名，指标 tag 优先使用 `gen_ai.*` 点分字段。为方便和 trace / session 查询关联，指标仍保留少量非官方字段，例如 `session_id`。

除 `gen_ai.agent.operation.count` / `gen_ai.agent.operation.duration` 外，旧 `gen_ai.agent.*`、`gen_ai.runtime.*`、session token / trace、runtime queue / webhook / session health 指标已停止上报。如果平台里还能看到这些指标，通常来自历史数据点。

## 指标清单

| 指标名 | 类型 | 单位 | tags | 描述 |
| --- | --- | --- | --- | --- |
| `gen_ai.workflow.duration` | Histogram | `s` | `session_id`, `gen_ai.conversation.id`, `final_status`, `status` | 一次 OpenClaw 用户请求 / workflow 的端到端耗时。 |
| `gen_ai.client.operation.duration` | Histogram | `s` | 模型调用：`gen_ai.operation.name=chat`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `session_id`, `gen_ai.conversation.id`, `status`；tool 调用：`gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `session_id`, `gen_ai.conversation.id`, `status`；skill 调用：`gen_ai.operation.name=skill`, `gen_ai.skill.name`, `session_id`, `gen_ai.conversation.id`, `status` | GenAI client operation 耗时，覆盖模型调用、tool 执行以及作为特殊 tool 处理的 skill 执行窗口。 |
| `gen_ai.client.token.usage` | Histogram | `{token}` | `gen_ai.operation.name=chat`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.token.type`, `session_id`, `gen_ai.conversation.id` | 模型输入 / 输出 token 用量。`input` 包含 cache read 与 cache write，`output` 保持原始输出用量；当前只上报 `gen_ai.token.type=input` 和 `gen_ai.token.type=output`。 |
| `gen_ai.client.operation.time_to_first_chunk` | Histogram | `s` | `agent_runtime`, `operation_name=chat`, `provider_name`, `request_model`, `status` | 单次模型调用的首块响应延迟。 |
| `gen_ai.client.operation.time_per_output_token` | Histogram | `s` | 与首块响应延迟相同 | 项目扩展：成功流式调用的非首 Token 平均耗时客户端估算。看板可换算为 `ms/token`。 |
| `gen_ai.agent.operation.count` | Counter | `1` | 基础：`session_id`, `gen_ai.conversation.id`, `gen_ai.operation.name`, `status`；模型调用：`gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`；tool 调用：`gen_ai.tool.name`；skill 调用：`gen_ai.skill.name` | Agent 侧 operation 次数。每个可确认结果的 `llm`、`tool:*`、`skill:*` span 记录 1 个点。 |
| `gen_ai.agent.operation.duration` | Histogram | `ms` | 与 `gen_ai.client.operation.duration` 使用同一组 operation attrs | Agent 侧 operation 耗时兼容指标，覆盖模型调用、tool 执行和 skill 执行窗口。 |

OpenClaw 的标准 usage 把普通 `input`、`cacheRead`、`cacheWrite` 分列，并可提供已包含缓存的 `promptTokens`。插件优先使用有效（有限、非负）的 `promptTokens` 作为符合 OpenTelemetry GenAI 语义的完整 input；缺失或无效时计算 `input + cacheRead + cacheWrite`。`total` / `totalTokens` 不用于推断缓存是否已经包含在 input 中。缓存明细作为 input 的子集保留在 trace 属性中，不另报 `gen_ai.token.type`。

新格式 transcript 提供 `usage.contextUsage.state=available` 时，优先读取其中有效的 `promptTokens`（顶层有效 `promptTokens` 优先级更高），且 `cacheRead` / `cacheWrite` 按本次调用保留，不再做跨调用差值。缺少该新格式标记的旧 transcript 保留累计缓存计数的兼容处理。

## 首块响应延迟

`gen_ai.client.operation.time_to_first_chunk` 为 Histogram，单位 `s`。按每次模型调用采集，tags 使用 `agent_runtime`、`operation_name=chat`、`provider_name`、`request_model`、`status`，不携带 session/run/call ID，也不新增 tag alias 双写。

数据来自 OpenClaw `model.call.completed` / `model.call.error` 的 `timeToFirstByteMs`，按会话、run、调用 ID 和调用时间窗口去重；宿主重试复用调用 ID 时仍分别采样。只有有限、非负且不超过调用耗时的值才上报；首块后失败的调用仍计入，`status=error`。没有该字段的旧版或运行路径不产生采样点，不补零，也不从 transcript 推算。

看板名称建议使用“首块响应延迟”。平均值使用同一统计范围内 Histogram 的 `sum / count`；跨实例、跨时间桶时先合并 sum/count 再相除，不平均各实例的平均值，也不新增 `.avg` 指标。分析成功调用时筛选 `status=ok`，首块后失败的调用通过 `status=error` 单独分析。没有采样时显示无数据，不显示零。

接收端保留 Histogram 桶并支持对应聚合时，可计算 P50/P95/P99。该字段表示宿主首次观察到响应块的时间，可能是空事件；宿主只观察最终结果时也可能记录最终结果到达时间，因此不等同于首个有效 token 的严格 TTFT，也不代表用户消息到首字的端到端等待时间。

能够唯一关联到 `llm` 的调用，延迟同时写入 Trace tag `gen_ai.response.time_to_first_chunk`（秒），不再生成自定义事件。

## 非首 Token 平均耗时估算

`gen_ai.client.operation.time_per_output_token` 是客户端项目扩展指标，沿用当前仓库的 `gen_ai.client.operation.*` 命名族；它不等同于服务端 `gen_ai.server.time_per_output_token`，也不是逐个响应块间隔的 `time_per_output_chunk`。

在每次成功的原生模型调用结束时，从同一个事件取 `durationMs`、`timeToFirstByteMs` 和 `usage.output`，上报一个 Histogram 采样点：

```text
估算值（s）= (durationMs - timeToFirstByteMs) / (outputTokens - 1) / 1000
```

例如总耗时 1000 ms、首块耗时 200 ms、输出 101 Token，上报 `0.008 s`，看板显示 `8 ms/token`。首块不保证是首个有效 Token，调用结束还可能包含收尾时间，因此该指标仅为客户端估算，不承诺与模型服务端数值一致。

采样条件：

- 原生终态为 `model.call.completed`，并关联到实际生成的 `llm` span；`status=ok`。
- 调用耗时及首块耗时有限，且 `0 <= timeToFirstByteMs <= durationMs`；本次调用输出 Token 数为大于 1 的安全整数。
- 先收到匹配的 `model.call.started`，再在调用时间窗口内观测到 `run.progress` / `reason=model_call:stream_progress`。该原生事件表示宿主观察到了实时模型流。它没有 call ID，因此只有同一 session/run 内唯一活跃的调用才能关联；有重叠调用时跳过，不能借用其他调用的流式证据。
- 排除 `observationUnit=turn` 的聚合调用。非流式、仅最终结果、缺失开始或流式进度事件、迟到事件、纯历史回放、无法关联及非法数据均不猜测补值。未知路径不会生成看似零延时的采样点。

流式关联最多保留 1000 个活跃调用，1 小时过期；超限时清除关联状态并暂停关联 1 小时，避免在不完整的活跃调用集合上误归因。不影响原有调用、Token 和首块指标。调用标识只用于内部关联及去重，不进入新指标 tags；重复终态不会重复上报。老版本或运行路径没有上述流式证据时，该指标没有采样，这不表示插件安装失败。

Histogram 的 `sum / count` 是各次调用估算值的等权平均，分位数也是各次调用估算值的分位数；它不是按 Token 数加权的总体均值，也不是逐 Token 间隔的 P95/P99。分位数需要接收端保留并支持 Histogram 桶聚合。

## 指标结果状态

成本汇总需要包含用户请求和内部后台任务的所有实际 `llm` 调用。`request_type` / `is_internal_request` 是来源分类，不是计费资格；缺少输入输出正文也不代表没有模型用量。用户对话列表的前台筛选条件不应直接套用到总用量或总成本统计。

Token 用量按逐次 `llm` 汇总一次；根 `invoke_agent` 的汇总用量仅用于展示，不能再与其子 `llm` 相加。金额估算由计费侧结合 provider/model 以及普通输入、缓存输入和输出的对应价格计算；完整 input 已包含缓存子集，不能将完整 input 与缓存再次相加计费。本插件的内部任务分类修复保留用量，不额外生成金额估算指标。

新采集数据的指标 `status` 仅使用 `ok` / `error`：正常完成映射为 `ok`；失败、取消、中断和超时映射为 `error`，详细原因仍由 Trace 原始字段表达。`final_status`、`tool_result_status` 和 Trace 业务状态保留原语义，不直接复制为指标 `status`，Token 用量指标不新增 `status`。

无法确认结果时，不默认成功，也不生成猜测的结果指标采样。原生调用使用自身终态，transcript / synthetic 模型路径使用对应 assistant turn 的 `stopReason`（`stop/length/toolUse` 为成功，`error/aborted` 为失败）。缺失模型结果的旧 `model.usage` 聚合事件和 transcript 仍可保留已有 Token 用量，但不产生带猜测状态的 operation count/duration；缺失 workflow 结果时也不产生 workflow duration。

首块时间缺失不会影响已知终态调用的 operation count/duration 和 Token 用量。每次模型尝试按自己的结果计数；失败后成功重试分别为 `error` 和 `ok`，整轮最终结果独立统计。历史指标可能仍含 `completed/cancelled`，迁移查询时应区分历史数据与新数据。

## 通用 Tag 说明

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
| `final_status` | workflow 最终状态。当前只使用 `completed` / `cancelled`。 |
| `status` | 指标统一结果维度，仅使用 `ok` / `error`。 |

## 迁移说明

| 旧指标 | 当前替代方式 |
| --- | --- |
| `gen_ai.agent.request.duration` | 使用 `gen_ai.workflow.duration`。单位从 `ms` 改为 `s`。 |
| `gen_ai.agent.operation.duration` | 已恢复兼容上报；推荐新查询仍可使用 `gen_ai.client.operation.duration`，需要兼容 codex 插件口径时使用本指标。 |
| `gen_ai.agent.token.usage` | 使用 `gen_ai.client.token.usage`，只查询 `gen_ai.token.type=input/output`。 |
| `gen_ai.agent.request.count` | 当前不再上报 request count；需要请求次数时按 `gen_ai.workflow.duration` 点数或 trace 聚合。 |
| `gen_ai.agent.operation.count` | 已恢复兼容上报；每个可确认结果的 operation span 记录值 `1`。 |
| `gen_ai.agent.session.*` | 当前不再上报 session 聚合指标；会话级分析优先使用 `session_id` 关联 trace / logs / 当前指标。 |
| `gen_ai.runtime.*` | 当前不再上报 runtime 健康类 metrics；runtime 细节保留在 trace / logs 中。 |

## 使用建议

1. 端到端耗时看 `gen_ai.workflow.duration`。
2. 模型、tool、skill 执行耗时优先看 `gen_ai.client.operation.duration`；兼容 codex 插件查询时可看 `gen_ai.agent.operation.duration`。两者都可按 `gen_ai.operation.name`、`gen_ai.tool.name`、`gen_ai.skill.name`、`gen_ai.request.model` 切分。
3. 模型、tool、skill 执行次数看 `gen_ai.agent.operation.count`，每个可确认结果的 operation span 记录值 `1`。
4. 对能识别为 skill 的调用，trace 侧结构为 `invoke_agent -> tool:Skill -> skill:<name>`；指标侧会分别记录 `gen_ai.operation.name=execute_tool` / `gen_ai.tool.name=Skill` 和 `gen_ai.operation.name=skill` / `gen_ai.skill.name=<name>`。
5. Token 消耗看 `gen_ai.client.token.usage`，按 `gen_ai.token.type=input/output` 切分。
6. 单会话排查优先使用 `session_id` 或 `gen_ai.conversation.id` 关联 metrics、traces 和 logs。

## 代码入口

- [src/otel-bootstrap.ts](../src/otel-bootstrap.ts)
- [src/service.ts](../src/service.ts)
- [src/diagnostic-event-handler.ts](../src/diagnostic-event-handler.ts)
- [src/tool-span-manager.ts](../src/tool-span-manager.ts)
- [src/service-utils.ts](../src/service-utils.ts)
