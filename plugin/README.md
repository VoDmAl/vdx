# vdx — Claude Code plugin

Plugin v0.2 that exposes the vdx lifecycle interface and maturity audit
to Claude Code as MCP tools, plus a `vdx-discover` skill and a PostToolUse
hook for success-path logging.

## Components

```
plugin/
├── .claude-plugin/plugin.json       # plugin manifest
├── .mcp.json                        # vdx-mcp stdio server (via npx)
├── skills/vdx-discover/SKILL.md     # discover-and-record workflow
├── hooks/hooks.json                 # PostToolUse hook on vdx_up
└── scripts/record-success-path.sh   # hook script
```

The MCP server lives in [`@vodmal/vdx-cli`](https://www.npmjs.com/package/@vodmal/vdx-cli)
on npm. `.mcp.json` spawns it via `npx -y -p @vodmal/vdx-cli@latest vdx-mcp`
— no local clone of vdx required.

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
  (`github.com/VoDmAl/vdx-rubric-vodmal@v0.2.1` by default)
- `vdx_record_success_path` — persist discovered commands into `mise.toml`

The `vdx-discover` skill auto-suggests itself when Claude enters a project
that has no `mise.toml` manifest.

## Limitations of v0.2

- `record-success-path.sh` only logs to `~/.cache/vdx/last-success-path.log`.
  Canonical record of the success path still goes through the
  `vdx_record_success_path` MCP tool (called by the agent, not by the hook).
- Bundled rubric in `@vodmal/vdx-cli` is a snapshot of canonical
  `vdx-rubric-vodmal@v0.2.2` at CLI release time. Newer canonical tags
  require either a CLI republish or per-project override of the rubric path.
- See open questions O26 (TOML round-trip with comments) and O27 (real
  shared-infra precheck) in `../docs/decisions.md`.
