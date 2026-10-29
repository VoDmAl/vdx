#!/bin/sh
# UserPromptSubmit: in a focused session (`vdx ai --focused`) the session's topic —
# the option @vdx_topic of the agent's tmux session (vdx 0.41) — goes with every
# message of the user's, with what to do with a message off it (focused-topic
# DL #4). The model judges; the hook only brings the topic. Any other session:
# out at once, before anything runs.

[ "${VDX_FOCUSED:-}" = 1 ] || exit 0
[ -n "${TMUX_PANE:-}" ] || exit 0
command -v tmux >/dev/null 2>&1 || exit 0
# -u: without a UTF-8 locale tmux would print a topic in Cyrillic as junk.
topic=$(tmux -u display-message -p -t "$TMUX_PANE" '#{@vdx_topic}' 2>/dev/null) || exit 0

# Only vdx 0.41+ sets a topic, and only it takes one: with none set, the line that
# asks the agent to set it needs that vdx (an older one reads the topic as a path).
if [ -z "$topic" ]; then
  command -v vdx >/dev/null 2>&1 || exit 0
  version=$(vdx --version 2>/dev/null) || exit 0
  printf '%s\n' "$version" | awk -F. '{ exit !($1 > 0 || $2 >= 41) }' || exit 0
fi

project="${CLAUDE_PROJECT_DIR:-$PWD}"
root="'$(printf '%s' "$project" | sed "s/'/'\\\\''/g")'"
set_it="\`vdx ai $root --focused \"<topic>\"\` (it changes this session's topic and nothing else)"

# Braces before a non-ASCII character: under a UTF-8 locale bash 3.2 (/bin/sh on macOS) reads the
# character's first byte as part of the name, and «$topic» came out as «U+FFFD (focused-topic Sidetrack #1).
if [ -n "$topic" ]; then
  text=$(cat <<EOF
vdx ai: the topic of this focused session is «${topic}»
· Keep the conversation in it. A message of the user's about something else: start the answer with one line, «🎯 off topic «${topic}»» in the user's language (Russian: «🎯 вне темы «${topic}»»), and offer where to put it aside — a sidetrack of the active crystal, a letter to the project's mail session, a session of its own (\`vdx ai --new\`). A short answer off the topic is given at once; edits, commits and letters off the topic wait for the user's «here» («здесь»). A message that goes on with the work at hand is on the topic, even when it does not name it. The user names another topic («тема теперь Y»): run $set_it.
EOF
)
else
  text="· This focused session has no topic yet: once a message of the user's gives one — or it is about the active crystal's work — set it with $set_it, and say it to the user in one line."
fi

# Plain stdout is not shown to the agent; additionalContext is.
printf '%s' "$text" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () =>
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: s } })),
);
'
