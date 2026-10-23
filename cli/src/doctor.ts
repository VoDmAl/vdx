import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { effectiveAuthor, isGitRepo, rankAuthors, remoteParts, scanPool } from './author.ts';
import {
  authorPoolDirs,
  loadEnvironment,
  resolveEnvironmentPath,
  resolveProjectRoot,
  shellQuote,
  type Environment,
} from './ai.ts';
import { checkRepoHooks } from './clone-checks.ts';
import { githubToken, machineIo, type HostingIo } from './hosting.ts';
import {
  describeMemory,
  fixProjectMemory,
  memoryApplies,
  memoryNeedsFix,
  memoryReaders,
  personalHosts,
  memoryState,
  type MemoryCtx,
  type MemoryState,
} from './memory.ts';
import { at, dict, errorMessage, str } from './narrow.ts';
import {
  checkPersonalHooks,
  defaultPersonalHookDeps,
  fixPersonalHooks,
  type PersonalHookDeps,
} from './personal-hooks.ts';

export type CheckStatus = 'ok' | 'warning' | 'missing';

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  level?: number;
  message: string;
  remedy?: string;
  /** For the agent's own session (`--check`): what the fix does not change for it. */
  sessionNote?: string;
}

/**
 * Context a check may consult. Doctor is primarily a machine-level report, but
 * some checks are about the repository it is invoked in (git config of this
 * clone, tracked hook files). `projectRoot` is null when doctor runs outside a
 * project — `vdx doctor` is explicitly usable from anywhere.
 */
export interface DoctorCtx {
  projectRoot: string | null;
}

export interface DoctorReport {
  cliVersion: string;
  checks: CheckResult[];
  ok: number;
  warning: number;
  missing: number;
}

