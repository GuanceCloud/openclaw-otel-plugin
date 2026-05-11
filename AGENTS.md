# AGENTS.md

本文件面向会在本仓库中执行阅读、修改、测试、提交流程的 AI 编码代理。目标是让代理优先遵守当前仓库已经确定的 telemetry、文档和发布约束，而不是按通用习惯自行猜测。

## 项目定位

- 本仓库是 OpenClaw 的 OTEL / GenAI telemetry 插件。
- 主要职责是把 OpenClaw runtime、diagnostics、session snapshot 转换为：
  - traces
  - metrics
  - 可选 logs
- 当前用户面向的主命名空间是：
  - `gen_ai.client.*`
  - `gen_ai.agent.*`
  - `gen_ai.runtime.*`

## Source Of Truth

处理对应主题前，优先阅读这些文件：

- 构建、打包、发布：[`BUILDING.md`](./BUILDING.md)
- 指标命名和 tag：[`docs/gen-ai-metrics.md`](./docs/gen-ai-metrics.md)
- trace / span / log tag：[`docs/gen-ai-trace-tags.md`](./docs/gen-ai-trace-tags.md)
- 配置入口：[`openclaw.plugin.json`](./openclaw.plugin.json)、[`src/config.ts`](./src/config.ts)
- OTEL 指标注册：[`src/otel-bootstrap.ts`](./src/otel-bootstrap.ts)
- 运行时主流程：[`src/service.ts`](./src/service.ts)、[`src/diagnostic-event-handler.ts`](./src/diagnostic-event-handler.ts)
- tool / skill span：[`src/tool-span-manager.ts`](./src/tool-span-manager.ts)

如果代码、README、历史习惯与上述文档冲突，优先以这些 source-of-truth 文件和当前代码实现为准。

## Telemetry Rules

- 用户文档里优先描述当前推荐的 `gen_ai.*` 指标。
- 不要在 README 中继续枚举旧 `openclaw.*` 指标名，除非明确是在解释兼容历史。
- trace / metrics 的关联字段统一使用 canonical tag，例如：
  - `session_id`
  - `session_key`
  - `channel`
  - `provider_name`
  - `request_model`
  - `tool_name`
  - `tool_call_id`
- 不要重新引入 `gen_ai.*` tag alias 双写，除非用户明确要求恢复兼容。
- `gen_ai.client.*` 是 client/model-call 维度，不能强行写成 session 维度语义。
- `gen_ai.agent.session.token.input` / `output` / `total` 是推荐的 session token 指标；`gen_ai.agent.session.token.usage` 仅兼容保留。

## Documentation Rules

- README 只保留用户安装、升级、配置、验证所需内容。
- 构建、源码安装、打包、发布流程统一放在 [`BUILDING.md`](./BUILDING.md)。
- 改 telemetry 命名时，必须同时检查：
  - [`README.md`](./README.md)
  - [`README_ZH.md`](./README_ZH.md)
  - [`docs/gen-ai-metrics.md`](./docs/gen-ai-metrics.md)
  - [`docs/gen-ai-trace-tags.md`](./docs/gen-ai-trace-tags.md)
- 如果 README 中出现旧字段名、旧 tag 名、旧指标名，优先收敛到当前 canonical 命名。

## Build And Test

常用命令：

```bash
npm run build
npm test
npm run pack:release
```

辅助脚本：

- 安装 release：[`scripts/install.sh`](./scripts/install.sh)
- 升级 release：[`scripts/update.sh`](./scripts/update.sh)
- 本地开发监听：`npm run dev`

涉及打包、安装、升级的改动后，优先至少验证：

```bash
bash scripts/install.sh --help
bash scripts/update.sh --help
npm run pack:release
```

## Commit Hygiene

以下内容不应进入提交，除非用户明确要求：

- `reports/`
- `output/`
- `.idea/`
- 其他本地产物、调试文件、临时分析报告

如果工作区里存在与当前任务无关的修改，不要顺手清理或回退，先避开它们。

## Change Checklist

当改动涉及 telemetry、文档、发布流程时，提交前至少检查：

1. 指标名是否仍符合 `gen_ai.*` 当前口径。
2. trace / metrics tag 是否仍使用 canonical 命名。
3. README 是否误写回旧 `openclaw.*` 指标名。
4. `BUILDING.md` 是否需要同步。
5. 测试是否更新并通过。

## Response Style

- 结论优先，少讲泛化背景。
- 说明问题时优先给“当前实现是什么、为什么这么做、改动边界是什么”。
- 如果发现与当前任务无关但可能危险的工作区变化，明确指出，但不要擅自处理。
