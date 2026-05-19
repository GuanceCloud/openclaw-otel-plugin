---
name: openclaw-gtrace-install
description: Use when the user wants to install or upgrade the OpenClaw OTEL plugin through the GTrace install flow, and expects the agent to build and run the install command from explicit parameters such as installer URL, endpoint, token, version, and tags. This skill is only for the GTrace install path.
---

# OpenClaw GTrace 安装任务

你是执行安装任务的 AI Agent。你的目标是在当前运行环境中完成 OpenClaw OTEL 插件安装或升级，并在安装后完成最小必要验证。该 skill 已内置 GTrace 安装方式，执行时始终使用 `--type gtrace`，不需要用户额外指定安装类型。严格按任务步骤执行，不要把本文档改写成说明文，不要改成 `otlp` 安装流程，也不要把具体域名、Token、tag、版本写死在 skill 里。

## 任务输入

从用户消息中读取以下参数：

- `OSS_ENDPOINT`
- `VERSION`
- `DATAWAY_ENDPOINT`
- `X_TOKEN`
- `TAGS`

可选参数：

- `NO_CONFIG`
- `NO_RESTART`

参数含义：

- `OSS_ENDPOINT`：OSS 根地址；执行时去掉末尾 `/` 后拼成 `<OSS_ENDPOINT>/openclaw-otel-plugin`，同时用于下载 installer 和插件包
- `VERSION`：安装来源，支持 `latest`、版本号、版本标签、本地 tar.gz 路径、远程 tar.gz URL
- `DATAWAY_ENDPOINT`：GTrace 接收端基础地址
- `X_TOKEN`：鉴权令牌
- `TAGS`：要追加的 `--tag KEY=VALUE` 列表
- `NO_CONFIG`：是否追加 `--no-config`
- `NO_RESTART`：是否追加 `--no-restart`

执行约束：

- 必须使用用户提供的参数
- 不要自行猜测、替换或改写用户提供的 URL、endpoint、token、tag
- 不要在输出中展示 `X_TOKEN` 明文
- `gtrace` 已内置在 skill 中，执行时必须直接使用，不要再向用户追问安装类型
- 如果命令失败，先根据错误信息修正并重试一次
- 安装完成后必须执行验证命令

## 任务 1：检查参数

确认以下参数存在且非空：

```text
OSS_ENDPOINT
VERSION
DATAWAY_ENDPOINT
X_TOKEN
```

如果缺少参数，停止安装并向用户说明缺少的参数名称。

参数格式检查：

- `OSS_ENDPOINT` 必须以 `http://` 或 `https://` 开头
- `DATAWAY_ENDPOINT` 必须以 `http://` 或 `https://` 开头
- `X_TOKEN` 不能为空，不能是占位符文本
- `VERSION` 不能为空

如果参数格式不符合要求，停止安装并提示用户重新提供正确参数。

## 任务 2：构造安装命令

基础命令模板如下。执行前先把 `OSS_ENDPOINT` 末尾的 `/` 去掉，再拼成 `OSS_ROOT=<OSS_ENDPOINT>` 和 `OSS_BASE=<OSS_ROOT>/openclaw-otel-plugin`：

```bash
OSS_ROOT="<OSS_ENDPOINT_WITHOUT_TRAILING_SLASH>"
OSS_BASE="${OSS_ROOT}/openclaw-otel-plugin"
rm -f /tmp/openclaw-otel-plugin-install.sh && \
curl -fsSL -o /tmp/openclaw-otel-plugin-install.sh "${OSS_BASE}/install.sh" && \
OSS_ENDPOINT="${OSS_ROOT}" \
bash /tmp/openclaw-otel-plugin-install.sh "<VERSION>" \
  --type gtrace \
  --endpoint "<DATAWAY_ENDPOINT>" \
  --x-token "<X_TOKEN>"
```

如果 `TAGS` 有多项，为每一项追加：

```bash
  --tag "<KEY=VALUE>"
```

如果 `NO_CONFIG=true`，追加：

```bash
  --no-config
```

如果 `NO_RESTART=true`，追加：

```bash
  --no-restart
```

构造完成后，执行真实命令。不要把 skill 目录中的脚本当作前提条件。

注意：

- 不要要求用户再补充 `TYPE`、`INSTALL_TYPE`、`gtrace` 或 `otlp`
- 该 skill 的安装类型固定就是 `gtrace`

## 任务 3：执行安装

执行时遵循以下规则：

- 先删除旧的 `/tmp/openclaw-otel-plugin-install.sh`
- 再从 `<OSS_BASE>/install.sh` 下载 installer
- 再把 `OSS_ENDPOINT=<OSS_ROOT>` 传给 installer，并显式传入 `--type gtrace`
- 所有 tag 都要单独展开为一个 `--tag`

安装兜底：

- 如果 `curl` 下载失败，先检查 `OSS_ENDPOINT` 是否可访问，再重试一次
- 如果 installer 执行失败，保留关键错误并重试一次
- 如果提示 `--endpoint` 或 `--x-token` 缺失，停止安装并提示用户补齐参数
- 如果提示依赖缺失，如 `tar`、`node`、`npm`、`openclaw`，按错误信息处理
- 不要把 `X_TOKEN` 改写成其他参数名

## 任务 4：验证安装结果

安装后至少执行以下检查：

```bash
test -d "${HOME}/.openclaw/extensions/openclaw-otel-plugin"
test -f "${HOME}/.openclaw/openclaw.json"
```

如果不是 `NO_CONFIG=true` 的场景，再检查：

- `openclaw.json` 中包含 `plugins.allow` 对 `openclaw-otel-plugin` 的允许
- `plugins.load.paths` 中包含插件目录
- `plugins.entries.openclaw-otel-plugin.enabled = true`

如果本机存在 `openclaw` 命令，再执行：

```bash
openclaw gateway restart
```

验证兜底：

- 插件目录不存在：说明安装包未成功展开或复制，回看 installer 输出
- 配置文件不存在：说明 `--no-config` 生效，或配置写入失败
- 配置项缺失：检查是否误传 `NO_CONFIG=true`
- `openclaw gateway restart` 失败：反馈关键错误，但不要回滚已安装文件

## 任务 5：完成回复

成功时回复：

```text
OpenClaw GTrace 安装已完成。
```

失败时回复：

```text
OpenClaw GTrace 安装未完成。
失败步骤：<步骤名称>
错误信息：<关键错误>
处理建议：<下一步建议>
```

回复中不得包含 `X_TOKEN` 明文。
