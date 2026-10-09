# @vodmal/vdx-cli — vdx evaluator + MCP server

Native predicate evaluator for `vdx-rubric-vodmal` + MCP stdio server for the
Claude Code `vdx` plugin. Decision basis: [docs/decisions.md](../docs/decisions.md)
D10 (native evaluator, not OPA).

Published on npm as **[@vodmal/vdx-cli](https://www.npmjs.com/package/@vodmal/vdx-cli)**.

## Install

Two equally supported paths:

```bash
# A. Daily-use install — recommended when you run `vdx <verb>` many times per session
npm install -g @vodmal/vdx-cli
vdx audit /path/to/project

# B. Zero-install via npx — recommended for CI runners, one-shot trial, or fresh envs
npx -y -p @vodmal/vdx-cli vdx audit /path/to/project
```

Same binary, same behavior. `npx` adds ~200–500 ms resolve overhead per
invocation; pick global when you'll run `vdx` repeatedly, npx when you
don't want anything in your global `node_modules` or you're in an
ephemeral environment.

**First command after install: `vdx doctor`** — it inspects your environment
(Node version, `vdx` on PATH, git, mise, npm auth, container runtime, Claude
Code plugin; in a project — whether its git hooks are on in this clone, and the
commit author; with a profile — whether your personal hooks run on this machine)
and points to remedies for everything that's missing or sub-optimal.

## Use

```bash
# Lifecycle verbs (pass-through to `mise run <verb>`; requires mise + mise.toml)
vdx up | down | build | test | check | fix

# Maturity audit against the owner baseline rubric
vdx audit [project-path] [--format=ansi|markdown|json] [--rubric <path>] [--stack <id>]   # default: cwd

# Generate mise.toml for a project (no AGENTS.md — vdx-discover skill covers Claude Code; pick your own format for other agents)
vdx init  [project-path] [--baseline github.com/org/repo@vX.Y] [--stack <id>] [--dry-run] [--force]   # default: cwd

# Publish a library (Node MVP; PHP/Python coming in Y.3)
vdx publish <patch|minor|major> [--dry-run] [--force] [--no-push]

# Environment self-check (Node / git / mise / npm auth / docker / Claude Code plugin; git hooks of the project)
vdx doctor [project-path] [--format=ansi|markdown|json]   # default: cwd
vdx doctor --check [project-path]   # one line per hook declared but not running here — the plugin's SessionStart hook tells the agent
vdx doctor --fix                    # write the profile's personal hooks (git.hooks) into ~/.gitconfig

# Start your agent in a project per your profile (~/.vdx-environment.yaml or $VDX_ENVIRONMENT)
vdx ai[@host] [project-path] [--new | --conversation <id>] [--focused] [--restart] [--detach] [--dry-run]   # default: cwd; @host: over ssh, in tmux there
vdx ai --check [project-path]   # this session against the profile — what the plugin's SessionStart hook tells the agent

# What a command does and takes; nothing runs (ai: also where launch flags live)
vdx <command> --help

# Print the installed version
vdx --version

# MCP stdio server consumed by the Claude Code plugin
vdx-mcp   --project <path>
```

**Three quick examples**

```bash
# 1. Score the project I'm standing in (no arg → cwd)
vdx audit

# 2. Wire native scripts into the 6 lifecycle verbs, then run one
vdx init --stack node
vdx test            # → mise run test (which calls `vitest run` or whatever was detected)

# 3. Ship a new minor release of a Node lib
vdx publish minor   # npm login if expired → bump package.json + lock → npm publish (OTP or browser) → commit + tag → push → wait for the registry

# 4. Start the agent here, continuing its last conversation (--new: a new one;
#    another machine's conversation is continued on that machine);
#    re-run to attach; an agent without the profile's flags is a question:
#    Enter attaches as is, r restarts it; --restart applies a changed profile
vdx ai

# 5. The same on another machine (an ssh host with vdx), attaching from here
vdx ai@m3
```

`vdx ai` reads a personal profile, never a bundled one: `$VDX_ENVIRONMENT`, else
`~/.vdx-environment.yaml`, else a plain `claude`/`codex` with no flags. Format:
[docs/specs/environment-format.md](../docs/specs/environment-format.md).
The session's `{project}` is `[vdx] name` from the project's `mise.toml`, else the
first file in the profile's `session.project_names` that has one, else the repo
name. `vdx ai@<host>` runs the same command on `<host>` over ssh — that machine's vdx,
profile and tmux, the path taken under its home directory; `--detach` only
starts it. The machine's own label (`$VDX_HOST`) runs here. Where git knows no
commit author, `vdx ai` proposes one (Enter writes it into `.git/config`).
For Claude Code `vdx ai` picks the conversation: each one is marked with the
machine it was last started on (`vdx ai --check`, run by the plugin's hook, writes
the label in), the running ones are asked of the other machines over ssh, and
another machine's conversation is continued there. When the choice is not plain
it lists them — Enter takes the newest; without a terminal, this machine's.

Every command takes `--help` (`-h`) and runs nothing with it. An unknown option,
a stray argument or a value flag without its value is refused with exit 2
before anything runs. In 0.16.0 and earlier the commands other than `vdx ai`
dropped such arguments, and `vdx init --help` wrote `mise.toml`.

By default the bundled `rubric/vdx-rubric.yaml` is used (a mirror of canonical
[vdx-rubric-vodmal](https://github.com/VoDmAl/vdx-rubric-vodmal) at the time of
each CLI release). Override via `--rubric <path>` or the env var `VDX_RUBRIC`.

## Dev

```bash
git clone https://github.com/VoDmAl/vdx
cd vdx/cli
npm install
npm run audit -- /path/to/project --json
npm run smoke      # gauge against 3 calibration references
npm run typecheck
```

## Structure

- `src/rubric.ts`     — types + YAML loader
- `src/manifest.ts`   — parser for `[vdx]` block in `mise.toml` + `.vdx-overrides.yml`
- `src/facts.ts`      — fact source loaders (tasks, packages, configs, sub-package detection)
- `src/predicates.ts` — predicate registry; true / false / unknown with a reason (schema 0.3)
- `src/evaluator.ts`  — recursive evaluator + sugar notation
- `src/scoring.ts`    — delta-style levels, `not_required` levels, flags for orthogonal axes
- `src/gha.ts`        — GitHub Actions workflows as the `ci` axis reads them
- `src/vocabulary.ts` — which project tasks a command calls through the project's runner
- `src/hooks.ts`      — one recognizer of hook frameworks for audit and doctor
- `src/clone-checks.ts` — clone checks printed by doctor and next to an axis in audit
- `src/personal-hooks.ts` — the profile's personal hooks in ~/.gitconfig: check and `--fix`
- `src/audit.ts`      — orchestrator: overrides + applies_to filter + subpackage-ctx
- `src/init.ts`       — `vdx init` planner (`selectVerbTask` + mise.toml renderer)
- `src/run.ts`        — `resolveLifecycleVerb` + error renderer (pure logic for `vdx <verb>`)
- `src/publish.ts`    — `planPublish` (pre-flight) + `executePublish` (bump → npm → git)
- `src/ai.ts`         — `vdx ai`: profile loader, launch plan, tmux session handling
- `src/report.ts`     — markdown / JSON output
- `src/index.ts`      — CLI entry
- `src/mcp-server.ts` — MCP stdio server (9 tools)
- `src/defaults.ts`   — bundled rubric resolution
- `bin/vdx.cjs`, `bin/vdx-mcp.cjs` — Node wrappers (tsx ESM loader in-process)

## Not implemented yet

- Above L1 the `ci` axis reads GitHub Actions only; other CI systems answer
  "unknown". `branch-protection` is "unknown" everywhere until a hosting
  extension exists.
- Baseline loading from a git ref is documented but evaluator still reads file
  paths only — `baseline:` in `mise.toml` is recorded but does not auto-fetch.
- Watermark drift (phase 2 of `drift-algorithm.md`).
- `vdx publish` only ships for Node (MVP). PHP/Python in Y.3; Cargo/Ruby/Go/Java
  in Y.4.
- Open items: O25 (mock-infra delta for Node), O26 (TOML round-trip), O27 (real
  shared-infra precheck), O32 (multi-subpackage monorepo). See
  [docs/decisions.md](../docs/decisions.md).
