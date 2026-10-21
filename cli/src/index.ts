#!/usr/bin/env node
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadRubric } from './rubric.ts';
import { loadManifest, loadManifestAt, loadOverrides } from './manifest.ts';
import { autoDetectStack, type Ctx } from './facts.ts';
import { at, errorMessage } from './narrow.ts';
import { LIFECYCLE_VERBS, type LifecycleVerb, resolveLifecycleVerb, renderResolveError } from './run.ts';
import { audit } from './audit.ts';
import {
  reportMarkdown,
  reportJson,
  reportAnsi,
  reportDoctorMarkdown,
  reportDoctorJson,
  reportDoctorAnsi,
} from './report.ts';
import {
  runDoctor,
  runDoctorCheck,
  runDoctorFix,
  resolveDoctorCtx,
  looksLikeProject,
  readCliVersion,
} from './doctor.ts';
import { planInit, writeInit, renderPlanSummary } from './init.ts';
import {
  planPublish,
  preflightFixable,
  renderPublishPlan,
  executePublish,
  defaultPublishDeps,
  type BumpKind,
  type PublishOptions,
} from './publish.ts';
import { resolveDefaultRubric } from './defaults.ts';
import { defaultGateDeps, GATE_PREFIX, planGate, pushThroughGate } from './gate.ts';
import { askLine, runAi, runAiCheck, runAiRemote, defaultDeps, hostLabel, REMOTE_HOST_RE } from './ai.ts';
import { isConversationId } from './conversations.ts';

const DEFAULT_RUBRIC = resolveDefaultRubric();

const USAGE = `Usage:
  vdx <up|down|build|test|check|fix>     run lifecycle verb (via mise run <verb>)
  vdx audit   [project_path]  [--rubric <path>] [--stack <stack>] [--format=ansi|markdown|json] [--json]   (default: cwd)
  vdx init    [project_path]  [--stack <id>] [--baseline <ref>] [--dry-run] [--force]                     (default: cwd)
  vdx publish <patch|minor|major> [--dry-run] [--force] [--no-push]
  vdx push    [project_path] [--dry-run]                     (default: cwd; through the branch's required checks)
  vdx doctor  [project_path] [--check | --fix] [--format=ansi|markdown|json] [--json]          (default: cwd)
  vdx ai[@host] [project_path] [--new | --conversation <id>] [--restart] [--detach] [--dry-run]   (default: cwd; @host: over ssh, in tmux there)
  vdx <command> --help                   what the command does; an unknown option is refused (exit 2)
  vdx --version
`;

function usage(): never {
  process.stderr.write(USAGE);
  process.exit(1);
}

/** What a command reads from its arguments; the rest is refused. */
interface CommandSpec {
  usage: string;
  /** Printed under the usage line by `--help`. */
  help: string;
  /** Flags that take no value. */
  bools?: string[];
  /** Flags that take one (`--stack node`, `--format=json`). */
  values?: string[];
  /** How many positional arguments the command takes. */
  positionals: number;
}

