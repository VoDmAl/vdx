import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { REGISTRY } from '../../src/predicates.ts';
import { isUnknown } from '../../src/evaluator.ts';
import { pushesMain } from '../../src/gha.ts';
import { covers, expandTasks, runnerCalls } from '../../src/vocabulary.ts';
import type { Ctx } from '../../src/facts.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string>): Ctx {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-ci-'));
  dirs.push(root);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return { projectRoot: root, stack: 'node', cache: new Map() };
}

const wf = (on: string, steps: string, extra = '') => `
name: CI
on: ${on}
jobs:
  test:
    runs-on: ubuntu-latest${extra}
    steps:
${steps}
`;
const run = (cmd: string, more = '') => `      - run: ${cmd}${more}\n`;
const PKG = JSON.stringify({ scripts: { test: 'vitest run', check: 'tsc --noEmit', 'check:lint': 'eslint .' } });

describe('pushesMain — the trigger the signal needs', () => {
  it.each([
    ['push', true],
    [['push', 'pull_request'], true],
    [{ push: null }, true],
    [{ push: { branches: ['main'] } }, true],
    [{ push: { branches: ['master'] } }, true],
    [{ push: { branches: ['**'] } }, true],
    [{ push: { branches: ['release/*'] } }, false],
    [{ push: { branches: ['*', '!main', '!master'] } }, false],
    [{ push: { 'branches-ignore': ['main', 'master'] } }, false],
    [{ push: { tags: ['v*'] } }, false],
    [{ pull_request: null }, false],
    ['pull_request', false],
  ])('%j → %s', (on, want) => {
    expect(pushesMain(on)).toBe(want);
  });
});

describe('ci L2 — gha_tests_on_push', () => {
  it('tests on a push to main count', () => {
    const c = project({ 'package.json': PKG, '.github/workflows/ci.yml': wf('{ push: { branches: [main] } }', run('npm test')) });
    expect(REGISTRY.gha_tests_on_push!({}, c)).toBe(true);
  });
  it('a PR-only workflow does not: in a repo that pushes to main it never runs', () => {
    const c = project({ 'package.json': PKG, '.github/workflows/ci.yml': wf('pull_request', run('npm test')) });
    expect(REGISTRY.gha_tests_on_push!({}, c)).toBe(false);
  });
  it('a masked test does not: `|| true`, continue-on-error on the step or the job', () => {
    for (const [steps, extra] of [
      [run('npm test || true'), ''],
      [run('npm test || :'), ''],
      [`      - run: npm test\n        continue-on-error: true\n`, ''],
      [run('npm test'), '\n    continue-on-error: true'],
    ] as const) {
      const c = project({ 'package.json': PKG, '.github/workflows/ci.yml': wf('push', steps, extra) });
      expect(REGISTRY.gha_tests_on_push!({}, c), steps + extra).toBe(false);
    }
  });
  it('another CI system is unknown above L1, not a no', () => {
    const c = project({ '.gitlab-ci.yml': 'test:\n  script: [npm test]\n' });
    const v = REGISTRY.gha_tests_on_push!({}, c);
    expect(isUnknown(v) && v.unknown).toMatch(/GitHub Actions only, not GitLab CI/);
  });
  it('GHA without tests next to another CI is unknown too — the other one may run them', () => {
    const c = project({ '.gitlab-ci.yml': 'x: 1\n', '.github/workflows/deploy.yml': wf('push', run('echo deploy')) });
    expect(isUnknown(REGISTRY.gha_tests_on_push!({}, c))).toBe(true);
  });
  it('no CI at all is a plain no', () => {
    expect(REGISTRY.gha_tests_on_push!({}, project({}))).toBe(false);
  });
});

