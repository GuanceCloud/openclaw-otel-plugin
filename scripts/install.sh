#!/usr/bin/env bash
set -euo pipefail

REPO_OWNER="${OPENCLAW_PLUGIN_REPO_OWNER:-GuanceCloud}"
REPO_NAME="${OPENCLAW_PLUGIN_REPO_NAME:-openclaw-otel-plugin}"
PLUGIN_DIR="${OPENCLAW_PLUGIN_DIR:-$HOME/.openclaw/extensions/openclaw-otel-plugin}"
CONFIG_FILE="${OPENCLAW_CONFIG_FILE:-$HOME/.openclaw/openclaw.json}"
RESTART_GATEWAY=1
WRITE_CONFIG=1
VERSION_INPUT=""
ENDPOINT=""
INSTALL_TYPE=""
X_TOKEN=""
TAGS=()
tmp_dir=""

log() {
  printf '[install] %s\n' "$1"
}

cleanup() {
  if [ -n "${tmp_dir:-}" ] && [ -d "${tmp_dir:-}" ]; then
    rm -rf "$tmp_dir"
  fi
}

trap cleanup EXIT

usage() {
  cat <<'EOF'
用法:
  scripts/install.sh [latest|v0.6.0|0.6.0|/path/to/archive.tar.gz|https://...tar.gz] [--type TYPE] [--endpoint URL] [--x-token TOKEN] [--tag KEY=VALUE] [--no-config] [--no-restart]

环境变量:
  OPENCLAW_PLUGIN_DIR        安装目录，默认 ~/.openclaw/extensions/openclaw-otel-plugin
  OPENCLAW_CONFIG_FILE       OpenClaw 配置文件，默认 ~/.openclaw/openclaw.json
  OPENCLAW_PLUGIN_REPO_OWNER GitHub owner，默认 GuanceCloud
  OPENCLAW_PLUGIN_REPO_NAME  GitHub repo，默认 openclaw-otel-plugin
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-restart)
      RESTART_GATEWAY=0
      ;;
    --no-config)
      WRITE_CONFIG=0
      ;;
    --endpoint)
      shift
      if [ "$#" -eq 0 ]; then
        printf '[install] --endpoint 需要传入 URL\n' >&2
        exit 1
      fi
      ENDPOINT="$1"
      ;;
    --endpoint=*)
      ENDPOINT="${1#*=}"
      ;;
    --x-token)
      shift
      if [ "$#" -eq 0 ]; then
        printf '[install] --x-token 需要传入 TOKEN\n' >&2
        exit 1
      fi
      X_TOKEN="$1"
      ;;
    --x-token=*)
      X_TOKEN="${1#*=}"
      ;;
    --type)
      shift
      if [ "$#" -eq 0 ]; then
        printf '[install] --type 需要传入类型\n' >&2
        exit 1
      fi
      INSTALL_TYPE="$1"
      ;;
    --type=*)
      INSTALL_TYPE="${1#*=}"
      ;;
    type=*)
      INSTALL_TYPE="${1#*=}"
      ;;
    --tag)
      shift
      if [ "$#" -eq 0 ]; then
        printf '[install] --tag 需要传入 KEY=VALUE\n' >&2
        exit 1
      fi
      TAGS+=("$1")
      ;;
    --tag=*)
      TAGS+=("${1#*=}")
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [ -z "$VERSION_INPUT" ]; then
        VERSION_INPUT="$1"
      fi
      ;;
  esac
  shift
done

if [ -z "$VERSION_INPUT" ]; then
  VERSION_INPUT="latest"
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[install] 缺少命令: %s\n' "$1" >&2
    exit 1
  fi
}

resolve_latest_version() {
  local api_url="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest"
  curl -fsSL "$api_url" | sed -n 's/.*"tag_name":[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1
}

normalize_version() {
  local value="$1"
  value="${value#v}"
  printf '%s' "$value"
}

download_release_archive() {
  local version="$1"
  local target="$2"
  local asset_name="${REPO_NAME}-v${version}.tar.gz"
  local url="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/v${version}/${asset_name}"
  log "downloading ${url}"
  curl -fL "$url" -o "$target"
}

