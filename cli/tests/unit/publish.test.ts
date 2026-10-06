import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  type GitRunner,
  type NpmRunner,
  type PublishDeps,
  type PublishPlan,
  bumpLockText,
  bumpSemver,
  checkNpmAuth,
  compareSemver,
  executePublish,
  planPublish,
  planPush,
  preflightFixable,
  publishRegistry,
  renderPublishPlan,
  waitForRegistry,
} from '../../src/publish.ts';
import type { AuditResult } from '../../src/audit.ts';
import type { Ctx } from '../../src/facts.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, '..', 'fixtures');

describe('bumpSemver', () => {
  it('patches the third segment', () => {
    expect(bumpSemver('0.3.0', 'patch')).toBe('0.3.1');
    expect(bumpSemver('1.2.3', 'patch')).toBe('1.2.4');
  });
  it('minor resets patch', () => {
    expect(bumpSemver('1.2.3', 'minor')).toBe('1.3.0');
  });
  it('major resets minor and patch', () => {
    expect(bumpSemver('1.2.3', 'major')).toBe('2.0.0');
  });
  it('throws on malformed input', () => {
    expect(() => bumpSemver('not-semver', 'patch')).toThrow(/Cannot parse semver/);
  });
});

describe('compareSemver', () => {
  it('returns -1/0/1', () => {
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1);
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
  });
  it('handles v-prefix', () => {
    expect(compareSemver('v1.0.0', '1.0.0')).toBe(0);
  });
});

function mockAudit(overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    baseline: 'file:///mock',
    stack: 'node',
    achieved_level: 'L2',
    overrides: [],
    expired_overrides: [],
    per_axis: [
      {
        axis_id: 'release-artifact',
        class: 'supporting',
        achieved: 'L4',
        baseline_target: 'L4',
        drift_kind: 'aligned',
        evidence: [],
      },
    ],
    ...overrides,
  };
}

/** A fake npm: answers from the table by joined args; an Error is thrown with that stderr. */
function fakeNpm(answers: Record<string, string | Error>): NpmRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    const a = answers[args.join(' ')];
    if (a === undefined) throw Object.assign(new Error('unexpected npm call'), { stderr: `unexpected: ${args.join(' ')}` });
    if (a instanceof Error) throw a;
    return a;
  };
  return Object.assign(run, { calls });
}

const npmError = (stderr: string) => Object.assign(new Error('Command failed: npm'), { stderr });

// The fixture is not on the registry, and its owner is logged in: no real npm.
const fixtureNpm = () =>
  fakeNpm({
    whoami: 'someone',
    'view fixture-node-with-vitest version': npmError('npm error code E404\nnpm error 404 Not Found\n'),
  });

