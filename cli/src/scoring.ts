import type { Axis, LevelName, Rubric } from './rubric.ts';
import type { Ctx } from './facts.ts';
import { evalPredicate, evalVerdict, isUnknown } from './evaluator.ts';

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
  /** Levels the axis asks nothing at; counted as met in `achieved`, not shown as an achievement. */
  not_required?: LevelName[];
  /** The level whose requirement could not be checked, and why; the ascent stopped there. */
  unknown?: { level: LevelName; reason: string };
  /** A clone check printed next to the axis; does not change the level. */
  note?: string;
}

export interface AxisEvaluation {
  achieved: LevelName;
  not_required?: LevelName[];
  unknown?: { level: LevelName; reason: string };
}

export function evalAxis(axis: Axis, ctx: Ctx): LevelName {
  return evalAxisDetailed(axis, ctx).achieved;
}

export function evalAxisDetailed(axis: Axis, ctx: Ctx): AxisEvaluation {
  if (axis.storage === 'flags') return { achieved: evalAxisFlags(axis, ctx) };
  return evalAxisLevels(axis, ctx);
}

function evalAxisLevels(axis: Axis, ctx: Ctx): AxisEvaluation {
  let achieved: LevelName = 'L0';
  const notRequired: LevelName[] = [];
  let unknown: AxisEvaluation['unknown'];
  for (const L of LEVELS) {
    const lvl = axis.levels?.[L];
    if (!lvl) break;
    if (lvl.not_required === true) {
      achieved = L;
      notRequired.push(L);
      continue;
    }
    const v = evalVerdict(lvl.requires, ctx);
    if (v === true) {
      achieved = L;
    } else {
      // delta-style: discontinuity → stop ascent; unknown is "not met", named
      if (isUnknown(v)) unknown = { level: L, reason: v.unknown };
      break;
    }
  }
  return {
    achieved,
    ...(notRequired.length > 0 ? { not_required: notRequired } : {}),
    ...(unknown ? { unknown } : {}),
  };
}

/**
 * The level a report shows: the highest met level that asked something.
 * `null` — none did (an unprotected repo's branch-protection is not "L2").
 */
export function shownLevel(r: Pick<AxisResult, 'achieved' | 'not_required'>): LevelName | null {
  let n = levelToInt(r.achieved);
  while (n > 0 && r.not_required?.includes(`L${n}` as LevelName)) n--;
  return n === 0 && r.not_required?.length ? null : (`L${n}` as LevelName);
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
