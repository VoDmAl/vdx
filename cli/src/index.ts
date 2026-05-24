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
import { reportMarkdown, reportJson } from './report.ts';
import { planInit, writeInit, renderPlanSummary } from './init.ts';
import {
  planPublish,
  renderPublishPlan,
  executePublish,
  type BumpKind,
  type PublishOptions,
} from './publish.ts';
import { resolveDefaultRubric } from './defaults.ts';

const DEFAULT_RUBRIC = resolveDefaultRubric();

function usage(): never {
  process.stderr.write(
    `Usage:
  vdx <up|down|build|test|check|fix>     run lifecycle verb (via mise run <verb>)
  vdx audit   <project_path> [--rubric <path>] [--stack <stack>] [--json]
  vdx init    <project_path> [--stack <id>] [--baseline <ref>] [--dry-run] [--force]
  vdx publish <patch|minor|major> [--dry-run] [--force]
`,
  );
  process.exit(1);
}

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
      const name = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { cmd, positionals, flags };
}

function cmdAudit(opts: ParsedArgs): void {
  const projectArg = opts.positionals[0];
  if (!projectArg) usage();
  const projectRoot = path.resolve(projectArg);

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

  if (opts.flags.json) {
    process.stdout.write(reportJson(result) + '\n');
  } else {
    process.stdout.write(reportMarkdown(result));
  }
}

function cmdInit(opts: ParsedArgs): void {
  const projectArg = opts.positionals[0];
  if (!projectArg) usage();
  const projectRoot = path.resolve(projectArg);

  const baselineFlag = opts.flags.baseline;
  const baseline = typeof baselineFlag === 'string' ? baselineFlag : undefined;
  const stackFlag = opts.flags.stack;
  const stackOverride = typeof stackFlag === 'string' ? stackFlag : undefined;
  const plan = planInit(projectRoot, {
    ...(baseline ? { baseline } : {}),
    ...(stackOverride ? { stack: stackOverride } : {}),
  });

  process.stdout.write(renderPlanSummary(plan));

  for (const w of plan.warnings) {
    process.stderr.write(`\n⚠ ${w}\n`);
  }

  if (opts.flags['dry-run']) {
    process.stderr.write('\n[dry-run] mise.toml / AGENTS.md не записаны.\n');
    return;
  }
  try {
    writeInit(plan, { force: Boolean(opts.flags.force) });
    process.stderr.write(
      `\n✓ Записаны:\n  ${plan.miseTomlPath}\n  ${plan.agentsMdPath}\n`,
    );
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

const parsed = parseArgs(process.argv);
if (parsed.cmd === 'audit') cmdAudit(parsed);
else if (parsed.cmd === 'init') cmdInit(parsed);
else if (parsed.cmd === 'publish') cmdPublish(parsed);
else if ((LIFECYCLE_VERBS as readonly string[]).includes(parsed.cmd))
  cmdRun(parsed.cmd as LifecycleVerb);
else usage();
