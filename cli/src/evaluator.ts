import type { Predicate } from './rubric.ts';
import type { Ctx } from './facts.ts';
import { REGISTRY, isUnknown, type Unknown, type Verdict } from './predicates.ts';

export { isUnknown, type Unknown, type Verdict };

/**
 * Sugar shorthand: `{ has_task: "up" }` → `{ fn: "has_task", args: { task: "up" } }`
 * For predicates whose single primary arg has a known name.
 */
const SUGAR_ARG_KEY: Record<string, string> = {
  has_task: 'task',
  has_task_matching: 'pattern',
  has_file: 'path',
  package_present: 'name',
  git_hook_installed: 'hook',
  phpstan_level_at_least: 'n',
};

export const COMBINATORS = ['all_of', 'any_of', 'at_least_n_of', 'not'] as const;

/** The first unknown among verdicts, for the reason a combination cannot be decided. */
function firstUnknown(vs: Verdict[]): Unknown | undefined {
  return vs.find(isUnknown);
}

/**
 * Three-valued: true, false, or unknown with the reason the fact could not be
 * read (a CI system or a hosting vdx does not inspect). Unknown never turns
 * into true: `any_of` is true only on a true branch, `all_of` false on any
 * false branch, otherwise unknown.
 */
export function evalVerdict(p: Predicate, ctx: Ctx): Verdict {
  if (p === null || p === undefined) return false;
  if (typeof p === 'boolean') return p;

  if (typeof p === 'object' && !Array.isArray(p)) {
    const obj = p as Record<string, any>;

    if ('all_of' in obj) {
      const vs = (obj.all_of as Predicate[]).map((q) => evalVerdict(q, ctx));
      if (vs.some((v) => v === false)) return false;
      return firstUnknown(vs) ?? true;
    }
    if ('any_of' in obj) {
      const vs = (obj.any_of as Predicate[]).map((q) => evalVerdict(q, ctx));
      if (vs.some((v) => v === true)) return true;
      return firstUnknown(vs) ?? false;
    }
    if ('at_least_n_of' in obj) {
      const { n, predicates } = obj.at_least_n_of as { n: number; predicates: Predicate[] };
      const vs = predicates.map((q) => evalVerdict(q, ctx));
      const matched = vs.filter((v) => v === true).length;
      if (matched >= n) return true;
      const open = vs.filter(isUnknown).length;
      if (matched + open < n) return false;
      return firstUnknown(vs)!;
    }
    if ('not' in obj) {
      const v = evalVerdict(obj.not, ctx);
      return isUnknown(v) ? v : !v;
    }
    if ('fn' in obj) {
      const fn = REGISTRY[String(obj.fn)];
      if (!fn) {
        process.stderr.write(`warning: unknown predicate "${obj.fn}"\n`);
        return false;
      }
      return fn(obj.args ?? {}, ctx);
    }

    // Sugar form: single-key object where key is a registered predicate
    const keys = Object.keys(obj);
    if (keys.length === 1) {
      const key = keys[0]!;
      const fn = REGISTRY[key];
      if (fn) {
        const value = obj[key];
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          return fn(value, ctx);
        }
        const argKey = SUGAR_ARG_KEY[key];
        if (argKey) {
          return fn({ [argKey]: value }, ctx);
        }
        return fn({ value }, ctx);
      }
    }
  }

  process.stderr.write(`warning: malformed predicate ${JSON.stringify(p)}\n`);
  return false;
}

/** Two-valued view: unknown counts as not met (applies_when, flags, profile rules). */
export function evalPredicate(p: Predicate, ctx: Ctx): boolean {
  return evalVerdict(p, ctx) === true;
}

/**
 * Predicate names a tree refers to, for load-time validation. Sugar keys and
 * `fn:` both count; combinators are walked, not reported.
 */
export function predicateNames(p: Predicate): string[] {
  const out: string[] = [];
  const walk = (q: Predicate): void => {
    if (q === null || q === undefined || typeof q !== 'object' || Array.isArray(q)) return;
    const obj = q as Record<string, any>;
    if ('all_of' in obj) return (obj.all_of as Predicate[]).forEach(walk);
    if ('any_of' in obj) return (obj.any_of as Predicate[]).forEach(walk);
    if ('at_least_n_of' in obj) return (obj.at_least_n_of?.predicates as Predicate[] ?? []).forEach(walk);
    if ('not' in obj) return walk(obj.not);
    if ('fn' in obj) {
      out.push(String(obj.fn));
      return;
    }
    const keys = Object.keys(obj);
    if (keys.length === 1) out.push(keys[0]!);
  };
  walk(p);
  return out;
}
