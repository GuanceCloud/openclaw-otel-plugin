# openclaw-otel-plugin

`openclaw-otel-plugin` 是一个 OpenClaw 链路导出插件，用于将 OpenClaw 的诊断事件转换为面向会话的 trace，并通过 OTLP HTTP/protobuf 上报到任意兼容的 OTel 接收端。

## 功能说明

- 导出根链路，例如 `openclaw_request`
- 导出运行链路，例如 `main`、`user_message`、`assistant_message`
- 导出模型和 skill 相关 span
- 导出诊断类事件，例如 `openclaw.session.stuck`
- 补充 OpenClaw 相关属性，便于在链路平台中排查问题

## 环境要求

- OpenClaw `2026.3.12+`
- Node.js `22.x`
- 一个可用的 OTLP HTTP/protobuf 接收端
- 默认示例地址：`http://localhost:4317`

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
[openclaw-otel-plugin] trace exporter enabled (http/protobuf) -> http://localhost:4317/v1/traces
```

然后在 OpenClaw 中发送一条测试消息，再到链路平台中按以下条件查询：

- `service = openclaw-otel-plugin`
- 最新的 `trace_id`

## 链路说明

- 主要 trace 层级为 `openclaw_request -> user_message -> main -> skill:* -> tool:* / provider:model -> assistant_message`
- tool 执行会导出独立的 `tool:<name>` span，并附带 `openclaw.tool.call_id`、`openclaw.tool.outcome` 等属性
- `openclaw.session.stuck` 当前作为诊断告警上报，不再标记为错误
- skill 识别会综合 session 元数据、transcript 内容和本地 `~/.openclaw/workspace/skills` 下的 skill 信息

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
- `serviceName`
- `resourceAttributes`
- `flushIntervalMs`
- `rootSpanTtlMs`

## 仓库结构

- `index.ts`：插件入口
- `src/config.ts`：配置解析
- `src/service.ts`：trace 生成与导出逻辑
- `src/trace-runtime.js`：运行时辅助函数
- `openclaw.plugin.json`：插件清单
- `test/trace-runtime.test.mjs`：运行时测试

## Todo

- `channel` 链路补充与收敛
- `OpenClaw` 指标补充与导出
- 协议层结构调整与兼容性梳理
