import type { Axis, LevelName, Rubric } from './rubric.ts';
import type { Ctx } from './facts.ts';
import { evalPredicate } from './evaluator.ts';

const LEVELS: LevelName[] = ['L1', 'L2', 'L3', 'L4'];

function levelToInt(L: LevelName): number {
  return parseInt(L.slice(1), 10);
}

export interface AxisResult {
  axis_id: string;
  class: 'critical' | 'supporting';
  achieved: LevelName;
  target: LevelName;
  drift_kind: 'aligned' | 'gap' | 'over' | 'excluded';
}

export function evalAxis(axis: Axis, ctx: Ctx): LevelName {
  if (axis.storage === 'flags') return evalAxisFlags(axis, ctx);
  return evalAxisLevels(axis, ctx);
}

function evalAxisLevels(axis: Axis, ctx: Ctx): LevelName {
  let achieved: LevelName = 'L0';
  for (const L of LEVELS) {
    const lvl = axis.levels?.[L];
    if (!lvl) break;
    if (evalPredicate(lvl.requires, ctx)) {
      achieved = L;
    } else {
      break; // delta-style: discontinuity → stop ascent
    }
  }
  return achieved;
}

function evalAxisFlags(axis: Axis, ctx: Ctx): LevelName {
  const impl = axis.stack_implementations?.[ctx.stack];
  if (!impl?.flags || !impl.level_thresholds) return 'L0';
  let implemented = 0;
  let total = 0;
  for (const f of impl.flags) {
    total += f.weight;
    if (evalPredicate(f.predicate, ctx)) implemented += f.weight;
  }
  const ratio = total === 0 ? 0 : implemented / total;
  let achieved: LevelName = 'L0';
  for (const L of LEVELS) {
    const th = impl.level_thresholds[L];
    if (th === undefined) continue;
    if (ratio >= th) achieved = L;
    else break;
  }
  return achieved;
}

export function projectLevel(
  results: AxisResult[],
  rubric: Rubric,
  suppressed: Set<string>,
): LevelName {
  const supportingThreshold = rubric.scoring.supporting_threshold ?? 0.8;
  const visible = results.filter(
    (r) => !suppressed.has(r.axis_id) && r.drift_kind !== 'excluded',
  );
  const critical = visible.filter((r) => r.class === 'critical');
  const supporting = visible.filter((r) => r.class === 'supporting');

  for (const L of [...LEVELS].reverse()) {
    const Lint = levelToInt(L);
    const critOk = critical.every((r) => levelToInt(r.achieved) >= Lint);
    if (!critOk) continue;
    if (supporting.length === 0) return L;
    const supRatio = supporting.filter((r) => levelToInt(r.achieved) >= Lint).length / supporting.length;
    if (supRatio >= supportingThreshold) return L;
  }
  return 'L0';
}