const AI_HELP = `Starts your agent in the project, or attaches to the one already running there.
Several running there: a list to pick from — Enter takes the newest.
Which agent, its flags and whether it runs in tmux come from your profile:
$VDX_ENVIRONMENT, else ~/.vdx-environment.yaml, else a plain claude/codex.

Launch flags live in the profile, not in a command to type: agent.args for
every project, agent.when[] for a class of projects (a rubric predicate over
the project's files). Hand a person \`vdx ai\`, not \`<agent> --<flag>\`.

  project_path  the project (default: cwd); its git toplevel is used
  @host         the same command on <host> over ssh: its vdx, profile and tmux
  --new         a new conversation instead of continuing the last one; an agent
                already running here keeps running, the new one starts next to
                it, in a tmux session of its own (<name>-2, -3, …)
  --focused     a new conversation, as --new, in a session nothing wakes: the
                agent, its hooks and MCP servers get VDX_FOCUSED=1 — for the
                plugins that wake sessions to leave it alone — and the profile's
                rules marked \`wakes: true\` (a channel flag) are left out. Back
                to it: --focused --conversation <id>. A running agent keeps its
                mode: plain vdx ai attaches to it as it is
  --conversation <id>
                continue this Claude Code conversation: attach to the agent in
                it, or start one next to the agents running here
  --restart     restart the running agent in its pane — applies a changed profile;
                with --new, --focused or --conversation, it is replaced by that.
                Without it, an agent running without the profile's flags is
                a question in a terminal: Enter attaches to it as is, r
                restarts it, q leaves it
  --detach      start without attaching; print the command that attaches
  --dry-run     print the plan and the project's running agents; start nothing
  --check       for the agent's own session: how the agent here is launched, and
                whether this session carries the profile's flags (the vdx plugin's
                SessionStart hook); prints nothing without a profile; exit 3 on drift
  -h, --help    this help

Which conversation a start continues (Claude Code): each one is marked with the
machine it was last started on (the vdx plugin's hook writes it in), and the
other machines (session.machines in the profile, and those the conversations
name) are asked over ssh what runs there now. Another machine's conversation
is continued on that machine; if it does not answer, vdx asks before
continuing it here. When the choice is not plain, vdx lists them, the running
ones marked — Enter takes the newest; without a terminal it takes this
machine's. A new conversation (--new, or none to continue) while an agent of
the project runs on another machine starts only after a yes.

Exit codes: 0 the agent runs per the profile; 2 profile or usage error;
3 the running agent lacks profile flags, or is not focused under --focused,
and was left as is — no terminal, or q (rerun with --restart); 4 the start
was not confirmed.
Profile format: https://github.com/VoDmAl/vdx/blob/main/docs/specs/environment-format.md
`;

