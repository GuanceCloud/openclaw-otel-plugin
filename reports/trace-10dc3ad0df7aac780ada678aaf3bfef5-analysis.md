# trace `10dc3ad0df7aac780ada678aaf3bfef5` 瀑布图分析

## 范围

- 时间范围：`2026-05-08 10:24:26 +0800` 到 `2026-05-08 10:25:36 +0800`
- 数据域：`T`、本地插件导出日志
- 使用工具：`owl.data.query`、本地日志检索

## 结论

这条瀑布图看起来“不对劲”，根因不是当前 trace 关系本身错了，而是：

1. **本地插件实际导出了 17 个 span**
2. **观测云当前只查到了 13 个 span**
3. 丢掉的是这条链路的**后半段**

因此你看到的“最后一个 `model_request` 在中间”并不是它真的在中间结束，而是因为：

- 它后面本来还有：
  - 1 次 `tool:exec`
  - 1 次 `tool:process`
  - 2 次 `model_request`
  - 1 次 `channel_egress`
- 这些 span 目前在平台查询结果里缺失了

## 观测云当前查到的 13 个 span

- `openclaw_request`
- `channel_ingress`
- `agent_run`
- `session_processing`
- `runtime_orchestration`
- `model_request x3`
- `skill:dashboard`
- `skill_call:dashboard x2`
- `tool:exec x2`

也就是说，观测云现在只显示到了这段：

1. 第 1 次 `model_request`
2. 第 1 次 `tool:exec`
3. 第 2 次 `model_request`
4. 第 2 次 `tool:exec`
5. 第 3 次 `model_request`

所以瀑布图里这个“最后一个 `model_request`”只是**当前可见部分里的最后一个**，不是整轮执行的最后一个。

## 本地实际导出证据

本地插件日志里同一条 `trace_id = 10dc3ad0df7aac780ada678aaf3bfef5` 明确有：

- `2026-05-08 10:24:33 +0800`
  - 先导出 `2` 个壳层 span：
    - `channel_ingress`
    - `session_processing`

- `2026-05-08 10:25:31 +0800`
  - 有 `5` 条 `model-turn` 调试日志：
    - turn 1: `f6369e35220c94cb`
    - turn 2: `044ea3a04106b6ce`
    - turn 3: `648c0643c97b55d9`
    - turn 4: `27ddfd14f618ca31`
    - turn 5: `3f0855dd8ab23487`

- `2026-05-08 10:25:36 +0800`
  - `trace export payload` 明确显示 `span_count = 17`
  - 其中包含：
    - `runtime_orchestration x1`
    - `model_request x5`
    - `tool:exec x3`
    - `tool:process x1`
    - `skill_call:dashboard x3`
    - `skill:dashboard x1`
    - `channel_egress x1`
    - `agent_run x1`
    - `openclaw_request x1`

## 为什么 skill:dashboard 很长，而最后一个 model_request 在中间

这是当前展示缺 span 后的视觉结果：

- `skill:dashboard` 本地是从第一次工具调用开始，一直覆盖到最后回复前
- 观测云缺了后面的 `tool:process`、第 4/5 次 `model_request` 和 `channel_egress`
- 因此剩下可见的最后一个 `model_request` 只能停在 `skill:dashboard` 长条的中间位置

换句话说：

- **skill span 长本身是合理的**
- **最后一个 model 看起来在中间，是因为后半段 span 没查出来**

## 判断

- 事实：本地导出 `17` 个 span，观测云只查到 `13` 个
- 事实：缺失 span 正好是链路尾部
- 推断：当前瀑布图展示异常，主要是平台落库/检索不完整，不是当前 trace 编排关系错误
- 置信度：高
