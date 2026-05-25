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
Code plugin) and points to remedies for everything that's missing or
sub-optimal.

## Use

```bash
# Lifecycle verbs (pass-through to `mise run <verb>`; requires mise + mise.toml)
vdx up | down | build | test | check | fix

# Maturity audit against the owner baseline rubric
vdx audit [project-path] [--format=ansi|markdown|json] [--rubric <path>] [--stack <id>]   # default: cwd

# Generate mise.toml + AGENTS.md for a project
vdx init  [project-path] [--baseline github.com/org/repo@vX.Y] [--stack <id>] [--dry-run] [--force]   # default: cwd

# Publish a library (Node MVP; PHP/Python coming in Y.3)
vdx publish <patch|minor|major> [--dry-run] [--force]

# Environment self-check (Node / git / mise / npm auth / docker / Claude Code plugin)
vdx doctor [--format=ansi|markdown|json]

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
vdx publish minor   # bump → npm publish (OTP prompt) → git commit + tag (no push)
```

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
- `src/predicates.ts` — predicate registry (11 functions)
- `src/evaluator.ts`  — recursive evaluator + sugar notation
- `src/scoring.ts`    — delta-style levels, flags for orthogonal axes
- `src/audit.ts`      — orchestrator: overrides + applies_to filter + subpackage-ctx
- `src/init.ts`       — `vdx init` planner (`selectVerbTask` + mise.toml/AGENTS.md renderers)
- `src/run.ts`        — `resolveLifecycleVerb` + error renderer (pure logic for `vdx <verb>`)
- `src/publish.ts`    — `planPublish` (pre-flight) + `executePublish` (bump → npm → git)
- `src/report.ts`     — markdown / JSON output
- `src/index.ts`      — CLI entry
- `src/mcp-server.ts` — MCP stdio server (9 tools)
- `src/defaults.ts`   — bundled rubric resolution
- `bin/vdx.cjs`, `bin/vdx-mcp.cjs` — Node wrappers (tsx ESM loader in-process)

## Not implemented yet

- `config_value`/`command_succeeds` predicates are stubs (warning at evaluation).
- Baseline loading from a git ref is documented but evaluator still reads file
  paths only — `baseline:` in `mise.toml` is recorded but does not auto-fetch.
- Watermark drift (phase 2 of `drift-algorithm.md`).
- `vdx publish` only ships for Node (MVP). PHP/Python in Y.3; Cargo/Ruby/Go/Java
  in Y.4.
- Open items: O25 (mock-infra delta for Node), O26 (TOML round-trip), O27 (real
  shared-infra precheck), O32 (multi-subpackage monorepo). See
  [docs/decisions.md](../docs/decisions.md).