const COMMANDS: Record<string, CommandSpec> = {
  audit: {
    usage: 'vdx audit [project_path] [--rubric <path>] [--stack <stack>] [--format=ansi|markdown|json] [--json]',
    help: `Scores the project (default: cwd) against the rubric and prints the report.
Reads only. The rubric is the bundled one unless --rubric or $VDX_RUBRIC names another.
For branch-protection it asks the hosting of origin whether its default branch
takes changes only after a check required of everyone: GitHub, with a token from
$GH_TOKEN, $GITHUB_TOKEN or gh when there is one; GitLab, with glab's token for that host,
or $GITLAB_TOKEN when the host is $GITLAB_HOST (gitlab.com unless set) — no
other host gets it; Bitbucket Server, with the login git keeps for that host
(git credential), or $BITBUCKET_TOKEN when the host is $BITBUCKET_HOST.
Another hosting is unknown; VDX_OFFLINE=1 does not ask, and the axis says
unknown.
`,
    bools: ['json'],
    values: ['rubric', 'stack', 'format'],
    positionals: 1,
  },
  init: {
    usage: 'vdx init [project_path] [--stack <id>] [--baseline <ref>] [--dry-run] [--force]',
    help: `Writes mise.toml for the project (default: cwd): the lifecycle verbs mapped to
the project's own scripts. --dry-run prints it and writes nothing; an existing
mise.toml is overwritten only with --force.
`,
    bools: ['dry-run', 'force'],
    values: ['stack', 'baseline'],
    positionals: 1,
  },
  publish: {
    usage: 'vdx publish <patch|minor|major> [--dry-run] [--force] [--no-push]',
    help: `Releases the library in the current directory, start to finish:
  pre-flight checks — at a terminal an expired npm login is renewed (\`npm login\`)
  and the checks run again;
  the version bump in package.json and package-lock.json;
  npm publish (npm asks for an OTP or a confirmation in the browser; Ctrl-C
  there puts the version back);
  git commit and tag, then \`git push --follow-tags\` to the branch's upstream —
  through its checks when it requires some, as \`vdx push\` does: the pre-flight
  then refuses local commits not pushed yet, npm would get them before CI;
  a wait until the registry shows the new version (up to 10 min from npm publish;
  Ctrl-C there stops only the wait).
Nothing in the package's directory changed since the tag of its version: the
same package under a new number — at a terminal a question, Enter releases nothing.
--dry-run runs the pre-flight and prints the plan; --force goes on past a failed
pre-flight; --no-push leaves the commit and the tag local.
`,
    bools: ['dry-run', 'force', 'no-push'],
    positionals: 1,
  },
  push: {
    usage: 'vdx push [project_path] [--dry-run]',
    help: `Pushes the current branch to its upstream. When the upstream is on GitHub and
requires checks (branch protection or a ruleset), the commit goes to
${GATE_PREFIX}<branch> first: CI checks it there, vdx waits for the checks and then
pushes the same commit to the branch, with its annotated tags (--follow-tags).
A failed check leaves the branch as it was and names the check. A branch that
requires no checks, a remote not on GitHub, a GitHub that does not answer: a
plain \`git push\`, hooks and all.

The pushes through the checks carry VDX_GATE_PUSH=1: a pre-push hook that runs
what CI runs may step aside. GitHub is asked with a token from $GH_TOKEN,
$GITHUB_TOKEN or gh when there is one — without one it answers 60 requests an
hour, and a push takes about ten; VDX_OFFLINE=1 does not ask.

  project_path  the repository (default: cwd)
  --dry-run     say which way the push goes; push nothing

Exit codes: 0 pushed; 2 nowhere to push it (no branch, no upstream, behind it);
3 the branch did not take the commit — a check failed, did not finish in 20 min,
or GitHub stopped answering; a plain git push exits with git's own code.
`,
    bools: ['dry-run'],
    positionals: 1,
  },
  doctor: {
    usage: 'vdx doctor [project_path] [--check | --fix] [--format=ansi|markdown|json] [--json]',
    help: `Checks this machine for what vdx needs (Node, git, mise, npm auth, docker, the
Claude Code plugin) and, inside a project (default: cwd), its commit author and
its git hooks: are the hooks the repository declares on in this clone, and do
the personal hooks of your profile (git.hooks) run on this machine; with origin on
GitHub, the token vdx asks GitHub with ($GH_TOKEN, $GITHUB_TOKEN or gh) and
whether it works — without one GitHub answers 60 requests an hour. Reads only.
Exit 2 when something is missing.

  --check  for the agent's own session (the vdx plugin's SessionStart hook): one
           line per hook that is declared but does not run here; nothing when in order
  --fix    write the profile's personal hooks into ~/.gitconfig where they are
           missing or differ; repository hooks are switched on by the project's
           install step, which the report names
`,
    bools: ['json', 'check', 'fix'],
    values: ['format'],
    positionals: 1,
  },
  ai: {
    usage: 'vdx ai[@host] [project_path] [--new | --conversation <id>] [--focused] [--restart] [--detach] [--dry-run]',
    help: AI_HELP,
    // `--resume` asked to continue in 0.12; continuing is the default now.
    bools: ['new', 'focused', 'restart', 'resume', 'detach', 'dry-run', 'check'],
    values: ['conversation'],
    positionals: 1,
  },
  ...Object.fromEntries(
    LIFECYCLE_VERBS.map((verb) => [
      verb,
      {
        usage: `vdx ${verb}`,
        help: `Runs \`mise run ${verb}\` in the current directory — the project's own ${verb}
command, as mise.toml maps it. Takes no arguments.
`,
        positionals: 0,
      },
    ]),
  ),
};

