import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkPersonalHooks, fixPersonalHooks, parseGitVersion, type PersonalHookDeps } from '../../src/personal-hooks.ts';
import { runDoctorCheck } from '../../src/doctor.ts';
import { parseEnvironment } from '../../src/ai.ts';

let home: string;
let gate: string;

function deps(over: Partial<PersonalHookDeps> = {}): PersonalHookDeps {
  const env = { ...process.env, VDX_ENVIRONMENT: path.join(home, 'profile.yaml'), GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') };
  return {
    env,
    home,
    git: (args, cwd) => {
      try {
        return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env, ...(cwd ? { cwd } : {}) }).trimEnd();
      } catch {
        return null;
      }
    },
    ...over,
  };
}

function profile(hooks: string): void {
  fs.writeFileSync(path.join(home, 'profile.yaml'), `schema_version: "0.1"\ngit:\n  hooks:\n${hooks}`);
}
const gateHook = (whenExists = '~/tool') => `    - name: vdm-crystal
      event: pre-commit
      command: '"$HOME/tool/gate.sh"'
      when_exists: "${whenExists}"
`;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-personal-')));
  fs.mkdirSync(path.join(home, 'tool'));
  gate = path.join(home, 'tool', 'gate.sh');
  fs.writeFileSync(gate, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(home, '.gitconfig'), '');
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('profile git.hooks', () => {
  it('validates name, event and command', () => {
    expect(() => parseEnvironment('git:\n  hooks:\n    - { name: x, event: pre-comit, command: y }\n', 'p')).toThrow(/git\.hooks\[0\]\.event/);
    expect(() => parseEnvironment('git:\n  hooks:\n    - { name: "a b", event: pre-commit, command: y }\n', 'p')).toThrow(/git\.hooks\[0\]\.name/);
    expect(() => parseEnvironment('git:\n  hooks:\n    - { name: x, event: pre-commit, command: "" }\n', 'p')).toThrow(/git\.hooks\[0\]\.command/);
    expect(parseEnvironment('git:\n  hooks:\n    - { name: x, event: [pre-commit, pre-push], command: y }\n', 'p').git?.hooks?.[0]?.name).toBe('x');
  });
});

describe('checkPersonalHooks', () => {
  it('no row without a profile hook that applies here', () => {
    profile(gateHook('~/not-installed'));
    expect(checkPersonalHooks(null, deps())).toBeNull();
  });
  it('declared but not in ~/.gitconfig → warning, fixed by vdx doctor --fix', () => {
    profile(gateHook());
    const row = checkPersonalHooks(null, deps());
    expect(row?.status).toBe('warning');
    expect(row?.message).toBe('vdm-crystal: not in ~/.gitconfig');
    expect(row?.remedy).toBe('vdx doctor --fix');
  });
  it('--fix writes event and command; then the row is ok and git lists the hook', () => {
    profile(gateHook());
    expect(fixPersonalHooks(deps())).toEqual(['hook.vdm-crystal: pre-commit → "$HOME/tool/gate.sh"']);
    const cfg = fs.readFileSync(path.join(home, '.gitconfig'), 'utf8');
    expect(cfg).toContain('[hook "vdm-crystal"]');
    expect(checkPersonalHooks(null, deps())?.status).toBe('ok');
    expect(fixPersonalHooks(deps())).toEqual([]); // nothing left to do
    const v = parseGitVersion(deps().git(['--version']));
    if (v && (v[0] > 2 || (v[0] === 2 && v[1] >= 54))) {
      const repo = path.join(home, 'r');
      execFileSync('git', ['init', '-q', repo]);
      expect(deps().git(['hook', 'list', 'pre-commit'], repo)).toContain('vdm-crystal');
    }
  });
  it('a command that drifted from the profile → warning', () => {
    profile(gateHook());
    fixPersonalHooks(deps());
    deps().git(['config', '--global', 'hook.vdm-crystal.command', 'true']);
    expect(checkPersonalHooks(null, deps())?.message).toMatch(/differs from the profile/);
  });
  it('git older than 2.54 skips config hooks silently — said out loud', () => {
    profile(gateHook());
    const old = deps({ git: (args) => (args[0] === '--version' ? 'git version 2.50.1 (Apple Git-155)' : null) });
    const row = checkPersonalHooks(null, old);
    expect(row?.status).toBe('warning');
    expect(row?.message).toMatch(/git 2\.50\.1 skips hooks from config — vdm-crystal never run here/);
  });
  it('a repository that switches the hook off is named, not flagged', () => {
    profile(gateHook());
    fixPersonalHooks(deps());
    const repo = path.join(home, 'r');
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'config', 'hook.vdm-crystal.enabled', 'false']);
    const row = checkPersonalHooks(repo, deps());
    expect(row?.status).toBe('ok');
    expect(row?.message).toContain('off in this repository');
  });
  it('the session line names what is off and the fix, and is empty when in order', () => {
    profile(gateHook());
    expect(runDoctorCheck({ projectRoot: null }, deps())).toBe(
      "vdx doctor: personal hooks — vdm-crystal: not in ~/.gitconfig. Fix, on the user's word: `vdx doctor --fix`.",
    );
    fixPersonalHooks(deps());
    expect(runDoctorCheck({ projectRoot: null }, deps())).toBe('');
  });
});
