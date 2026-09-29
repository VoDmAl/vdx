import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type NpmRunner,
  bumpSemver,
  checkNpmAuth,
  compareSemver,
  planPublish,
  publishRegistry,
  renderPublishPlan,
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
    expect(text).toMatch(/NOT pushed/);
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