interface ParsedArgs {
  cmd: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const cmd = argv[2] ?? '';
  const rest = argv.slice(3);
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eqIdx = body.indexOf('=');
      if (eqIdx >= 0) {
        flags[body.slice(0, eqIdx)] = body.slice(eqIdx + 1);
      } else {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { cmd, positionals, flags };
}

/**
 * Keeps what the command reads and refuses the rest, before anything runs: a
 * misread argument must not run the command. `vdx ai --help` started an agent,
 * `vdx init --help` wrote mise.toml, `vdx down --help` ran `mise run down`.
 */
function checkArgs(name: string, opts: ParsedArgs): ParsedArgs {
  const spec = COMMANDS[name]!;
  const bools = [...(spec.bools ?? []), 'help'];
  const values = spec.values ?? [];
  // parseArgs hands the token after a bare flag to that flag as its value; a
  // flag that takes none gives it back — it is the path (or `-h`).
  const positionals = [...opts.positionals];
  const flags: Record<string, string | boolean> = {};
  for (const [flag, value] of Object.entries(opts.flags)) {
    if (bools.includes(flag) && typeof value === 'string') {
      positionals.push(value);
      flags[flag] = true;
    } else {
      flags[flag] = value;
    }
  }
  if (flags.help || positionals.includes('-h')) {
    process.stdout.write(`Usage: ${spec.usage}\n\n${spec.help}`);
    process.exit(0);
  }
  const fail = (message: string): never => {
    process.stderr.write(`vdx ${name}: ${message}\nUsage: ${spec.usage}\nMore: vdx ${name} --help\n`);
    process.exit(2);
  };
  const unknown = [
    ...Object.keys(flags)
      .filter((f) => !bools.includes(f) && !values.includes(f))
      .map((f) => `--${f}`),
    ...positionals.filter((p) => p.startsWith('-')),
  ];
  if (unknown.length > 0) fail(`unknown option ${unknown.join(', ')}`);
  const bare = values.filter((f) => flags[f] === true).map((f) => `--${f}`);
  if (bare.length > 0) fail(`${bare.join(', ')} needs a value`);
  if (positionals.length > spec.positionals) {
    fail(`unexpected argument ${positionals.slice(spec.positionals).join(' ')}`);
  }
  return { cmd: opts.cmd, positionals, flags };
}

function cmdAudit(opts: ParsedArgs): void {
  const projectArg = opts.positionals[0] ?? '.';
  const projectRoot = path.resolve(projectArg);

  if (!looksLikeProject(projectRoot)) {
    process.stderr.write(
      `vdx: ${projectRoot} doesn't look like a project root ` +
        `(no package.json / composer.json / pyproject.toml / Makefile / mise.toml / .git found)\n` +
        `hint: try \`vdx doctor\` to check your environment, or \`vdx audit <path-to-project>\`.\n\n`,
    );
  }

  const found = loadManifestAt(projectRoot);
  const manifest = found?.manifest ?? null;
  if (found?.place === 'vdx') {
    process.stderr.write(
      'note: the manifest is in [vdx] of mise.toml, and mise 2026.10 warns about it on every run; ' +
        'its place is [_.vdx], once every machine of the project runs vdx 0.26 or newer\n',
    );
  }
  const overrides = loadOverrides(projectRoot);

  const rubricPath = (opts.flags.rubric as string) || DEFAULT_RUBRIC;
  const rubric = loadRubric(rubricPath);

  const stack = (opts.flags.stack as string) || manifest?.stack || autoDetectStack(projectRoot);

  const ctx: Ctx = {
    projectRoot,
    stack,
    cache: new Map(),
  };

  const baselineRef = manifest?.baseline ?? `file://${rubricPath}`;
  const result = audit(rubric, ctx, overrides, baselineRef, manifest);

  const formatFlag = typeof opts.flags.format === 'string' ? opts.flags.format : undefined;
  const wantJson = opts.flags.json === true || formatFlag === 'json';
  const wantMarkdown = formatFlag === 'markdown' || formatFlag === 'md';
  const wantAnsi = formatFlag === 'ansi';
  const isTty = process.stdout.isTTY === true;

  if (wantJson) {
    process.stdout.write(reportJson(result) + '\n');
  } else if (wantMarkdown) {
    process.stdout.write(reportMarkdown(result));
  } else if (wantAnsi || (isTty && !formatFlag)) {
    process.stdout.write(reportAnsi(result));
  } else {
    process.stdout.write(reportMarkdown(result));
  }
}

function cmdInit(opts: ParsedArgs): void {
  const projectArg = opts.positionals[0] ?? '.';
  const projectRoot = path.resolve(projectArg);

  const baselineFlag = opts.flags.baseline;
  const baseline = typeof baselineFlag === 'string' ? baselineFlag : undefined;
  const stackFlag = opts.flags.stack;
  const stackOverride = typeof stackFlag === 'string' ? stackFlag : undefined;
  const plan = planInit(projectRoot, {
    ...(baseline ? { baseline } : {}),
    ...(stackOverride ? { stack: stackOverride } : {}),
  });

  const dryRun = Boolean(opts.flags['dry-run']);
  process.stdout.write(renderPlanSummary(plan, { verbose: dryRun }));

  for (const w of plan.warnings) {
    process.stderr.write(`\n⚠ ${w}\n`);
  }

  if (dryRun) {
    process.stderr.write('\n[dry-run] mise.toml не записан.\n');
    return;
  }
  try {
    writeInit(plan, { force: Boolean(opts.flags.force) });
    process.stderr.write(`\n✓ wrote ${plan.miseTomlPath}\n`);
  } catch (e) {
    process.stderr.write(`\nerror: ${errorMessage(e)}\n`);
    process.exit(2);
  }
}

function cmdPublish(opts: ParsedArgs): void {
  const bumpArg = opts.positionals[0];
  if (!bumpArg || !['patch', 'minor', 'major'].includes(bumpArg)) {
    process.stderr.write('Usage: vdx publish <patch|minor|major> [--dry-run] [--force] [--no-push]\n');
    process.exit(1);
  }
  const bump = bumpArg as BumpKind;
  const projectRoot = process.cwd();

  const manifest = loadManifest(projectRoot);
  const overrides = loadOverrides(projectRoot);
  const rubric = loadRubric(DEFAULT_RUBRIC);
  const stack = manifest?.stack || autoDetectStack(projectRoot);
  const ctx: Ctx = { projectRoot, stack, cache: new Map() };
  const baselineRef = manifest?.baseline ?? `file://${DEFAULT_RUBRIC}`;
  const auditResult = audit(rubric, ctx, overrides, baselineRef, manifest);

  const planOpts: PublishOptions = {
    projectRoot,
    bump,
    dryRun: Boolean(opts.flags['dry-run']),
    force: Boolean(opts.flags.force),
    push: !opts.flags['no-push'],
  };

  const replan = () => {
    try {
      return planPublish(planOpts, auditResult, ctx);
    } catch (e) {
      process.stderr.write(`error: ${errorMessage(e)}\n`);
      process.exit(2);
    }
  };
  let plan = replan();

  process.stdout.write(renderPublishPlan(plan));

  if (planOpts.dryRun) {
    process.stderr.write('\n[dry-run] не выполнено.\n');
    return;
  }

  // A failure a command fixes (an expired npm login): run it here, then check again.
  const deps = defaultPublishDeps();
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!plan.preflightPassed && !planOpts.force && interactive && preflightFixable(plan)) {
    const fixes = plan.preflight.filter((c) => !c.ok && c.fix);
    for (const c of fixes) {
      process.stderr.write(`\n→ ${c.name}: ${c.fix!.cmd} ${c.fix!.args.join(' ')}\n`);
      try {
        deps.run(c.fix!.cmd, c.fix!.args, projectRoot);
      } catch {
        process.stderr.write(`error: \`${c.fix!.cmd} ${c.fix!.args.join(' ')}\` failed\n`);
        process.exit(2);
      }
    }
    if (fixes.length > 0) {
      plan = replan();
      process.stdout.write('\n' + renderPublishPlan(plan));
    }
  }

