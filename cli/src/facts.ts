import * as fs from 'node:fs';
import * as path from 'node:path';
import * as TOML from 'smol-toml';
import * as YAML from 'js-yaml';
import { at, dict, str } from './narrow.ts';

export interface Ctx {
  projectRoot: string;
  stack: string;
  cache: Map<string, unknown>;
  /**
   * Meta repo: the other half, where a file missing here is looked for — the repo root
   * for an axis evaluated in the primary subpackage (`.github/` lives there), the
   * subpackage for an axis evaluated in a root without a stack manifest of its own.
   */
  fallbackRoot?: string;
}

/** Names in `dir`, read once per context; none when it cannot be read. */
function entries(ctx: Ctx, dir: string): string[] {
  const key = `dir:${dir}`;
  let names = ctx.cache.get(key) as string[] | undefined;
  if (!names) {
    try {
      names = fs.readdirSync(dir);
    } catch {
      names = [];
    }
    ctx.cache.set(key, names);
  }
  return names;
}

/**
 * `rel` under `root`, each segment in the case it is written. APFS and NTFS find a file
 * under any case and ext4 does not: `tests/Fixtures` was there on a Mac that has only
 * `tests/fixtures`, and the same project got another level on Linux.
 */
function existsAsWritten(ctx: Ctx, root: string, rel: string): boolean {
  let dir = root;
  for (const name of path.normalize(rel).split(path.sep)) {
    if (name === '' || name === '.') continue;
    if (name !== '..' && !entries(ctx, dir).includes(name)) return false;
    dir = path.join(dir, name);
  }
  return fs.existsSync(dir);
}

/** Absolute path of `rel`: here, else in `fallbackRoot`; null when in neither. */
function locate(ctx: Ctx, rel: string): string | null {
  if (existsAsWritten(ctx, ctx.projectRoot, rel)) return path.join(ctx.projectRoot, rel);
  if (ctx.fallbackRoot !== undefined && existsAsWritten(ctx, ctx.fallbackRoot, rel)) {
    return path.join(ctx.fallbackRoot, rel);
  }
  return null;
}

/** The same directory without the fallback: a project's tasks are the ones its own runner sees. */
function ownCtx(ctx: Ctx): Ctx {
  if (ctx.fallbackRoot === undefined) return ctx;
  let own = ctx.cache.get('ctx:own') as Ctx | undefined;
  if (!own) {
    own = { projectRoot: ctx.projectRoot, stack: ctx.stack, cache: new Map() };
    ctx.cache.set('ctx:own', own);
  }
  return own;
}

export function fileExists(ctx: Ctx, rel: string): boolean {
  return locate(ctx, rel) !== null;
}

export function readText(ctx: Ctx, rel: string): string | null {
  const key = `file:${rel}`;
  if (ctx.cache.has(key)) return ctx.cache.get(key) as string | null;
  const abs = locate(ctx, rel);
  if (abs === null) {
    ctx.cache.set(key, null);
    return null;
  }
  try {
    const t = fs.readFileSync(abs, 'utf8');
    ctx.cache.set(key, t);
    return t;
  } catch {
    ctx.cache.set(key, null);
    return null;
  }
}

export function readJson(ctx: Ctx, rel: string): unknown {
  const key = `json:${rel}`;
  if (ctx.cache.has(key)) return ctx.cache.get(key);
  const text = readText(ctx, rel);
  if (text === null) {
    ctx.cache.set(key, null);
    return null;
  }
  try {
    const data: unknown = JSON.parse(text);
    ctx.cache.set(key, data);
    return data;
  } catch {
    ctx.cache.set(key, null);
    return null;
  }
}

