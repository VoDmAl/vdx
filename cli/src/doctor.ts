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
      message: 'not logged in — `vdx publish` will fail with E404',
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

const CHECKS: Array<() => CheckResult> = [
  checkVdxVersion,
  checkVdx,
  checkClaudeCode,
  checkClaudeCodePlugin,
  checkNode,
  checkGit,
  checkMise,
  checkNpmAuth,
  checkContainerRuntime,
];

export function runDoctor(): DoctorReport {
  const checks = CHECKS.map((fn) => fn());
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
