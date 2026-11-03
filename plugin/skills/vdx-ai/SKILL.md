---
name: vdx-ai
description: How the agent in a project is launched — `vdx ai` and the personal profile, never a `claude --<flag>` command typed by hand. Use when a README, a letter or a person says to start or restart the agent with some flag; when a project needs a flag for its sessions (a channel, a permission mode); when the session-start line from vdx reports that this session lacks the profile's flags; or when asked how sessions here are started.
---

# vdx ai — how the agent here is launched

`vdx ai [path]` starts the agent in a project, or attaches to the one already
running there. Which agent, with which flags, and whether inside tmux comes
from a personal profile, not from a command anyone types:

- the profile: `$VDX_ENVIRONMENT`, else `~/.vdx-environment.yaml` (often a
  symlink into a personal set repo, such as `vdx-rubric-vodmal`);
- `agent.args` — flags for every project;
- `agent.when[]` — flags for a class of projects: a rubric predicate over the
  project's files (`config_value`, `has_file`, …) and the `args` it adds,
  plus `confirm` for a prompt the flag causes; `wakes: true` marks a rule
  that is there to wake the agent (a channel flag);
- `resume_args` — continue the last conversation on every start except `--new`,
  `--focused`, `--intercom` and `--hq`;
- `intercom_args`, `hq_args` — what the project's intercom session and HQ session
  start with (the first prompt of a new conversation), right after the command.
  For Claude Code vdx picks which one: the session-start line opens with the
  machine this session runs on (``vdx ai: this machine is `lft` ``), and that
  line, kept in the transcript, tells later starts whose conversation it is.
  Another machine's conversation is continued on that machine.
- `session.machines` — the machines a project's agent may run on; before a
  start vdx asks the others over ssh what runs there. A new conversation while
  an agent of the project runs on one of them starts only after a yes.

Format: `docs/specs/environment-format.md` in the vdx repository.

## What to hand the user

- **To start or fix a session: `vdx ai`, not `claude --<flag>`.** When a
  README or a letter says "start the session with `--some-flag`", the flag
  belongs in the profile; the user runs `vdx ai`.
- **A flag a class of projects needs is a condition in the profile.** Propose
  an `agent.when[]` rule with the predicate that tells those projects apart
  (for example `has_file: {path: signals/sources.yaml}`),
  not an instruction to remember. Editing the profile is the user's call — it
  is personal and may live in another repository.
- **This session lacks the profile's flags** (the session-start line says ✗):
  hand the user the command it names. In tmux that is `vdx ai --restart <root>`
  — **do not run it yourself**: it stops the session you are in, then resumes
  the conversation. Outside tmux vdx cannot reach the session: the user exits
  it and runs `vdx ai <root>`.
- **A session nobody should wake: `vdx ai --focused`.** The agent, its hooks
  and MCP servers get `VDX_FOCUSED=1`, and the profile's `wakes` rules are
  left out. From vdx 0.25 it is a new conversation, next to the project's
  running agent; back to it: `vdx ai --focused --conversation <id>`. When the session-start line says **this session is focused**:
  work on what the user gave you; do not read the inbox or follow a wake
  pointer unless the user asks.
