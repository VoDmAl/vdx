# @vodmal/vdx-cli — vdx evaluator + MCP server

Native predicate evaluator for `vdx-rubric-vodmal` + MCP stdio server for the
Claude Code `vdx` plugin. Decision basis: [docs/decisions.md](../docs/decisions.md)
D10 (native evaluator, not OPA).

Published on npm as **[@vodmal/vdx-cli](https://www.npmjs.com/package/@vodmal/vdx-cli)**.

## Install

```bash
# global install
npm install -g @vodmal/vdx-cli

# or one-shot via npx (no install)
npx -y -p @vodmal/vdx-cli vdx audit /path/to/project
```

## Use

```bash
vdx audit <project-path> [--json] [--rubric <path>] [--stack <id>]
vdx init  <project-path> [--baseline github.com/org/repo@vX.Y] [--dry-run] [--force]
vdx-mcp   --project <path>   # MCP stdio server (used by the plugin)
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
- O25/O26/O27/O33/O34 — see [docs/decisions.md](../docs/decisions.md).
