#!/usr/bin/env bash
set -euo pipefail

PLUGIN_NAME="${OPENCLAW_PLUGIN_NAME:-openclaw-otel-plugin}"
DEFAULT_OSS_ENDPOINT="${OPENCLAW_PLUGIN_DEFAULT_OSS_ENDPOINT:-https://static.guance.com}"
OSS_ENDPOINT="${OSS_ENDPOINT:-}"
tmp_dir=""

cleanup() {
  if [ -n "${tmp_dir:-}" ] && [ -d "${tmp_dir:-}" ]; then
    rm -rf "$tmp_dir"
  fi
}

trap cleanup EXIT

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[update] missing command: %s\n' "$1" >&2
    exit 1
  fi
}

resolve_download_base_url() {
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

resolve_oss_endpoint() {
  if [ -n "$OSS_ENDPOINT" ]; then
    printf '%s' "$OSS_ENDPOINT"
    return
  fi

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --oss-endpoint)
        shift
        if [ "$#" -eq 0 ]; then
          printf '[update] --oss-endpoint requires a URL\n' >&2
          exit 1
        fi
        printf '%s' "$1"
        return
        ;;
      --oss-endpoint=*)
        printf '%s' "${1#*=}"
        return
        ;;
    esac
    shift
  done

  printf '%s' "$DEFAULT_OSS_ENDPOINT"
}

main() {
  require_command curl
  require_command bash

  local base_url
  local install_script

  OSS_ENDPOINT="$(resolve_oss_endpoint "$@")"
  base_url="$(resolve_download_base_url)"
  tmp_dir="$(mktemp -d)"
  install_script="${tmp_dir}/install.sh"

  printf '[update] downloading %s/install.sh\n' "$base_url"
  curl -fsSL -o "$install_script" "${base_url}/install.sh"
  chmod +x "$install_script"

  OSS_ENDPOINT="${OSS_ENDPOINT%/}" exec "$install_script" "$@"
}

main "$@"
