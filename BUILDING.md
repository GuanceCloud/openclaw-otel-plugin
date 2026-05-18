# openclaw-otel-plugin 构建与发布

本文档只覆盖开发、编译、打包和发布流程。普通使用者安装或升级插件，请看仓库根目录的 README。

## 版本策略

- 版本号以 [package.json](./package.json) 的 `version` 为准
- 建议遵循 semver：`MAJOR.MINOR.PATCH`
- Git tag 建议使用 `vX.Y.Z`，例如 `v0.2.0`

## 环境要求

- Node.js `22.x`
- npm
- OpenClaw `2026.3.23+`

## 本地开发

安装依赖：

```bash
npm install
```

构建产物：

```bash
npm run build
```

运行测试：

```bash
npm test
```

开发模式会监听 `index.ts`、`src/` 和 `openclaw.plugin.json`，自动重新 build 并重启 gateway：

```bash
npm run dev
```

## 源码安装，仅开发使用

```bash
cd ~/.openclaw/extensions
git clone <git-url>
cd openclaw-otel-plugin
npm install
npm run build
```

然后在 `~/.openclaw/openclaw.json` 中把该目录加入 `plugins.load.paths`。

## 预构建发布包

生成 release 安装包：

```bash
npm run pack:release
```

会生成到 `output/` 目录，例如：

- `output/openclaw-otel-plugin-v0.6.5.tar.gz`
- `output/openclaw-otel-plugin-v0.6.5.tar.gz.sha256`
- `output/openclaw-otel-plugin.tar.gz`
- `output/openclaw-otel-plugin.tar.gz.sha256`

其中带版本包是不可变发布包，`openclaw-otel-plugin.tar.gz` 是 latest 包，每次发布可以覆盖。

打包内容包括：

- `dist/`
- `openclaw.plugin.json`
- `package.json`
- `README.md`
- `README_ZH.md`
- `LICENSE`
- `VERSION`
- `RELEASE.json`

## 建议发布流程

1. 更新代码和文档。
2. 运行 `npm test`。
3. 运行 `npm run pack:release`。
4. 提交版本变更并打 tag，例如 `v0.6.5`。
5. 将 `output/` 下的带版本包、latest 包以及对应 `.sha256` 上传到 OSS 的 `openclaw-otel-plugin/` 目录。
