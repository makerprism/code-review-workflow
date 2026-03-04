#!/usr/bin/env bash
set -euo pipefail

: "${REVIEW_AGENT_PROMPT_FILE:?REVIEW_AGENT_PROMPT_FILE is required}"
: "${REVIEW_AGENT_CONTEXT_FILE:?REVIEW_AGENT_CONTEXT_FILE is required}"

cmd=(npx -y opencode-ai run --prompt-file "$REVIEW_AGENT_PROMPT_FILE" --context-file "$REVIEW_AGENT_CONTEXT_FILE")

if [[ -n "${REVIEW_AGENT_MODEL:-}" ]]; then
  cmd+=(--model "$REVIEW_AGENT_MODEL")
fi

if [[ -n "${REVIEW_AGENT_OPENCODE_EXTRA_ARGS:-}" ]]; then
  # shellcheck disable=SC2206
  extra=( ${REVIEW_AGENT_OPENCODE_EXTRA_ARGS} )
  cmd+=("${extra[@]}")
fi

"${cmd[@]}"
