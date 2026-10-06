#!/usr/bin/env node
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadRubric } from './rubric.ts';
import { loadManifest, loadOverrides } from './manifest.ts';
import { autoDetectStack, type Ctx } from './facts.ts';
import {
  LIFECYCLE_VERBS,
  type LifecycleVerb,
  resolveLifecycleVerb,
  renderResolveError,
} from './run.ts';
import { audit } from './audit.ts';
import {
  reportMarkdown,
  reportJson,
  reportAnsi,
  reportDoctorMarkdown,
  reportDoctorJson,
  reportDoctorAnsi,
} from './report.ts';
import { runDoctor, looksLikeProject, readCliVersion } from './doctor.ts';
import { planInit, writeInit, renderPlanSummary } from './init.ts';
import {
  planPublish,
  renderPublishPlan,
  executePublish,
  type BumpKind,
  type PublishOptions,
} from './publish.ts';
import { resolveDefaultRubric } from './defaults.ts';
import { runAi, runAiCheck, runAiRemote, defaultDeps, hostLabel, REMOTE_HOST_RE } from './ai.ts';
import { isConversationId } from './conversations.ts';

const DEFAULT_RUBRIC = resolveDefaultRubric();

const USAGE = `Usage:
  vdx <up|down|build|test|check|fix>     run lifecycle verb (via mise run <verb>)
  vdx audit   [project_path]  [--rubric <path>] [--stack <stack>] [--format=ansi|markdown|json] [--json]   (default: cwd)
  vdx init    [project_path]  [--stack <id>] [--baseline <ref>] [--dry-run] [--force]                     (default: cwd)
  vdx publish <patch|minor|major> [--dry-run] [--force]
  vdx doctor  [--format=ansi|markdown|json] [--json]
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
Which agent, its flags and whether it runs in tmux come from your profile:
$VDX_ENVIRONMENT, else ~/.vdx-environment.yaml, else a plain claude/codex.

Launch flags live in the profile, not in a command to type: agent.args for
every project, agent.when[] for a class of projects (a rubric predicate over
the project's files). Hand a person \`vdx ai\`, not \`<agent> --<flag>\`.

  project_path  the project (default: cwd); its git toplevel is used
  @host         the same command on <host> over ssh: its vdx, profile and tmux
  --new         a new conversation instead of continuing the last one
  --conversation <id>
                continue this Claude Code conversation
  --restart     restart the running agent in its pane — applies a changed profile
  --detach      start without attaching; print the command that attaches
  --dry-run     print the plan and the project's running agents; start nothing
  --check       for the agent's own session: how the agent here is launched, and
                whether this session carries the profile's flags (the vdx plugin's
                SessionStart hook); prints nothing without a profile; exit 3 on drift
  -h, --help    this help

Which conversation a start continues (Claude Code): each one is marked with the
machine it was last started on (the vdx plugin's hook writes it in), and the
other machines are asked over ssh which ones run there now. Another machine's
conversation is continued on that machine; if it does not answer, vdx asks
before continuing it here. When the choice is not plain, vdx lists them, the
running ones marked — Enter takes the newest; without a terminal it takes this
machine's.

Exit codes: 0 the agent runs per the profile; 2 profile or usage error;
3 the running agent lacks profile flags (rerun with --restart); 4 the start
was not confirmed.
Profile format: https://github.com/VoDmAl/vdx/blob/main/docs/specs/environment-format.md
`;

