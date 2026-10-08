/**
 * One recognizer of git-hook frameworks for both surfaces: `vdx audit` asks it
 * whether the repository installs its hooks itself (a property of the repo),
 * `vdx doctor` asks whether every declared hook runs in this clone (a property
 * of the clone). Two separate recognizers would drift apart — the very class
 * of defect this exists to remove.
 *
 * Per framework: where hooks are declared, which install step switches them
 * on, and where they land — `core.hooksPath` (husky, .githooks) or the git
 * hooks directory (lefthook, simple-git-hooks, cghooks; the last two copy the
 * commands there, so the copy can go stale).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'js-yaml';
import { fileExists, isPackagePresent, readJson, readText, readToml, type Ctx } from './facts.ts';

export type FrameworkId = 'husky' | 'lefthook' | 'simple-git-hooks' | 'cghooks' | 'githooks';

export interface HookFramework {
  id: FrameworkId;
  /** Where the hooks are declared, for messages: `.husky/`, `composer.json extra.hooks`. */
  declaredIn: string;
  /** Hook event → the commands it runs, as declared. */
  hooks: Map<string, string[]>;
  /** The install step that switches the hooks on by itself, or null. */
  installedBy: string | null;
  /** What turns them on by hand in a clone. */
  manualInstall: string;
  /** `core.hooksPath` the framework sets; null — it writes into the git hooks directory. */
  hooksPath: string | null;
  /** The framework copies commands into the installed hook, so a copy can be older than the config. */
  copies: boolean;
}

export const GIT_HOOK_EVENTS = new Set([
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit',
  'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge',
  'pre-push', 'pre-auto-gc', 'post-rewrite', 'reference-transaction', 'push-to-checkout',
  'post-index-change', 'sendemail-validate', 'fsmonitor-watchman', 'p4-changelist',
  'p4-prepare-changelist', 'p4-post-changelist', 'p4-pre-submit',
]);

/** Install steps a clone runs anyway: npm-family lifecycle scripts, composer's, the vdx `up` task. */
interface InstallStep {
  where: string;
  text: string;
}

/** Yarn 2+ does not run a project's `prepare` (husky docs, How To → Yarn). */
export function yarnBerry(ctx: Ctx): boolean {
  const pm = readJson(ctx, 'package.json')?.packageManager;
  if (typeof pm === 'string') {
    const m = pm.match(/^yarn@(\d+)/);
    if (m) return parseInt(m[1]!, 10) >= 2;
  }
  return fileExists(ctx, '.yarnrc.yml');
}

function installSteps(ctx: Ctx): InstallStep[] {
  const out: InstallStep[] = [];
  const pkg = readJson(ctx, 'package.json');
  const scripts = pkg?.scripts ?? {};
  const npmHooks = yarnBerry(ctx) ? ['postinstall'] : ['prepare', 'postinstall'];
  for (const name of npmHooks) {
    if (typeof scripts[name] === 'string') {
      out.push({ where: `package.json ${name}`, text: expandNpm(scripts, scripts[name]) });
    }
  }
  const composer = readJson(ctx, 'composer.json');
  const cmd = composer?.scripts?.['post-install-cmd'];
  if (cmd !== undefined) {
    out.push({ where: 'composer post-install-cmd', text: expandComposer(composer.scripts, cmd) });
  }
  const up = readToml(ctx, 'mise.toml')?.tasks?.up;
  if (up && typeof up === 'object') {
    const runs = (Array.isArray(up.run) ? up.run : [up.run]).filter((r: unknown) => typeof r === 'string');
    if (runs.length > 0) out.push({ where: 'mise task up', text: runs.join('\n') });
  }
  return out;
}

/** `npm run x` inside an npm script, one level at a time, cycle-safe. */
function expandNpm(scripts: Record<string, unknown>, text: string, seen = new Set<string>()): string {
  return text.replace(/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:.-]+)/g, (whole, name: string) => {
    const body = scripts[name];
    if (typeof body !== 'string' || seen.has(name)) return whole;
    seen.add(name);
    return `${whole}\n${expandNpm(scripts, body, seen)}`;
  });
}