extract_archive() {
  local archive_path="$1"
  local work_dir="$2"
  tar -xzf "$archive_path" -C "$work_dir"
  find "$work_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1
}

install_payload() {
  local payload_dir="$1"

  if [ ! -f "${payload_dir}/openclaw.plugin.json" ] || [ ! -f "${payload_dir}/dist/index.cjs" ]; then
    printf '[install] 安装包内容不完整: %s\n' "$payload_dir" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$PLUGIN_DIR")"
  rm -rf "$PLUGIN_DIR"
  cp -R "$payload_dir" "$PLUGIN_DIR"
}

link_openclaw_runtime() {
  require_command npm

  local npm_root
  npm_root="$(npm root -g 2>/dev/null || true)"
  if [ -z "$npm_root" ] || [ ! -d "${npm_root}/openclaw" ]; then
    printf '[install] 未找到全局 openclaw 包目录，请先确认 OpenClaw CLI 已正确安装\n' >&2
    exit 1
  fi

  mkdir -p "${PLUGIN_DIR}/node_modules"
  rm -rf "${PLUGIN_DIR}/node_modules/openclaw"
  ln -s "${npm_root}/openclaw" "${PLUGIN_DIR}/node_modules/openclaw"
  log "linked host openclaw runtime from ${npm_root}/openclaw"
}

configure_openclaw_json() {
  require_command node

  mkdir -p "$(dirname "$CONFIG_FILE")"

  local tags_json='[]'
  if [ "${#TAGS[@]}" -gt 0 ]; then
    require_command python3
    tags_json="$(printf '%s\n' "${TAGS[@]}" | python3 -c 'import json,sys; print(json.dumps([line.strip() for line in sys.stdin if line.strip()]))')"
  fi

  OPENCLAW_CONFIG_FILE_RUNTIME="$CONFIG_FILE" \
  OPENCLAW_PLUGIN_DIR_RUNTIME="$PLUGIN_DIR" \
  OPENCLAW_PLUGIN_ENDPOINT_RUNTIME="$ENDPOINT" \
  OPENCLAW_PLUGIN_INSTALL_TYPE_RUNTIME="$INSTALL_TYPE" \
  OPENCLAW_PLUGIN_X_TOKEN_RUNTIME="$X_TOKEN" \
  OPENCLAW_PLUGIN_TAGS_RUNTIME="$tags_json" \
  node <<'NODE'
const fs = require("fs");
const path = require("path");

const configFile = process.env.OPENCLAW_CONFIG_FILE_RUNTIME;
const pluginDir = process.env.OPENCLAW_PLUGIN_DIR_RUNTIME;
const endpoint = process.env.OPENCLAW_PLUGIN_ENDPOINT_RUNTIME || "";
const installType = process.env.OPENCLAW_PLUGIN_INSTALL_TYPE_RUNTIME || "";
const xToken = process.env.OPENCLAW_PLUGIN_X_TOKEN_RUNTIME || "";
const tags = JSON.parse(process.env.OPENCLAW_PLUGIN_TAGS_RUNTIME || "[]");
const pluginId = "openclaw-otel-plugin";

let config = {};
if (fs.existsSync(configFile)) {
  const raw = fs.readFileSync(configFile, "utf8").trim();
  if (raw) {
    config = JSON.parse(raw);
  }
}

config.plugins ??= {};
config.plugins.allow = Array.isArray(config.plugins.allow) ? config.plugins.allow : [];
if (!config.plugins.allow.includes(pluginId)) {
  config.plugins.allow.push(pluginId);
}

config.plugins.load ??= {};
config.plugins.load.paths = Array.isArray(config.plugins.load.paths) ? config.plugins.load.paths : [];
if (!config.plugins.load.paths.includes(pluginDir)) {
  config.plugins.load.paths.push(pluginDir);
}

config.plugins.entries ??= {};
config.plugins.entries[pluginId] ??= {};
config.plugins.entries[pluginId].enabled = true;
config.plugins.entries[pluginId].config ??= {};
config.plugins.entries[pluginId].config.resourceAttributes ??= {};
if (!config.plugins.entries[pluginId].config.resourceAttributes.agent_runtime) {
  config.plugins.entries[pluginId].config.resourceAttributes.agent_runtime = "openclaw";
}

for (const tag of tags) {
  const [key, ...rest] = String(tag).split("=");
  if (!key || rest.length === 0) continue;
  config.plugins.entries[pluginId].config.resourceAttributes[key] = rest.join("=");
}

if (endpoint) {
  config.plugins.entries[pluginId].config.endpoint = endpoint;
}
if (installType === "gtrace") {
  config.plugins.entries[pluginId].config.tracePath = "v1/write/otel-llm";
  config.plugins.entries[pluginId].config.metricsPath = "v1/write/otel-metrics";
  config.plugins.entries[pluginId].config.logsEnabled = false;
  config.plugins.entries[pluginId].config.logsPath = "v1/write/otel-logs";
  config.plugins.entries[pluginId].config.headers ??= {};
  config.plugins.entries[pluginId].config.headers["to_headless"] = "true";
  delete config.plugins.entries[pluginId].config.resourceAttributes.app_name;
  delete config.plugins.entries[pluginId].config.resourceAttributes.app_id;
}
if (xToken) {
  config.plugins.entries[pluginId].config.headers ??= {};
  config.plugins.entries[pluginId].config.headers["X-Token"] = xToken;
}

fs.mkdirSync(path.dirname(configFile), { recursive: true });
fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
NODE
}

