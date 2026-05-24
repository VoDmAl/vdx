# vdx

**A thin layer over existing tools: a unified lifecycle vocabulary + a
versioned maturity rubric with drift detection + a structured manifest for
the AI agent.**

> Working name. Subject to rename.

---

## The problem

AI lifted the parallelism ceiling: instead of one primary stack (PHP), the
same developer now juggles dozens of products at once across PHP, Node,
Python, and Go. That creates two compounding pains:

1. **Operational friction.** Every project has its own way to "bring up /
   shut down / rebuild / run tests." The depth and vocabulary of commands
   varies wildly from repo to repo.
2. **Quality drift.** There is no objective measure of maturity. As the
   personal quality bar rises, older projects quietly fall behind, and
   there is no place to notice it.

## Concept

vdx is built as a **combine** of ready-made tools. Custom code goes only
into the things nobody else does — which is precisely why vdx exists.

### The defensible core — four things

| # | What | Why nothing off-the-shelf covers it |
|---|------|--------------------------------------|
| 1 | Normalized verb vocabulary `up / down / build / test / check / fix` | task runners (mise/Task/just) don't prescribe a vocabulary |
| 2 | **Versioned maturity rubric + drift engine** | Soundcheck/Cortex/OpsLevel mutate the standard live; they don't work locally or on third-party repos |
| 3 | **Shared-infra orchestration** (Global Traefik as a dependency of `up`) | no runner models cross-repo dependencies |
| 4 | A structured, executable manifest for the AI agent | AGENTS.md is deliberately prose; Claude Code auto-memory also writes prose |

> **What vdx will NOT do:**
> — ship its own task runner (mise already does this polyglot and well);
> — claim "discover-and-cache" as a novel loop (Claude Code auto-memory
>   already writes findings between sessions natively; vdx's novelty is
>   that the recorded path is *structured and executable*, not prose).

## Install

Prerequisites:

