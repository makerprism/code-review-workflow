#!/usr/bin/env bash
set -euo pipefail

: "${REVIEW_AGENT_PROMPT_FILE:?REVIEW_AGENT_PROMPT_FILE is required}"
: "${REVIEW_AGENT_CONTEXT_FILE:?REVIEW_AGENT_CONTEXT_FILE is required}"

# Workaround for opencode-ai postinstall bug on Alpine/musl systems
# The postinstall script incorrectly links the glibc binary even on musl
# Solution: Set OPENCODE_BIN_PATH to force the correct musl binary
if [[ -f "/etc/alpine-release" ]]; then
  arch=$(uname -m)
  case "$arch" in
    x86_64)  musl_pkg="opencode-linux-x64-musl" ;;
    aarch64) musl_pkg="opencode-linux-arm64-musl" ;;
    *) echo "Unsupported arch: $arch" >&2; exit 1 ;;
  esac
  
  # First run npx to ensure package is installed
  npx -y opencode-ai@latest --version >/dev/null 2>&1 || true
  
  # Find and export the musl binary path
  npx_cache=$(find ~/.npm/_npx -type d -name "node_modules" | head -1)
  if [[ -n "$npx_cache" ]]; then
    musl_bin="$npx_cache/$musl_pkg/bin/opencode"
    if [[ -x "$musl_bin" ]]; then
      export OPENCODE_BIN_PATH="$musl_bin"
    fi
  fi
fi

# Build command with correct opencode-ai options
# --attach for files, prompt passed as positional message
cmd=(npx -y opencode-ai run --format json --attach "$REVIEW_AGENT_CONTEXT_FILE")

if [[ -n "${REVIEW_AGENT_MODEL:-}" ]]; then
  cmd+=(--model "$REVIEW_AGENT_MODEL")
fi

if [[ -n "${REVIEW_AGENT_OPENCODE_EXTRA_ARGS:-}" ]]; then
  # shellcheck disable=SC2206
  extra=( ${REVIEW_AGENT_OPENCODE_EXTRA_ARGS} )
  cmd+=("${extra[@]}")
fi

# Read prompt and pass as positional message argument
prompt=$(cat "$REVIEW_AGENT_PROMPT_FILE")

"${cmd[@]}" "$prompt"
