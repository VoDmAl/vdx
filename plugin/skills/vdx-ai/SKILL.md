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
- `resume_args` — continue the last conversation on every start except `--new`.
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
  left out. When the session-start line says **this session is focused**:
  work on what the user gave you; do not read the inbox or follow a wake
  pointer unless the user asks.

## Commands

| Command | What it does |
|---|---|
| `vdx ai [path]` | start the agent, or attach to the running one |
| `vdx ai --dry-run [path]` | the plan (agent, flags, matched conditions) and the project's running agents; starts nothing — safe to run |
| `vdx ai --check [path]` | this session against the profile; what the session-start hook prints |
| `vdx ai --restart [path]` | restart the running agent in its tmux pane with the profile's flags |
| `vdx ai --new [path]` | a new conversation instead of continuing the last one |
| `vdx ai --focused [path]` | a session nothing wakes (vdx 0.23+); a running agent keeps its mode until `--restart` |
| `vdx ai --conversation <id> [path]` | continue this Claude Code conversation (`vdx ai@<host> … --conversation <id>` — on the machine it belongs to) |
| `vdx ai@<host> [path]` | the same on another machine over ssh |
| `vdx ai --help` | flags and exit codes |

Exit codes: 0 — the agent runs per the profile; 2 — profile or usage error;
3 — the running agent lacks profile flags, or is not focused under `--focused`;
4 — the start was not confirmed.
