import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cloneHookStates, detectHookFrameworks, missingMachinePaths } from '../../src/hooks.ts';
import { checkRepoHooks } from '../../src/clone-checks.ts';
import { REGISTRY } from '../../src/predicates.ts';
import type { Ctx } from '../../src/facts.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>, opts: { git?: boolean } = {}): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-hooks-')));
  dirs.push(root);
  if (opts.git !== false) execFileSync('git', ['init', '-q', root], { stdio: 'ignore' });
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}
const ctxOf = (root: string): Ctx => ({ projectRoot: root, stack: 'node', cache: new Map() });
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
const writeExec = (root: string, rel: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
  fs.chmodSync(path.join(root, rel), 0o755);
};
const pkg = (o: object) => JSON.stringify(o);

describe('does the repository install its hooks itself (git_hooks_arranged, L2)', () => {
  it('husky in prepare — yes, with npm', () => {
    const r = repo({ 'package.json': pkg({ scripts: { prepare: 'husky', test: 'x' } }), '.husky/pre-commit': 'npm test\n' });
    const [fw] = detectHookFrameworks(ctxOf(r));
    expect(fw?.id).toBe('husky');
    expect(fw?.installedBy).toBe('package.json prepare');
    expect(REGISTRY.git_hooks_arranged!({}, ctxOf(r))).toBe(true);
  });
  it('husky in prepare under Yarn 2+ — no: Yarn 2+ does not run prepare (limeflow)', () => {
    for (const extra of [{ packageManager: 'yarn@4.9.2' }, {}]) {
      const files: Record<string, string> = {
        'package.json': pkg({ ...extra, scripts: { prepare: 'husky' } }),
        '.husky/pre-commit': 'yarn lint\n',
      };
      if (!('packageManager' in extra)) files['.yarnrc.yml'] = 'nodeLinker: node-modules\n';
      expect(REGISTRY.git_hooks_arranged!({}, ctxOf(repo(files)))).toBe(false);
    }
  });
  it('husky in postinstall under Yarn 2+ — yes', () => {
    const r = repo({ 'package.json': pkg({ packageManager: 'yarn@4.9.2', scripts: { postinstall: 'husky' } }), '.husky/pre-commit': 'yarn lint\n' });
    expect(REGISTRY.git_hooks_arranged!({}, ctxOf(r))).toBe(true);
  });
  it('the husky package alone — no: husky 9 has no postinstall', () => {
    const r = repo({ 'package.json': pkg({ devDependencies: { husky: '^9' } }), '.husky/pre-commit': 'npm test\n' });
    expect(REGISTRY.git_hooks_arranged!({}, ctxOf(r))).toBe(false);
  });
  it('lefthook and simple-git-hooks packages install themselves', () => {
    const lh = repo({ 'package.json': pkg({ devDependencies: { lefthook: '^2' } }), 'lefthook.yml': 'pre-commit:\n  commands:\n    t:\n      run: npm test\n' });
    expect(REGISTRY.git_hooks_arranged!({}, ctxOf(lh))).toBe(true);
    const sgh = repo({ 'package.json': pkg({ devDependencies: { 'simple-git-hooks': '^2' }, 'simple-git-hooks': { 'pre-commit': 'npm test' } }) });
    expect(REGISTRY.git_hooks_arranged!({}, ctxOf(sgh))).toBe(true);
  });
  it('cghooks add in post-install-cmd, through an @ reference too (telegram)', () => {
    const r = repo({
      'composer.json': pkg({
        scripts: { 'post-install-cmd': ['@cghooks add --ignore-lock'], cghooks: './vendor/bin/cghooks' },
        extra: { hooks: { 'pre-commit': ['composer check:before:commit'], config: { 'stop-on-failure': ['pre-commit'] } } },
      }),
    });
    const [fw] = detectHookFrameworks(ctxOf(r));
    expect(fw?.id).toBe('cghooks');
    expect([...fw!.hooks.keys()]).toEqual(['pre-commit']);
    expect(REGISTRY.git_hooks_arranged!({}, ctxOf(r))).toBe(true);
  });
  it('.githooks — only when an install step sets core.hooksPath (cc-vdm-plugins: no)', () => {
    const bare = repo({ '.githooks/pre-commit': 'scripts/check.sh\n' });
    expect(REGISTRY.git_hooks_arranged!({}, ctxOf(bare))).toBe(false);
    const up = repo({ '.githooks/pre-commit': 'x\n', 'mise.toml': '[tasks.up]\nrun = "git config core.hooksPath .githooks"\n' });
    expect(REGISTRY.git_hooks_arranged!({}, ctxOf(up))).toBe(true);
  });
  it('no hooks declared — not arranged (L1 stays L1)', () => {
    expect(REGISTRY.git_hooks_arranged!({}, ctxOf(repo({ 'package.json': pkg({ scripts: { prepare: 'husky' } }) })))).toBe(false);
  });
});

