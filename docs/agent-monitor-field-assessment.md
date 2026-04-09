# Agent 监测字段梳理

基于以下两部分信息整理：

- 需求文档：[Agent监测字段整理.docx](/home/liurui/Downloads/Agent监测字段整理.docx)
- 当前插件实现：[src/service.ts](/home/liurui/code/openclaw-otel-plugin/src/service.ts)、[src/tool-span-manager.ts](/home/liurui/code/openclaw-otel-plugin/src/tool-span-manager.ts)、[src/otel-bootstrap.ts](/home/liurui/code/openclaw-otel-plugin/src/otel-bootstrap.ts)、[src/config.ts](/home/liurui/code/openclaw-otel-plugin/src/config.ts)

目标不是把文档里的字段全量塞进插件，而是按当前应用能力分成三类：

1. 可以直接从链路提取
2. 应补成全局 tag
3. 不建议插件硬传，或当前阶段不需要

## 1. 当前应用已具备的提取面

当前插件里的字段来源分三层：

- OTel 原生链路字段：`trace_id`、`span_id`、`parent_span_id`、span 起止时间、span duration、`service.name`
- 全局 resource 标签：`agent_provider`、`agent_version`、`runtime_environment`、`agent_name`、`globalTags`、`resourceAttributes`
- span/request attributes：`session_id`、`session_key`、`channel`、`model_provider`、`model_name`、`tool_*`、`skill_*`、`final_status` 等

## 1.1 当前映射规则

当前实现已经不再建议平台直接消费原始 `openclaw.*` 字段，而是统一映射成通用字段名：

### 会话/模型/状态映射

| 原字段 | 当前映射字段 |
| --- | --- |
| `openclaw.sessionId` | `session_id` |
| `openclaw.sessionKey` | `session_key` |
| `openclaw.channel` / `openclaw.session.lastChannel` | `channel` |
| `openclaw.session.origin.provider` | `source_app` |
| `openclaw.session.origin.surface` | `entry_point` |
| `openclaw.provider` | `model_provider` |
| `openclaw.model` | `model_name` |
| `openclaw.tokens.input` | `input_tokens` |
| `openclaw.tokens.output` | `output_tokens` |
| `openclaw.tokens.total` | `total_tokens` |
| `openclaw.outcome` / `openclaw.final_state` | `final_status` |

### Tool 映射

规则是：凡是 `openclaw.tool.*`，统一映射成 `tool_*`，并删除原始 `openclaw.tool.*` 字段。

| 原字段 | 当前映射字段 |
| --- | --- |
| `openclaw.tool.call_id` | `tool_call_id` |
| `openclaw.tool.name` | `tool_name` |
| `openclaw.tool.target` | `tool_target` |
| `openclaw.tool.command` | `tool_command` |
| `openclaw.tool.phase` | `tool_phase` |
| `openclaw.tool.outcome` | `tool_outcome` |
| `openclaw.tool.result_status` | `tool_result_status` |
| `openclaw.tool.arg_keys` | `tool_arg_keys` |
| `openclaw.tool.args.preview` | `tool_args_preview` |
| `openclaw.tool.meta.preview` | `tool_meta_preview` |
| `openclaw.tool.result.preview` | `tool_result_preview` |
| `openclaw.tool.partial_result.preview` | `tool_partial_result_preview` |
| `openclaw.tool.loop.level` | `tool_loop_level` |
| `openclaw.tool.loop.action` | `tool_loop_action` |
| `openclaw.tool.loop.detector` | `tool_loop_detector` |
| `openclaw.tool.loop.count` | `tool_loop_count` |
| `openclaw.tool.loop.paired_tool` | `tool_loop_paired_tool` |
| `openclaw.tool.loop.message` | `tool_loop_message` |

同时保留两组兼容字段：

- `tool_target` 同时可派生为 `target_resource`
- `tool_outcome` 同时可派生为 `call_result`

### Skill 映射

| 原字段 | 当前映射字段 |
| --- | --- |
| `openclaw.skill.call_id` | `skill_call_id` |
| `openclaw.skill.name` | `skill_name` |
| `openclaw.skill.kind` | `skill_type` |
| `openclaw.skill.source` | `skill_source` |

## 2. 可直接从链路提取

这部分不需要再额外补全局 tag，或者只需要保留当前做法。

