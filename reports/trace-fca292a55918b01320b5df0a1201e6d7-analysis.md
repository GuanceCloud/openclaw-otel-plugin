# trace `fca292a55918b01320b5df0a1201e6d7` 排查

## 范围

- 时间范围：`2026-05-08 09:57:00 +0800` 到 `2026-05-08 10:05:30 +0800`
- 数据域：`T`、本地插件导出日志
- 使用工具：`owl.data.query`、本地日志检索

## 发现

1. 这次执行不是单条 trace，而是被拆成了两条高度重叠的 trace：
   - `fca292a55918b01320b5df0a1201e6d7`
   - `20aa71da0459c2ef2794740617f94268`

2. 本地插件日志确认：
   - `fca292...` 先在 `09:57:09 +0800` 导出了一批仅 `2` 个 span 的 payload
   - 后续在 `10:04:39 +0800` 又为同一条 `fca292...` 导出了一批 `63` 个 span 的 payload
   - 随后在 `10:05:21 +0800` 又导出了一条新的 `20aa71...`，且 payload 有 `71` 个 span

3. 观测云侧精确查询结果：
   - `fca292...` 返回 `46` 个 span
   - `20aa71...` 也返回 `46` 个 span
   - 两条 trace 的主体结构几乎相同，说明同一轮执行被重复切 trace 了

## 本地导出证据

### `fca292...` 第一批

- 时间：`2026-05-08 09:57:09 +0800`
- `items=2`
- payload 只有：
  - `channel_ingress`
  - `session_processing`

### `fca292...` 第二批

- 时间：`2026-05-08 10:04:39 +0800`
- `items=63`
- payload 包含：
  - `runtime_orchestration x1`
  - `model_request x18`
  - `tool:*`
  - `skill_call:*`
  - `agent_run`
  - `openclaw_request`
  - 以及其他链路节点

### `20aa71...` 第三批

- 时间：`2026-05-08 10:05:21 +0800`
- `items=71`
- payload 结构与 `fca292...` 高度重叠，同样覆盖整轮 dashboard 生成流程

## 观测云查询结果

### `fca292...`

- 返回 `46` 个 span
- 资源分布：
  - `model_request x12`
  - `skill_call:dashboard x12`
  - `tool:read x8`
  - `tool:exec x4`
  - `tool:write x2`
  - `tool:process x2`
  - `skill:dashboard x1`
  - `runtime_orchestration x1`
  - `agent_run x1`
  - `session_processing x1`
  - `openclaw_request x1`
  - `channel_ingress x1`

### `20aa71...`

- 返回 `46` 个 span
- 资源分布与 `fca292...` 基本一致

## 判断

- 事实：本地导出已经确认同一轮执行至少被导出了两条主 trace：`fca292...` 和 `20aa71...`
- 事实：两条 trace 的时间窗和主体结构高度重叠
- 事实：观测云中这两条 trace 都各自只落了 `46` 个 span，与本地 `63`/`71` 的导出规模不一致
- 推断：当前插件仍然存在“同一轮执行被重复切 trace”的问题，而且平台侧对这两条 trace 的落库也存在截断或不完整
- 置信度：高

## 结论

这条 `fca292...` 不能单独看成“某条 trace 缺少部分 span”。更准确的结论是：

1. 同一轮 dashboard 生成执行被拆成了两条 trace
2. 两条 trace 都只落到了一部分 span
3. 这说明当前问题仍然在插件 trace 生命周期切分逻辑上，而不是单纯的平台查询误差

## 代码级原因

已定位到为什么会“重开 trace”：

1. `message.processed` 会先检查 replay 水位线：
   - [src/diagnostic-event-handler.ts](/home/liurui/code/openclaw-otel-plugin/src/diagnostic-event-handler.ts:569)
   - 只要 `hasReplayWatermark(sessionKey, snapshot)` 返回 `false`，就会再次进入 transcript replay

2. replay 水位线是按 **session 最新 snapshot** 算的，不是按“这条消息 / 这轮 run”算的：
   - [src/service.ts](/home/liurui/code/openclaw-otel-plugin/src/service.ts:89)
   - 水位线包含 `lastAssistantTs`、`lastRunAssistantTurns.length`、`lastAssistantText.length` 等字段
   - 这意味着：如果同一轮执行在第一次 finalize 之后，transcript 又继续增长，水位线就会变化

3. 一旦水位线变化，而当前 active trace 又已经被清掉，`emitTranscriptModelSpans()` 会重新创建 run：
   - [src/tool-span-manager.ts](/home/liurui/code/openclaw-otel-plugin/src/tool-span-manager.ts:629)
   - 它内部直接调用 `getRun(..., true)`

4. `getRun(..., true)` 在没有 active requestKey 时，会重新生成新的 requestKey：
   - [src/service.ts](/home/liurui/code/openclaw-otel-plugin/src/service.ts:230)
   - [src/service.ts](/home/liurui/code/openclaw-otel-plugin/src/service.ts:638)
   - 这会直接创建一条新的 `openclaw_request / agent_run`，也就是一条新的 trace

5. 新 trace 的开始时间之所以会回到最早的 turn，而不是晚到 `10:05` 才开始，是因为 replay 用的是 transcript 的回放起点：
   - [src/tool-span-manager.ts](/home/liurui/code/openclaw-otel-plugin/src/tool-span-manager.ts:637)
   - 所以第二条 trace 会从第一轮 `model_request` 的时间重新开始，看起来像“整轮执行又来了一遍”

### 直接结论

当前真正的 bug 不是单纯“重复 `message.queued`”，而是：

- **replay 去重是按 session 最新 snapshot 做的**
- **不是按单条消息 / 单轮请求做的**

因此当同一轮执行在第一次 finalize 之后，snapshot 继续增长时：

1. 原 trace 已经 `endRun/endRoot/clearRun`
2. 新 snapshot 让 replay 水位线失效
3. transcript replay 又用 `createIfMissing: true` 补出新的 run/root
4. 最终同一轮执行被拆成第二条 trace