  // A failure the person may waive (nothing changed since the release): a question, Enter no.
  let waived = false;
  const left = plan.preflight.filter((c) => !c.ok);
  if (!planOpts.force && interactive && left.length > 0 && left.every((c) => c.waive)) {
    for (const c of left) {
      process.stderr.write(`\n${c.name}: ${c.message}\n`);
      if (!/^y(es)?$/i.test(askLine(c.waive!) ?? '')) {
        process.stderr.write('nothing released\n');
        process.exit(2);
      }
    }
    waived = true;
  }

  if (!plan.preflightPassed && !planOpts.force && !waived) {
    process.stderr.write('\nerror: pre-flight failed (use --force to bypass)\n');
    process.exit(2);
  }

  try {
    executePublish(plan, deps);
  } catch (e) {
    process.stderr.write(`\nerror: ${errorMessage(e)}\n`);
    process.exit(3);
  }
}

function cmdPush(opts: ParsedArgs): void {
  const root = path.resolve(opts.positionals[0] ?? '.');
  const deps = defaultGateDeps(root);
  const plan = planGate(deps.io);
  if (plan.kind === 'refuse') {
    process.stderr.write(`vdx push: ${plan.message}\n`);
    process.exit(2);
  }
  if (plan.kind === 'plain') {
    process.stderr.write(`→ git push — ${plan.why}\n`);
    if (opts.flags['dry-run']) return;
    try {
      execFileSync('git', ['-C', root, 'push'], { stdio: 'inherit' });
    } catch (e) {
      const status = at(e, 'status');
      process.exit(typeof status === 'number' ? status : 1);
    }
    return;
  }
  const t = plan.target;
  process.stderr.write(
    `→ ${t.remote}/${t.branch} requires ${t.checks.join(', ')}: through ${GATE_PREFIX}${t.branch}, ` +
      `then ${t.branch} once they pass\n`,
  );
  if (opts.flags['dry-run']) return;
  try {
    pushThroughGate(t, deps);
  } catch (e) {
    process.stderr.write(`\nerror: ${errorMessage(e)}\n`);
    process.exit(3);
  }
}