/** Composer `@name` references, recursively. */
function expandComposer(scripts: Record<string, unknown>, entry: unknown, seen = new Set<string>()): string {
  const list = Array.isArray(entry) ? entry : [entry];
  const out: string[] = [];
  for (const e of list) {
    if (typeof e !== 'string') continue;
    out.push(e);
    if (e.startsWith('@')) {
      const ref = e.slice(1).split(/\s+/)[0]!;
      if (!seen.has(ref) && scripts[ref] !== undefined) {
        seen.add(ref);
        out.push(expandComposer(scripts, scripts[ref], seen));
      }
    }
  }
  return out.join('\n');
}

function findStep(steps: InstallStep[], re: RegExp): string | null {
  return steps.find((s) => re.test(s.text))?.where ?? null;
}

/** Hook scripts in a directory: file name = event; the body is the command. */
function hooksFromDir(ctx: Ctx, dir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.join(ctx.projectRoot, dir));
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    if (!GIT_HOOK_EVENTS.has(name)) continue;
    const body = readText(ctx, path.join(dir, name));
    if (body !== null) out.set(name, [scriptBody(body)]);
  }
  return out;
}

/** A hook script without its shebang, comments and husky's own sourcing line. */
function scriptBody(text: string): string {
  return text
    .split('\n')
    .filter((l) => {
      const s = l.trim();
      return s !== '' && !s.startsWith('#') && !/husky\.sh/.test(s);
    })
    .join('\n');
}

function lefthookRuns(node: unknown): string[] {
  const out: string[] = [];
  if (!node || typeof node !== 'object') return out;
  const o = node as Record<string, any>;
  if (typeof o.run === 'string') out.push(o.run);
  if (typeof o.runner === 'string') out.push(o.runner);
  for (const key of ['commands', 'scripts']) {
    if (o[key] && typeof o[key] === 'object') for (const v of Object.values(o[key])) out.push(...lefthookRuns(v));
  }
  if (Array.isArray(o.jobs)) for (const j of o.jobs) out.push(...lefthookRuns(j));
  if (o.group && typeof o.group === 'object') out.push(...lefthookRuns(o.group));
  return out;
}

const LEFTHOOK_FILES = ['lefthook.yml', '.lefthook.yml', 'lefthook.yaml', '.lefthook.yaml'];