describe('planPublish: pre-flight', () => {
  it('rejects non-node stacks in MVP', () => {
    const ctx: Ctx = {
      projectRoot: path.join(FIXTURES, 'php-with-phpstan'),
      stack: 'php',
      cache: new Map(),
    };
    expect(() =>
      planPublish(
        { projectRoot: ctx.projectRoot, bump: 'patch', dryRun: true, force: false },
        mockAudit({ stack: 'php' }),
        ctx,
      ),
    ).toThrow(/only "node" stack/);
  });

  it('flags excluded release-artifact axis (app, not lib)', () => {
    const projectRoot = path.join(FIXTURES, 'node-with-vitest');
    const ctx: Ctx = { projectRoot, stack: 'node', cache: new Map() };
    const audit = mockAudit({
      per_axis: [
        {
          axis_id: 'release-artifact',
          class: 'supporting',
          achieved: 'L0',
          baseline_target: 'L4',
          drift_kind: 'excluded',
          evidence: [],
        },
      ],
    });
    const plan = planPublish(
      { projectRoot, bump: 'patch', dryRun: true, force: false },
      audit,
      ctx,
      fixtureNpm(),
    );
    const libCheck = plan.preflight.find((c) => c.name === 'lib-intent (applies_when)');
    expect(libCheck?.ok).toBe(false);
    expect(libCheck?.message).toMatch(/excluded/);
    expect(plan.preflightPassed).toBe(false);
  });

  it('flags release-artifact below L3', () => {
    const projectRoot = path.join(FIXTURES, 'node-with-vitest');
    const ctx: Ctx = { projectRoot, stack: 'node', cache: new Map() };
    const audit = mockAudit({
      per_axis: [
        {
          axis_id: 'release-artifact',
          class: 'supporting',
          achieved: 'L1',
          baseline_target: 'L4',
          drift_kind: 'gap',
          evidence: [],
        },
      ],
    });
    const plan = planPublish(
      { projectRoot, bump: 'patch', dryRun: true, force: false },
      audit,
      ctx,
      fixtureNpm(),
    );
    const raCheck = plan.preflight.find((c) => c.name === 'release-artifact >= L3');
    expect(raCheck?.ok).toBe(false);
    expect(raCheck?.message).toMatch(/L1.*need >= L3/);
  });

  it('refuses before the bump when npm has no login for the package', () => {
    const projectRoot = path.join(FIXTURES, 'node-with-vitest');
    const ctx: Ctx = { projectRoot, stack: 'node', cache: new Map() };
    const plan = planPublish(
      { projectRoot, bump: 'patch', dryRun: true, force: false },
      mockAudit(),
      ctx,
      fakeNpm({
        whoami: npmError('npm error code E401\n'),
        'view fixture-node-with-vitest version': '0.0.1',
      }),
    );
    expect(plan.preflight.find((c) => c.name === 'npm-auth')?.ok).toBe(false);
    expect(plan.preflightPassed).toBe(false);
  });
});

describe('checkNpmAuth', () => {
  it('passes when npm whoami names the user', () => {
    const c = checkNpmAuth(null, fakeNpm({ whoami: 'vodmal\n' }));
    expect(c).toEqual({ name: 'npm-auth', ok: true, message: 'OK (logged in to npm as vodmal)' });
  });

  it('offers npm login as the fix for an expired session, with the registry the package goes to', () => {
    expect(checkNpmAuth(null, fakeNpm({ whoami: npmError('npm error code E401\n') })).fix).toEqual({ cmd: 'npm', args: ['login'] });
    const scoped = checkNpmAuth('https://npm.example/', fakeNpm({ 'whoami --registry https://npm.example/': npmError('code ENEEDAUTH') }));
    expect(scoped.fix).toEqual({ cmd: 'npm', args: ['login', '--registry', 'https://npm.example/'] });
    expect(checkNpmAuth(null, fakeNpm({ whoami: npmError('npm error code ECONNREFUSED\n') })).fix).toBeUndefined();
  });

  it('fails on an expired session (E401) and names npm login — the 0.13.0 case', () => {
    const c = checkNpmAuth(
      null,
      fakeNpm({ whoami: npmError('npm error code E401\nnpm error 401 Unauthorized - GET https://registry.npmjs.org/-/whoami\n') }),
    );
    expect(c.ok).toBe(false);
    expect(c.message).toMatch(/not logged in to npm .*Run: npm login$/);
  });

  it('fails without any token (ENEEDAUTH)', () => {
    const c = checkNpmAuth(null, fakeNpm({ whoami: npmError('npm error code ENEEDAUTH\nnpm error need auth\n') }));
    expect(c.ok).toBe(false);
    expect(c.message).toMatch(/not logged in/);
  });

  it('reports another failure by its first line, not as a missing login', () => {
    const c = checkNpmAuth(null, fakeNpm({ whoami: npmError('npm error code ENOTFOUND\nnpm error network\n') }));
    expect(c.ok).toBe(false);
    expect(c.message).toBe('npm whoami failed for npm: npm error code ENOTFOUND');
  });

  it('asks the registry the package goes to', () => {
    const npm = fakeNpm({ 'whoami --registry https://npm.example.com/': 'me' });
    const c = checkNpmAuth('https://npm.example.com/', npm);
    expect(c.ok).toBe(true);
    expect(c.message).toBe('OK (logged in to https://npm.example.com/ as me)');
  });
});

