# openclaw-otel-plugin

`openclaw-otel-plugin` 是一个 OpenClaw 可观测性导出插件，用于将 OpenClaw 的诊断事件转换为面向会话的 trace，并导出补充 metrics，通过 `OTLP HTTP/protobuf` 上报到任意兼容的 OpenTelemetry 接收端。

## 功能说明

- 导出根链路，例如 `openclaw_request`
- 导出运行链路，例如 `main`、`user_message`、`assistant_message`
- 导出模型和 skill 相关 span
- 导出 tool 相关 span
- 导出诊断类事件，例如 `openclaw.session.stuck`
- 补充 OpenClaw 相关属性，便于在链路平台中排查问题
- 导出补充指标，例如请求数、请求时长、tool 调用数、tool 错误数、tool 时长、skill 命中数、model 调用数
- 镜像最新 OpenClaw 官方 `openclaw.*` diagnostics metrics，例如 `openclaw.tokens`、`openclaw.cost.usd`、`openclaw.message.queued`、`openclaw.queue.depth`

## 环境要求

- OpenClaw `2026.3.23+`
- Node.js `22.x`
- 一个可用的 OTLP HTTP/protobuf 接收端
- 默认示例地址：`http://localhost:4317`

兼容性说明：

- 当前代码已适配 OpenClaw `2026.3.23` 之后的插件 SDK 入口变化
- 已在本机安装的 OpenClaw `2026.3.23-2` 上验证可运行
- 如果你使用的是更早版本 OpenClaw，建议先升级后再安装本插件

## 安装方式

将仓库克隆到本地 OpenClaw 扩展目录：

```bash
cd ~/.openclaw/extensions
git clone https://github.com/GuanceDemo/openclaw-otel-plugin.git
cd openclaw-otel-plugin
npm install
npm run build
```

说明：

- `npm install`：安装插件运行所需依赖
- `npm run build`：将 `index.ts` 与 `src/*.ts` 编译到 `dist/`
- 首次安装必须执行以上两步，否则插件可能无法被正常加载

## 配置方式

编辑 `~/.openclaw/openclaw.json`，将插件加入：

- `plugins.allow`
- `plugins.load.paths`
- `plugins.entries`

示例配置如下：

```json
{
  "plugins": {
    "allow": [
      "openclaw-otel-plugin"
    ],
    "load": {
      "paths": [
        "/Users/yourname/.openclaw/extensions/openclaw-otel-plugin"
      ]
    },
    "entries": {
      "openclaw-otel-plugin": {
        "enabled": true,
        "config": {
          "endpoint": "http://localhost:4317",
          "tracePath": "v1/traces",
          "protocol": "http/protobuf",
          "serviceName": "openclaw-otel-plugin",
          "flushIntervalMs": 15000,
          "rootSpanTtlMs": 600000,
          "resourceAttributes": {
            "service.namespace": "openclaw",
            "deployment.environment": "local"
          }
        }
      }
    }
  }
}
```

说明：

- `flushIntervalMs` 同时作为 OTLP metrics 的周期导出间隔
- `tracePath` 默认为 `v1/traces`，可按需改成 `v1/llms` 等其他路由
- traces 走 `endpoint + / + tracePath`
- metrics 走 `/otel/v1/metrics`

## 重启网关

修改配置后，优先使用 OpenClaw 官方 CLI 重启网关服务：

```bash
openclaw gateway restart
```

如果你改动了插件 TypeScript 代码，先重新编译再重启网关：

```bash
npm run build
openclaw gateway restart
```

如果你正在本地开发插件，可以直接运行监听脚本，源码变更后会自动重新编译并重启网关：

```bash
npm run dev
```

说明：

- `npm run dev` 会监听 `index.ts`、`src/` 和 `openclaw.plugin.json`
- 每次检测到变更后，会自动执行 `npm run build` 和 `openclaw gateway restart`

## 验证方式

查看网关日志：

```bash
tail -n 50 ~/.openclaw/logs/gateway.log
```

正常情况下可以看到：

```text
[otel-plugin] trace exporter enabled (http/protobuf) -> http://localhost:4317/v1/traces
```

然后在 OpenClaw 中发送一条测试消息，再到链路平台中按以下条件查询：

- `service = openclaw-otel-plugin`
- 最新的 `trace_id`

如果接收端支持 metrics，还可以查询这些指标：

- `openclaw.requests`
- `openclaw.request.duration`
- `openclaw.tool.calls`
- `openclaw.tool.errors`
- `openclaw.tool.duration`
- `openclaw.skill.activations`
- `openclaw.model.calls`
- `openclaw.tokens`
- `openclaw.cost.usd`
- `openclaw.run.duration_ms`
- `openclaw.context.tokens`
- `openclaw.webhook.received`
- `openclaw.message.queued`
- `openclaw.message.processed`
- `openclaw.message.duration_ms`
- `openclaw.queue.depth`
- `openclaw.queue.wait_ms`
- `openclaw.session.state`
- `openclaw.session.stuck`
- `openclaw.run.attempt`

## 链路与指标说明

- 主要 trace 层级为 `openclaw_request -> user_message -> main -> skill:* -> skill_call:* -> tool:* / provider:model -> assistant_message`
- tool 执行会导出独立的 `tool:<name>` span，并附带 `openclaw.tool.call_id`、`openclaw.tool.outcome` 等属性
- `openclaw.session.stuck` 当前作为诊断告警上报，不再标记为错误
- skill 识别会综合 session 元数据、transcript 内容和本地 `~/.openclaw/workspace/skills` 下的 skill 信息
- metrics 分为两类：插件补充的请求/tool/skill/model 指标，以及按 OpenClaw 诊断事件镜像出来的官方 `openclaw.*` 指标

## 常见问题

### 1. 收不到 trace

请依次检查：

- OTLP 接收端是否可用
- `endpoint` 配置是否正确
- 插件是否已在 `openclaw.json` 中启用
- `gateway.log` 中是否出现 exporter enabled 日志

### 2. skill 名称显示不全

请检查：

- skill 是否存在于 session 元数据或本地 workspace skills 中
- skill 名称或描述是否出现在 transcript / reasoning / output 中
- 新增本地 skill 后是否已经重启网关

### 3. 配置无效

注意插件自定义配置必须放在：

```text
plugins.entries.openclaw-otel-plugin.config
```

不要把以下字段直接放在插件 entry 顶层：

- `endpoint`
- `tracePath`
- `serviceName`
- `resourceAttributes`
- `flushIntervalMs`
- `rootSpanTtlMs`

## 仓库结构

- `index.ts`：插件入口
- `src/config.ts`：配置解析
- `src/service.ts`：trace 与 metrics 生成、导出逻辑
- `src/trace-runtime.js`：运行时辅助函数
- `openclaw.plugin.json`：插件清单
- `test/trace-runtime.test.mjs`：运行时测试

## Todo

- `channel` 链路补充与收敛
- 协议层结构调整与兼容性梳理