export function readToml(ctx: Ctx, rel: string): unknown {
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

function readYaml(ctx: Ctx, rel: string): unknown {
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
export function readStructured(ctx: Ctx, rel: string): unknown {
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
  return at(root, ...jsonpath.split('.'));
}

/**
 * Aggregated task names from mise.toml, composer scripts, npm scripts, Makefile.
 * Without the fallback: `vdx test` here runs this directory's tasks, not the other half's.
 */
export function listAllTasks(ctx: Ctx): Set<string> {
  const key = 'tasks:all';
  if (ctx.cache.has(key)) return ctx.cache.get(key) as Set<string>;
  const tasks = new Set<string>();
  const own = ownCtx(ctx);

  for (const k of Object.keys(dict(at(readToml(own, 'mise.toml'), 'tasks')) ?? {})) tasks.add(k);
  for (const k of Object.keys(dict(at(readJson(own, 'composer.json'), 'scripts')) ?? {})) tasks.add(k);
  for (const k of Object.keys(dict(at(readJson(own, 'package.json'), 'scripts')) ?? {})) tasks.add(k);
  // monorepo-ish fallback: server/package.json (см. bookmap)
  for (const k of Object.keys(dict(at(readJson(own, 'server/package.json'), 'scripts')) ?? {})) {
    tasks.add(`server:${k}`);
  }

  const make = readText(own, 'Makefile');
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
    if (at(composer, 'require', name)) return true;
    if (at(composer, 'require-dev', name)) return true;
  }
  if (eco === 'any' || eco === 'npm') {
    for (const rel of ['package.json', 'server/package.json']) {
      const pkg = readJson(ctx, rel);
      if (at(pkg, 'dependencies', name)) return true;
      if (at(pkg, 'devDependencies', name)) return true;
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
        const abs = locate(ctx, dir);
        // A missing dir lists nothing.
        for (const f of abs === null ? [] : entries(ctx, abs)) {
          if (f.endsWith('.' + ext)) out.push(path.join(dir, f));
        }
      }
    } else {
      out.push(p);
    }
  }
  return out;
}

export function readTsconfig(ctx: Ctx): { compilerOptions?: Record<string, unknown> } | null {
  const cfg = dict(readJson(ctx, 'tsconfig.json')) ?? dict(readJson(ctx, 'server/tsconfig.json'));
  if (!cfg) return null;
  const own = dict(cfg['compilerOptions']);
  // basic one-level `extends` resolution
  const ext = str(cfg['extends']);
  if (ext?.startsWith('.')) {
    const base = dict(at(readJson(ctx, ext.endsWith('.json') ? ext : `${ext}.json`), 'compilerOptions'));
    if (base) return { compilerOptions: { ...base, ...own } };
  }
  return own ? { compilerOptions: own } : {};
}

const MANIFEST_TO_STACK: Array<[string, string]> = [
  ['composer.json', 'php'],
  ['package.json', 'node'],
  ['go.mod', 'go'],
  ['pyproject.toml', 'python'],
  ['requirements.txt', 'python'],
];

export function stackForDir(dir: string): string | null {
  for (const [manifest, stack] of MANIFEST_TO_STACK) {
    if (fs.existsSync(path.join(dir, manifest))) return stack;
  }
  return null;
}

const SUBPACKAGE_SCAN_IGNORE = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  '.git',
  '.next',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  'coverage',
]);

export interface SubPackage {
  relPath: string;
  stack: string;
}

export function findSubPackages(projectRoot: string): SubPackage[] {
  const found: SubPackage[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectRoot, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (SUBPACKAGE_SCAN_IGNORE.has(entry.name)) continue;
    const stack = stackForDir(path.join(projectRoot, entry.name));
    if (stack) found.push({ relPath: entry.name, stack });
  }
  return found;
}

export function autoDetectStack(projectRoot: string): string {
  const rootStack = stackForDir(projectRoot);
  if (rootStack) return rootStack;
  const subs = findSubPackages(projectRoot);
  if (subs.length === 0) return 'unknown';
  const stacks = new Set(subs.map((s) => s.stack));
  if (stacks.size === 1) return subs[0]!.stack;
  return 'monorepo';
}