describe('ci L3 — gha_runs_tasks: CI calls the project vocabulary', () => {
  it('check and test through the project runner', () => {
    const c = project({ 'package.json': PKG, '.github/workflows/ci.yml': wf('push', run('npm run check') + run('npm test')) });
    expect(REGISTRY.gha_runs_tasks!({ tasks: ['check', 'test'] }, c)).toBe(true);
  });
  it('a namespaced form counts: check:lint', () => {
    const c = project({ 'package.json': PKG, '.github/workflows/ci.yml': wf('push', run('npm run check:lint') + run('npm test')) });
    expect(REGISTRY.gha_runs_tasks!({ tasks: ['check', 'test'] }, c)).toBe(true);
  });
  it('the tool called directly is not the project task: tsc instead of check', () => {
    const c = project({ 'package.json': PKG, '.github/workflows/ci.yml': wf('push', run('npx tsc --noEmit') + run('npm test')) });
    expect(REGISTRY.gha_runs_tasks!({ tasks: ['check', 'test'] }, c)).toBe(false);
  });
});

describe('ci L4 — matrix or a pipeline that waits for the checks', () => {
  it('a testing job across a matrix', () => {
    const c = project({
      'package.json': PKG,
      '.github/workflows/ci.yml': wf('push', run('npm test'), '\n    strategy:\n      matrix:\n        node: [20, 22]'),
    });
    expect(REGISTRY.gha_test_matrix!({}, c)).toBe(true);
  });
  const pipeline = (deployNeeds: string) => `
on: { push: { branches: [master] } }
jobs:
  testing:
    runs-on: ubuntu-latest
    steps:
      - run: composer test
  deployment:
    runs-on: ubuntu-latest${deployNeeds}
    steps:
      - run: ./deploy.sh
  sentry-release:
    runs-on: ubuntu-latest
    needs: [deployment]
    steps:
      - uses: getsentry/action-release@v3
`;
  it('everything that ships waits for a checking job via needs (telegram)', () => {
    const c = project({ 'composer.json': JSON.stringify({ scripts: { test: 'phpunit' } }), '.github/workflows/deploy.yml': pipeline('\n    needs: [testing]') });
    expect(REGISTRY.gha_ship_needs_checks!({}, c)).toBe(true);
  });
  it('a deploy that does not wait is not a pipeline', () => {
    const c = project({ 'composer.json': JSON.stringify({ scripts: { test: 'phpunit' } }), '.github/workflows/deploy.yml': pipeline('') });
    expect(REGISTRY.gha_ship_needs_checks!({}, c)).toBe(false);
  });
});

describe('runnerCalls — what a command line calls through the project runner', () => {
  it.each([
    ['npm test', ['test']],
    ['npm run check:lint', ['check:lint']],
    ['npm --prefix cli run typecheck', ['typecheck']],
    ['yarn lint && yarn test', ['lint', 'test']],
    ['composer check:before:commit', ['check:before:commit']],
    ['composer run-script test', ['test']],
    ['mise run check', ['check']],
    ['vdx test', ['test']],
    ['make test', ['test']],
    ['CI=1 pnpm test', ['test']],
    ['bun test', []],
    ['cd /srv && composer install --no-dev', ['install']],
    ['vendor/bin/phpunit', []],
  ])('%s → %j', (cmd, want) => {
    expect(runnerCalls(cmd)).toEqual(want);
  });
});

describe('task expansion — composer @refs and npm run', () => {
  const c = () =>
    project({
      'composer.json': JSON.stringify({
        scripts: {
          'check:before:push': ['@check:config', '@check:before:commit'],
          'check:before:commit': ['@test', '@check:code:static'],
          'check:code:static': ['@check:code:lint', 'phpstan'],
          'check:code:lint': 'phplint',
          'check:config': ['@check:config:composer'],
          'check:config:composer': 'composer validate --strict',
          test: '@phpunit',
          phpunit: 'vendor/bin/phpunit',
          check: ['@check:code:lint', '@test'],
        },
      }),
    });
  it('expands transitively', () => {
    const got = expandTasks(c(), ['check:before:push']);
    for (const t of ['check:before:push', 'check:config', 'check:config:composer', 'check:before:commit', 'test', 'check:code:lint']) {
      expect(got.has(t), t).toBe(true);
    }
  });
  it('covers: a task is covered when it, or everything it calls, is', () => {
    const ctx = c();
    const have = new Set(['check:code:lint', 'test', 'phpunit']);
    expect(covers(ctx, have, 'check')).toBe(true);
    expect(covers(ctx, have, 'check:config:composer')).toBe(false);
  });
});
