#!/usr/bin/env bash
set -euo pipefail

REPO_OWNER="${OPENCLAW_PLUGIN_REPO_OWNER:-GuanceCloud}"
REPO_NAME="${OPENCLAW_PLUGIN_REPO_NAME:-openclaw-otel-plugin}"
PLUGIN_DIR="${OPENCLAW_PLUGIN_DIR:-$HOME/.openclaw/extensions/openclaw-otel-plugin}"
RESTART_GATEWAY=1
VERSION_INPUT=""

log() {
  printf '[install] %s\n' "$1"
}

usage() {
  cat <<'EOF'
用法:
  scripts/install.sh [latest|v0.1.0|0.1.0|/path/to/archive.tar.gz|https://...tar.gz] [--no-restart]

环境变量:
  OPENCLAW_PLUGIN_DIR        安装目录，默认 ~/.openclaw/extensions/openclaw-otel-plugin
  OPENCLAW_PLUGIN_REPO_OWNER GitHub owner，默认 GuanceCloud
  OPENCLAW_PLUGIN_REPO_NAME  GitHub repo，默认 openclaw-otel-plugin
EOF
}

for arg in "$@"; do
  case "$arg" in
    --no-restart)
      RESTART_GATEWAY=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [ -z "$VERSION_INPUT" ]; then
        VERSION_INPUT="$arg"
      fi
      ;;
  esac
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

  if [ ! -f "${payload_dir}/openclaw.plugin.json" ] || [ ! -f "${payload_dir}/dist/index.js" ]; then
    printf '[install] 安装包内容不完整: %s\n' "$payload_dir" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$PLUGIN_DIR")"
  rm -rf "$PLUGIN_DIR"
  cp -R "$payload_dir" "$PLUGIN_DIR"
}

main() {
  require_command curl
  require_command tar

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT

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

  cat <<EOF

请确认 ~/.openclaw/openclaw.json 中已允许并加载该插件:

{
  "plugins": {
    "allow": ["openclaw-otel-plugin"],
    "load": {
      "paths": ["${PLUGIN_DIR}"]
    }
  }
}
EOF

  if [ "$RESTART_GATEWAY" -eq 1 ] && command -v openclaw >/dev/null 2>&1; then
    log "restarting openclaw gateway"
    openclaw gateway restart
  elif [ "$RESTART_GATEWAY" -eq 1 ]; then
    log "openclaw 命令不存在，跳过 gateway restart"
  fi
}

main "$@"
