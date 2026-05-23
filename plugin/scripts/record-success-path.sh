#!/usr/bin/env bash
# PostToolUse hook for vdx_up (and friends).
#
# Reads tool-call JSON from stdin (Claude Code passes input/output here),
# appends a one-line audit entry to ~/.cache/vdx/last-success-path.log.
# This is a passive watermark — the canonical record lives in the project's
# mise.toml via the vdx_record_success_path MCP tool.

set -eu

VERB="${1:-unknown}"
LOG_DIR="${HOME}/.cache/vdx"
LOG_FILE="${LOG_DIR}/last-success-path.log"

mkdir -p "$LOG_DIR"

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-${PWD}}"
TS="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

# Drain stdin so Claude Code doesn't block on a closed pipe; ignore content
# for now (future: parse exit_code from tool result to record only successes).
cat >/dev/null 2>&1 || true

printf '%s\tverb=%s\tproject=%s\n' "$TS" "$VERB" "$PROJECT_DIR" >> "$LOG_FILE"