const COMMANDS: Record<string, CommandSpec> = {
  audit: {
    usage: 'vdx audit [project_path] [--rubric <path>] [--stack <stack>] [--format=ansi|markdown|json] [--json]',
    help: `Scores the project (default: cwd) against the rubric and prints the report.
Reads only. The rubric is the bundled one unless --rubric or $VDX_RUBRIC names another.
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
    usage: 'vdx publish <patch|minor|major> [--dry-run] [--force]',
    help: `Releases the library in the current directory: pre-flight checks, version bump,
npm publish (npm asks for an OTP), git commit and tag. Does not push.
--dry-run runs the pre-flight and prints the plan; --force goes on past a failed pre-flight.
`,
    bools: ['dry-run', 'force'],
    positionals: 1,
  },
  doctor: {
    usage: 'vdx doctor [--format=ansi|markdown|json] [--json]',
    help: `Checks this machine for what vdx needs (Node, git, mise, npm auth, docker, the
Claude Code plugin) and, inside a project, its commit author. Reads only.
Exit 2 when something is missing.
`,
    bools: ['json'],
    values: ['format'],
    positionals: 0,
  },
  ai: {
    usage: 'vdx ai[@host] [project_path] [--new | --conversation <id>] [--restart] [--detach] [--dry-run]',
    help: AI_HELP,
    // `--resume` asked to continue in 0.12; continuing is the default now.
    bools: ['new', 'restart', 'resume', 'detach', 'dry-run', 'check'],
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
    ...Object.keys(flags).filter((f) => !bools.includes(f) && !values.includes(f)).map((f) => `--${f}`),
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

  const manifest = loadManifest(projectRoot);
  const overrides = loadOverrides(projectRoot);

  const rubricPath = (opts.flags.rubric as string) || DEFAULT_RUBRIC;
  const rubric = loadRubric(rubricPath);

  const stack =
    (opts.flags.stack as string) || manifest?.stack || autoDetectStack(projectRoot);

  const ctx: Ctx = {
    projectRoot,
    stack,
    cache: new Map(),
  };

  const baselineRef = manifest?.baseline ?? `file://${rubricPath}`;
  const result = audit(rubric, ctx, overrides, baselineRef, manifest);

  const formatFlag =
    typeof opts.flags.format === 'string' ? opts.flags.format : undefined;
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
  } catch (e: any) {
    process.stderr.write(`\nerror: ${e?.message ?? String(e)}\n`);
    process.exit(2);
  }
}

function cmdPublish(opts: ParsedArgs): void {
  const bumpArg = opts.positionals[0];
  if (!bumpArg || !['patch', 'minor', 'major'].includes(bumpArg)) {
    process.stderr.write(
      'Usage: vdx publish <patch|minor|major> [--dry-run] [--force]\n',
    );
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
  };

  let plan;
  try {
    plan = planPublish(planOpts, auditResult, ctx);
  } catch (e: any) {
    process.stderr.write(`error: ${e?.message ?? String(e)}\n`);
    process.exit(2);
  }

  process.stdout.write(renderPublishPlan(plan));

  if (planOpts.dryRun) {
    process.stderr.write('\n[dry-run] не выполнено.\n');
    return;
  }

  if (!plan.preflightPassed && !planOpts.force) {
    process.stderr.write('\nerror: pre-flight failed (use --force to bypass)\n');
    process.exit(2);
  }

  try {
    executePublish(plan);
  } catch (e: any) {
    process.stderr.write(`\nerror: ${e?.message ?? String(e)}\n`);
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
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      process.stderr.write(
        `vdx: \`mise\` binary not found on PATH\n` +
          `hint: install mise — https://mise.jdx.dev/getting-started.html\n`,
      );
      process.exit(127);
    }
    process.exit(typeof e?.status === 'number' ? e.status : 1);
  }
}

function cmdDoctor(opts: ParsedArgs): void {
  const report = runDoctor();

  const formatFlag =
    typeof opts.flags.format === 'string' ? opts.flags.format : undefined;
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
else if (parsed.cmd === 'doctor') cmdDoctor(checkArgs('doctor', parsed));
else if (parsed.cmd === 'ai' || parsed.cmd.startsWith('ai@')) cmdAi(checkArgs('ai', parsed));
else if ((LIFECYCLE_VERBS as readonly string[]).includes(parsed.cmd)) {
  checkArgs(parsed.cmd, parsed);
  cmdRun(parsed.cmd as LifecycleVerb);
} else {
  if (parsed.cmd !== '') process.stderr.write(`vdx: unknown command "${parsed.cmd}"\n`);
  usage();
}
