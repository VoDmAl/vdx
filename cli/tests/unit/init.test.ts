import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planInit } from '../../src/init.ts';

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
  });
});
