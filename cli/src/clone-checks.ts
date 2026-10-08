/**
 * Checks of this clone that both `vdx doctor` (a row) and `vdx audit` (a note
 * next to the axis that names it in `clone_check`) print — one check, two
 * surfaces, so they cannot disagree.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { CheckResult } from './doctor.ts';
import {
  cloneHookStates,
  detectHookFrameworks,
  effectiveHooksDir,
  missingMachinePaths,
  unsetGatingVars,
} from './hooks.ts';
import { autoDetectStack, type Ctx } from './facts.ts';

function gitConfig(root: string, key: string): string | null {
  try {
    const out = execFileSync('git', ['-C', root, 'config', '--get', key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function isGitWorkTree(root: string): boolean {
  return fs.existsSync(path.join(root, '.git'));
}

function executableHooks(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((f) => !f.startsWith('.') && !f.endsWith('.sample'));
  } catch {
    return out;
  }
  for (const f of names) {
    const file = path.join(dir, f);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) out.set(f, fs.readFileSync(file, 'utf8'));
    } catch {
      /* not executable — git skips it silently */
    }
  }
  return out;
}

/**
 * Git hooks: declared vs actually running in this clone.
 *
 * A framework leaves two separable traces: files in the repository (tracked,
 * the same for every clone) and activation in the clone (`core.hooksPath`, or
 * hooks written into the git hooks directory). The first says nothing about
 * the second, and a hook that is declared but off fails exactly like success —
 * nothing is printed, the commit goes through. So does a hook gated on a
 * variable nobody set, or one that calls a path missing on this machine.
 *
 * Null (no row) when the repo declares no hooks — there is nothing to be wrong about.
 */
export function checkRepoHooks(root: string | null): CheckResult | null {
  if (root === null || !isGitWorkTree(root)) return null;
  const id = 'git-hooks';
  const label = 'git hooks';
  const ctx: Ctx = { projectRoot: root, stack: autoDetectStack(root), cache: new Map() };
  const frameworks = detectHookFrameworks(ctx);
  const hooksPath = gitConfig(root, 'core.hooksPath');

  if (frameworks.length === 0) {
    if (hooksPath === null) return null;
    // Hooks in a directory no framework owns: read what is there.
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
    const hooks = executableHooks(dir);
    if (hooks.size === 0) {
      return {
        id,
        label,
        status: 'warning',
        message: `core.hooksPath=${hooksPath} but it holds no executable hook`,
        remedy: `chmod +x ${hooksPath}/*`,
      };
    }
    return bodyProblems(id, label, [...hooks.values()]) ?? {
      id,
      label,
      status: 'ok',
      message: `${hooks.size} hook(s) active via ${hooksPath}`,
    };
  }

  const states = cloneHookStates(root, ctx, frameworks);
  const off = states.filter((s) => !s.enabled);
  if (off.length > 0) {
    return {
      id,
      label,
      status: 'warning',
      message: off.map((s) => `${s.framework.id} (${s.framework.declaredIn}): ${s.problem} — those hooks never run`).join('; '),
      ...(off[0]!.remedy ? { remedy: off[0]!.remedy } : {}),
    };
  }

  const commands = frameworks.flatMap((f) => [...f.hooks.values()].flat());
  const problem = bodyProblems(id, label, commands);
  if (problem) return problem;

  const dir = effectiveHooksDir(root);
  const where = dir ? path.relative(root, dir) || dir : 'the hooks directory';
  const count = frameworks.reduce((n, f) => n + f.hooks.size, 0);
  return {
    id,
    label,
    status: 'ok',
    message: `${frameworks.map((f) => f.id).join(', ')}: ${count} hook(s) active in ${where}`,
  };
}

/** A body that looks installed but does nothing here: gated on an unset variable, or calling a missing path. */
function bodyProblems(id: string, label: string, bodies: string[]): CheckResult | null {
  const unset = unsetGatingVars(bodies);
  if (unset.length > 0) {
    return {
      id,
      label,
      status: 'warning',
      message: `hooks gated on unset ${unset.join(', ')} — those gates are no-ops`,
      remedy: `export ${unset[0]}=... in your shell profile (see the tool that ships the hook)`,
    };
  }
  const missing = missingMachinePaths(bodies);
  if (missing.length > 0) {
    return {
      id,
      label,
      status: 'warning',
      message: `hooks call ${missing.join(', ')} — not on this machine, the commit fails or the gate is skipped`,
      remedy: 'install what the hook calls here, or move the hook out of the repository (a personal hook in git config)',
    };
  }
  return null;
}

/** The checks an axis may name in `clone_check`. */
export function cloneCheck(name: 'git-hooks', root: string): CheckResult | null {
  switch (name) {
    case 'git-hooks':
      return checkRepoHooks(root);
    default:
      return null;
  }
}
