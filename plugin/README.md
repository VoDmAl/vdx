# vdx — Claude Code plugin

Plugin v0.7 that exposes the vdx lifecycle interface and maturity audit
to Claude Code as MCP tools, tells the agent at session start how it is
launched in the project (`vdx ai`), and ships the `vdx-discover` and `vdx-ai`
skills plus a PostToolUse hook for success-path logging.

## Components

```
plugin/
├── .claude-plugin/plugin.json       # plugin manifest
├── .mcp.json                        # vdx-mcp stdio server (installed, else via npx)
├── skills/vdx-discover/SKILL.md     # discover-and-record workflow
├── skills/vdx-ai/SKILL.md           # how the agent is launched: vdx ai + profile
├── hooks/hooks.json                 # SessionStart; PostToolUse on vdx_up
├── scripts/session-start.sh         # SessionStart: `vdx ai --check` → agent context
└── scripts/record-success-path.sh   # PostToolUse hook script
```

The MCP server lives in [`@vodmal/vdx-cli`](https://www.npmjs.com/package/@vodmal/vdx-cli)
on npm. `.mcp.json` starts the installed `vdx-mcp` when it is on PATH, and
`npx -y -p @vodmal/vdx-cli@latest vdx-mcp` otherwise — no local clone of vdx
required, and no npm round-trip per session where vdx is installed. The
project is `${CLAUDE_PROJECT_DIR}`, else the server's working directory. In
practice (Claude Code, 2026-10-04) the variable is not substituted for a
plugin's MCP server: it runs `--project .`, started in the session's project
directory.

## Local installation (development)

The plugin is local-first. There are two ways to wire it up:

### Option A — one-shot session (no persistent install)

Launch Claude Code with `--plugin-dir`:

```bash
claude --plugin-dir "/Users/vdm/AI Projects/vdx/plugin" /path/to/your/project
```

Plugin loads for that session only.

### Option B — persistent install via local marketplace

Add to `~/.claude/settings.json`:

```jsonc
{
  "extraKnownMarketplaces": {
    "vdx-local": {
      "source": {
        "source": "local",
        "path": "/Users/vdm/AI Projects/vdx/plugin"
      }
    }
  }
}
```

Then in Claude Code:

```
/plugin install vdx@vdx-local --scope user
```

## What you get

After install, the following MCP tools are available in any project:

- `list_capabilities` — read `mise.toml` `[vdx]` block + tasks
- `vdx_up`, `vdx_down`, `vdx_build`, `vdx_test`, `vdx_check`, `vdx_fix` —
  lifecycle wrappers over `mise run <verb>`
- `vdx_audit` — maturity audit against the canonical rubric
  (`github.com/VoDmAl/vdx-rubric-vodmal@v1.0.0` by default)
- `vdx_record_success_path` — persist discovered commands into `mise.toml`

The `vdx-discover` skill auto-suggests itself when Claude enters a project
that has no `mise.toml` manifest.

At session start the plugin runs `vdx ai --check` and hands its answer to the
agent: the machine this session runs on, the agent here is started with
`vdx ai`, its flags come from the profile, and whether this session carries
them — with the command that fixes it when not. Claude Code keeps that answer
in the transcript, and the machine in it is how a later `vdx ai` (0.19+) tells
whose conversation it is. Silent without a `vdx ai` profile, and with a vdx older than
0.18 (up to 0.15 `vdx ai` took an unknown flag for a launch, so the hook asks
for the version first). The `vdx-ai` skill covers the rest: where the profile
lives, `agent.when[]` for a class of projects, what to hand the user.

With vdx 0.22+ the same hook adds `vdx doctor --check`: one line per hook
that is declared but does not run here — a hook framework of this repository
that is off in this clone, or a personal hook of the profile (`git.hooks`)
missing from `~/.gitconfig` or skipped by a git older than 2.54 — with the fix
for the agent to hand the user. Silent when the hooks are in order.

## Limitations

- `record-success-path.sh` only logs to `~/.cache/vdx/last-success-path.log`.
  Canonical record of the success path still goes through the
  `vdx_record_success_path` MCP tool (called by the agent, not by the hook).
- Bundled rubric in `@vodmal/vdx-cli` is a snapshot of canonical
  `vdx-rubric-vodmal@v1.0.0` at CLI release time. Newer canonical tags
  require either a CLI republish or per-project override of the rubric path.
- See open questions O26 (TOML round-trip with comments) and O27 (real
  shared-infra precheck) in `../docs/decisions.md`.