- **Node.js** ≥ 20 (the CLI ships as ESM TypeScript via `tsx`, no build step required).
- **[mise](https://mise.jdx.dev/getting-started.html)** — vdx delegates lifecycle execution to `mise run <verb>`.
- **git** — for `vdx audit` rubric resolution (`github.com/.../vdx-rubric-vodmal@<tag>`) and for `vdx publish`.

Then pick one — same binary, same behavior, different trade-offs:

```bash
# A. Daily-use install (recommended for any repeated `vdx <verb>` workflow)
npm i -g @vodmal/vdx-cli
vdx audit .

# B. Zero-install, run from anywhere (recommended for CI, one-shot trial,
#    onboarding a teammate, or any "I just want to look")
#
# NOTE: `-p` is required because the binary `vdx` doesn't match the scoped
# package name `@vodmal/vdx-cli` — npx can't auto-infer the entry point.
npx -y -p @vodmal/vdx-cli vdx audit .
```

Rule of thumb:

- **Global** when you run `vdx` many times per session — pays no per-invocation latency.
- **npx** when you don't want a global install or you're in a clean / ephemeral environment (CI runner, fresh VM, someone else's laptop). Each `npx` call adds ~200–500 ms for resolve+stat.

Either way you get two binaries: **`vdx`** (the CLI) and **`vdx-mcp`** (the MCP server consumed by the Claude Code plugin — itself launched via `npx` from the plugin manifest, so plugin users never need a global install).

**Run `vdx doctor` first.** It checks your environment (Node version, `vdx` on PATH, git, mise, npm auth, container runtime, Claude Code plugin) and shows you exactly what to install or configure before using anything else.

## Quick start

```bash
# 1. Score any project against the owner baseline rubric
vdx audit .

# 2. Generate a mise.toml that wires native scripts to vdx's 6 verbs
vdx init .

# 3. Run lifecycle verbs (pass-through to `mise run <verb>`)
vdx build
vdx test
vdx check
vdx up    # bring services up
vdx down  # tear down

# 4. Publish a library (Node MVP; PHP/Python coming in Y.3)
vdx publish minor   # bump, npm publish (with OTP), git commit+tag

# 5. Check your local environment (Node version, mise, git, docker, Claude Code plugin)
vdx doctor
```

`vdx init` works deterministically on Node/PHP/Python/Go/Ruby projects. For unknown or `meta` (monorepo-with-subpackage) stacks, pass `--stack <id>` or — preferably — invoke vdx inside Claude Code with the plugin installed and let the `vdx-discover` skill bootstrap interactively.

## Claude Code plugin

vdx ships a Claude Code plugin (MCP server + skill + hook) so the agent can call `vdx_build`, `vdx_audit`, etc. natively and bootstrap unknown projects.

Inline marketplace (this repo serves the plugin directly):

```jsonc
// ~/.claude/settings.json
{
  "extraKnownMarketplaces": [
    "github.com/VoDmAl/vdx/marketplace"
  ]
}
```

…or point at a local clone: `"/abs/path/to/vdx/marketplace"`. Then `/plugin install vdx@vdx` inside Claude Code.

The plugin gives you:

- **MCP tools** — `list_capabilities`, `vdx_up`/`down`/`build`/`test`/`check`/`fix`, `vdx_audit`, `vdx_record_success_path`.
- **`vdx-discover` skill** — auto-triggers when a project lacks `mise.toml` (or audits at L0/L1 on `lifecycle-interface`); walks native scripts, verifies them, records the success path.
- **PostToolUse hook** — passive watermark of successful lifecycle runs into `~/.cache/vdx/last-success-path.log`.

## Architecture

| Layer | Tool | Decision |
|-------|------|----------|
| Task runner | **mise** | [D3](docs/decisions.md) |
| Capability manifest | `mise.toml` + vdx meta-block; projected into `AGENTS.md ## Commands` | [D4](docs/decisions.md) |
| Fact gathering for audit | OpenSSF Scorecard · Qlty CLI · MegaLinter (planned) | [D5](docs/decisions.md) |
| Scaffold-fix on own projects | copier (`copier update`, 3-way merge) — planned | [D5](docs/decisions.md) |
| Claude Code packaging | plugin: MCP server + skill + hook | [D6](docs/decisions.md) |

Full rationale and open questions live in [docs/decisions.md](docs/decisions.md).

## Scenarios

**Familiar stack.** `vdx up` → infra precheck → `mise run up` → native
command. Instant.

**Unfamiliar stack via Claude Code.** Through MCP, the agent knows the
project's 6 verbs and can invoke them without reading docker files.
`vdx audit` scores it against *your* rubric even in unfamiliar tooling.

**No manifest yet.** `vdx` falls back to detection — `make`/`composer`/
`npm` — and calls them directly. Once the agent finds a working success
path, a hook records it into `mise.toml` — the next run is instant.

**Drift.** The owner rubric moved forward → `vdx audit` shows the gap on
an old project. On your own repos, `copier update` applies the template
fixes; on third-party repos, it's a read-only report.

## Two-repo layout

| Repo | What | Release cadence |
|------|------|-----------------|
| **[vdx](https://github.com/VoDmAl/vdx)** (this) | dev hub: research, spec, evaluator (`cli/`), Claude Code plugin (`plugin/`) | changes often |
| **[vdx-rubric-vodmal](https://github.com/VoDmAl/vdx-rubric-vodmal)** | canonical owner-baseline rubric (`vdx-rubric.yaml`) | semver tags (`v0.3.0`+) |

Manifest references in projects, e.g. `baseline:
github.com/VoDmAl/vdx-rubric-vodmal@v0.3.0`, point at a specific semver
tag of the canonical repo. Sync rules between the two repos are documented
in [CLAUDE.md](CLAUDE.md) ("External repo").

## Current status: CLI v0.4.0 on npm, rubric v0.3.1, D12 (`publish`) MVP validated end-to-end

Spec D1–D12 ratified; core delivered in steps A–X.1.c within a single
working session (see [PROJECT_CHANGELOG.md](PROJECT_CHANGELOG.md) for the
full per-step log and [HANDOFF.md](HANDOFF.md) for live state). Highlights:

- **Step A** — rubric v0.2 + draft spec (format, predicate DSL, drift algorithm).
- **Step B** — canonical repo `vdx-rubric-vodmal` published on GitHub.
- **Step C** — native evaluator (TypeScript, ~600 LOC under `cli/src/`).
- **Step D** — evaluator tuned via smoke tests on 3 reference projects.
- **Step E** — `vdx init`: stack autodetect → mapping native tasks to the
  6 verbs → generation of `mise.toml` + `AGENTS.md ## Commands`.
- **Step F** — MCP server `vdx-mcp` on stdio with 9 tools.
- **Step G** — Claude Code plugin `vdx/plugin/` (`.claude-plugin/`,
  `.mcp.json`, skill, hook).
- **Step H** — dogfooding: vdx now has its own root `mise.toml`, baseline audit.
- **Step I** — stack detector sees depth-1 sub-packages (monorepo / dev hub).
- **Step J** — `applies_to` filter in rubric v0.2.2: stack-irrelevant axes
  get `drift_kind: excluded` and don't count toward overall.
- **Step K** — `[vdx].primary_subpackage` + `resolveSubpackageCtx` (O31 closed).
- **Step L** — `.github/workflows/ci.yml` + `npm test` alias (ci L0→L3).
- **Step M** — `matrix.node-version: [20, 22]` (ci L3→L4, first axis at max).
- **Step N** — CLI published on npm as
  **[@vodmal/vdx-cli](https://www.npmjs.com/package/@vodmal/vdx-cli)**;
  the plugin is now marketplace-ready (`npx -y -p @vodmal/vdx-cli@latest vdx-mcp`).
- **Step O** — O33 closed (subpackage stack lift): for axes with
  `applies_to`, the evaluator now uses the subpackage's stack instead of
  the root's. For vdx this removes the `excluded` mask from 5 stack axes →
  an honest score.
- **Steps P–U** — vitest harness (tests axis L0→L3), new
  `release-artifact` axis with `applies_when` lib/app gate (rubric
  v0.3.1, O34/O35 closed), `vdx init` transparency + monorepo fallback
  (O39 closed), CLI bumped to **v0.3.0** on npm.
- **Step V** — D12 (`publish`) accepted as 7th lifecycle verb after
  parallel landscape research; `vdx publish` lib-gated via the new
  `applies_when` predicate, stack-specific defaults institutionalized
  inside vdx (npm/composer/twine/cargo/gem) so users don't learn
  ecosystem-specific commands.
- **Step X.1.a–X.1.c** — D12 MVP for Node delivered and dogfooded:
  `executePublish()` runs the full pipeline (bump → `npm publish` with
  interactive OTP via `stdio: 'inherit'` → git commit + tag, no push) and
  was used to ship **[@vodmal/vdx-cli@0.4.0](https://www.npmjs.com/package/@vodmal/vdx-cli)**
  end-to-end.

### Research artifacts
| Artifact | File | Status |
|----------|------|--------|
| Onboarding for a new session | [HANDOFF.md](HANDOFF.md) | current |
| Research journal (Decided / Open / Observed) | [docs/decisions.md](docs/decisions.md) | current |
| Landscape of comparable tools (does / doesn't) | [docs/landscape.md](docs/landscape.md) | current |
| Maturity rubric v0.2 (calibrated) | [docs/maturity-rubric.md](docs/maturity-rubric.md) | current |
| Build-vs-adopt decision | [docs/decision.md](docs/decision.md) | current |
| Change log | [PROJECT_CHANGELOG.md](PROJECT_CHANGELOG.md) | maintained |

> Internal research artifacts above are kept in Russian — they are the
> author's working notes. The outward-facing surface (this README, the
> CLI README, plugin README, and canonical-rubric repo) is English.

### Core spec (v0.3.0)
| Document | What it specifies |
|----------|-------------------|
| [docs/specs/rubric-format.md](docs/specs/rubric-format.md) | Format of the `vdx-rubric.yaml` owner baseline + predicate DSL + `applies_to` |
| [docs/specs/manifest-format.md](docs/specs/manifest-format.md) | The `[vdx]` block in `mise.toml` + `AGENTS.md` projection |
| [docs/specs/overrides-format.md](docs/specs/overrides-format.md) | `.vdx-overrides.yml` for per-project overrides |
| [docs/specs/mcp-api.md](docs/specs/mcp-api.md) | Contract of the vdx MCP server |
| [docs/specs/drift-algorithm.md](docs/specs/drift-algorithm.md) | Level computation + drift algorithm |
| [docs/specs/vdx-rubric.example.yaml](docs/specs/vdx-rubric.example.yaml) | Mirror of the canonical instance (for documentation) |

## Dogfooding

vdx audits itself against its own rubric. The declaration in
[mise.toml](mise.toml) is `stack = "meta"` (documentation + a nested CLI
in `cli/`).

Current position: **overall L0**. The real blocker is the `ci` axis (vdx
lacked GitHub Actions until step L; the supporting axes still need real
artifacts). Five stack-specific axes (tests, static-analysis, code-style,
dependency-hygiene, mock-infra) correctly receive `drift_kind: excluded`
under the meta stack and don't count toward overall. Lifecycle-interface
is at L2 (3 of 6 verbs: build, test, check — up/down/fix are absent by
design, vdx is not a service).

Next steps inside `vdx`: real tests (vitest), CI workflow, and sub-package-aware
predicates (O31) so the nested `cli/` is audited as a Node project. The
full list of open questions lives in [docs/decisions.md](docs/decisions.md)
and [HANDOFF.md](HANDOFF.md).