main() {
  require_command curl
  require_command tar

  tmp_dir="$(mktemp -d)"

  local archive_path="${tmp_dir}/plugin.tar.gz"
  local payload_dir
  local version

  case "$VERSION_INPUT" in
    http://*|https://*)
      log "downloading archive from custom url"
      curl -fL "$VERSION_INPUT" -o "$archive_path"
      ;;
    *.tar.gz)
      log "using local archive ${VERSION_INPUT}"
      cp "$VERSION_INPUT" "$archive_path"
      ;;
    latest|"")
      version="$(resolve_latest_version)"
      if [ -z "$version" ]; then
        printf '[install] 无法解析 latest 版本\n' >&2
        exit 1
      fi
      download_release_archive "$version" "$archive_path"
      ;;
    *)
      version="$(normalize_version "$VERSION_INPUT")"
      download_release_archive "$version" "$archive_path"
      ;;
  esac

  payload_dir="$(extract_archive "$archive_path" "$tmp_dir")"
  if [ -z "$payload_dir" ]; then
    printf '[install] 解压后未找到插件目录\n' >&2
    exit 1
  fi

  install_payload "$payload_dir"
  log "installed to ${PLUGIN_DIR}"
  link_openclaw_runtime
  if [ "$WRITE_CONFIG" -eq 1 ]; then
    if [ "$INSTALL_TYPE" = "gtrace" ]; then
      if [ -z "$ENDPOINT" ]; then
        printf '[install] type=gtrace 时必须传入 --endpoint\n' >&2
        exit 1
      fi
      if [ -z "$X_TOKEN" ]; then
        printf '[install] type=gtrace 时必须传入 --x-token\n' >&2
        exit 1
      fi
    fi
    configure_openclaw_json
    log "updated ${CONFIG_FILE}"
  else
    cat <<EOF

请确认 ${CONFIG_FILE} 中已允许并加载该插件:

{
  "plugins": {
    "allow": ["openclaw-otel-plugin"],
    "load": {
      "paths": ["${PLUGIN_DIR}"]
    },
    "entries": {
      "openclaw-otel-plugin": {
        "enabled": true
      }
    }
  }
}
EOF
  fi

  if [ -n "$ENDPOINT" ]; then
    log "configured OTLP endpoint: ${ENDPOINT}"
  else
    log "未设置 endpoint；如需立即启用，请在 ${CONFIG_FILE} 中为 openclaw-otel-plugin.config.endpoint 填写 OTLP 地址"
  fi
  if [ -n "$INSTALL_TYPE" ]; then
    log "install type: ${INSTALL_TYPE}"
  fi

  if [ "$RESTART_GATEWAY" -eq 1 ] && command -v openclaw >/dev/null 2>&1; then
    log "restarting openclaw gateway"
    openclaw gateway restart
  elif [ "$RESTART_GATEWAY" -eq 1 ]; then
    log "openclaw 命令不存在，跳过 gateway restart"
  fi
}

main "$@"
