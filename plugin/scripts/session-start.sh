#!/bin/sh
# SessionStart: tells the agent how it is launched in this project — `vdx ai`
# and the profile — and whether this session carries the profile's flags
# (`vdx ai --check`). Silent when vdx is missing or too old, and on a machine
# without a `vdx ai` profile.

command -v vdx >/dev/null 2>&1 || exit 0

# `--check` arrives in 0.18. Up to 0.15 `vdx ai` dropped unknown flags, so
# `vdx ai --check` there would start an agent: ask for the version first.
# (Before 0.13.1 `vdx --version` fails, and that is "too old" as well.)
version=$(vdx --version 2>/dev/null) || exit 0
printf '%s\n' "$version" | awk -F. '{ exit !($1 > 0 || $2 >= 18) }' || exit 0

# Exit 3 means drift; the text is wanted either way.
context=$(vdx ai --check "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null)
[ -n "$context" ] || exit 0

# Plain stdout is not shown to the agent; additionalContext is.
node -e 'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: process.argv[1] } }))' "$context"