describe('publishRegistry', () => {
  it('takes publishConfig.registry first', () => {
    const npm = fakeNpm({});
    expect(publishRegistry({ name: '@x/y', publishConfig: { registry: 'https://r/' } }, npm)).toBe('https://r/');
    expect(npm.calls).toEqual([]);
  });

  it('takes the scope registry from npm config for a scoped package', () => {
    expect(publishRegistry({ name: '@finam/lib' }, fakeNpm({ 'config get @finam:registry': 'https://nexus/\n' }))).toBe(
      'https://nexus/',
    );
  });

  it('is the default registry for an unscoped package or a scope without its own', () => {
    expect(publishRegistry({ name: 'demo' }, fakeNpm({}))).toBeNull();
    expect(publishRegistry({ name: '@vodmal/vdx-cli' }, fakeNpm({ 'config get @vodmal:registry': 'undefined\n' }))).toBeNull();
  });
});

describe('renderPublishPlan', () => {
  it('produces a markdown plan with pre-flight table and pipeline section when passed', () => {
    const projectRoot = path.join(FIXTURES, 'node-publishable-lib');
    const ctx: Ctx = { projectRoot, stack: 'node', cache: new Map() };
    // Note: real pre-flight will call npm view + git status, so just smoke-test render output
    // via a hand-built plan (skipping planPublish to keep the test hermetic).
    const text = renderPublishPlan({
      stack: 'node',
      packageName: 'demo',
      currentVersion: '1.0.0',
      newVersion: '1.0.1',
      bump: 'patch',
      packageJsonPath: path.join(projectRoot, 'package.json'),
      preflight: [{ name: 'fake', ok: true, message: 'ok' }],
      preflightPassed: true,
      delegatedToMise: false,
    });
    expect(text).toMatch(/# vdx publish plan/);
    expect(text).toMatch(/Version.*1\.0\.0 → 1\.0\.1/);
    expect(text).toMatch(/Pipeline \(would execute/);
    expect(text).toMatch(/npm publish/);
    expect(text).toMatch(/Not pushed \(`--no-push`\)/);
  });

  const plan = (over: Partial<PublishPlan> = {}): PublishPlan => ({
    projectRoot: '/p',
    stack: 'node',
    packageName: 'demo',
    currentVersion: '1.0.0',
    newVersion: '1.1.0',
    bump: 'minor',
    packageJsonPath: '/p/package.json',
    lockPath: '/p/package-lock.json',
    push: { enabled: true, upstream: 'origin/main', ahead: 2, behind: 0 },
    preflight: [{ name: 'fake', ok: true, message: 'ok' }],
    preflightPassed: true,
    delegatedToMise: false,
    ...over,
  });

  it('names the push, the lock in the commit and the wait for the registry', () => {
    const text = renderPublishPlan(plan());
    expect(text).toContain('package.json and package-lock.json → `1.1.0`');
    expect(text).toContain('`git push --follow-tags` → origin/main (with 2 local commit(s) not pushed yet)');
    expect(text).toContain('Wait until the registry shows 1.1.0');
    expect(renderPublishPlan(plan({ push: { enabled: true, upstream: null, ahead: 0, behind: 0 } }))).toContain(
      'Not pushed: the branch has no upstream',
    );
  });

  it('an expired npm login is a step of the plan, not a dead end — the 0.16.0 and 0.19.0 releases', () => {
    const p = plan({
      preflight: [
        { name: 'npm-auth', ok: false, message: 'not logged in', fix: { cmd: 'npm', args: ['login'] } },
        { name: 'fake', ok: true, message: 'ok' },
      ],
      preflightPassed: false,
    });
    expect(preflightFixable(p)).toBe(true);
    const text = renderPublishPlan(p);
    expect(text).toContain('0. `npm login` — at a terminal, then the pre-flight again');
    expect(text).not.toContain('Pre-flight failed');
    const dirty = plan({
      preflight: [...p.preflight, { name: 'working-tree-clean', ok: false, message: '1 uncommitted file(s)' }],
      preflightPassed: false,
    });
    expect(preflightFixable(dirty)).toBe(false);
    expect(renderPublishPlan(dirty)).toContain('Pre-flight failed');
  });

  it('renders delegated-to-mise mode', () => {
    const text = renderPublishPlan({
      stack: 'node',
      packageName: '(delegated)',
      currentVersion: '',
      newVersion: '',
      bump: 'patch',
      packageJsonPath: '',
      preflight: [{ name: 'mise-override', ok: true, message: 'delegating' }],
      preflightPassed: true,
      delegatedToMise: true,
    });
    expect(text).toMatch(/delegated to/);
    expect(text).toMatch(/mise run publish/);
  });
});

describe('the release goes out whole: lock, push, registry', () => {
  let dir: string;
  let work: string;
  let logs: string[];
  const git = (args: string[], cwd = work) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-publish-')));
    work = path.join(dir, 'work');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(dir, 'remote.git')]);
    execFileSync('git', ['clone', '-q', path.join(dir, 'remote.git'), work], { stdio: 'ignore' });
    for (const [k, v] of [
      ['user.name', 'T'],
      ['user.email', 't@example.org'],
      ['commit.gpgsign', 'false'],
      ['tag.gpgsign', 'false'],
      ['core.hooksPath', '/dev/null'],
    ]) git(['config', k!, v!]);
    git(['checkout', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }, null, 2) + '\n');
    fs.writeFileSync(
      path.join(work, 'package-lock.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'demo', version: '1.0.0' } } }, null, 2) + '\n',
    );
    git(['add', '.']);
    git(['commit', '-q', '-m', 'init']);
    git(['push', '-q', '-u', 'origin', 'main']);
    logs = [];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const deps = (over: Partial<PublishDeps> = {}): PublishDeps & { npmRuns: string[][] } => {
    const npmRuns: string[][] = [];
    let views = 0;
    return {
      npmRuns,
      run: (cmd, args, cwd) => {
        if (cmd === 'npm') npmRuns.push(args);
        else execFileSync(cmd, args, { cwd, stdio: 'ignore' });
      },
      // The registry shows the version on the second look, as after a real 202.
      npm: (args) => {
        if (args[0] === 'view' && ++views >= 2) return '1.1.0\n';
        throw Object.assign(new Error('E404'), { stderr: 'npm error code E404' });
      },
      log: (l) => logs.push(l),
      sleep: () => {},
      registryWaitMs: 60_000,
      ...over,
    };
  };
  const releasePlan = (over: Partial<PublishPlan> = {}): PublishPlan => ({
    projectRoot: work,
    stack: 'node',
    packageName: 'demo',
    currentVersion: '1.0.0',
    newVersion: '1.1.0',
    bump: 'minor',
    packageJsonPath: path.join(work, 'package.json'),
    lockPath: path.join(work, 'package-lock.json'),
    push: planPush(work, true),
    preflight: [],
    preflightPassed: true,
    delegatedToMise: false,
    ...over,
  });

  it('knows the upstream and how far apart they are', () => {
    expect(planPush(work, true)).toEqual({ enabled: true, upstream: 'origin/main', ahead: 0, behind: 0 });
    fs.writeFileSync(path.join(work, 'a'), 'a');
    git(['add', 'a']);
    git(['commit', '-q', '-m', 'a']);
    expect(planPush(work, true).ahead).toBe(1);
    git(['reset', '-q', '--hard', 'HEAD~1']);
    git(['commit', '-q', '--allow-empty', '-m', 'b']);
    git(['push', '-q']);
    git(['reset', '-q', '--hard', 'HEAD~1']);
    expect(planPush(work, true)).toMatchObject({ ahead: 0, behind: 1 });
    git(['checkout', '-q', '-b', 'side']);
    expect(planPush(work, false)).toEqual({ enabled: false, upstream: null, ahead: 0, behind: 0 });
  });

  it('refuses before anything when the branch is behind its upstream — the push would fail after npm publish', () => {
    const behind: GitRunner = (args) => {
      if (args.includes('@{u}') && args[0] === 'rev-parse') return 'origin/main\n';
      if (args.includes('HEAD..@{u}')) return '3\n';
      if (args[0] === 'status') return '';
      return '0\n';
    };
    const projectRoot = path.join(FIXTURES, 'node-with-vitest');
    const ctx: Ctx = { projectRoot, stack: 'node', cache: new Map() };
    const p = planPublish({ projectRoot, bump: 'patch', dryRun: true, force: false }, mockAudit(), ctx, fixtureNpm(), behind);
    expect(p.preflight.find((c) => c.name === 'push-target')).toMatchObject({ ok: false });
    expect(p.preflight.find((c) => c.name === 'push-target')?.message).toContain('origin/main has 3 commit(s)');
    const off = planPublish({ projectRoot, bump: 'patch', dryRun: true, force: false, push: false }, mockAudit(), ctx, fixtureNpm(), behind);
    expect(off.preflight.find((c) => c.name === 'push-target')).toBeUndefined();
  });

  it('bumps package.json and the lock, commits both, tags, pushes the tag and waits for the registry', () => {
    const d = deps();
    executePublish(releasePlan(), d);
    expect(d.npmRuns).toEqual([['publish']]);
    expect(JSON.parse(fs.readFileSync(path.join(work, 'package-lock.json'), 'utf8'))).toMatchObject({
      version: '1.1.0',
      packages: { '': { version: '1.1.0' } },
    });
    expect(git(['show', '--name-only', '--format=%s', 'HEAD']).trim().split('\n')).toEqual([
      'release: v1.1.0',
      '',
      'package-lock.json',
      'package.json',
    ]);
    expect(git(['ls-remote', '--tags', 'origin', 'v1.1.0'])).toContain('refs/tags/v1.1.0');
    expect(git(['rev-parse', 'HEAD'])).toBe(git(['rev-parse', 'origin/main']));
    expect(logs.join('\n')).toMatch(/✓ demo@1\.1\.0 is on the registry/);
  });

  it('--no-push leaves the commit and the tag here', () => {
    executePublish(releasePlan({ push: planPush(work, false) }), deps());
    expect(git(['ls-remote', '--tags', 'origin', 'v1.1.0'])).toBe('');
    expect(logs.join('\n')).toContain('not pushed (--no-push)');
  });

  it('a failed npm publish puts both files back and commits nothing', () => {
    const d = deps({
      run: (cmd, args, cwd) => {
        if (cmd === 'npm') throw Object.assign(new Error('E403'), { status: 1 });
        execFileSync(cmd, args, { cwd, stdio: 'ignore' });
      },
    });
    expect(() => executePublish(releasePlan(), d)).toThrow('npm publish failed');
    expect(git(['status', '--porcelain'])).toBe('');
    expect(git(['log', '--format=%s'])).toBe('init\n');
  });

  it('a version the registry has not shown in time is reported, not failed — npm took it', () => {
    const d = deps({ npm: () => { throw new Error('E404'); }, registryWaitMs: 0 });
    expect(waitForRegistry('demo', '1.1.0', d)).toBe(false);
    expect(logs.join('\n')).toContain('not visible on the registry after 0 min — npm accepted it');
  });

  it('writes the lock back in npm\'s own format', () => {
    const text = fs.readFileSync(path.join(work, 'package-lock.json'), 'utf8');
    expect(bumpLockText(text, '1.0.0')).toBe(text);
  });
});
