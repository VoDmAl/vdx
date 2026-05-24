import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
  checks: CheckResult[];
  ok: number;
  warning: number;
  missing: number;
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

function checkVdxOnPath(): CheckResult {
  const found = findOnPath('vdx');
  if (found) {
    return {
      id: 'vdx-on-path',
      label: 'vdx on PATH',
      status: 'ok',
      level: 4,
      message: found,
    };
  }
  return {
    id: 'vdx-on-path',
    label: 'vdx on PATH',
    status: 'warning',
    level: 1,
    message: 'binary not on PATH — `vdx <verb>` will not work directly in shell',
    remedy:
      'npm i -g @vodmal/vdx-cli  (or alias vdx="npx -y -p @vodmal/vdx-cli vdx")',
  };
}

function checkClaudeCodePlugin(): CheckResult {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    return {
      id: 'claude-plugin',
      label: 'Claude Code vdx plugin',
      status: 'warning',
      message: '~/.claude/settings.json not found — Claude Code not installed or not configured',
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
        message: 'vdx marketplace present in extraKnownMarketplaces',
      };
    }
    return {
      id: 'claude-plugin',
      label: 'Claude Code vdx plugin',
      status: 'warning',
      message: 'Claude Code configured but vdx marketplace not registered',
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
  checkNode,
  checkVdxOnPath,
  checkGit,
  checkMise,
  checkNpmAuth,
  checkContainerRuntime,
  checkClaudeCodePlugin,
];

export function runDoctor(): DoctorReport {
  const checks = CHECKS.map((fn) => fn());
  const ok = checks.filter((c) => c.status === 'ok').length;
  const warning = checks.filter((c) => c.status === 'warning').length;
  const missing = checks.filter((c) => c.status === 'missing').length;
  return { checks, ok, warning, missing };
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
