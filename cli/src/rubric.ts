import * as fs from 'node:fs';
import YAML from 'js-yaml';
import { COMBINATORS, predicateNames } from './evaluator.ts';
import { REGISTRY, REMOVED_IN_0_3 } from './predicates.ts';

export type LevelName = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
export type AxisClass = 'critical' | 'supporting';
export type Storage = 'level' | 'flags';

// Predicate структура динамическая — оставляем any для дешёвого парсинга
// со сахаром. Валидация — отдельная история v0.2.
export type Predicate = unknown;

export interface Flag {
  id: string;
  weight: number;
  predicate: Predicate;
}

export interface StackImpl {
  flags?: Flag[];
  level_thresholds?: Partial<Record<LevelName, number>>;
}

export interface Axis {
  id: string;
  class: AxisClass;
  description?: string;
  storage: Storage;
  default_target: LevelName;
  fact_sources?: string[];
  /**
   * A level is either a requirement or, from schema 0.3, `not_required`: the
   * axis asks nothing at that level (branch-protection below L3). Such a level
   * counts as met for the overall level, and the report does not show it as
   * an achievement.
   */
  levels?: Partial<Record<LevelName, { requires?: Predicate; not_required?: boolean }>>;
  stack_implementations?: Record<string, StackImpl>;
  applies_to?: string[];
  applies_when?: Predicate;
  /**
   * From schema 0.3: a clone check whose result `vdx audit` prints next to the
   * axis without changing its level — `git-hooks`: are the declared hooks on
   * in this clone. A clone property cannot be a level (the same tag would score
   * differently per clone), and without the note only `vdx doctor` would see it.
   */
  clone_check?: 'git-hooks';
}

export interface Rubric {
  schema_version: string;
  metadata: {
    name: string;
    version: string;
    owner?: string;
    description?: string;
    homepage?: string;
  };
  scoring: {
    formula: string;
    supporting_threshold: number;
  };
  levels: Record<LevelName, { name: string; description: string }>;
  axes: Axis[];
}

/** The newest rubric schema this CLI reads. A newer set is refused, not misread. */
export const SUPPORTED_SCHEMA = '0.3';

function schemaParts(v: string): [number, number] | null {
  const m = String(v).match(/^(\d+)\.(\d+)$/);
  return m ? [parseInt(m[1]!, 10), parseInt(m[2]!, 10)] : null;
}

/** -1 / 0 / 1 as `a` is older / equal / newer than `b`; null when either is not `M.m`. */
export function compareSchema(a: string, b: string): number | null {
  const pa = schemaParts(a);
  const pb = schemaParts(b);
  if (!pa || !pb) return null;
  return pa[0] !== pb[0] ? Math.sign(pa[0] - pb[0]) : Math.sign(pa[1] - pb[1]);
}

/**
 * Predicates a 0.3 set may not name: removed ones, and any the registry does
 * not know. In 0.2 an unknown name is a warning at evaluation, as it was.
 */
function invalidPredicates(rubric: Rubric): string[] {
  const out = new Set<string>();
  const check = (p: unknown, where: string) => {
    for (const name of predicateNames(p)) {
      if ((COMBINATORS as readonly string[]).includes(name)) continue;
      if (REMOVED_IN_0_3.has(name)) out.add(`${where}: ${name} (removed in schema 0.3)`);
      else if (!REGISTRY[name]) out.add(`${where}: ${name} (unknown predicate)`);
    }
  };
  for (const ax of rubric.axes) {
    if (ax.applies_when !== undefined) check(ax.applies_when, `${ax.id}.applies_when`);
    for (const [L, lvl] of Object.entries(ax.levels ?? {})) {
      if (lvl?.requires !== undefined) check(lvl.requires, `${ax.id}.${L}`);
    }
    for (const [stack, impl] of Object.entries(ax.stack_implementations ?? {})) {
      for (const f of impl.flags ?? []) check(f.predicate, `${ax.id}.${stack}.${f.id}`);
    }
  }
  return [...out];
}

export function parseRubric(text: string, source: string): Rubric {
  const data = YAML.load(text) as Rubric;
  if (!data || !data.schema_version || !data.axes) {
    throw new Error(`Invalid rubric at ${source}: missing schema_version or axes`);
  }
  const schema = String(data.schema_version);
  const cmp = compareSchema(schema, SUPPORTED_SCHEMA);
  if (cmp === null) {
    throw new Error(`Invalid rubric at ${source}: schema_version "${schema}" is not of the form M.m`);
  }
  if (cmp > 0) {
    throw new Error(
      `rubric ${source} is schema ${schema}; this vdx reads up to ${SUPPORTED_SCHEMA} — ` +
        `update vdx (npm i -g @vodmal/vdx-cli@latest)`,
    );
  }
  // нормализуем default_target (если кто-то напишет "L4" со spaces)
  for (const ax of data.axes) {
    ax.default_target = (ax.default_target ?? 'L4') as LevelName;
    ax.storage = (ax.storage ?? 'level') as Storage;
  }
  if (compareSchema(schema, '0.3')! >= 0) {
    const bad = invalidPredicates(data);
    if (bad.length > 0) {
      throw new Error(`rubric ${source} (schema ${schema}) names predicates it may not:\n  ${bad.join('\n  ')}`);
    }
  }
  return data;
}

export function loadRubric(yamlPath: string): Rubric {
  return parseRubric(fs.readFileSync(yamlPath, 'utf8'), yamlPath);
}