| 文档字段 | 当前应用提取方式 | 当前字段/来源 | 结论 |
| --- | --- | --- | --- |
| `event_time` | OTel span/event 时间 | span start/end time | 直接可取 |
| `trace_id` | OTel 原生 | trace 主键 | 直接可取 |
| `span_id` | OTel 原生 | span 主键 | 直接可取 |
| `parent_id` | OTel 原生 | 父子关系 | 直接可取 |
| `service_name` | resource | `service.name` | 直接可取，不要重复塞自定义字段 |
| `session_id` | span attr | `session_id` | 直接可取 |
| `session_key` | span attr | `session_key` | 直接可取 |
| `channel` | span attr | `channel` | 直接可取 |
| `source_app / origin.provider` | span attr | `source_app` | 直接可取 |
| `entry_point` | span attr | `entry_point` | 当前够用 |
| `model_provider` | model/request attrs | `model_provider` | 直接可取 |
| `model_name` | model/request attrs | `model_name` | 直接可取 |
| `input_tokens` | model/request attrs | `input_tokens` | 直接可取 |
| `output_tokens` | model/request attrs | `output_tokens` | 直接可取 |
| `total_tokens` | model/request attrs | `total_tokens` | 直接可取 |
| `latency_ms` | span duration | model span duration | 不必重复存字段 |
| `status` | span status + attrs | span status / `openclaw.outcome` | 直接可取 |
| `tool_call_id` | tool span attr | `tool_call_id` | 直接可取 |
| `tool_name` | tool span attr | `tool_name` | 直接可取 |
| `call_latency_ms` | tool span duration | tool span duration | 不必重复存字段 |
| `call_result` | tool span attr | `call_result` / `tool_outcome` | 直接可取 |
| `target_resource` | tool span attr | `target_resource` / `tool_target` | 直接可取 |
| `final_status` | root/run attr | `final_status` | 直接可取 |
| `agent_name` | resource | `agent_name` | 已补全局 tag |
| `agent_runtime` | resource | `runtime_environment` | 已补全局 tag，但语义更接近 runtime lane |
| `output_summary` | run/message attr | `openclaw.output.preview` | 直接可取，属于摘要字段 |
| `output_text_length` | message attr | `openclaw.output.length` | 直接可取 |

## 3. 建议补充到全局 tag

这部分适合做成 resource 级别标签，用于跨 trace/metric 统一筛选。它们通常是“一个实例/一个 Agent/一个部署周期内相对稳定”的信息。

当前应用已经自动补了：

- `agent_provider`
- `agent_version`
- `runtime_environment`
- `agent_name`

当前应用也已经支持通过 [src/config.ts](/home/liurui/code/openclaw-otel-plugin/src/config.ts) 里的 `globalTags` 追加固定标签。

建议补的全局 tag：

| 建议字段 | 是否已支持 | 建议来源 | 说明 |
| --- | --- | --- | --- |
| `deployment.environment` / `env` | 部分支持 | `globalTags` 或 `resourceAttributes` | 用于 prod/test/dev 隔离，优先补 |
| `app_id` | 未内建，已可配置 | `globalTags` | 用于区分“监测应用”而不是插件本身 |
| `app_name` | 未内建，已可配置 | `globalTags` | 页面展示常用 |
| `agent_id` | 未内建，已可配置 | `globalTags` | 如果要稳定识别某个 Agent，建议补 |
| `agent_type` | 未内建，已可配置 | `globalTags` | 如 `assistant`、`workflow-agent` |
| `agent_source` | 未内建，已可配置 | `globalTags` | 如 `builtin`、`sdk`、`api` |
| `agent_provider` | 已支持 | `agentProvider` 配置 | 默认 `openclaw` |
| `agent_version` | 已支持 | 自动解析 | 适合版本维度排查 |
| `runtime_environment` | 已支持 | 自动解析 | 当前从 `agent:<runtime>:<name>` 提取 |
| `agent_name` | 已支持 | 自动解析 | 当前从 session key 提取 |

推荐最小全局 tag 组合：

- `agent_provider`
- `agent_version`
- `runtime_environment`
- `agent_name`
- `deployment.environment`
- `app_id`
- `app_name`
- `agent_id`
- `agent_type`
- `agent_source`

推荐配置方式：

```json
{
  "plugins": {
    "entries": {
      "openclaw-otel-plugin": {
        "enabled": true,
        "config": {
          "endpoint": "http://localhost:4318",
          "tracePath": "v1/traces",
          "agentProvider": "openclaw",
          "globalTags": {
            "deployment.environment": "prod",
            "app_id": "agent-monitor",
            "app_name": "Agent监测",
            "agent_id": "main",
            "agent_type": "builtin",
            "agent_source": "openclaw"
          }
        }
      }
    }
  }
}
```

当前实现里的合并优先级：

1. 自动标签
2. `globalTags`
3. `resourceAttributes`

