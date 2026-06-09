#!/usr/bin/env bash
set -euo pipefail

PLUGIN_NAME="${OPENCLAW_PLUGIN_NAME:-openclaw-otel-plugin}"
OSS_ENDPOINT="${OSS_ENDPOINT:-}"
DOWNLOAD_BASE_URL=""
PLUGIN_DIR="${OPENCLAW_PLUGIN_DIR:-$HOME/.openclaw/extensions/openclaw-otel-plugin}"
CONFIG_FILE="${OPENCLAW_CONFIG_FILE:-$HOME/.openclaw/openclaw.json}"
RESTART_GATEWAY=1
WRITE_CONFIG=1
VERSION_INPUT=""
ENDPOINT=""
INSTALL_TYPE="${OPENCLAW_PLUGIN_INSTALL_TYPE:-}"
X_TOKEN=""
TAGS=()
tmp_dir=""
INSTALL_TYPE_EXPLICIT=0
PLUGIN_DIR_EXPLICIT=0
EXISTING_PLUGIN_DIR=""
EXISTING_ENDPOINT=""
EXISTING_X_TOKEN=""
EXISTING_INSTALL_TYPE=""

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
Usage:
  OSS_ENDPOINT=https://example.com scripts/install.sh [latest|vX.Y.Z|X.Y.Z|/path/to/archive.tar.gz|https://...tar.gz] [--type gtrace|otlp] [--endpoint URL] [--x-token TOKEN] [--tag KEY=VALUE] [--no-config] [--no-restart]

Environment variables:
  OSS_ENDPOINT              OSS root endpoint. Required for OSS-backed install/upgrade.
                            The script appends /openclaw-otel-plugin when needed.
  OPENCLAW_PLUGIN_DIR        Install directory. Default: ~/.openclaw/extensions/openclaw-otel-plugin
  OPENCLAW_CONFIG_FILE       OpenClaw config file. Default: ~/.openclaw/openclaw.json
  OPENCLAW_PLUGIN_NAME       Plugin package name prefix. Default: openclaw-otel-plugin
  OPENCLAW_PLUGIN_INSTALL_TYPE
                             Install config type. Default: gtrace. Can be set to otlp
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
    --oss-endpoint)
      shift
      if [ "$#" -eq 0 ]; then
        printf '[install] --oss-endpoint requires a URL\n' >&2
        exit 1
      fi
      OSS_ENDPOINT="$1"
      ;;
    --oss-endpoint=*)
      OSS_ENDPOINT="${1#*=}"
      ;;
    --endpoint)
      shift
      if [ "$#" -eq 0 ]; then
        printf '[install] --endpoint requires a URL\n' >&2
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
        printf '[install] --x-token requires a TOKEN\n' >&2
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
        printf '[install] --type requires a type\n' >&2
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
        printf '[install] --tag requires KEY=VALUE\n' >&2
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

if [ -n "$INSTALL_TYPE" ]; then
  INSTALL_TYPE_EXPLICIT=1
fi
if [ -n "${OPENCLAW_PLUGIN_DIR:-}" ]; then
  PLUGIN_DIR_EXPLICIT=1
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[install] missing command: %s\n' "$1" >&2
    exit 1
  fi
}

normalize_install_type() {
  case "$1" in
    gtrace)
      printf 'gtrace'
      ;;
    otlp|otel)
      printf 'otlp'
      ;;
    "")
      printf ''
      ;;
    *)
      printf '[install] unsupported --type: %s. Supported values: gtrace, otlp\n' "$1" >&2
      exit 1
      ;;
  esac
}

normalize_version() {
  local value="$1"
  value="${value#v}"
  printf '%s' "$value"
}

resolve_download_base_url() {
  if [ -z "$OSS_ENDPOINT" ]; then
    printf '[install] OSS_ENDPOINT is required. Example: OSS_ENDPOINT=https://example.com scripts/install.sh latest\n' >&2
    exit 1
  fi

  local root="${OSS_ENDPOINT%/}"
  case "$root" in
    */"$PLUGIN_NAME")
      printf '%s' "$root"
      ;;
    *)
      printf '%s/%s' "$root" "$PLUGIN_NAME"
      ;;
  esac
}

