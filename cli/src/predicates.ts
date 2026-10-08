import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Ctx,
  fileExists,
  readText,
  readJson,
  listAllTasks,
  isPackagePresent,
  expandPaths,
  readTsconfig,
  readStructured,
  resolveConfigPath,
} from './facts.ts';
import { checkingJobs, ciSystems, ciTaskCalls, mainPushSteps, readWorkflows, shippingJobs, upstream } from './gha.ts';
import { detectHookFrameworks } from './hooks.ts';
import { covers, expandTasks, isVocabularyTask, projectTaskCalls } from './vocabulary.ts';

type Args = Record<string, any>;

/** A fact vdx could not read here — a CI system or a hosting it does not inspect. */
export interface Unknown {
  unknown: string;
}
export type Verdict = boolean | Unknown;
type PredicateFn = (args: Args, ctx: Ctx) => Verdict;

export function isUnknown(v: Verdict): v is Unknown {
  return typeof v === 'object' && v !== null;
}

/**
 * Removed from schema 0.3: each name promised more than its body checked
 * (DL #20 of docs/tasks/vdm-gates-wiring-axis). They stay in the registry for
 * sets of schema 0.2 only — the same tag gives the same score on any CLI — and
 * a 0.3 set that names one does not load.
 */
export const REMOVED_IN_0_3 = new Set(['gh_workflow_blocks_pr', 'git_hook_installed', 'command_succeeds']);

const DEFAULT_TEST_PATTERN =
  '\\b(phpunit|pest|composer test|npm test|npm run test|yarn test|pnpm test|jest|vitest|pytest|go test|cargo test|mocha|mix test|rspec|vdx test|mise run test)\\b';

function testPattern(args: Args): RegExp {
  try {
    return new RegExp(String(args.pattern ?? DEFAULT_TEST_PATTERN));
  } catch {
    return new RegExp(DEFAULT_TEST_PATTERN);
  }
}

/**
 * Above "a CI config exists" vdx reads GitHub Actions only (DL #14). What the
 * workflows show decides when it says yes; a no is only a no when no other CI
 * system could say otherwise.
 */
function ciVerdict(ctx: Ctx, readGha: () => boolean): Verdict {
  const systems = ciSystems(ctx);
  if (systems.length === 0) return false;
  if (systems.includes('gha') && readGha()) return true;
  const others = systems.filter((s) => s !== 'gha');
  if (others.length > 0) return { unknown: `vdx reads GitHub Actions only, not ${others.join(', ')}` };
  return false;
}

function hookWords(args: Args): string[] {
  return Array.isArray(args.tasks) ? args.tasks.map(String) : ['test', 'check'];
}

/** Tasks the hooks of `events` call, through the project's runner. */
function hookTaskCalls(ctx: Ctx, events: string[]): Set<string> {
  const out = new Set<string>();
  for (const fw of detectHookFrameworks(ctx)) {
    for (const e of events) {
      for (const cmd of fw.hooks.get(e) ?? []) for (const t of projectTaskCalls(cmd, ctx)) out.add(t);
    }
  }
  return out;
}

const warned = new Set<string>();
function warnOnce(name: string) {
  if (warned.has(name)) return;
  warned.add(name);
  process.stderr.write(`warning: predicate "${name}" not implemented in v0.1 — returning false\n`);
}

