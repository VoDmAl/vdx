---
name: vdx-discover
description: Bootstrap and verify the project's lifecycle interface. Use when entering a project that has no mise.toml [vdx] block, when `vdx <verb>` reports a missing task, or when verifying that recorded lifecycle commands still work.
---

# vdx discover-and-record workflow

This skill ties together the `vdx` MCP tools (`list_capabilities`,
`vdx_up`/`down`/`build`/`test`/`check`/`fix`, `vdx_audit`,
`vdx_record_success_path`) into a coherent flow for any project.

## When this skill applies

Trigger when **any** of the following:

- A new project is opened in Claude Code and `list_capabilities` returns
  `verbs[].has_manifest = false` for all verbs.
- The user runs `vdx <verb>` in shell and gets a `no mise.toml` or
  `no [tasks.<verb>] in mise.toml` error (the user typically pastes the
  error back; treat that as a discovery trigger).
- The user asks "how do I run this?" / "what are the lifecycle commands?".
- `vdx_audit` reports `lifecycle-interface` at L0 or L1.
- The user explicitly asks to set up vdx, bootstrap commands, generate
  a `mise.toml`, or normalize verbs across the project.

## Workflow

### Step 1 — probe current state

Call `list_capabilities` (no args). Cases:

- **All verbs have `native_command != null`**: manifest already exists.
  Optionally run `vdx_audit` to confirm and stop here.
- **Some verbs missing**: continue to step 2.
- **All verbs missing AND no `mise.toml`**: continue to step 2.

### Step 2 — discover existing native commands

Inspect the project. For each standard verb (up/down/build/test/check/fix),
look for an existing native command. Heuristics:

- **PHP**: read `composer.json` `scripts` — exact match (`up`, `down`,
  `test`, `fix`, `check`) or close alias (`phpunit`, `lint`,
  `check:before:commit`, `build-prod` / `build:prod`).
- **Node**: read `package.json` `scripts` — same matching plus
  `docker:up` / `docker:down` / `docker:build` group.
- **Makefile**: top-level targets named `up`/`test`/etc.

If still no candidate, proceed to **Step 2b — propose**.

### Step 2b — propose when no native candidate exists

For each verb that has zero native candidates after the heuristic pass,
classify the project and propose:

1. **Is the project writable by the user?** (heuristic: look for
   `.git` they own + recent commits authored by the user, or just ask).
   - **Writable + the verb is conventionally implemented inside the
     project** (e.g., `test`, `check`, `fix`, `build`): propose **(A)**
     adding the native script (`composer.json` scripts / `package.json`
     scripts / Makefile target) **and** a thin wrapper in
     `mise.toml` that calls it. This is the preferred path — keeps the
     project usable without vdx.
   - **Writable but the verb is environmental** (`up`/`down` usually
     means `docker compose up`/`down` or `mise run server`): propose
     **(B)** a pure mise task in `mise.toml` that wraps the
     environment command — no need to clutter `composer.json`/`package.json`.
   - **Readonly / third-party / vendored**: propose **(C)** mise-only
     wrapper in `.vdx-overrides.toml` (or the project's `mise.toml` if
     the user can add one file). Never modify the project's native
     manifest.

Always show the user the concrete diff before applying. Anti-pattern:
do not invent project-specific scripts (e.g. a fictional `composer test`
that calls a phpunit binary that isn't installed). If you don't know
the test runner, **ask**.

### Step 3 — verify each command works

For each candidate `(verb, native_command)`:

1. If the command is `mise run <verb>` form: invoke the matching MCP
   lifecycle tool (`vdx_up`/etc) and confirm `exit_code == 0`.
2. Otherwise: ask the user to confirm the command, or run it via `Bash`
   in a safe scope (test/check/fix are generally safe; up/down may have
   side effects — ask first).

Skip and mark as unmapped if the command fails.

### Step 4 — record the success path

When at least 3 verbs are confirmed working, call
`vdx_record_success_path` with:

```json
{
  "verbs": [
    {"name": "up",    "command": "composer up"},
    {"name": "test",  "command": "composer test"},
    {"name": "check", "command": "composer lint"}
  ],
  "shared_infra": { "provider": "...", "precheck": true },
  "notes": "verified via Claude Code session, all green"
}
```

`shared_infra` is optional — only set if the project depends on an
external service that must be up before `vdx_up` (e.g. a shared
reverse-proxy).

### Step 5 — re-audit and report

Call `vdx_audit` (format: json). Surface the diff to the user:

- which axes improved
- which still have gaps (lifecycle-interface, static-analysis, ci, etc.)
- the top 1–2 highest-leverage next moves to reach L2/L3

## Anti-patterns

- **Don't invent commands.** If a project has only `composer build:assets`
  and `composer build:db`, do not invent a top-level `composer build` —
  either pick the most canonical sub-command (e.g. `build:prod`), or ask
  the user.
- **Don't overwrite an existing manifest** without explicit consent. If
  `mise.toml` already has `[vdx]`, treat it as ground truth and only
  patch missing entries.
- **Don't record unverified commands.** `vdx_record_success_path` is
  meant to persist commands you have actually observed succeed.
