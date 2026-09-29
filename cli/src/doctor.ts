import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export type CheckStatus = 'ok' | 'warning' | 'missing';

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  level?: number;
  message: string;
  remedy?: string;
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
    const pkgPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'package.json',
    );
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
      remedy: 'https://nodejs.org/en/download (LTS ≥ 20 recommended)',
    };
  }
  const major = parseSemverMajor(v);
  if (major === null) {
    return { id: 'node', label: 'Node.js', status: 'warning', message: `unparseable version: ${v}` };
  }
  if (major < 20) {
    return {
      id: 'node',
      label: 'Node.js',
      status: 'warning',
      level: 1,
      message: `${v} — below recommended (≥ 20 LTS)`,
      remedy: 'mise use -g node@20 (or upgrade via nvm/brew)',
    };
  }
  return { id: 'node', label: 'Node.js', status: 'ok', level: major >= 22 ? 4 : 3, message: v };
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
    remedy:
      'npm i -g @vodmal/vdx-cli  OR  add `alias vdx="npx -y -p @vodmal/vdx-cli vdx"` to your shell rc',
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

function checkClaudeCodePlugin(): CheckResult {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    return {
      id: 'claude-plugin',
      label: 'Claude Code vdx plugin',
      status: 'warning',
      message: '~/.claude/settings.json not found',
      remedy: 'Install Claude Code, then add vdx marketplace (see README)',
    };
  }
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    if (raw.includes('VoDmAl/vdx') || raw.includes('vdx/marketplace')) {
      return {
        id: 'claude-plugin',
        label: 'Claude Code vdx plugin',
        status: 'ok',
        message: 'vdx marketplace registered',
      };
    }
    return {
      id: 'claude-plugin',
      label: 'Claude Code vdx plugin',
      status: 'warning',
      message: 'vdx marketplace not registered',
      remedy: 'Add github.com/VoDmAl/vdx/marketplace to extraKnownMarketplaces',
    };
  } catch (e: any) {
    return {
      id: 'claude-plugin',
      label: 'Claude Code vdx plugin',
      status: 'warning',
      message: `cannot read settings.json: ${e?.message ?? e}`,
    };
  }
}

/**
 * Variables a hook body *gates on*: `[ -n "${VAR:-}" ]`, `[ -x "$VAR" ]` and
 * friends. Restricted to test-expression positions on purpose — a bare `$VAR`
 * anywhere in a script says nothing about whether the hook still does its job,
 * while an unset variable inside the guard means the guarded block never runs.
 */
const GATING_VAR_RE =
  /\[\s+-[nxfse]\s+"\$\{([A-Z][A-Z0-9_]*)(?::-[^}]*)?\}"|\[\s+-[nxfse]\s+"\$([A-Z][A-Z0-9_]*)"/g;

/**
 * Git hooks: declared vs actually wired.
 *
 * A hook framework leaves two separable traces: files in the repository
 * (tracked, same for every clone) and activation in `.git/config` (per-clone,
 * never committed). Presence of the first says nothing about the second, and a
 * hook that is present but inert fails exactly like success — nothing is
 * printed, the commit goes through. Same for a hook whose body is gated on an
 * environment variable nobody set: the guard short-circuits and the gate is a
 * no-op.
 *
 * Returns null (row omitted) when the repo declares no hooks at all — there is
 * nothing to be wrong about.
 */
function checkGitHooks(ctx: DoctorCtx): CheckResult | null {
  const root = ctx.projectRoot;
  if (root === null) return null;
  if (!fs.existsSync(path.join(root, '.git'))) return null;

  const id = 'git-hooks';
  const label = 'git hooks';

  let hooksPath: string | null = null;
  try {
    const out = execFileSync('git', ['-C', root, 'config', '--get', 'core.hooksPath'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    hooksPath = out.trim() || null;
  } catch {
    hooksPath = null;
  }

  // Directories a framework would have written into the repo.
  const declaredDirs = ['.githooks', '.husky'].filter((d) =>
    fs.existsSync(path.join(root, d)),
  );

  if (hooksPath === null) {
    if (declaredDirs.length === 0) return null; // nothing declared — not applicable
    return {
      id,
      label,
      status: 'warning',
      message: `${declaredDirs.join(', ')} present but core.hooksPath is unset — hooks never run`,
      remedy: `git -C ${root} config core.hooksPath ${declaredDirs[0]}`,
    };
  }

  const dir = path.resolve(root, hooksPath);
  if (!fs.existsSync(dir)) {
    return {
      id,
      label,
      status: 'missing',
      message: `core.hooksPath=${hooksPath} but that directory does not exist`,
      remedy: `git -C ${root} config --unset core.hooksPath, or create ${hooksPath}/`,
    };
  }

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir).filter((f) => !f.startsWith('.') && !f.endsWith('.sample'));
  } catch {
    entries = [];
  }
  const executable = entries.filter((f) => {
    try {
      fs.accessSync(path.join(dir, f), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });

  if (executable.length === 0) {
    return {
      id,
      label,
      status: 'warning',
      message: `core.hooksPath=${hooksPath} but it holds no executable hook`,
      remedy: `chmod +x ${hooksPath}/*`,
    };
  }

  // A hook gated on an unset variable is inert while looking installed.
  const unresolved = new Set<string>();
  for (const f of executable) {
    let body = '';
    try {
      body = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const m of body.matchAll(GATING_VAR_RE)) {
      const name = m[1] ?? m[2];
      if (name && !process.env[name]) unresolved.add(name);
    }
  }

  if (unresolved.size > 0) {
    const names = [...unresolved].sort();
    return {
      id,
      label,
      status: 'warning',
      message: `${executable.length} hook(s) via ${hooksPath}, but gated on unset ${names.join(', ')} — those gates are no-ops`,
      remedy: `export ${names[0]}=... in your shell profile (see the tool that ships the hook)`,
    };
  }

  return {
    id,
    label,
    status: 'ok',
    message: `${executable.length} hook(s) active via ${hooksPath}`,
  };
}

const CHECKS: Array<(ctx: DoctorCtx) => CheckResult | null> = [
  checkVdxVersion,
  checkVdx,
  checkClaudeCode,
  checkClaudeCodePlugin,
  checkNode,
  checkGit,
  checkMise,
  checkNpmAuth,
  checkContainerRuntime,
  checkGitHooks,
];

export function resolveDoctorCtx(cwd: string = process.cwd()): DoctorCtx {
  return { projectRoot: looksLikeProject(cwd) ? cwd : null };
}

export function runDoctor(ctx: DoctorCtx = resolveDoctorCtx()): DoctorReport {
  const checks = CHECKS.map((fn) => fn(ctx)).filter((c): c is CheckResult => c !== null);
  const ok = checks.filter((c) => c.status === 'ok').length;
  const warning = checks.filter((c) => c.status === 'warning').length;
  const missing = checks.filter((c) => c.status === 'missing').length;
  return { cliVersion: readCliVersion(), checks, ok, warning, missing };
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
