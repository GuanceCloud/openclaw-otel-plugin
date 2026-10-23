# openclaw-otel-plugin 构建与发布

本文档只覆盖开发、编译、打包和发布流程。普通使用者安装或升级插件，请看仓库根目录的 README。

## 版本策略

- 版本号以 [package.json](./package.json) 的 `version` 为准
- 建议遵循 semver：`MAJOR.MINOR.PATCH`
- Git tag 建议使用 `vX.Y.Z`，例如 `v0.2.0`
- RC 使用 `vX.Y.Z-rc.N`，GitHub Release 标记为 pre-release，不更新正式版 latest；OSS 如需分发，仅上传带版本包及其校验文件。

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

- `output/openclaw-otel-plugin-v0.6.7.tar.gz`
- `output/openclaw-otel-plugin-v0.6.7.tar.gz.sha256`
- `output/openclaw-otel-plugin.tar.gz`
- `output/openclaw-otel-plugin.tar.gz.sha256`
- `output/install.sh`
- `output/install-release.sh`
- `output/install.ps1`
- `output/install-release.ps1`

其中带版本包是不可变发布包，`openclaw-otel-plugin.tar.gz` 是 latest 包，每次发布可以覆盖。
`install.sh` / `install-release.sh`（Linux/macOS）和 `install.ps1` / `install-release.ps1`（Windows）同时作为安装和升级执行层；未设置 `OSS_ENDPOINT` / `-OssEndpoint` 时从 GitHub Releases 下载，设置后从 OSS 下载。

打包时自动向安装器嵌入发布版本。RC 安装器收到 `latest` 时固定下载自身所属 RC；正式版安装器与源码安装器的 `latest` 仍选择正式版最新包。显式传入版本、URL 或本地包时按传入值处理。

打包内容包括：

- `dist/`
- `openclaw.plugin.json`
- `package.json`
- `README.md`
- `README_ZH.md`
- `LICENSE`
- `VERSION`
- `RELEASE.json`

发布入口 `dist/index.cjs` 已内置 OTEL 运行依赖，因此包内 `package.json` 不再声明源码构建所用的 dependencies/devDependencies；宿主 SDK 仍由安装器链接。源码仓库的依赖声明保持完整。

## 建议发布流程

1. 更新代码和文档。
2. 运行 `npm test`。
3. 运行 `npm run pack:release`。
4. 提交版本变更并打 tag，例如 `v0.6.7`。
5. 将 `output/` 下的带版本包、latest 包、对应 `.sha256`、`install.sh`、`install-release.sh`、`install.ps1` 和 `install-release.ps1` 上传到对应发布渠道。

RC 仅上传带版本包、其 `.sha256`、四个安装器和覆盖这些资产的 `SHA256SUMS`；Release 标记为 pre-release 且不更新 latest。发布后重新下载校验，并使用连接器指定该 RC 的 `--static-base` 在临时插件和配置目录执行安装。