/** Every framework this repository declares hooks with; empty — it declares none. */
export function detectHookFrameworks(ctx: Ctx): HookFramework[] {
  const key = 'hooks:frameworks';
  if (ctx.cache.has(key)) return ctx.cache.get(key) as HookFramework[];
  const steps = installSteps(ctx);
  const pkg = readJson(ctx, 'package.json');
  const composer = readJson(ctx, 'composer.json');
  const out: HookFramework[] = [];

  const husky = hooksFromDir(ctx, '.husky');
  if (husky.size > 0) {
    out.push({
      id: 'husky',
      declaredIn: '.husky/',
      hooks: husky,
      installedBy: findStep(steps.filter((s) => s.where.startsWith('package.json') || s.where === 'mise task up'), /(^|[\s;&|(])husky(\s+install)?(?=$|[\s;&|)])/m),
      manualInstall: 'npx husky',
      hooksPath: '.husky/_',
      copies: false,
    });
  }

  for (const file of LEFTHOOK_FILES) {
    const text = readText(ctx, file);
    if (text === null) continue;
    let data: any;
    try {
      data = YAML.load(text);
    } catch {
      continue;
    }
    const hooks = new Map<string, string[]>();
    for (const [event, def] of Object.entries((data ?? {}) as Record<string, unknown>)) {
      if (GIT_HOOK_EVENTS.has(event)) hooks.set(event, lefthookRuns(def));
    }
    if (hooks.size === 0) continue;
    const viaPackage =
      isPackagePresent('lefthook', 'npm', ctx) || isPackagePresent('@evilmartians/lefthook', 'npm', ctx)
        ? 'lefthook package (its postinstall)'
        : null;
    out.push({
      id: 'lefthook',
      declaredIn: file,
      hooks,
      installedBy: viaPackage ?? findStep(steps, /\blefthook\s+install\b/),
      manualInstall: 'lefthook install',
      hooksPath: null,
      copies: false,
    });
    break;
  }

  const sgh =
    (pkg?.['simple-git-hooks'] as Record<string, unknown> | undefined) ??
    readJson(ctx, '.simple-git-hooks.json') ??
    readJson(ctx, 'simple-git-hooks.json');
  if (sgh && typeof sgh === 'object') {
    const hooks = new Map<string, string[]>();
    for (const [event, cmd] of Object.entries(sgh)) {
      if (GIT_HOOK_EVENTS.has(event) && typeof cmd === 'string') hooks.set(event, [cmd]);
    }
    if (hooks.size > 0) {
      out.push({
        id: 'simple-git-hooks',
        declaredIn: pkg?.['simple-git-hooks'] ? 'package.json simple-git-hooks' : 'simple-git-hooks.json',
        hooks,
        installedBy: isPackagePresent('simple-git-hooks', 'npm', ctx)
          ? 'simple-git-hooks package (its postinstall)'
          : findStep(steps, /\bsimple-git-hooks\b/),
        manualInstall: 'npx simple-git-hooks',
        hooksPath: null,
        copies: true,
      });
    }
  }

  const extra = composer?.extra?.hooks;
  if (extra && typeof extra === 'object') {
    const hooks = new Map<string, string[]>();
    for (const [event, cmd] of Object.entries(extra as Record<string, unknown>)) {
      if (!GIT_HOOK_EVENTS.has(event)) continue;
      const list = (Array.isArray(cmd) ? cmd : [cmd]).filter((c): c is string => typeof c === 'string');
      if (list.length > 0) hooks.set(event, list);
    }
    if (hooks.size > 0) {
      out.push({
        id: 'cghooks',
        declaredIn: 'composer.json extra.hooks',
        hooks,
        installedBy: findStep(steps.filter((s) => s.where.startsWith('composer') || s.where === 'mise task up'), /\bcghooks\s+(add|update)\b/),
        manualInstall: 'vendor/bin/cghooks update',
        hooksPath: null,
        copies: true,
      });
    }
  }

  const githooks = hooksFromDir(ctx, '.githooks');
  if (githooks.size > 0) {
    out.push({
      id: 'githooks',
      declaredIn: '.githooks/',
      hooks: githooks,
      installedBy: findStep(steps, /git\s+config\s+(--local\s+)?core\.hooksPath\s+["']?\.?\/?\.githooks/),
      manualInstall: 'git config core.hooksPath .githooks',
      hooksPath: '.githooks',
      copies: false,
    });
  }

  ctx.cache.set(key, out);
  return out;
}

/** What a clone runs to switch hooks on: the install step of the project's package manager. */
export function installCommand(fw: HookFramework, ctx: Ctx): string {
  if (fw.installedBy === null) return fw.manualInstall;
  if (fw.installedBy.startsWith('composer')) return 'composer install';
  if (fw.installedBy === 'mise task up') return 'vdx up';
  const pm = readJson(ctx, 'package.json')?.packageManager;
  if (typeof pm === 'string' && pm.startsWith('pnpm')) return 'pnpm install';
  if ((typeof pm === 'string' && pm.startsWith('yarn')) || fileExists(ctx, 'yarn.lock')) return 'yarn install';
  if (fileExists(ctx, 'pnpm-lock.yaml')) return 'pnpm install';
  return 'npm install';
}

// ---------------------------------------------------------------------------
// The clone: does each declared hook run here?
// ---------------------------------------------------------------------------

export interface CloneHookState {
  framework: HookFramework;
  /** Every declared hook is where git takes hooks from, executable and current. */
  enabled: boolean;
  /** Why not, when not. */
  problem?: string;
  /** How to switch them on. */
  remedy?: string;
}

function gitOut(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** The directory git takes hooks from in this clone — `core.hooksPath` or `.git/hooks`. */
export function effectiveHooksDir(root: string): string | null {
  const p = gitOut(root, ['rev-parse', '--git-path', 'hooks']);
  if (p === null || p === '') return null;
  return path.resolve(root, p);
}

function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function cloneHookStates(root: string, ctx: Ctx, frameworks: HookFramework[]): CloneHookState[] {
  const dir = effectiveHooksDir(root);
  const hooksPath = gitOut(root, ['config', '--get', 'core.hooksPath']) || null;
  return frameworks.map((fw) => {
    const remedy = installCommand(fw, ctx);
    const events = [...fw.hooks.keys()];
    if (dir === null) return { framework: fw, enabled: false, problem: 'git does not answer where hooks live', remedy };
    if (fw.hooksPath !== null) {
      const want = path.resolve(root, fw.hooksPath);
      const legacyHusky = fw.id === 'husky' && path.resolve(root, '.husky') === dir;
      if (dir !== want && !legacyHusky) {
        const now = hooksPath ? `core.hooksPath is ${hooksPath}` : 'core.hooksPath is unset';
        return { framework: fw, enabled: false, problem: `${now}, ${fw.id} needs ${fw.hooksPath}`, remedy };
      }
    }
    const where = path.relative(root, dir) || dir;
    const missing = events.filter((e) => !fs.existsSync(path.join(dir, e)));
    if (missing.length > 0) {
      return { framework: fw, enabled: false, problem: `${missing.join(', ')} not installed in ${where}`, remedy };
    }
    const inert = events.filter((e) => !executable(path.join(dir, e)));
    if (inert.length > 0) {
      return {
        framework: fw,
        enabled: false,
        problem: `${inert.join(', ')} in ${where} not executable — git skips it silently`,
        remedy: `chmod +x ${inert.map((e) => path.join(where, e)).join(' ')}`,
      };
    }
    if (fw.id === 'lefthook') {
      const foreign = events.filter((e) => !/lefthook/.test(readFile(path.join(dir, e))));
      if (foreign.length > 0) return { framework: fw, enabled: false, problem: `${foreign.join(', ')} in ${path.relative(root, dir)} is not lefthook's`, remedy };
    }
    if (fw.copies) {
      const stale = events.filter((e) => {
        const body = readFile(path.join(dir, e));
        return fw.hooks.get(e)!.some((cmd) => !body.includes(cmd.trim()));
      });
      if (stale.length > 0) {
        return { framework: fw, enabled: false, problem: `installed ${stale.join(', ')} older than ${fw.declaredIn}`, remedy };
      }
    }
    return { framework: fw, enabled: true };
  });
}

function readFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// What a hook body depends on outside the repository
// ---------------------------------------------------------------------------

/**
 * Variables a hook body *gates on*: `[ -n "${VAR:-}" ]`, `[ -x "$VAR" ]` and
 * friends. Restricted to test-expression positions on purpose — a bare `$VAR`
 * anywhere in a script says nothing about whether the hook still does its job,
 * while an unset variable inside the guard means the guarded block never runs.
 */
const GATING_VAR_RE =
  /\[\s+-[nxfse]\s+"\$\{([A-Z][A-Z0-9_]*)(?::-[^}]*)?\}"|\[\s+-[nxfse]\s+"\$([A-Z][A-Z0-9_]*)"/g;

export function unsetGatingVars(commands: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const out = new Set<string>();
  for (const body of commands) {
    for (const m of body.matchAll(GATING_VAR_RE)) {
      const name = m[1] ?? m[2];
      if (name && !env[name]) out.add(name);
    }
  }
  return [...out].sort();
}

/**
 * A program a command runs from this machine, outside the repository:
 * `$HOME/…`, `~/…`, `/Users/…` — quoted or bare, at the head of a command.
 * Only what is run: a path in an argument or an `echo` says nothing about
 * whether the hook works here.
 */
const MACHINE_PROGRAM_RE = /^(?:"((?:\$HOME|\$\{HOME\}|~|\/Users|\/home|\/Volumes)\/[^"]+)"|((?:\$HOME|\$\{HOME\}|~|\/Users|\/home|\/Volumes)\/[^\s"';|&)]+))/;

export function missingMachinePaths(commands: string[], home: string = os.homedir()): string[] {
  const out = new Set<string>();
  for (const body of commands) {
    for (const segment of body.split(/&&|\|\||;|\||\n/)) {
      const head = segment.trim().replace(/^(?:[{(!]\s*|(?:exec|then|do|else|command)\s+)+/, '');
      const m = head.match(MACHINE_PROGRAM_RE);
      if (!m) continue;
      const raw = (m[1] ?? m[2])!;
      const abs = raw.replace(/^(\$HOME|\$\{HOME\}|~)(?=\/)/, home);
      if (!fs.existsSync(abs)) out.add(raw);
    }
  }
  return [...out].sort();
}