describe('what the hooks check (git_hook_runs_task L3, git_hook_covers_ci L4)', () => {
  const composer = {
    scripts: {
      'check:before:commit': ['@test'],
      'check:before:push': ['@check:config:composer', '@check:before:commit', '@check:code:lint'],
      'check:config:composer': 'composer validate --strict',
      'check:code:lint': 'phplint',
      test: 'phpunit',
      'post-install-cmd': ['@cghooks add'],
      cghooks: 'vendor/bin/cghooks',
    },
    extra: { hooks: { 'pre-commit': ['composer check:before:commit'], 'pre-push': ['composer check:before:push'] } },
  };
  const ci = `on: { push: { branches: [master] } }
jobs:
  testing:
    runs-on: ubuntu-latest
    steps:
      - run: composer check:config:composer
      - run: composer check:code:lint
      - run: composer test
`;
  it('L3: a hook calls a vocabulary task through the runner', () => {
    expect(REGISTRY.git_hook_runs_task!({ tasks: ['test', 'check'] }, ctxOf(repo({ 'composer.json': pkg(composer) })))).toBe(true);
  });
  it('L3: lint is not a vocabulary word', () => {
    const r = repo({ 'package.json': pkg({ scripts: { lint: 'eslint .', postinstall: 'husky' } }), '.husky/pre-commit': 'yarn lint\n' });
    expect(REGISTRY.git_hook_runs_task!({ tasks: ['test', 'check'] }, ctxOf(r))).toBe(false);
  });
  it('L4: pre-push covers every vocabulary task CI calls, after expansion (telegram)', () => {
    expect(REGISTRY.git_hook_covers_ci!({}, ctxOf(repo({ 'composer.json': pkg(composer), '.github/workflows/ci.yml': ci })))).toBe(true);
  });
  it('L4: a CI check the pre-push skips — no', () => {
    const narrow = { ...composer, extra: { hooks: { 'pre-push': ['composer test'] } } };
    expect(REGISTRY.git_hook_covers_ci!({}, ctxOf(repo({ 'composer.json': pkg(narrow), '.github/workflows/ci.yml': ci })))).toBe(false);
  });
  it('L4: no CI to compare with — no', () => {
    expect(REGISTRY.git_hook_covers_ci!({}, ctxOf(repo({ 'composer.json': pkg(composer) })))).toBe(false);
  });
});

