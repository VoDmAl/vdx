import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planInit, selectVerbTask } from '../../src/init.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, '..', 'fixtures');

describe('planInit: stack=unknown', () => {
  it('emits warning when autoDetectStack returns unknown without override', () => {
    const plan = planInit(path.join(FIXTURES, 'empty'));
    expect(plan.stack).toBe('unknown');
    expect(plan.stackOverridden).toBe(false);
    expect(plan.warnings.length).toBeGreaterThan(0);
    expect(plan.warnings[0]).toMatch(/unknown/);
    expect(plan.miseTomlContent).toMatch(/TODO\(vdx\)/);
  });

  it('respects --stack override and suppresses unknown warning', () => {
    const plan = planInit(path.join(FIXTURES, 'empty'), { stack: 'node' });
    expect(plan.stack).toBe('node');
    expect(plan.stackOverridden).toBe(true);
    expect(plan.warnings).toHaveLength(0);
    expect(plan.miseTomlContent).not.toMatch(/TODO\(vdx\)/);
    expect(plan.miseTomlContent).toMatch(/stack = "node"/);
  });
});

describe('planInit: stack=meta', () => {
  it('reports empty subpackages when none found', () => {
    const plan = planInit(path.join(FIXTURES, 'empty'), { stack: 'meta' });
    expect(plan.stack).toBe('meta');
    expect(plan.primarySubpackage).toBeNull();
    expect(plan.warnings.some((w) => /nested manifest не найден/.test(w))).toBe(true);
  });

  it('resolves single subpackage and uses its tasks', () => {
    const plan = planInit(path.join(FIXTURES, 'meta-single-subpkg'), { stack: 'meta' });
    expect(plan.stack).toBe('meta');
    expect(plan.primarySubpackage).toBe('api');
    expect(plan.miseTomlContent).toMatch(/primary_subpackage = "api"/);
    const testMapping = plan.mappings.find((m) => m.verb === 'test');
    expect(testMapping?.runCommand).toBe('cd api && npm run test');
    const buildMapping = plan.mappings.find((m) => m.verb === 'build');
    expect(buildMapping?.runCommand).toBe('cd api && npm run build');
  });
});

describe('planInit: regular stacks (regression)', () => {
  it('node fixture detects vitest test task', () => {
    const plan = planInit(path.join(FIXTURES, 'node-with-vitest'));
    expect(plan.stack).toBe('node');
    expect(plan.stackOverridden).toBe(false);
    expect(plan.warnings).toHaveLength(0);
    const testMapping = plan.mappings.find((m) => m.verb === 'test');
    expect(testMapping?.runCommand).toBe('npm run test');
    expect(testMapping?.reason).toBe('exact');
  });
});

describe('selectVerbTask: reason classification', () => {
  it('exact match wins, sibling aliases reported as alternatives', () => {
    const tasks = new Set(['build', 'build-prod', 'build-dev']);
    const r = selectVerbTask('build', tasks);
    expect(r.task).toBe('build');
    expect(r.reason).toBe('exact');
    expect(r.alternatives).toEqual(['build-dev', 'build-prod']);
  });

  it('alias fallback when verb name absent', () => {
    const tasks = new Set(['phpunit', 'vitest']);
    const r = selectVerbTask('test', tasks);
    expect(r.task).toBe('phpunit');
    expect(r.reason).toBe('alias');
    expect(r.alternatives).toContain('vitest');
  });

  it('prefix-group picks canonical hint (build:prod) via alias before prefix-group fires', () => {
    const tasks = new Set(['build:dev', 'build:prod', 'build:assets']);
    const r = selectVerbTask('build', tasks);
    expect(r.reason).toBe('alias');
    expect(r.task).toBe('build:prod');
    expect(r.alternatives).toEqual(['build:assets', 'build:dev']);
  });

  it('prefix-group fires when no alias matches', () => {
    const tasks = new Set(['build:cache', 'build:docs', 'build:db:migrations']);
    const r = selectVerbTask('build', tasks);
    expect(r.reason).toBe('prefix-group');
    expect(r.task).toBeTruthy();
    expect(r.alternatives.length).toBeGreaterThan(0);
  });

  it('suffix-group catches monorepo `server:test`', () => {
    const tasks = new Set(['server:test', 'docker:up']);
    const r = selectVerbTask('test', tasks);
    expect(r.task).toBe('server:test');
    expect(r.reason).toBe('suffix-group');
    expect(r.alternatives).toEqual([]);
  });

  it('suffix-group picks shortest when multiple monorepo packages have same verb', () => {
    const tasks = new Set(['server:test', 'admin-api:test']);
    const r = selectVerbTask('test', tasks);
    expect(r.reason).toBe('suffix-group');
    expect(r.task).toBe('server:test');
    expect(r.alternatives).toEqual(['admin-api:test']);
  });

  it('returns not-found when no candidate exists', () => {
    const tasks = new Set(['docker:up', 'docker:down']);
    const r = selectVerbTask('fix', tasks);
    expect(r.task).toBeNull();
    expect(r.reason).toBe('not-found');
    expect(r.alternatives).toEqual([]);
  });
});

describe('planInit: monorepo with server/ subdir', () => {
  it('maps verbs across root docker:* and server:test via suffix-group', () => {
    const plan = planInit(path.join(FIXTURES, 'node-monorepo-with-server'));
    const byVerb = Object.fromEntries(plan.mappings.map((m) => [m.verb, m]));
    expect(byVerb.up?.runCommand).toBe('npm run docker:up');
    expect(byVerb.up?.reason).toBe('alias');
    expect(byVerb.test?.runCommand).toBe('npm run server:test');
    expect(byVerb.test?.reason).toBe('suffix-group');
    expect(byVerb.check?.runCommand).toBeNull();
    expect(byVerb.check?.reason).toBe('not-found');
  });
});
