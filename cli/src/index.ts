#!/usr/bin/env node
import * as path from 'node:path';
import { loadRubric } from './rubric.ts';
import { loadManifest, loadOverrides } from './manifest.ts';
import { autoDetectStack, type Ctx } from './facts.ts';
import { audit } from './audit.ts';
import { reportMarkdown, reportJson } from './report.ts';
import { planInit, writeInit, renderPlanSummary } from './init.ts';
import { resolveDefaultRubric } from './defaults.ts';

const DEFAULT_RUBRIC = resolveDefaultRubric();

function usage(): never {
  process.stderr.write(
    `Usage:
  vdx audit <project_path> [--rubric <path>] [--stack <stack>] [--json]
  vdx init  <project_path> [--baseline <ref>] [--dry-run] [--force]
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
  const plan = planInit(projectRoot, baseline ? { baseline } : {});

  process.stdout.write(renderPlanSummary(plan));

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

const parsed = parseArgs(process.argv);
if (parsed.cmd === 'audit') cmdAudit(parsed);
else if (parsed.cmd === 'init') cmdInit(parsed);
else usage();