- **A focused session's topic** (vdx 0.41+, plugin 0.11+): `vdx ai --focused
  "<topic>"`; without one, a terminal asks, and Enter leaves it to you. It
  lives in the agent's tmux session (`@vdx_topic`), and the plugin brings it
  with every message of the user's (`vdx ai: the topic of this focused
  session is «…»`). A message off it: the first line of your answer says so
  (`🎯 off topic «…»`, in the user's language) and offers where to put it
  aside; a short answer goes at once, edits, commits and letters off the
  topic wait for the user's "here". No topic yet: take it from the user's
  first message — or the active crystal's name, if the message is about its
  work — and set it yourself: `vdx ai '<root>' --focused "<topic>"` run in
  your own focused session changes its topic and starts nothing (in a
  session that is not focused it is refused). The same when the user names
  another topic.
- **A new topic for a session of its own** (vdx 0.49+): hand the user
  `vdx ai '<root>' --focused "<topic>"`, the topic filled in, to paste into a
  terminal: the new session opens with the topic as its first prompt. Do not
  run it yourself: in a focused session it changes your own topic, in another
  it is refused.
- **A letter for a project, and nobody to wake there: its intercom session.**
  `vdx ai --intercom --detach <project root>` (vdx 0.36+) starts it on this
  machine — `VDX_INTERCOM=1`, a new conversation in a tmux session of its own
  (`<name>-intercom`) that opens with the profile's `agent.intercom_args`. One per
  project and machine: when one runs, the command says so and starts nothing.
  This one you run yourself — it touches no session anyone sits at.
- **The project's HQ session: `vdx ai --hq`** (vdx 0.49+), for what comes from
  outside. `VDX_HQ=1`, a new conversation in a tmux session of its own
  (`<name>-hq`) that opens with the profile's `agent.hq_args`; one per project and
  machine. The user sits at it and keeps it running: hand them the command, do
  not start it for them. When the session-start line says this is the HQ
  session: `vdx ai --close` is not for it, and a topic that is not its work goes
  to a session of its own, by the line above.
- **When the session-start line says this is the project's intercom session:**
  nobody sits at it. When a check of the inbox shows nothing left to take, end
  it yourself — say what was done first, then `vdx ai --close` (the pane goes
  2 s later); with questions to the user still unanswered,
  `vdx ai --close --waiting <n>`. If the line says the user started this one and
  it stays, say what was done and wait for the next wake: `--close` there only
  moves the number. Anywhere else `--close` is refused.

## Commands

| Command | What it does |
|---|---|
| `vdx ai [path]` | start the agent, or attach to the running one; when the choice is not plain (vdx 0.44+) — one list of the agents on every machine and the conversations nobody runs, with their state; Enter never takes one a terminal at the user's seat shows |
| `vdx ai --list [path]` | that list, printed: what runs on every machine and what can be continued; asks nothing, starts nothing (vdx 0.44+) — the answer to «what runs of this project?» |
| `vdx ai --find "<phrase>" [path]` | the conversations whose replies (the user's and the agent's, as the screen showed them) have the phrase, with the text around it and, without a terminal, the command that continues each on its machine (vdx 0.45+) — the answer to «which conversation was about X?»; the user can type `/<phrase>` at the list too |
| `vdx ai --restore [--dry-run]` | after the tmux server fell (a crash, a kill-server, a reboot): every agent it took down on this machine, of every project, back in its tmux session, conversation, mode and topic; nothing attaches (vdx 0.46+). It starts agents nobody sits at, as `--intercom --detach` does: run `--dry-run` first and name what it will start; a plain `vdx ai` in a terminal offers the same as `r` |
| `vdx ai --dry-run [path]` | the plan (agent, flags, matched conditions) and the project's running agents; starts nothing — safe to run |
| `vdx ai --check [path]` | this session against the profile, and against the installed Claude Code and plugins; what the session-start hook prints |
| `vdx ai --restart [path]` | restart the running agent in its tmux pane with the profile's flags |
| `vdx ai --new [path]` | a new conversation instead of continuing the last one; from vdx 0.25 next to a running agent, which runs on |
| `vdx ai --focused [path]` | a session nothing wakes (vdx 0.23+); from 0.25 a new conversation, as `--new`; a running agent keeps its mode until `--restart` |
| `vdx ai [path] --focused "<topic>"` | the same, with its topic (vdx 0.41+), which opens a new conversation as its first prompt (vdx 0.49+); run inside the focused session by its agent — a new topic, nothing started |
| `vdx ai --intercom [--detach] [path]` | the project's intercom session (vdx 0.36+): letters and wakes go there; every other start leaves it alone |
| `vdx ai --hq [path]` | the project's HQ session (vdx 0.49+): what comes from outside goes there; every other start leaves it alone, `--restore` brings it back, `--restart` keeps its conversation, `--new` with it starts a new one |
| `vdx ai --close [--waiting <n>]` | inside the intercom session: it ends itself (one the user started or attached to from a terminal stays, only the number changes); n — questions to the user still unanswered |
| `vdx ai --conversation <id> [path]` | continue this Claude Code conversation: attach to the agent in it, or start one next to the running ones (`vdx ai@<host> … --conversation <id>` — on the machine it belongs to) |
| `vdx ai@<host> [path]` | the same on another machine over ssh |
| `vdx ai --help` | flags and exit codes |

Exit codes: 0 — the agent runs per the profile; 2 — profile or usage error;
3 — the running agent lacks profile flags, or is not focused under `--focused --conversation`;
4 — the start was not confirmed.
