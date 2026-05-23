import * as fs from 'node:fs';
import * as path from 'node:path';
import * as TOML from 'smol-toml';
import * as YAML from 'js-yaml';

export interface Ctx {
  projectRoot: string;
  stack: string;
  cache: Map<string, unknown>;
}

export function fileExists(ctx: Ctx, rel: string): boolean {
  return fs.existsSync(path.join(ctx.projectRoot, rel));
}

export function readText(ctx: Ctx, rel: string): string | null {
  const key = `file:${rel}`;
  if (ctx.cache.has(key)) return ctx.cache.get(key) as string | null;
  const abs = path.join(ctx.projectRoot, rel);
  try {
    const t = fs.readFileSync(abs, 'utf8');
    ctx.cache.set(key, t);
    return t;
  } catch {
    ctx.cache.set(key, null);
    return null;
  }
}

export function readJson(ctx: Ctx, rel: string): any {
  const key = `json:${rel}`;
  if (ctx.cache.has(key)) return ctx.cache.get(key);
  const text = readText(ctx, rel);
  if (text === null) {
    ctx.cache.set(key, null);
    return null;
  }
  try {
    const data = JSON.parse(text);
    ctx.cache.set(key, data);
    return data;
  } catch {
    ctx.cache.set(key, null);
    return null;
  }
}

export function readToml(ctx: Ctx, rel: string): any {
  const key = `toml:${rel}`;
  if (ctx.cache.has(key)) return ctx.cache.get(key);
  const text = readText(ctx, rel);
  if (text === null) {
    ctx.cache.set(key, null);
    return null;
  }
  try {
    const data = TOML.parse(text);
    ctx.cache.set(key, data);
    return data;
  } catch {
    ctx.cache.set(key, null);
    return null;
  }
}

export function readYaml(ctx: Ctx, rel: string): any {
  const key = `yaml:${rel}`;
  if (ctx.cache.has(key)) return ctx.cache.get(key);
  const text = readText(ctx, rel);
  if (text === null) {
    ctx.cache.set(key, null);
    return null;
  }
  try {
    const data = YAML.load(text);
    ctx.cache.set(key, data);
    return data;
  } catch {
    ctx.cache.set(key, null);
    return null;
  }
}

/** Parse a structured file by extension. Returns parsed object/array or null. */
export function readStructured(ctx: Ctx, rel: string): any {
  const lower = rel.toLowerCase();
  if (lower.endsWith('.json')) return readJson(ctx, rel);
  if (lower.endsWith('.toml')) return readToml(ctx, rel);
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return readYaml(ctx, rel);
  return null;
}

/**
 * Resolve a dot-notation path inside a parsed config object.
 * Supports plain dots only — array indices and bracket notation are not used by
 * the current rubric. Returns `undefined` if any segment is missing.
 */
export function resolveConfigPath(root: unknown, jsonpath: string): unknown {
  if (root === null || root === undefined) return undefined;
  const parts = jsonpath.split('.');
  let cur: any = root;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Aggregated task names from mise.toml, composer scripts, npm scripts, Makefile. */
export function listAllTasks(ctx: Ctx): Set<string> {
  const key = 'tasks:all';
  if (ctx.cache.has(key)) return ctx.cache.get(key) as Set<string>;
  const tasks = new Set<string>();

  const miseT = readToml(ctx, 'mise.toml');
  if (miseT?.tasks && typeof miseT.tasks === 'object') {
    for (const k of Object.keys(miseT.tasks as object)) tasks.add(k);
  }

  const composer = readJson(ctx, 'composer.json');
  if (composer?.scripts && typeof composer.scripts === 'object') {
    for (const k of Object.keys(composer.scripts)) tasks.add(k);
  }

  const pkg = readJson(ctx, 'package.json');
  if (pkg?.scripts && typeof pkg.scripts === 'object') {
    for (const k of Object.keys(pkg.scripts)) tasks.add(k);
  }

  // monorepo-ish fallback: server/package.json (см. bookmap)
  const serverPkg = readJson(ctx, 'server/package.json');
  if (serverPkg?.scripts && typeof serverPkg.scripts === 'object') {
    for (const k of Object.keys(serverPkg.scripts)) tasks.add(`server:${k}`);
  }

  const make = readText(ctx, 'Makefile');
  if (make) {
    const lines = make.split('\n');
    for (const line of lines) {
      const m = line.match(/^([a-zA-Z0-9_.\-:]+)\s*:[^=]/);
      if (m && m[1] && !m[1].startsWith('.')) tasks.add(m[1]);
    }
  }

  ctx.cache.set(key, tasks);
  return tasks;
}

export function isPackagePresent(name: string, ecosystem: string, ctx: Ctx): boolean {
  const eco = ecosystem ?? 'any';
  if (eco === 'any' || eco === 'composer') {
    const composer = readJson(ctx, 'composer.json');
    if (composer) {
      if (composer.require?.[name]) return true;
      if (composer['require-dev']?.[name]) return true;
    }
  }
  if (eco === 'any' || eco === 'npm') {
    for (const rel of ['package.json', 'server/package.json']) {
      const pkg = readJson(ctx, rel);
      if (pkg) {
        if (pkg.dependencies?.[name]) return true;
        if (pkg.devDependencies?.[name]) return true;
      }
    }
  }
  return false;
}

export function expandPaths(paths: string[], ctx: Ctx): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (p.includes('*')) {
      const m = p.match(/^([^*]+)\/\*\.(.+)$/);
      if (m && m[1] && m[2]) {
        const dir = m[1];
        const ext = m[2];
        const abs = path.join(ctx.projectRoot, dir);
        try {
          const files = fs.readdirSync(abs);
          for (const f of files) {
            if (f.endsWith('.' + ext)) out.push(path.join(dir, f));
          }
        } catch {
          /* dir missing — silent */
        }
      }
    } else {
      out.push(p);
    }
  }
  return out;
}

export function readTsconfig(ctx: Ctx): any {
  let cfg = readJson(ctx, 'tsconfig.json');
  if (!cfg) cfg = readJson(ctx, 'server/tsconfig.json');
  if (!cfg) return null;
  // basic one-level `extends` resolution
  if (cfg.extends && typeof cfg.extends === 'string' && cfg.extends.startsWith('.')) {
    const baseRel = cfg.extends.endsWith('.json') ? cfg.extends : `${cfg.extends}.json`;
    const base = readJson(ctx, baseRel);
    if (base?.compilerOptions) {
      cfg.compilerOptions = { ...base.compilerOptions, ...(cfg.compilerOptions ?? {}) };
    }
  }
  return cfg;
}

export function autoDetectStack(projectRoot: string): string {
  const has = (p: string) => fs.existsSync(path.join(projectRoot, p));
  if (has('composer.json')) return 'php';
  if (has('package.json')) return 'node';
  if (has('go.mod')) return 'go';
  if (has('pyproject.toml') || has('requirements.txt')) return 'python';
  return 'unknown';
}