export const REGISTRY: Record<string, PredicateFn> = {
  always_true: () => true,

  has_task: (args, ctx) => listAllTasks(ctx).has(String(args.task)),

  has_task_matching: (args, ctx) => {
    try {
      const re = new RegExp(String(args.pattern));
      for (const t of listAllTasks(ctx)) if (re.test(t)) return true;
    } catch {
      return false;
    }
    return false;
  },

  has_file: (args, ctx) => fileExists(ctx, String(args.path)),

  file_contains: (args, ctx) => {
    const paths: string[] = Array.isArray(args.paths) ? args.paths : [String(args.path)];
    const expanded = expandPaths(paths, ctx);
    let re: RegExp;
    try {
      re = new RegExp(String(args.pattern));
    } catch {
      return false;
    }
    for (const p of expanded) {
      const text = readText(ctx, p);
      if (text !== null && re.test(text)) return true;
    }
    return false;
  },

  package_present: (args, ctx) => {
    if (typeof args === 'string') return isPackagePresent(args, 'any', ctx);
    return isPackagePresent(String(args.name), String(args.ecosystem ?? 'any'), ctx);
  },

  tsc_flag: (args, ctx) => {
    const cfg = readTsconfig(ctx);
    const co = cfg?.compilerOptions;
    if (!co) return false;
    const target = args.equals === undefined ? true : args.equals;
    return co[String(args.name)] === target;
  },

  phpstan_level_at_least: (args, ctx) => {
    const text =
      readText(ctx, 'phpstan.neon') ||
      readText(ctx, 'phpstan.dist.neon') ||
      readText(ctx, 'phpstan.neon.dist');
    if (!text) return false;
    const m = text.match(/^\s*level:\s*(\d+|max)/m);
    if (!m || !m[1]) return false;
    const lvl = m[1] === 'max' ? 9 : parseInt(m[1], 10);
    return lvl >= Number(args.n);
  },

  gh_workflow_blocks_pr: (args, ctx) => {
    const dir = path.join(ctx.projectRoot, '.github', 'workflows');
    if (!fs.existsSync(dir)) return false;
    const wanted = args.check_name ? String(args.check_name) : null;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!/\.ya?ml$/.test(f)) continue;
        const text = readText(ctx, path.join('.github', 'workflows', f));
        if (!text) continue;
        if (!/on:[\s\S]*?(pull_request|pull-request)/.test(text)) continue;
        if (wanted === null) return true;
        if (text.includes(wanted)) return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  },

  git_hook_installed: (args, ctx) => {
    const hook = String(args.hook);
    if (fileExists(ctx, `.husky/${hook}`)) return true;
    for (const f of ['.lefthook.yml', 'lefthook.yml']) {
      const text = readText(ctx, f);
      if (text && new RegExp(`^${hook}:`, 'm').test(text)) return true;
    }
    const composer = readJson(ctx, 'composer.json');
    if (composer?.extra?.hooks?.[hook]) return true;
    return false;
  },

  config_value: (args, ctx) => {
    const filePath = String(args.path ?? '');
    const jsonpath = String(args.jsonpath ?? '');
    if (!filePath || !jsonpath) return false;
    const data = readStructured(ctx, filePath);
    if (data === null || data === undefined) return false;
    const value = resolveConfigPath(data, jsonpath);

    // Operator resolution: explicit `op`, otherwise infer from arg shape.
    let op = args.op ? String(args.op) : null;
    if (!op) {
      if (args.equals !== undefined) op = 'equals';
      else if (args.gte !== undefined) op = 'gte';
      else if (args.pattern !== undefined) op = 'matches';
      else op = 'present';
    }

    switch (op) {
      case 'present':
        return value !== undefined && value !== null;
      case 'equals':
        return value === args.equals;
      case 'gte': {
        const v = typeof value === 'number' ? value : Number(value);
        const target = Number(args.gte);
        if (Number.isNaN(v) || Number.isNaN(target)) return false;
        return v >= target;
      }
      case 'matches': {
        if (typeof value !== 'string') return false;
        try {
          return new RegExp(String(args.pattern)).test(value);
        } catch {
          return false;
        }
      }
      default:
        process.stderr.write(`warning: config_value: unknown op "${op}"\n`);
        return false;
    }
  },
  command_succeeds: () => {
    warnOnce('command_succeeds');
    return false;
  },

  // --- ci: the signal, read from GitHub Actions workflows (schema 0.3) ---

  /** L2: tests run on a push to main/master, and their failure fails the job. */
  gha_tests_on_push: (args, ctx) =>
    ciVerdict(ctx, () => {
      const re = testPattern(args);
      return mainPushSteps(ctx).some(({ step }) => re.test(step.run!));
    }),

  /** L3: on that push CI calls the project's own tasks — each of `tasks` (or its `name:*` form). */
  gha_runs_tasks: (args, ctx) =>
    ciVerdict(ctx, () => {
      const calls = [...ciTaskCalls(ctx)];
      return hookWords(args).every((w) => calls.some((t) => isVocabularyTask(t, [w])));
    }),

  /** L4 (library): the testing job runs across a matrix. */
  gha_test_matrix: (args, ctx) =>
    ciVerdict(ctx, () => [...checkingJobs(ctx, testPattern(args))].some((j) => j.matrix)),

  /** L4 (service): whatever CI ships on a push to main waits, via `needs:`, for a checking job. */
  gha_ship_needs_checks: (args, ctx) =>
    ciVerdict(ctx, () => {
      const checking = checkingJobs(ctx, testPattern(args));
      const shipping = readWorkflows(ctx)
        .filter((wf) => wf.pushesMain)
        .flatMap((wf) => shippingJobs(wf).map((job) => ({ wf, job })));
      if (shipping.length === 0) return false;
      return shipping.every(({ wf, job }) => [...upstream(wf, job)].some((j) => checking.has(j)));
    }),

  // --- branch-protection: only the hosting knows (schema 0.3) ---

  /** L3: main takes changes only after a required check. No hosting extension yet — unknown everywhere (DL #12). */
  branch_requires_checks: () => ({
    unknown: 'only the hosting knows whether main is protected — vdx has no extension for it yet',
  }),

  // --- git-hygiene: the hook recognizer (schema 0.3) ---

  /** L2: the repository declares hooks, and every framework it declares them with is switched on by an install step. */
  git_hooks_arranged: (_args, ctx) => {
    const fws = detectHookFrameworks(ctx);
    return fws.length > 0 && fws.every((f) => f.installedBy !== null);
  },

  /** L3: pre-commit or pre-push calls a task of the vocabulary (`test`, `check`, `check:*`, `test:*`). */
  git_hook_runs_task: (args, ctx) => {
    const calls = [...hookTaskCalls(ctx, ['pre-commit', 'pre-push'])];
    return calls.some((t) => isVocabularyTask(t, hookWords(args)));
  },

  /** L4: pre-push calls every vocabulary task CI calls on a push to main — a push past the hook does not fail CI on a check. */
  git_hook_covers_ci: (args, ctx) =>
    ciVerdict(ctx, () => {
      const ci = [...ciTaskCalls(ctx)].filter((t) => isVocabularyTask(t, hookWords(args)));
      if (ci.length === 0) return false;
      const hook = expandTasks(ctx, hookTaskCalls(ctx, ['pre-push']));
      return ci.every((t) => covers(ctx, hook, t));
    }),
};