function cmdRun(verb: LifecycleVerb): void {
  const projectRoot = process.cwd();
  const res = resolveLifecycleVerb(projectRoot, verb);
  if (!res.ok) {
    process.stderr.write(renderResolveError(res, projectRoot, verb));
    process.exit(2);
  }

  try {
    execFileSync('mise', ['run', verb], { cwd: projectRoot, stdio: 'inherit' });
  } catch (e) {
    if (at(e, 'code') === 'ENOENT') {
      process.stderr.write(
        `vdx: \`mise\` binary not found on PATH\n` + `hint: install mise — https://mise.jdx.dev/getting-started.html\n`,
      );
      process.exit(127);
    }
    const status = at(e, 'status');
    process.exit(typeof status === 'number' ? status : 1);
  }
}

function cmdDoctor(opts: ParsedArgs): void {
  const ctx = resolveDoctorCtx(path.resolve(opts.positionals[0] ?? '.'));
  if (opts.flags.check === true && opts.flags.fix === true) {
    process.stderr.write('vdx doctor: --check reports and --fix writes — pick one\n');
    process.exit(2);
  }
  if (opts.flags.check === true) {
    const text = runDoctorCheck(ctx);
    if (text) process.stdout.write(text + '\n');
    return;
  }
  if (opts.flags.fix === true) {
    try {
      const done = runDoctorFix();
      process.stderr.write(
        done.length > 0 ? done.map((d) => `✓ ${d}`).join('\n') + '\n' : 'nothing to fix in ~/.gitconfig\n',
      );
    } catch (e) {
      process.stderr.write(`vdx doctor --fix: ${errorMessage(e)}\n`);
      process.exit(2);
    }
  }
  const report = runDoctor(ctx);

  const formatFlag = typeof opts.flags.format === 'string' ? opts.flags.format : undefined;
  const wantJson = opts.flags.json === true || formatFlag === 'json';
  const wantMarkdown = formatFlag === 'markdown' || formatFlag === 'md';
  const wantAnsi = formatFlag === 'ansi';
  const isTty = process.stdout.isTTY === true;

  if (wantJson) {
    process.stdout.write(reportDoctorJson(report) + '\n');
  } else if (wantMarkdown) {
    process.stdout.write(reportDoctorMarkdown(report));
  } else if (wantAnsi || (isTty && !formatFlag)) {
    process.stdout.write(reportDoctorAnsi(report));
  } else {
    process.stdout.write(reportDoctorMarkdown(report));
  }

  if (report.missing > 0) process.exit(2);
}

