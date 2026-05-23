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

type Args = Record<string, any>;
type PredicateFn = (args: Args, ctx: Ctx) => boolean;

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
};
