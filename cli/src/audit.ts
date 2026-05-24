import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Rubric, LevelName } from './rubric.ts';
import { findSubPackages, stackForDir, type Ctx } from './facts.ts';
import { evalPredicate } from './evaluator.ts';
import type { Override, VdxManifest } from './manifest.ts';
import { evalAxis, projectLevel, type AxisResult } from './scoring.ts';

function levelToInt(L: LevelName): number {
  return parseInt(L.slice(1), 10);
}

export interface AuditResult {
  baseline: string;
  stack: string;
  achieved_level: LevelName;
  per_axis: Array<AxisResult & { suppressed?: boolean; override_target?: LevelName }>;
  overrides: Override[];
  expired_overrides: string[];
  primary_subpackage?: string;
}

/**
 * Резолвит ctx для stack-specific осей (с `applies_to`). Источник subpackage:
 *   1. manifest.primary_subpackage (explicit) — если папка существует.
 *   2. findSubPackages() auto-detect — если ровно один subpackage совпадает с ctx.stack.
 *   3. fallback на root ctx.
 *
 * Возвращает `{ ctx, relPath }` где relPath — относительный путь либо null
 * (если subpackage не разрезолвился — будем использовать root).
 */
function resolveSubpackageCtx(
  ctx: Ctx,
  manifest: VdxManifest | null,
): { ctx: Ctx; relPath: string | null } {
  let relPath: string | null = null;
  let subpackageStack: string | null = null;

  if (manifest?.primary_subpackage) {
    const p = manifest.primary_subpackage;
    const abs = path.join(ctx.projectRoot, p);
    if (fs.existsSync(abs)) {
      relPath = p;
      subpackageStack = stackForDir(abs);
    } else {
      process.stderr.write(
        `warning: primary_subpackage "${p}" does not exist — falling back to root\n`,
      );
    }
  } else {
    const subs = findSubPackages(ctx.projectRoot);
    const matching = subs.filter((s) => s.stack === ctx.stack);
    if (matching.length === 1) {
      relPath = matching[0]!.relPath;
      subpackageStack = matching[0]!.stack;
    } else if (matching.length === 0 && subs.length === 1) {
      // O33: single sub-package with a stack different from ctx.stack —
      // adopt it so applies_to-axes for that stack can evaluate.
      relPath = subs[0]!.relPath;
      subpackageStack = subs[0]!.stack;
    }
  }

  if (!relPath) return { ctx, relPath: null };
  return {
    ctx: {
      projectRoot: path.join(ctx.projectRoot, relPath),
      stack: subpackageStack ?? ctx.stack,
      cache: new Map(),
    },
    relPath,
  };
}

export function audit(
  rubric: Rubric,
  ctx: Ctx,
  overrides: Override[],
  baselineRef: string,
  manifest: VdxManifest | null = null,
): AuditResult {
  const suppressed = new Set<string>();
  const overrideByAxis = new Map<string, Override>();
  const expired: string[] = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const ov of overrides) {
    overrideByAxis.set(ov.axis, ov);
    if (ov.suppress) suppressed.add(ov.axis);
    if (ov.until && ov.until < today) expired.push(ov.axis);
  }

  const { ctx: subpackageCtx, relPath: subpackagePath } = resolveSubpackageCtx(ctx, manifest);

  const perAxis: AuditResult['per_axis'] = [];
  for (const axis of rubric.axes) {
    if (suppressed.has(axis.id)) {
      perAxis.push({
        axis_id: axis.id,
        class: axis.class,
        achieved: 'L0',
        target: axis.default_target,
        drift_kind: 'aligned',
        suppressed: true,
      });
      continue;
    }
    const evalCtx = axis.applies_to ? subpackageCtx : ctx;
    if (axis.applies_to && !axis.applies_to.includes(evalCtx.stack)) {
      perAxis.push({
        axis_id: axis.id,
        class: axis.class,
        achieved: 'L0',
        target: axis.default_target,
        drift_kind: 'excluded',
      });
      continue;
    }
    if (axis.applies_when && !evalPredicate(axis.applies_when, evalCtx)) {
      perAxis.push({
        axis_id: axis.id,
        class: axis.class,
        achieved: 'L0',
        target: axis.default_target,
        drift_kind: 'excluded',
      });
      continue;
    }
    const achieved = evalAxis(axis, evalCtx);
    const ov = overrideByAxis.get(axis.id);
    const target = (ov?.target as LevelName) ?? axis.default_target;
    const drift: 'aligned' | 'gap' | 'over' =
      levelToInt(achieved) === levelToInt(target)
        ? 'aligned'
        : levelToInt(achieved) < levelToInt(target)
          ? 'gap'
          : 'over';
    const entry: AuditResult['per_axis'][number] = {
      axis_id: axis.id,
      class: axis.class,
      achieved,
      target,
      drift_kind: drift,
    };
    if (ov?.target) entry.override_target = ov.target as LevelName;
    perAxis.push(entry);
  }

  const overall = projectLevel(perAxis, rubric, suppressed);

  const result: AuditResult = {
    baseline: baselineRef,
    stack: ctx.stack,
    achieved_level: overall,
    per_axis: perAxis,
    overrides,
    expired_overrides: expired,
  };
  if (subpackagePath) result.primary_subpackage = subpackagePath;
  return result;
}
