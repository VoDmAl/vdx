/**
 * Personal hooks: the owner's gates (vdm, echelon's guard) that hold in every
 * repository on the machine. They live in git's user config — `hook.<name>.*`
 * in ~/.gitconfig, Git 2.54 — not in each repository, where they fought the
 * repository's own hook framework for one slot (DL #19 of
 * docs/tasks/vdm-gates-wiring-axis). The profile declares them (`git.hooks`);
 * `vdx doctor` checks they are in place and that this git runs them, and
 * `vdx doctor --fix` writes the missing ones.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { CheckResult } from './doctor.ts';
import { loadEnvironment, resolveEnvironmentPath, type PersonalHook } from './ai.ts';
import { missingMachinePaths } from './hooks.ts';

/** Git reads hooks from config since 2.54; older git skips the keys without a word. */
export const CONFIG_HOOKS_SINCE: [number, number] = [2, 54];

export interface PersonalHookDeps {
  env: NodeJS.ProcessEnv;
  home: string;
  /** `git <args>` → stdout, or null when git exits non-zero. */
  git: (args: string[], cwd?: string) => string | null;
}

export function defaultPersonalHookDeps(): PersonalHookDeps {
  return {
    env: process.env,
    home: os.homedir(),
    git: (args, cwd) => {
      try {
        return execFileSync('git', args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          ...(cwd ? { cwd } : {}),
        }).trimEnd();
      } catch {
        return null;
      }
    },
  };
}

export function parseGitVersion(out: string | null): [number, number, number] | null {
  const m = out?.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3] ?? '0', 10)] : null;
}

function readsConfigHooks(v: [number, number, number]): boolean {
  const [maj, min] = CONFIG_HOOKS_SINCE;
  return v[0] > maj || (v[0] === maj && v[1] >= min);
}

function expandHome(p: string, home: string): string {
  return p.replace(/^~(?=$|\/)/, home);
}

function events(h: PersonalHook): string[] {
  return Array.isArray(h.event) ? h.event : [h.event];
}

/** The hooks of the profile that apply on this machine; null — no profile, or none declared. */
export function applicableHooks(deps: PersonalHookDeps): PersonalHook[] | null {
  const file = resolveEnvironmentPath(deps.env, deps.home);
  if (!file) return null;
  let hooks: PersonalHook[];
  try {
    hooks = loadEnvironment(file).git?.hooks ?? [];
  } catch {
    return null; // a broken profile is `vdx ai`'s report
  }
  const here = hooks.filter((h) => !h.when_exists || fs.existsSync(expandHome(h.when_exists, deps.home)));
  return here.length > 0 ? here : null;
}

interface HookState {
  hook: PersonalHook;
  /** What is wrong with the user-config entry; null — it matches the profile. */
  drift: string | null;
  /** How this repository treats it (switched off, its own command), for the message. */
  local: string | null;
}

function stateOf(h: PersonalHook, root: string | null, deps: PersonalHookDeps): HookState {
  const key = `hook.${h.name}`;
  const have = (deps.git(['config', '--global', '--includes', '--get-all', `${key}.event`]) ?? '')
    .split('\n')
    .filter(Boolean);
  const command = deps.git(['config', '--global', '--includes', '--get', `${key}.command`]);
  let drift: string | null = null;
  if (have.length === 0 && command === null) drift = 'not in ~/.gitconfig';
  else if (command !== h.command) drift = `its command in ~/.gitconfig differs from the profile`;
  else if (events(h).some((e) => !have.includes(e))) drift = `not bound to ${events(h).filter((e) => !have.includes(e)).join(', ')}`;

  let local: string | null = null;
  if (root !== null) {
    if (deps.git(['-C', root, 'config', '--local', '--get', `${key}.enabled`]) === 'false') local = 'off in this repository';
    else if (deps.git(['-C', root, 'config', '--local', '--get', `${key}.command`]) !== null) local = 'own command in this repository';
  }
  return { hook: h, drift, local };
}

export function checkPersonalHooks(projectRoot: string | null, deps: PersonalHookDeps = defaultPersonalHookDeps()): CheckResult | null {
  const hooks = applicableHooks(deps);
  if (!hooks) return null;
  const id = 'personal-hooks';
  const label = 'personal hooks';
  const names = hooks.map((h) => h.name).join(', ');

  const version = parseGitVersion(deps.git(['--version']));
  if (version && !readsConfigHooks(version)) {
    return {
      id,
      label,
      status: 'warning',
      message: `git ${version.join('.')} skips hooks from config — ${names} never run here (needs git ≥ ${CONFIG_HOOKS_SINCE.join('.')})`,
      remedy: 'git ≥ 2.54 first on PATH (brew install git)',
    };
  }

  const states = hooks.map((h) => stateOf(h, projectRoot, deps));
  const drifted = states.filter((s) => s.drift !== null);
  if (drifted.length > 0) {
    return {
      id,
      label,
      status: 'warning',
      message: drifted.map((s) => `${s.hook.name}: ${s.drift}`).join('; '),
      remedy: 'vdx doctor --fix',
    };
  }

  const missing = missingMachinePaths(hooks.map((h) => h.command), deps.home);
  if (missing.length > 0) {
    return {
      id,
      label,
      status: 'warning',
      message: `${names} call ${missing.join(', ')} — not on this machine`,
      remedy: 'install the tool here, or drop the hook from the profile',
    };
  }

  return {
    id,
    label,
    status: 'ok',
    message: states
      .map((s) => `${s.hook.name} (${events(s.hook).join(', ')})${s.local ? ` — ${s.local}` : ''}`)
      .join('; '),
  };
}

/** Writes the profile's hooks into ~/.gitconfig where they are missing or differ; returns what it wrote. */
export function fixPersonalHooks(deps: PersonalHookDeps = defaultPersonalHookDeps()): string[] {
  const hooks = applicableHooks(deps);
  if (!hooks) return [];
  const done: string[] = [];
  for (const h of hooks) {
    if (stateOf(h, null, deps).drift === null) continue;
    const key = `hook.${h.name}`;
    deps.git(['config', '--global', '--unset-all', `${key}.event`]);
    for (const e of events(h)) {
      if (deps.git(['config', '--global', '--add', `${key}.event`, e]) === null) {
        throw new Error(`git config --global --add ${key}.event ${e} failed`);
      }
    }
    if (deps.git(['config', '--global', `${key}.command`, h.command]) === null) {
      throw new Error(`git config --global ${key}.command failed`);
    }
    done.push(`${key}: ${events(h).join(', ')} → ${h.command}`);
  }
  return done;
}

/** For messages: where the user config lives. */
export function userGitConfigPath(deps: PersonalHookDeps): string {
  return deps.env['GIT_CONFIG_GLOBAL'] ?? path.join(deps.home, '.gitconfig');
}
