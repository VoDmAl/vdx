import { describe, expect, it } from 'vitest';
import { evalVerdict, isUnknown } from '../../src/evaluator.ts';
import { parseRubric, compareSchema, SUPPORTED_SCHEMA } from '../../src/rubric.ts';
import { evalAxisDetailed, projectLevel, shownLevel, type AxisResult } from '../../src/scoring.ts';
import { reportMarkdown } from '../../src/report.ts';
import type { Axis, Rubric } from '../../src/rubric.ts';
import type { Ctx } from '../../src/facts.ts';

const ctx = (): Ctx => ({ projectRoot: '/dev/null', stack: 'node', cache: new Map() });
const T = { always_true: {} };
const F = { has_file: 'nonexistent-path' };
const U = { branch_requires_checks: {} }; // unknown everywhere today

describe('three-valued predicates', () => {
  it('a predicate can answer unknown, with its reason', () => {
    const v = evalVerdict(U, ctx());
    expect(isUnknown(v)).toBe(true);
    expect(isUnknown(v) && v.unknown).toMatch(/hosting/);
  });
  it('any_of: true wins over unknown; unknown wins over false', () => {
    expect(evalVerdict({ any_of: [U, T] }, ctx())).toBe(true);
    expect(isUnknown(evalVerdict({ any_of: [F, U] }, ctx()))).toBe(true);
    expect(evalVerdict({ any_of: [F, F] }, ctx())).toBe(false);
  });
  it('all_of: false wins over unknown; unknown wins over true', () => {
    expect(evalVerdict({ all_of: [U, F] }, ctx())).toBe(false);
    expect(isUnknown(evalVerdict({ all_of: [T, U] }, ctx()))).toBe(true);
    expect(evalVerdict({ all_of: [T, T] }, ctx())).toBe(true);
  });
  it('at_least_n_of: decided when the unknowns cannot change it', () => {
    expect(evalVerdict({ at_least_n_of: { n: 1, predicates: [T, U] } }, ctx())).toBe(true);
    expect(evalVerdict({ at_least_n_of: { n: 2, predicates: [F, F, U] } }, ctx())).toBe(false);
    expect(isUnknown(evalVerdict({ at_least_n_of: { n: 2, predicates: [T, F, U] } }, ctx()))).toBe(true);
  });
  it('not keeps unknown unknown', () => {
    expect(isUnknown(evalVerdict({ not: U }, ctx()))).toBe(true);
    expect(evalVerdict({ not: F }, ctx())).toBe(true);
  });
});

const rubricText = (schema: string, requires: string) => `
schema_version: "${schema}"
metadata: { name: t, version: "1.0.0" }
scoring: { formula: weighted_two_class, supporting_threshold: 0.8 }
levels: {}
axes:
  - id: a
    class: critical
    storage: level
    levels:
      L1: { requires: ${requires} }
`;

describe('rubric schema', () => {
  it('reads up to 0.3', () => {
    expect(SUPPORTED_SCHEMA).toBe('0.3');
    expect(compareSchema('0.2', '0.3')).toBe(-1);
    expect(compareSchema('0.10', '0.3')).toBe(1);
  });
  it('refuses a set newer than it reads, instead of misreading it', () => {
    expect(() => parseRubric(rubricText('0.4', '{ always_true: {} }'), 'x.yaml')).toThrow(/schema 0\.4.*up to 0\.3.*update vdx/);
  });
  it('a 0.3 set that names a removed predicate does not load', () => {
    for (const name of ['gh_workflow_blocks_pr', 'git_hook_installed', 'command_succeeds']) {
      expect(() => parseRubric(rubricText('0.3', `{ ${name}: {} }`), 'x.yaml')).toThrow(new RegExp(`${name} \\(removed in schema 0\\.3\\)`));
    }
  });
  it('a 0.3 set that names an unknown predicate does not load', () => {
    expect(() => parseRubric(rubricText('0.3', '{ any_of: [{ no_such_thing: {} }] }'), 'x.yaml')).toThrow(/a\.L1: no_such_thing \(unknown predicate\)/);
  });
  it('a 0.2 set keeps loading with the removed predicates, as before', () => {
    expect(parseRubric(rubricText('0.2', '{ gh_workflow_blocks_pr: {} }'), 'x.yaml').axes).toHaveLength(1);
  });
});

function axis(levels: Axis['levels']): Axis {
  return { id: 'bp', class: 'critical', storage: 'level', default_target: 'L4', levels } as Axis;
}

describe('not_required levels and unknown', () => {
  const bp = axis({ L1: { not_required: true }, L2: { not_required: true }, L3: { requires: U }, L4: { not_required: true } });

  it('counts levels that ask nothing as met, and stops at the unknown one, naming it', () => {
    const e = evalAxisDetailed(bp, ctx());
    expect(e.achieved).toBe('L2');
    expect(e.not_required).toEqual(['L1', 'L2']);
    expect(e.unknown?.level).toBe('L3');
  });
  it('when L3 is met, L4 asks nothing more', () => {
    const e = evalAxisDetailed(axis({ L1: { not_required: true }, L2: { not_required: true }, L3: { requires: T }, L4: { not_required: true } }), ctx());
    expect(e.achieved).toBe('L4');
    expect(shownLevel(e)).toBe('L3');
  });
  it('a report never shows a level nothing was asked for', () => {
    expect(shownLevel({ achieved: 'L2', not_required: ['L1', 'L2'] })).toBeNull();
    expect(shownLevel({ achieved: 'L2' })).toBe('L2');
    expect(shownLevel({ achieved: 'L0' })).toBe('L0');
  });
  it('a critical axis that asks nothing below L3 does not hold the overall level below L3', () => {
    const rubric = { scoring: { supporting_threshold: 0.8 } } as Rubric;
    const r = (axis_id: string, achieved: AxisResult['achieved']): AxisResult =>
      ({ axis_id, class: 'critical', achieved, target: 'L4', drift_kind: 'gap' });
    expect(projectLevel([r('tests', 'L2'), r('bp', 'L2')], rubric, new Set())).toBe('L2');
    expect(projectLevel([r('tests', 'L4'), r('bp', 'L2')], rubric, new Set())).toBe('L2');
  });
  it('the report marks the unchecked level and lists why', () => {
    const md = reportMarkdown({
      baseline: 'b',
      stack: 'node',
      achieved_level: 'L1',
      per_axis: [
        { axis_id: 'branch-protection', class: 'critical', achieved: 'L2', target: 'L4', drift_kind: 'gap', not_required: ['L1', 'L2'], unknown: { level: 'L3', reason: 'only the hosting knows' } },
        { axis_id: 'ci', class: 'critical', achieved: 'L1', target: 'L4', drift_kind: 'gap', unknown: { level: 'L2', reason: 'not GitLab CI' } },
        { axis_id: 'git-hygiene', class: 'supporting', achieved: 'L2', target: 'L4', drift_kind: 'gap', note: 'husky: off here → npm install' },
      ],
      overrides: [],
      expired_overrides: [],
    });
    expect(md).toContain('| `branch-protection` | **C** | — (L3 ?) |');
    expect(md).toContain('| `ci` | **C** | L1 · L2 ? |');
    expect(md).toContain('| `git-hygiene` | s | L2 ⚑ |');
    expect(md).toContain('- `ci` L2: not GitLab CI');
    expect(md).toContain('## In this clone');
    expect(md).toContain('- `git-hygiene`: husky: off here → npm install');
  });
});
