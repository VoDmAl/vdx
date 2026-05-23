import type { Predicate } from './rubric.ts';
import type { Ctx } from './facts.ts';
import { REGISTRY } from './predicates.ts';

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

export function evalPredicate(p: Predicate, ctx: Ctx): boolean {
  if (p === null || p === undefined) return false;
  if (typeof p === 'boolean') return p;

  if (typeof p === 'object' && !Array.isArray(p)) {
    const obj = p as Record<string, any>;

    if ('all_of' in obj) {
      const list = obj.all_of as Predicate[];
      return list.every((q) => evalPredicate(q, ctx));
    }
    if ('any_of' in obj) {
      const list = obj.any_of as Predicate[];
      return list.some((q) => evalPredicate(q, ctx));
    }
    if ('at_least_n_of' in obj) {
      const { n, predicates } = obj.at_least_n_of as { n: number; predicates: Predicate[] };
      let matched = 0;
      for (const q of predicates) if (evalPredicate(q, ctx)) matched += 1;
      return matched >= n;
    }
    if ('not' in obj) {
      return !evalPredicate(obj.not, ctx);
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
