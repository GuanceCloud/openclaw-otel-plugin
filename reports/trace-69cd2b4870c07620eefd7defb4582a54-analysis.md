# Trace 分析：`69cd2b4870c07620eefd7defb4582a54`

**范围**
- 时间范围：`2026-05-08 15:44:35 +0800` 到 `2026-05-08 15:48:34 +0800`
- 数据域：`APM Trace` + 本地导出日志
- 使用工具：`owl.data.simple_query`、本地日志检索

**发现**
- 这条 trace 的层级问题在 exporter 侧已经存在，不是单纯平台展示问题。
- 本地日志显示这条 trace 被分两批导出：
  - 第 1 批：`2` 个 span，只包含 `channel_ingress` 和 `session_processing`
  - 第 2 批：`112` 个 span
- 第 2 批里存在大量异常 span：
  - 多个 `model_request` 的 `start_time = 1778226275436`、`end_time = 1778226275437`
  - 多个 `tool:exec` 的 `start_time = 1778226275556`、`end_time = 1778226275676`
  - 这些 span 的 `parent_id` 全都直接指向 `agent_run = 5c704c0d70b8d531`
- 观测云查询到的结果和本地异常导出一致，说明“层级塌陷”不是查询丢数据导致的假象。

**证据**
- 本地导出日志：
  - `/tmp/openclaw/openclaw-2026-05-08.log`
  - `2026-05-08 15:44:40 +0800`：`trace export payload`，`span_count=2`
  - `2026-05-08 15:48:33 +0800`：`trace export payload`，`span_count=112`
- 第 2 批 payload 中的典型异常 span：
  - `model_request`:
    - `9fc127ca80849f21`
    - `acdc9b67ed3cc782`
    - `195696b1adef86b3`
    - `c45b60e19ea817ee`
    - 以及更多同类 span
  - 以上 span 共同特征：
    - `parent_id = 5c704c0d70b8d531`
    - `start_time = 1778226275436`
    - `end_time = 1778226275437`
- 观测云查询结果同样出现：
  - 一串 `duration = 1000` 的 `model_request`
  - 一串 `duration = 120000` 的 `tool:exec`
  - 全部直接挂在 `agent_run` 下

**判断**
- 事实：
  - 这条 trace 的层级缺失不是平台 UI 独有问题。
  - 插件本地已经导出了错误结构的 span。
- 推断：
  - 这次异常更像是 transcript replay 或增量回放状态在这条消息上失控了。
  - 回放过程把多轮 turn / tool call 压扁成一批“同一时刻开始”的 synthetic span。
  - 同时没有正确产出 `skill_call:*` 这一层，导致 `tool:exec` 全部直接挂到 `agent_run`。

**结论**
- 你感觉“缺少层级关系”是对的。
- 对这条 trace 来说，根因在上报端：
  - `model_request` 层级被压扁
  - `tool:exec` 缺少 `skill_call` 包裹层
  - 大量 span 使用了同一时间基线

**后续建议**
1. 优先检查 transcript 增量回放在这条消息上的 turn 去重和 tool call 去重逻辑。
2. 检查 `skill_call` 生成路径是否在 replay 分支被跳过。
3. 对 replay 生成的 span 增加“同一毫秒大批量重复 start/end”的保护，避免继续导出明显异常结构。
