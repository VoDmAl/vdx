import { describe, expect, it } from 'vitest';
import { evalAxis, projectLevel, type AxisResult } from '../../src/scoring.ts';
import type { Axis, Rubric } from '../../src/rubric.ts';
import type { Ctx } from '../../src/facts.ts';

function mkCtx(stack = 'node'): Ctx {
  return { projectRoot: '/dev/null', stack, cache: new Map() };
}

function levelAxis(levels: Partial<Record<'L1' | 'L2' | 'L3' | 'L4', boolean>>): Axis {
  const requires = (pass: boolean) => (pass ? { always_true: {} } : { has_file: 'nonexistent-path' });
  return {
    id: 'tests',
    class: 'critical',
    storage: 'level',
    default_target: 'L4',
    levels: {
      L1: { requires: requires(levels.L1 ?? false) },
      L2: { requires: requires(levels.L2 ?? false) },
      L3: { requires: requires(levels.L3 ?? false) },
      L4: { requires: requires(levels.L4 ?? false) },
    },
  } as Axis;
}

describe('evalAxis — delta-style levels', () => {
  it('L0 when L1 predicate fails', () => {
    expect(evalAxis(levelAxis({ L1: false }), mkCtx())).toBe('L0');
  });

  it('continuous run stops at first false (L1 only)', () => {
    expect(evalAxis(levelAxis({ L1: true, L2: false, L3: true, L4: true }), mkCtx())).toBe('L1');
  });

  it('full run reaches L4', () => {
    expect(evalAxis(levelAxis({ L1: true, L2: true, L3: true, L4: true }), mkCtx())).toBe('L4');
  });

  it('break semantics: L3 passes but L2 fails → cap at L1', () => {
    expect(evalAxis(levelAxis({ L1: true, L2: false, L3: true }), mkCtx())).toBe('L1');
  });
});

describe('evalAxis — flags-storage axis', () => {
  function flagsAxis(passes: boolean[]): Axis {
    return {
      id: 'static-analysis',
      class: 'critical',
      storage: 'flags',
      default_target: 'L4',
      stack_implementations: {
        node: {
          flags: passes.map((p, i) => ({
            id: `flag${i}`,
            weight: 1.0,
            predicate: p ? { always_true: {} } : { has_file: 'nope' },
          })),
          level_thresholds: { L1: 0.1, L2: 0.35, L3: 0.65, L4: 0.85 },
        },
      },
    } as Axis;
  }

  it('0 of 4 → L0', () => {
    expect(evalAxis(flagsAxis([false, false, false, false]), mkCtx())).toBe('L0');
  });

  it('1 of 4 (0.25) → L1', () => {
    expect(evalAxis(flagsAxis([true, false, false, false]), mkCtx())).toBe('L1');
  });

  it('2 of 4 (0.5) → L2', () => {
    expect(evalAxis(flagsAxis([true, true, false, false]), mkCtx())).toBe('L2');
  });

  it('3 of 4 (0.75) → L3', () => {
    expect(evalAxis(flagsAxis([true, true, true, false]), mkCtx())).toBe('L3');
  });

  it('4 of 4 (1.0) → L4', () => {
    expect(evalAxis(flagsAxis([true, true, true, true]), mkCtx())).toBe('L4');
  });

  it('unknown stack → L0', () => {
    expect(evalAxis(flagsAxis([true, true, true, true]), mkCtx('python'))).toBe('L0');
  });
});

describe('projectLevel — weighted two-class', () => {
  const rubric = { scoring: { supporting_threshold: 0.8 } } as Rubric;

  function r(axis_id: string, cls: 'critical' | 'supporting', achieved: AxisResult['achieved']): AxisResult {
    return { axis_id, class: cls, achieved, target: 'L4', drift_kind: 'aligned' };
  }

  it('only critical, all at L2 → L2', () => {
    const res = [r('ci', 'critical', 'L2'), r('tests', 'critical', 'L2')];
    expect(projectLevel(res, rubric, new Set())).toBe('L2');
  });

  it('critical capped by lowest', () => {
    const res = [r('ci', 'critical', 'L3'), r('tests', 'critical', 'L1')];
    expect(projectLevel(res, rubric, new Set())).toBe('L1');
  });

  it('supporting <80% blocks level', () => {
    const res = [
      r('ci', 'critical', 'L3'),
      r('docs', 'supporting', 'L3'),
      r('git-hygiene', 'supporting', 'L3'),
      r('reproducibility', 'supporting', 'L0'),
      r('observability', 'supporting', 'L0'),
    ];
    // 2 of 4 supporting at L3 = 0.5 < 0.8 → fall to L0 (none at L1 either)
    expect(projectLevel(res, rubric, new Set())).toBe('L0');
  });

  it('supporting ≥80% allows level', () => {
    const res = [
      r('ci', 'critical', 'L2'),
      r('docs', 'supporting', 'L2'),
      r('git-hygiene', 'supporting', 'L2'),
      r('reproducibility', 'supporting', 'L2'),
      r('observability', 'supporting', 'L1'),
    ];
    // 3 of 4 supporting at L2 = 0.75 < 0.8 → cap at L1 (4 of 4 at L1)
    expect(projectLevel(res, rubric, new Set())).toBe('L1');
  });

  it('excluded axes ignored', () => {
    const res = [
      r('ci', 'critical', 'L2'),
      { ...r('tests', 'critical', 'L0'), drift_kind: 'excluded' as const },
    ];
    expect(projectLevel(res, rubric, new Set())).toBe('L2');
  });

  it('suppressed axes ignored', () => {
    const res = [r('ci', 'critical', 'L2'), r('tests', 'critical', 'L0')];
    expect(projectLevel(res, rubric, new Set(['tests']))).toBe('L2');
  });

  it('no critical, no supporting → L4 (vacuously)', () => {
    expect(projectLevel([], rubric, new Set())).toBe('L4');
  });
});
