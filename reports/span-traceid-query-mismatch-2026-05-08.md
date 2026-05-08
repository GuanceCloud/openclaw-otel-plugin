# span_id / trace_id 查询不一致排查

## 目标

- `span_id = f1a0ae98fddbb0bf`
- 验证是否能先查到对应 `trace_id`，再按该 `trace_id` 回查到同一条记录

## 时间范围

- 查询窗口：`2026-05-01` 到 `2026-05-08`
- 数据域：`T`
- 工具：`owl.data.check_dql`、`owl.data.query`

## 查询 1：按 span_id 精确查询

DQL：

```text
T::*:(time, trace_id, span_id, parent_id, service, resource, status, duration) { span_id = "f1a0ae98fddbb0bf" } [7d]
```

结果：

- 命中 `1` 条
- `trace_id = 41be47bf1ca76b47b61c29d60a264141`
- `resource = tool:exec`
- `parent_id = ee6e447c53a483d6`
- `time = 1778162484816`
- `duration = 120000`

## 查询 2：按 trace_id 精确查询整条 trace

DQL：

```text
T::*:(time, trace_id, span_id, parent_id, service, resource, status, duration) { trace_id = "41be47bf1ca76b47b61c29d60a264141" } [7d]
```

结果：

- 命中 `10` 条
- 能看到 `openclaw_request`、`agent_run`、`session_processing`、`runtime_orchestration`
- 能看到部分 `model_request`、`skill:dashboard`、`skill_call:dashboard`、`tool:write`
- **看不到** `span_id = f1a0ae98fddbb0bf`

## 查询 3：按 trace_id + span_id 联合精确查询

DQL：

```text
T::*:(time, trace_id, span_id, parent_id, service, resource, status, duration) { trace_id = "41be47bf1ca76b47b61c29d60a264141" AND span_id = "f1a0ae98fddbb0bf" } [7d]
```

结果：

- 命中 `0` 条

## 结论

已确认存在同一条数据的可检索不一致：

1. 按 `span_id` 精确查，能查到这条 `tool:exec`
2. 这条记录返回的 `trace_id` 明确是 `41be47bf1ca76b47b61c29d60a264141`
3. 但再按该 `trace_id` 精确查整条 trace，返回结果中没有这条 span
4. 再用 `trace_id + span_id` 联合精确查，也返回空

这说明问题不在插件上报格式，也不在“同批次上报”本身，而在平台侧该条数据的检索一致性上。更具体地说：

- 原始 span 记录已经存在，否则按 `span_id` 不可能查到
- 但这条记录没有稳定出现在 `trace_id` 维度的查询结果里

## 本地导出证据

从 `/var/log/syslog` 可确认，这条 `trace_id` 在本地插件侧已经正常生成并导出：

1. 插件在 `2026-05-07 22:02:27 +0800` 连续打印了 `7` 条 `model-turn` 日志，全部带有：
   - `trace_id = 41be47bf1ca76b47b61c29d60a264141`
   - `session_id = 32c7d402-793d-4350-be26-7f3db1f5978f`
   - `turn_index = 1..7`

2. 随后在 `2026-05-07 22:02:32 +0800` 打印了导出成功日志：

```text
[otel-plugin] trace export succeeded -> http://localhost:9529/otel/v1/traces (16ms, items=24)
```

这说明：

- 这条 trace 在插件本地不是零散上报，而是已经随同一批导出请求正常发出
- 本地至少可以确认该批次包含完整 trace 数据，且规模为 `24` 个 span
- 平台侧按 `trace_id` 精确查询只返回 `10` 条，和本地导出规模明显不一致

## 进一步判断

- 事实：本地 syslog 已确认 `trace_id = 41be47bf1ca76b47b61c29d60a264141` 的导出行为存在，且同批次导出 `items=24`
- 事实：平台按 `trace_id` 精确查询仅返回 `10` 条，并且缺失已知存在的 `span_id = f1a0ae98fddbb0bf`
- 推断：问题更接近平台侧的 trace 聚合 / 索引收敛 / 查询路径不一致，而不是插件漏上报
- 置信度：高

## 判断

- 事实：`span_id` 查询命中，`trace_id` 和 `trace_id + span_id` 查询不命中
- 推断：平台侧在 `trace_id` 关联、索引收敛或查询路径上存在不一致
- 置信度：高

## 建议

1. 平台侧直接核对这条记录的底层存储是否同时带有 `trace_id = 41be47bf1ca76b47b61c29d60a264141`
2. 检查 `trace_id` 维度查询与 `span_id` 维度查询是否走了不同索引或聚合链路
3. 对这条 `span_id` 做原始文档回查，确认 `trace_id` 字段是否在原始文档中可见、是否被标准化或裁剪