describe('is it on in this clone (cloneHookStates, checkRepoHooks)', () => {
  it('husky: core.hooksPath unset → off, remedy is the install step', () => {
    const r = repo({ 'package.json': pkg({ scripts: { prepare: 'husky' } }), 'package-lock.json': '{}', '.husky/pre-commit': 'npm test\n' });
    const row = checkRepoHooks(r);
    expect(row?.status).toBe('warning');
    expect(row?.message).toMatch(/husky \(\.husky\/\): core\.hooksPath is unset, husky needs \.husky\/_ — those hooks never run/);
    expect(row?.remedy).toBe('npm install');
  });
  it('husky: hooksPath at .husky/_ with the wrappers → on', () => {
    const r = repo({ 'package.json': pkg({ scripts: { prepare: 'husky' } }), '.husky/pre-commit': 'npm test\n' });
    writeExec(r, '.husky/_/pre-commit', '#!/bin/sh\n. "$(dirname "$0")/h"\n');
    git(r, 'config', 'core.hooksPath', '.husky/_');
    expect(checkRepoHooks(r)?.status).toBe('ok');
  });
  it('husky never switched on by the repo itself: remedy is the manual command', () => {
    const r = repo({ 'package.json': pkg({ packageManager: 'yarn@4.9.2', scripts: { prepare: 'husky' } }), '.husky/pre-commit': 'yarn lint\n' });
    expect(checkRepoHooks(r)?.remedy).toBe('npx husky');
  });
  it('cghooks: hooks in .git/hooks with every declared command → on', () => {
    const r = repo({ 'composer.json': pkg({ scripts: { 'post-install-cmd': 'cghooks add' }, extra: { hooks: { 'pre-commit': ['composer test'] } } }) });
    writeExec(r, '.git/hooks/pre-commit', '#!/bin/sh\n\ncomposer test\n');
    expect(checkRepoHooks(r)?.status).toBe('ok');
  });
  it('cghooks: the installed copy is older than extra.hooks → stale, composer install', () => {
    const r = repo({ 'composer.json': pkg({ scripts: { 'post-install-cmd': 'cghooks add' }, extra: { hooks: { 'pre-commit': ['composer test', 'composer check'] } } }) });
    writeExec(r, '.git/hooks/pre-commit', '#!/bin/sh\n\ncomposer test\n');
    const row = checkRepoHooks(r);
    expect(row?.status).toBe('warning');
    expect(row?.message).toMatch(/installed pre-commit older than composer\.json extra\.hooks/);
    expect(row?.remedy).toBe('composer install');
  });
  it('cghooks hooks in .git/hooks while core.hooksPath points elsewhere → off: git never reads them', () => {
    const r = repo({ 'composer.json': pkg({ scripts: { 'post-install-cmd': 'cghooks add' }, extra: { hooks: { 'pre-commit': ['composer test'] } } }) });
    writeExec(r, '.git/hooks/pre-commit', '#!/bin/sh\ncomposer test\n');
    fs.mkdirSync(path.join(r, '.other'));
    git(r, 'config', 'core.hooksPath', '.other');
    const [state] = cloneHookStates(r, ctxOf(r), detectHookFrameworks(ctxOf(r)));
    expect(state?.enabled).toBe(false);
  });
  it('lefthook: a pre-commit that is not lefthook\'s → off', () => {
    const r = repo({ 'package.json': pkg({ devDependencies: { lefthook: '^2' } }), 'lefthook.yml': 'pre-commit:\n  commands:\n    t:\n      run: npm test\n' });
    writeExec(r, '.git/hooks/pre-commit', '#!/bin/sh\necho other\n');
    expect(checkRepoHooks(r)?.message).toMatch(/not lefthook's/);
  });
  it('a hook calling a program missing on this machine is flagged; one only mentioning a path is not', () => {
    expect(missingMachinePaths(['"$HOME/no-such-dir-vdx/check.sh" && composer test'])).toEqual(['$HOME/no-such-dir-vdx/check.sh']);
    expect(missingMachinePaths(['echo "see $HOME/no-such-dir-vdx/x"'])).toEqual([]);
    expect(missingMachinePaths(['"$HOME" && true'])).toEqual([]);
  });
  it('no row when the repo declares no hooks', () => {
    expect(checkRepoHooks(repo({ 'package.json': '{}' }))).toBeNull();
  });
});