download_archive() {
  local url="$1"
  local target="$2"
  log "downloading ${url}"
  curl -fL "$url" -o "$target"

  local checksum_path="${target}.sha256"
  if curl -fsSL "${url}.sha256" -o "$checksum_path"; then
    if command -v sha256sum >/dev/null 2>&1; then
      local expected
      local actual
      expected="$(sed -n '1s/[[:space:]].*//p' "$checksum_path")"
      actual="$(sha256sum "$target" | awk '{print $1}')"
      if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
        printf '[install] sha256 verification failed: %s\n' "$url" >&2
        exit 1
      fi
      log "sha256 verified"
    else
      log "sha256sum is not available, skipping verification"
    fi
  else
    log "checksum not found, skipped sha256 verification"
  fi
}

load_existing_install_context() {
  require_command node

  OPENCLAW_CONFIG_FILE_RUNTIME="$CONFIG_FILE" \
  OPENCLAW_PLUGIN_NAME_RUNTIME="$PLUGIN_NAME" \
  node <<'NODE'
const fs = require("fs");

const configFile = process.env.OPENCLAW_CONFIG_FILE_RUNTIME;
const pluginName = process.env.OPENCLAW_PLUGIN_NAME_RUNTIME;

if (!configFile || !fs.existsSync(configFile)) {
  process.exit(0);
}

const raw = fs.readFileSync(configFile, "utf8").trim();
if (!raw) {
  process.exit(0);
}

let config;
try {
  config = JSON.parse(raw);
} catch {
  process.exit(0);
}

const pluginConfig = config?.plugins?.entries?.[pluginName]?.config ?? {};
const path = require("path");

const headers = pluginConfig.headers ?? {};
const loadPaths = Array.isArray(config?.plugins?.load?.paths) ? config.plugins.load.paths : [];
const explicitPluginDir =
  loadPaths.find((value) => {
    if (typeof value !== "string") return false;
    const pluginManifestPath = path.join(value, "openclaw.plugin.json");
    if (!fs.existsSync(pluginManifestPath)) {
      return false;
    }
    try {
      const manifest = JSON.parse(fs.readFileSync(pluginManifestPath, "utf8"));
      return manifest?.id === pluginName;
    } catch {
      return false;
    }
  }) ??
  loadPaths.find((value) => typeof value === "string" && value.includes(`/${pluginName}`)) ??
  (loadPaths.length === 1 && typeof loadPaths[0] === "string" ? loadPaths[0] : "");

let installType = "";
if (
  pluginConfig.tracePath === "v1/write/otel-llm" &&
  pluginConfig.metricsPath === "v1/write/otel-metrics" &&
  String(headers.to_headless ?? "") === "true"
) {
  installType = "gtrace";
} else if (pluginConfig.endpoint || pluginConfig.tracePath || pluginConfig.metricsPath || pluginConfig.logsPath) {
  installType = "otlp";
}

const values = {
  plugin_dir: explicitPluginDir,
  endpoint: typeof pluginConfig.endpoint === "string" ? pluginConfig.endpoint : "",
  x_token: typeof headers["X-Token"] === "string" ? headers["X-Token"] : "",
  install_type: installType,
};

for (const [key, value] of Object.entries(values)) {
  process.stdout.write(`${key}=${JSON.stringify(value)}\n`);
}
NODE
}

apply_existing_install_context() {
  local line key value
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    key="${line%%=*}"
    value="${line#*=}"
    value="$(node -p "JSON.parse(process.argv[1])" "$value")"
    case "$key" in
      plugin_dir)
        EXISTING_PLUGIN_DIR="$value"
        ;;
      endpoint)
        EXISTING_ENDPOINT="$value"
        ;;
      x_token)
        EXISTING_X_TOKEN="$value"
        ;;
      install_type)
        EXISTING_INSTALL_TYPE="$value"
        ;;
    esac
  done <<EOF