也就是说，如果你要手动覆盖自动值，可以直接在 `globalTags` 或 `resourceAttributes` 里覆盖。

## 4. 不建议插件直接硬传，应由平台侧 enrich

这部分更适合注册表、CMDB、权限中心、工具台账来补齐，不适合插件本地硬编码。

| 字段组 | 原因 |
| --- | --- |
| `agent_owner`、`agent_owner_id` | 责任归属信息，属于平台台账 |
| `is_registered_agent`、`register_source`、`register_id`、`register_status` | 注册中心/接入治理信息 |
| `agent_namespace`、`agent_version` | 更适合平台注册信息或发布系统补齐 |
| `tool_permission_scope`、`tool_risk_level`、`is_sensitive_tool`、`is_dangerous_tool` | 治理策略字段，不应由插件主观判断 |
| `tool_category`、`tool_provider`、`tool_namespace` | 适合工具注册表 enrich |
| `permission_scope`、`role_id`、`role_name`、`policy_id`、`policy_name`、`is_privileged_identity` | 权限系统字段，插件拿不到可靠口径 |

## 5. 不建议当前阶段额外上报

这部分要么和链路原生字段重复，要么当前收益不够高。

| 字段 | 原因 |
| --- | --- |
| `request_id` | 如果一条请求对应一条 trace，`trace_id` 已可替代；除非业务方强依赖独立请求号 |
| `call_sequence` | 当前链路树和时间线通常够用，二期再考虑 |
| `parent_call_id` | 工具嵌套关系当前可由 span 层级体现 |
| `call_depth` | 可由 span tree 推导，非首要字段 |
| `tool_type` | 当前可由 span 名称和层级区分，必要时二期补 |
| `target_resource_type`、`target_system`、`target_method`、`is_external_access` | 需要结构化解析，当前只拿到 `openclaw.tool.target` / `command`，二期再做更稳妥 |
| `blocked`、`block_reason` | 当前应用没有统一阻断框架，容易口径失真 |
| `error_code` | 当前插件拿不到稳定标准错误码 |
| `error_message` | 现有 `openclaw.reason` / `openclaw.error` 已可辅助排障，不建议先单独扩展统一 schema |

## 6. 明确不应由插件判定的字段

这部分在原始文档里也已明确，建议保持平台统一计算，不要在插件里做：

- 风险判定类：`risk_*`、`hit_policy_*`、`confidence_score`、`action_decision`
- 越权判断类：`is_cross_workspace_access`、`is_cross_tenant_access`、`unauthorized_*`
- 合规类：`is_masked`、`mask_strategy`、`data_classification`、`pii_*`、`compliance_tag`

原因只有一个：这些字段如果由插件自己算，平台之间会出现口径漂移，后续很难统一。

## 7. 二期增强字段

如果后续你们希望把 Agent 监测做成“可回放、可治理、可审计”的完整平台，再考虑这批字段：

- Prompt/输入摘要：`instruction_summary`、`context_summary`、`prompt_template_*`
- 模型高级参数：`temperature`、`top_p`、`max_tokens`、`queue_time_ms`、`first_token_latency_ms`
- Tool 结果摘要：`tool_params_digest`、`result_summary`、`result_size`
- 检索/知识访问：`knowledge_source_*`、`dataset_*`、`file_*`、`retrieval_latency_ms`
- 流程性能增强：`workflow_*`、`pipeline_*`、`execution_stage`、`fallback_*`、`cache_*`

这些字段价值确实高，但当前插件的数据面还不够稳定，优先级应低于“全局身份标签 + 基础 trace 事实字段”。

## 8. 结合当前应用的最终建议

最适合当前插件的一期字段方案：

- 链路直接取：
  `trace_id`、`span_id`、`parent_span_id`、`service.name`、`session_id`、`session_key`、`channel`、`model_provider`、`model_name`、`input_tokens`、`output_tokens`、`total_tokens`、`tool_call_id`、`tool_name`、`tool_phase`、`tool_result_status`、`call_result`、`target_resource`、`skill_call_id`、`skill_name`、`skill_type`、`skill_source`、`final_status`
- 全局 tag 补：
  `agent_provider`、`agent_version`、`runtime_environment`、`agent_name`、`deployment.environment`、`app_id`、`app_name`、`agent_id`、`agent_type`、`agent_source`
- 平台 enrich：
  注册信息、负责人、权限、工具治理信息
- 平台计算：
  风险、越权、合规

一句话总结：

- 事实字段尽量从链路直接取
- 稳定身份字段放全局 tag
- 治理和风险字段交给平台
- 不要为了“字段齐全”把冗余字段全部塞进插件
