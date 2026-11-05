#!/bin/sh
# The tmux option @vdx_state of the agent's session — `empty` or `finished`, the words the
# `vdx ai` list uses — for the cmux sidebar, which nas-info keeps (vdx-ai-predictable Sidetrack #4;
# the contract: their letter sidebar-states-owner-choice-outcome, 2026-11-05). SessionStart sets
# it through `vdx ai --check`. This script, by its argument:
#   stop   — a turn ended: compute it again from the transcript (`vdx ai --state`, vdx 0.50), so a
#            wrap shows as finished;
#   prompt — a prompt went in: unset it, computing nothing — the transcript may not have the
#            prompt yet. A prompt that is not the person's (a wake, a task's notice) is unset too;
#            the Stop of its turn sets the option back. A `!` line runs no UserPromptSubmit hook;
#   end    — the session ends: unset it.
# Prints nothing: a hook's stdout goes to the agent. Outside tmux it does nothing.

[ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ] || exit 0
command -v tmux >/dev/null 2>&1 || exit 0

case "${1:-}" in
  prompt | end)
    # A pane as the target: tmux unsets the option of the session the pane is in.
    tmux set-option -u -t "$TMUX_PANE" @vdx_state >/dev/null 2>&1
    exit 0
    ;;
  stop) ;;
  *) exit 0 ;;
esac

command -v vdx >/dev/null 2>&1 || exit 0
project="${CLAUDE_PROJECT_DIR:-$PWD}"
# The hook's input names the conversation whose turn ended (session_id).
conversation=""
[ -t 0 ] || conversation=$(sed -n 's/.*"session_id" *: *"\([0-9a-fA-F-]\{36\}\)".*/\1/p' | head -n 1)

# Two runs of node, about 0.6 s: in the background, so the turn ends — and a queued prompt goes
# in — without waiting for them. A prompt that goes in first is unset by its own hook; the
# option set after it is behind the sidebar's ⏳ until that turn's Stop sets it again.
# `ai --state` arrives in 0.50; an older vdx refuses it, and before 0.16 `vdx ai` would take it
# for a start: ask for the version first.
(
  version=$(vdx --version 2>/dev/null) || exit 0
  printf '%s\n' "$version" | awk -F. '{ exit !($1 > 0 || $2 >= 50) }' || exit 0
  if [ -n "$conversation" ]; then
    vdx ai --state "$project" --conversation "$conversation"
  else
    vdx ai --state "$project"
  fi
) </dev/null >/dev/null 2>&1 &
exit 0