export function readCliVersion(): string {
  try {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return raw.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function probeNpmLatestVersion(pkg: string, timeoutMs = 2000): string | null {
  try {
    const out = execFileSync('npm', ['view', pkg, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10));
  const pb = b.split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

function probeVersion(binary: string, args: string[] = ['--version']): string | null {
  try {
    const out = execFileSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}

function parseSemverMajor(s: string): number | null {
  const m = s.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? parseInt(m[1]!, 10) : null;
}

function checkNode(): CheckResult {
  const v = probeVersion('node', ['--version']);
  if (!v) {
    return {
      id: 'node',
      label: 'Node.js',
      status: 'missing',
      message: 'node binary not on PATH',
      remedy: 'https://nodejs.org/en/download (vdx needs 22 or newer)',
    };
  }
  const major = parseSemverMajor(v);
  if (major === null) {
    return { id: 'node', label: 'Node.js', status: 'warning', message: `unparseable version: ${v}` };
  }
  if (major < 22) {
    return {
      id: 'node',
      label: 'Node.js',
      status: 'warning',
      level: 1,
      message: `${v} — vdx needs 22 or newer (engines in its package.json)`,
      remedy: 'mise use -g node@24 (or upgrade via nvm/brew)',
    };
  }
  return { id: 'node', label: 'Node.js', status: 'ok', level: major >= 24 ? 4 : 3, message: v };
}

function checkGit(): CheckResult {
  const v = probeVersion('git', ['--version']);
  if (!v) {
    return {
      id: 'git',
      label: 'git',
      status: 'missing',
      message: 'git binary not on PATH',
      remedy: 'https://git-scm.com/downloads',
    };
  }
  return { id: 'git', label: 'git', status: 'ok', message: v };
}

function checkMise(): CheckResult {
  const v = probeVersion('mise', ['--version']);
  if (!v) {
    return {
      id: 'mise',
      label: 'mise',
      status: 'missing',
      message: 'mise not on PATH — `vdx <verb>` will fail',
      remedy: 'https://mise.jdx.dev/getting-started.html',
    };
  }
  return { id: 'mise', label: 'mise', status: 'ok', message: v };
}

function checkNpmAuth(): CheckResult {
  try {
    const who = execFileSync('npm', ['whoami'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!who) {
      return {
        id: 'npm-auth',
        label: 'npm auth',
        status: 'warning',
        message: 'npm whoami returned empty',
        remedy: 'npm login',
      };
    }
    return { id: 'npm-auth', label: 'npm auth', status: 'ok', message: `logged in as ${who}` };
  } catch {
    return {
      id: 'npm-auth',
      label: 'npm auth',
      status: 'warning',
      message: 'not logged in — `vdx publish` refuses at pre-flight (npm-auth)',
      remedy: 'npm login',
    };
  }
}

function checkContainerRuntime(): CheckResult {
  const orbV = probeVersion('orb', ['version']);
  if (orbV) {
    return {
      id: 'container-runtime',
      label: 'container runtime',
      status: 'ok',
      level: 4,
      message: `OrbStack: ${orbV.split('\n')[0]}`,
    };
  }
  const dockerV = probeVersion('docker', ['--version']);
  if (dockerV) {
    return {
      id: 'container-runtime',
      label: 'container runtime',
      status: 'ok',
      level: 3,
      message: `Docker: ${dockerV} (OrbStack recommended on macOS)`,
      remedy: 'https://orbstack.dev (optional upgrade)',
    };
  }
  return {
    id: 'container-runtime',
    label: 'container runtime',
    status: 'missing',
    message: 'no docker/orbstack — `vdx up` of containerised projects will fail',
    remedy: 'https://orbstack.dev (macOS) or https://docker.com',
  };
}

function findOnPath(name: string): string | null {
  const PATH = process.env.PATH ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function isEphemeralPath(p: string): 'npx-cache' | 'local-bin' | null {
  if (p.includes(`${path.sep}.npm${path.sep}_npx${path.sep}`)) return 'npx-cache';
  if (p.includes(`${path.sep}node_modules${path.sep}.bin${path.sep}`)) return 'local-bin';
  return null;
}

function checkVdxVersion(): CheckResult {
  const current = readCliVersion();
  const latest = probeNpmLatestVersion('@vodmal/vdx-cli');
  if (current === 'unknown') {
    return {
      id: 'vdx-version',
      label: 'vdx version',
      status: 'warning',
      message: 'cannot read local cli package.json version',
    };
  }
  if (!latest) {
    return {
      id: 'vdx-version',
      label: 'vdx version',
      status: 'ok',
      level: 3,
      message: `${current} (latest check skipped — offline or npm timeout)`,
    };
  }
  const cmp = compareSemver(current, latest);
  if (cmp < 0) {
    return {
      id: 'vdx-version',
      label: 'vdx version',
      status: 'warning',
      level: 2,
      message: `${current} → latest ${latest}`,
      remedy: 'npm i -g @vodmal/vdx-cli@latest (or clear npx cache)',
    };
  }
  if (cmp > 0) {
    return {
      id: 'vdx-version',
      label: 'vdx version',
      status: 'ok',
      level: 4,
      message: `${current} (ahead of npm latest ${latest} — local dev build)`,
    };
  }
  return {
    id: 'vdx-version',
    label: 'vdx version',
    status: 'ok',
    level: 4,
    message: `${current} (latest)`,
  };
}

function classifyVdxInstall(found: string): { mode: 'global' | 'npx-cache' | 'local-bin'; level: number; tag: string } {
  const ephemeral = isEphemeralPath(found);
  if (ephemeral === 'npx-cache') return { mode: 'npx-cache', level: 3, tag: 'npx cache (ephemeral)' };
  if (ephemeral === 'local-bin') return { mode: 'local-bin', level: 2, tag: 'project node_modules' };
  return { mode: 'global', level: 4, tag: 'global' };
}

function checkVdx(): CheckResult {
  const found = findOnPath('vdx');
  if (!found) {
    return {
      id: 'vdx',
      label: 'vdx',
      status: 'warning',
      level: 1,
      message: 'not on PATH (alias may still work — doctor cannot detect aliases)',
      remedy: 'npm i -g @vodmal/vdx-cli  OR  alias vdx="npx -y -p @vodmal/vdx-cli vdx"',
    };
  }
  const { mode, level, tag } = classifyVdxInstall(found);
  if (mode === 'global') {
    return {
      id: 'vdx',
      label: 'vdx',
      status: 'ok',
      level,
      message: `${tag} — resolves in any shell (${found})`,
    };
  }
  if (mode === 'npx-cache') {
    return {
      id: 'vdx',
      label: 'vdx',
      status: 'ok',
      level,
      message: `${tag} — \`npx -y -p @vodmal/vdx-cli vdx …\` works; bare \`vdx\` in a fresh shell does not`,
      remedy:
        'npm i -g @vodmal/vdx-cli  OR  add `alias vdx="npx -y -p @vodmal/vdx-cli vdx"` to your shell rc (~/.zshrc / ~/.bashrc)',
    };
  }
  return {
    id: 'vdx',
    label: 'vdx',
    status: 'ok',
    level,
    message: `${tag} — works inside this project only (${found})`,
    remedy: 'npm i -g @vodmal/vdx-cli  OR  add `alias vdx="npx -y -p @vodmal/vdx-cli vdx"` to your shell rc',
  };
}

function checkClaudeCode(): CheckResult {
  const found = findOnPath('claude');
  if (!found) {
    return {
      id: 'claude-code',
      label: 'Claude Code',
      status: 'warning',
      message: '`claude` CLI not on PATH',
      remedy: 'https://docs.claude.com/en/docs/claude-code',
    };
  }
  const v = probeVersion('claude', ['--version']);
  return {
    id: 'claude-code',
    label: 'Claude Code',
    status: 'ok',
    level: 4,
    message: v ?? `installed (${found})`,
  };
}

const PLUGIN_INSTALL_HINT =
  'in Claude Code: /plugin marketplace add VoDmAl/ai-dev-plugins, then /plugin install vdx from it';

/**
 * The vdx plugin as Claude Code records it: `vdx@<marketplace>` in
 * plugins/installed_plugins.json, and not switched off in settings.json
 * enabledPlugins. Whichever marketplace brought it — the plugin ships through
 * the owner's marketplace (VoDmAl/ai-dev-plugins), not a vdx one of its own.
 */
export function checkClaudeCodePlugin(
  claudeDir: string = process.env['CLAUDE_CONFIG_DIR'] || path.join(os.homedir(), '.claude'),
): CheckResult {
  const base = { id: 'claude-plugin', label: 'Claude Code vdx plugin' };
  const readJson = (file: string): unknown => {
    try {
      return JSON.parse(fs.readFileSync(path.join(claudeDir, file), 'utf8'));
    } catch {
      return null;
    }
  };
  const installed = readJson(path.join('plugins', 'installed_plugins.json'));
  if (!installed) {
    return {
      ...base,
      status: 'warning',
      message: `no plugin records in ${claudeDir}/plugins/installed_plugins.json`,
      remedy: PLUGIN_INSTALL_HINT,
    };
  }
  const key = Object.keys(dict(at(installed, 'plugins')) ?? {}).find((k) => k.startsWith('vdx@'));
  if (!key) {
    return { ...base, status: 'warning', message: 'not installed', remedy: PLUGIN_INSTALL_HINT };
  }
  const version = at(installed, 'plugins', key, '0', 'version');
  const label = `${key}${typeof version === 'string' ? ` ${version}` : ''}`;
  if (at(readJson('settings.json'), 'enabledPlugins', key) === false) {
    return { ...base, status: 'warning', message: `${label} installed but disabled`, remedy: `/plugin enable ${key}` };
  }
  return { ...base, status: 'ok', message: label };
}

/**
 * The project's commit author. With `user.useConfigOnly` git refuses to commit
 * in a repo that has none; the remedy names the likely one, as `vdx ai` does.
 */
export function checkGitAuthor(ctx: DoctorCtx): CheckResult | null {
  const root = ctx.projectRoot;
  if (root === null || !isGitRepo(root)) return null;
  const id = 'git-author';
  const label = 'git author';
  const current = effectiveAuthor(root);
  if (current) return { id, label, status: 'ok', message: `${current.email} (${current.scope})` };

  let environment: Environment = {};
  const profilePath = resolveEnvironmentPath();
  try {
    if (profilePath) environment = loadEnvironment(profilePath);
  } catch {
    /* a broken profile is vdx ai's report; the parent directory still gives neighbours */
  }
  const home = os.homedir();
  const dirs = authorPoolDirs(environment, root, home, profilePath ? path.dirname(profilePath) : home);
  const top = rankAuthors(root, scanPool(dirs))[0];
  const q = shellQuote(root);
  return {
    id,
    label,
    status: 'warning',
    message: `no author of its own — git refuses to commit here${top ? `; likely ${top.email}` : ''}`,
    remedy: top
      ? `git -C ${q} config --local user.name ${shellQuote(top.name)} && git -C ${q} config --local user.email ${shellQuote(top.email)}`
      : `git -C ${q} config --local user.email <address>`,
  };
}

/**
 * The token vdx asks GitHub with, for a repository whose origin is there — the audit
 * (`branch-protection`) and `vdx push` ask. Without one GitHub answers 60 requests an
 * hour; a token that no longer works is worse than none: every answer is a 401.
 * `/rate_limit` tells both apart and costs nothing of the limit.
 */
export function checkGithubToken(
  ctx: DoctorCtx,
  io: HostingIo | null = ctx.projectRoot ? machineIo(ctx.projectRoot) : null,
  ghOnPath: boolean = findOnPath('gh') !== null,
  platform: NodeJS.Platform = process.platform,
): CheckResult | null {
  if (ctx.projectRoot === null || io === null) return null;
  const url = io.git(['remote', 'get-url', 'origin']);
  if (!url || remoteParts(url).host !== 'github.com') return null;
  const id = 'github-token';
  const label = 'GitHub token';
  if (io.env.VDX_OFFLINE) return { id, label, status: 'ok', message: 'VDX_OFFLINE is set — vdx does not ask GitHub' };
  const t = githubToken(io);
  let status: number;
  let body: unknown;
  try {
    ({ status, body } = io.get('/rate_limit', t?.token ?? null));
  } catch (e) {
    return { id, label, status: 'warning', message: `GitHub did not answer: ${errorMessage(e)}` };
  }
  if (status === 401 && t) {
    return {
      id,
      label,
      status: 'warning',
      message: `the token from ${t.source} does not work (GitHub: ${str(at(body, 'message')) ?? '401'}) — every answer is a 401`,
      remedy: t.source === 'gh' ? 'gh auth login -h github.com' : `a working ${t.source}, or unset it`,
    };
  }
  if (status !== 200) return { id, label, status: 'warning', message: `GitHub answered ${status} for /rate_limit` };
  const limit = at(body, 'resources', 'core', 'limit');
  const left = at(body, 'resources', 'core', 'remaining');
  const hour = typeof limit === 'number' ? `${limit} requests an hour` : 'its limit';
  const remaining = typeof left === 'number' ? `, ${left} left` : '';
  if (t) return { id, label, status: 'ok', message: `from ${t.source}: ${hour}${remaining}` };
  return {
    id,
    label,
    status: 'warning',
    message: `none — GitHub answers ${hour} without one${remaining}; an audit takes about 3, vdx push about 10`,
    remedy: !ghOnPath
      ? 'install gh (https://cli.github.com) and gh auth login, or set GH_TOKEN'
      : io.env.SSH_CONNECTION && platform === 'darwin'
        ? // m3, 2026-10-19: logged in, and `ssh m3 gh` saw no token, while tmux there did.
          'over ssh gh cannot read the macOS keychain where it keeps the token — in a local terminal or tmux it can; else gh auth login -h github.com'
        : 'gh auth login -h github.com',
  };
}

/** The profile, or none: a broken one is `vdx ai`'s report, not a reason for doctor to stop. */
function profile(): Environment {
  const file = resolveEnvironmentPath();
  try {
    return file ? loadEnvironment(file) : {};
  } catch {
    return {};
  }
}

/** Claude Code is the project's agent: the profile names it, or names no agent at all. */
function claudeIsTheAgent(environment: Environment): boolean {
  return path.basename(environment.agent?.command ?? 'claude') === 'claude';
}

function memoryCtx(): MemoryCtx {
  return { env: process.env, home: os.homedir() };
}

/**
 * Where Claude Code keeps the project's memory (claude-memory-in-project): inside the
 * project, `.claude/memory/`, so a moved folder takes it along — and the path set there
 * is the trace a move leaves.
 */
export function checkClaudeMemory(
  ctx: DoctorCtx,
  environment: Environment = profile(),
  mctx: MemoryCtx = memoryCtx(),
): CheckResult | null {
  if (ctx.projectRoot === null || !claudeIsTheAgent(environment)) return null;
  // Claude Code's slot is the folder the agent starts in — the checkout's top for vdx ai.
  const root = resolveProjectRoot(ctx.projectRoot) ?? ctx.projectRoot;
  if (!memoryApplies(root, mctx)) return null;
  const state = memoryState(root, mctx);
  return {
    id: 'claude-memory',
    label: 'Claude memory',
    status: memoryNeedsFix(state) ? 'warning' : 'ok',
    message: describeMemory(state, mctx),
    ...(memoryNeedsFix(state) ? { remedy: `vdx doctor --fix ${shellQuote(root)}` } : {}),
    // A session read the place when it started: after a fix it keeps writing to the old one.
    ...(state.kind === 'outside' || state.kind === 'moved' || state.kind === 'elsewhere'
      ? { sessionNote: 'This session keeps the old place until it restarts (vdx ai --restart).' }
      : {}),
  };
}

const CHECKS: Array<(ctx: DoctorCtx) => CheckResult | null> = [
  checkVdxVersion,
  checkVdx,
  checkClaudeCode,
  () => checkClaudeCodePlugin(),
  checkNode,
  checkGit,
  checkMise,
  checkNpmAuth,
  checkContainerRuntime,
  (ctx) => checkRepoHooks(ctx.projectRoot),
  (ctx) => checkPersonalHooks(ctx.projectRoot),
  checkGitAuthor,
  (ctx) => checkGithubToken(ctx),
  (ctx) => checkClaudeMemory(ctx),
];

/**
 * The project doctor looks at: a directory named on the command line is one, whatever it
 * holds — a folder of notes or of other repos has Claude Code memory too (avatar,
 * l10inc, 2026-10-23); the working directory only with a project's marker file.
 */
export function resolveDoctorCtx(cwd: string = process.cwd(), named = false): DoctorCtx {
  if (named) {
    try {
      if (fs.statSync(cwd).isDirectory()) return { projectRoot: cwd };
    } catch {
      /* no such directory: no project */
    }
  }
  return { projectRoot: looksLikeProject(cwd) ? cwd : null };
}

export function runDoctor(ctx: DoctorCtx = resolveDoctorCtx()): DoctorReport {
  const checks = CHECKS.map((fn) => fn(ctx)).filter((c): c is CheckResult => c !== null);
  const ok = checks.filter((c) => c.status === 'ok').length;
  const warning = checks.filter((c) => c.status === 'warning').length;
  const missing = checks.filter((c) => c.status === 'missing').length;
  return { cliVersion: readCliVersion(), checks, ok, warning, missing };
}

/**
 * For the agent's own session (the vdx plugin's SessionStart hook): one line
 * per hook that is declared but does not run — in this clone, or a personal
 * hook on this machine. Nothing when they are in order; the fix is the user's
 * call, so the line names it rather than applying it.
 */
export function runDoctorCheck(
  ctx: DoctorCtx = resolveDoctorCtx(),
  deps: PersonalHookDeps = defaultPersonalHookDeps(),
  environment: Environment = profile(),
  mctx: MemoryCtx = memoryCtx(),
): string {
  const rows = [
    checkRepoHooks(ctx.projectRoot),
    checkPersonalHooks(ctx.projectRoot, deps),
    checkClaudeMemory(ctx, environment, mctx),
  ].filter((c): c is CheckResult => c !== null && c.status !== 'ok');
  return rows
    .map(
      (c) =>
        `vdx doctor: ${c.label} — ${c.message}.` +
        (c.remedy ? ` Fix, on the user's word: \`${c.remedy}\`.` : '') +
        (c.sessionNote ? ` ${c.sessionNote}` : ''),
    )
    .join('\n');
}

/**
 * `vdx doctor --fix`: what doctor can put right without installing anything —
 * the profile's personal hooks in ~/.gitconfig. Repository hooks are switched
 * on by the project's own install step; doctor names it and leaves it to you.
 */
export function runDoctorFix(deps: PersonalHookDeps = defaultPersonalHookDeps()): string[] {
  return fixPersonalHooks(deps);
}

/** `vdx doctor --fix` for the memory: the profile's personal hosts, this machine's Claude Code. */
export function fixDoctorMemory(
  projectRoot: string,
  state: MemoryState,
  io: { ask: (prompt: string) => string | null; log: (line: string) => void; today: string },
): string[] {
  return fixProjectMemory(projectRoot, state, memoryCtx(), {
    ...io,
    personalHosts: personalHosts(profile().git?.personal_hosts),
  });
}

/**
 * `vdx doctor --staged`, the profile's pre-commit hook: Claude Code's memory goes into a
 * commit only where nobody but the owner reads every place the commit reaches
 * (claude-memory-in-project DL #11, #12). Nothing staged under `.claude/memory/` — no word.
 * Returns the refusal, or null to let the commit go.
 */
export function runDoctorStaged(
  projectRoot: string,
  io: HostingIo = machineIo(projectRoot),
  environment: Environment = profile(),
): string | null {
  const staged = io.git(['diff', '--cached', '--name-only', '--', '.claude/memory']);
  if (!staged) return null;
  const readers = memoryReaders(io, personalHosts(environment.git?.personal_hosts));
  if (readers.only) return null;
  const n = staged.split('\n').length;
  return (
    `vdx doctor: Claude memory stays out of this commit (${n} file(s)) — ${readers.why}.\n` +
    `  commit the rest: git restore --staged .claude/memory, and commit again\n` +
    `  keep it out of git here: echo /.claude/memory/ >> "$(git rev-parse --git-path info/exclude)"`
  );
}

const PROJECT_MARKER_FILES = [
  'package.json',
  'composer.json',
  'pyproject.toml',
  'Makefile',
  'mise.toml',
  'Cargo.toml',
  'go.mod',
  '.git',
];

export function looksLikeProject(projectRoot: string): boolean {
  for (const marker of PROJECT_MARKER_FILES) {
    if (fs.existsSync(path.join(projectRoot, marker))) return true;
  }
  return false;
}