$(load_existing_install_context)
EOF

  if [ "$PLUGIN_DIR_EXPLICIT" -eq 0 ] && [ -n "$EXISTING_PLUGIN_DIR" ]; then
    PLUGIN_DIR="$EXISTING_PLUGIN_DIR"
    log "reusing existing plugin path: ${PLUGIN_DIR}"
  fi
  if [ -z "$ENDPOINT" ] && [ -n "$EXISTING_ENDPOINT" ]; then
    ENDPOINT="$EXISTING_ENDPOINT"
    log "reusing existing endpoint from ${CONFIG_FILE}"
  fi
  if [ -z "$X_TOKEN" ] && [ -n "$EXISTING_X_TOKEN" ]; then
    X_TOKEN="$EXISTING_X_TOKEN"
    log "reusing existing X-Token from ${CONFIG_FILE}"
  fi
  if [ "$INSTALL_TYPE_EXPLICIT" -eq 0 ] && [ -n "$EXISTING_INSTALL_TYPE" ]; then
    INSTALL_TYPE="$EXISTING_INSTALL_TYPE"
    log "reusing existing install type: ${INSTALL_TYPE}"
  fi
}

download_latest_archive() {
  local target="$1"
  local base_url="${DOWNLOAD_BASE_URL%/}"
  download_archive "${base_url}/${PLUGIN_NAME}.tar.gz" "$target"
}

download_version_archive() {
  local version="$1"
  local target="$2"
  local base_url="${DOWNLOAD_BASE_URL%/}"
  download_archive "${base_url}/${PLUGIN_NAME}-v${version}.tar.gz" "$target"
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
    printf '[install] incomplete plugin archive contents: %s\n' "$payload_dir" >&2
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
    printf '[install] global openclaw package directory was not found. Make sure OpenClaw CLI is installed correctly\n' >&2
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

  DOWNLOAD_BASE_URL="$(resolve_download_base_url)"
  apply_existing_install_context
  INSTALL_TYPE="$(normalize_install_type "$INSTALL_TYPE")"
  if [ -z "$INSTALL_TYPE" ]; then
    INSTALL_TYPE="gtrace"
  fi
  if [ "$WRITE_CONFIG" -eq 1 ] && [ "$INSTALL_TYPE" = "gtrace" ]; then
    if [ -z "$ENDPOINT" ]; then
      printf '[install] type=gtrace requires --endpoint\n' >&2
      exit 1
    fi
    if [ -z "$X_TOKEN" ]; then
      printf '[install] type=gtrace requires --x-token\n' >&2
      exit 1
    fi
  fi

  tmp_dir="$(mktemp -d)"

  local archive_path="${tmp_dir}/plugin.tar.gz"
  local payload_dir
  local version

  case "$VERSION_INPUT" in
    http://*|https://*)
      log "downloading archive from custom url"
      download_archive "$VERSION_INPUT" "$archive_path"
      ;;
    *.tar.gz)
      log "using local archive ${VERSION_INPUT}"
      cp "$VERSION_INPUT" "$archive_path"
      ;;
    latest|"")
      download_latest_archive "$archive_path"
      ;;
    *)
      version="$(normalize_version "$VERSION_INPUT")"
      download_version_archive "$version" "$archive_path"
      ;;
  esac

  payload_dir="$(extract_archive "$archive_path" "$tmp_dir")"
  if [ -z "$payload_dir" ]; then
    printf '[install] no plugin directory found after extracting archive\n' >&2
    exit 1
  fi

  install_payload "$payload_dir"
  log "installed to ${PLUGIN_DIR}"
  link_openclaw_runtime
  if [ "$WRITE_CONFIG" -eq 1 ]; then
    configure_openclaw_json
    log "updated ${CONFIG_FILE}"
  else
    cat <<EOF

Make sure ${CONFIG_FILE} allows and loads this plugin:

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
    log "endpoint is not set. To enable the plugin now, set openclaw-otel-plugin.config.endpoint in ${CONFIG_FILE}"
  fi
  if [ -n "$INSTALL_TYPE" ]; then
    log "install type: ${INSTALL_TYPE}"
  fi

  if [ "$RESTART_GATEWAY" -eq 1 ] && command -v openclaw >/dev/null 2>&1; then
    log "restarting openclaw gateway"
    openclaw gateway restart
  elif [ "$RESTART_GATEWAY" -eq 1 ]; then
    log "openclaw command was not found, skipping gateway restart"
  fi
}

main "$@"
