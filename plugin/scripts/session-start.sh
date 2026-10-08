#!/bin/sh
# SessionStart: tells the agent how it is launched in this project — `vdx ai`
# and the profile — and whether this session carries the profile's flags
# (`vdx ai --check`); then which hooks are declared but do not run here — in
# this clone, or the profile's personal hooks on this machine
# (`vdx doctor --check`). Silent when vdx is missing or too old, and when
# there is nothing to say.

command -v vdx >/dev/null 2>&1 || exit 0

# `ai --check` arrives in 0.18. Up to 0.15 `vdx ai` dropped unknown flags, so
# `vdx ai --check` there would start an agent: ask for the version first.
# (Before 0.13.1 `vdx --version` fails, and that is "too old" as well.)
version=$(vdx --version 2>/dev/null) || exit 0
at_least() { printf '%s\n' "$version" | awk -F. -v m="$1" '{ exit !($1 > 0 || $2 >= m) }'; }
at_least 18 || exit 0

project="${CLAUDE_PROJECT_DIR:-$PWD}"

# Exit 3 means drift; the text is wanted either way.
context=$(vdx ai --check "$project" 2>/dev/null)

# `doctor --check` arrives in 0.22; an older doctor would print its whole report.
if at_least 22; then
  hooks=$(vdx doctor --check "$project" 2>/dev/null)
  if [ -n "$hooks" ]; then
    context="${context:+$context
}$hooks"
  fi
fi
[ -n "$context" ] || exit 0

# Plain stdout is not shown to the agent; additionalContext is.
node -e 'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: process.argv[1] } }))' "$context"