function cmdAi(opts: ParsedArgs): void {
  if (opts.flags.check === true) {
    // About the session this runs in — there is nothing to start, and no other machine.
    const others = Object.keys(opts.flags).filter((f) => f !== 'check');
    if (others.length > 0 || opts.cmd !== 'ai') {
      process.stderr.write(
        `vdx ai: --check takes only the project path (not ${opts.cmd !== 'ai' ? opts.cmd : `--${others.join(', --')}`})\n`,
      );
      process.exit(2);
    }
    process.exit(runAiCheck(opts.positionals[0] ?? '.', defaultDeps()));
  }
  const conversation = typeof opts.flags.conversation === 'string' ? opts.flags.conversation : undefined;
  if (conversation !== undefined && !isConversationId(conversation)) {
    process.stderr.write(`vdx ai: --conversation takes a conversation id (a UUID), not "${conversation}"\n`);
    process.exit(2);
  }
  if (conversation !== undefined && opts.flags.new === true) {
    process.stderr.write('vdx ai: --new and --conversation ask for different conversations — pick one\n');
    process.exit(2);
  }
  const options = {
    path: opts.positionals[0] ?? '.',
    restart: opts.flags.restart === true,
    fresh: opts.flags.new === true,
    conversation,
    detach: opts.flags.detach === true,
    dryRun: opts.flags['dry-run'] === true,
    focused: opts.flags.focused === true,
  };
  const deps = { ...defaultDeps(), version: readCliVersion() };
  // `ai@m3`: the same command on another machine. Its own label runs here.
  const host = opts.cmd.startsWith('ai@') ? opts.cmd.slice(3) : null;
  if (host !== null) {
    if (!REMOTE_HOST_RE.test(host)) {
      process.stderr.write(`vdx ai@host: "${host}" is not a host name (an ssh destination such as m3)\n`);
      process.exit(2);
    }
    if (host.toLowerCase() !== hostLabel().toLowerCase()) {
      process.exit(runAiRemote(options, host, deps));
    }
  }
  process.exit(runAi(options, deps));
}

const parsed = parseArgs(process.argv);
if (parsed.cmd === '--version') process.stdout.write(readCliVersion() + '\n');
else if (['--help', '-h', 'help'].includes(parsed.cmd)) process.stdout.write(USAGE);
else if (parsed.cmd === 'audit') cmdAudit(checkArgs('audit', parsed));
else if (parsed.cmd === 'init') cmdInit(checkArgs('init', parsed));
else if (parsed.cmd === 'publish') cmdPublish(checkArgs('publish', parsed));
else if (parsed.cmd === 'push') cmdPush(checkArgs('push', parsed));
else if (parsed.cmd === 'doctor') cmdDoctor(checkArgs('doctor', parsed));
else if (parsed.cmd === 'ai' || parsed.cmd.startsWith('ai@')) cmdAi(checkArgs('ai', parsed));
else if ((LIFECYCLE_VERBS as readonly string[]).includes(parsed.cmd)) {
  checkArgs(parsed.cmd, parsed);
  cmdRun(parsed.cmd as LifecycleVerb);
} else {
  if (parsed.cmd !== '') process.stderr.write(`vdx: unknown command "${parsed.cmd}"\n`);
  usage();
}
