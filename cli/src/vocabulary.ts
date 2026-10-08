/**
 * Which project tasks a command line calls through the project's own runner
 * (mise, vdx, composer, npm/pnpm/yarn/bun, make, just, task), and what a task
 * calls in turn. Shared by the `ci` predicates (what CI runs) and the hook
 * predicates (what a hook runs), so both read "the project's task" the same way.
 */
import { listAllTasks, readJson, readToml, type Ctx } from './facts.ts';

export const LIFECYCLE_VOCABULARY = ['up', 'down', 'build', 'test', 'check', 'fix'] as const;

/** npm-family options that take a value; their value is not the script name. */
const VALUE_OPTIONS = new Set(['--prefix', '-C', '--dir', '-w', '--workspace', '--filter', '--cwd']);

/** Whitespace split that keeps quoted spans together and drops the quotes. */
function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  for (const m of s.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

function positionalArgs(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith('-')) {
      if (VALUE_OPTIONS.has(t)) i++;
      continue;
    }
    out.push(t);
  }
  return out;
}

/** Task names a shell command calls through a project runner, in order. */
export function runnerCalls(command: string): string[] {
  const out: string[] = [];
  for (const raw of command.split(/&&|\|\||;|\n|\|/)) {
    const toks = tokenize(raw.trim());
    let i = 0;
    // `FOO=1 npm test`, `exec npm test`, `npx --no -- vdx test`
    while (i < toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]!) || ['exec', 'time', 'command'].includes(toks[i]!))) i++;
    const head = toks[i];
    if (!head) continue;
    const runner = head.split('/').pop()!;
    const args = positionalArgs(toks.slice(i + 1));
    const first = args[0];
    switch (runner) {
      case 'mise':
        if ((first === 'run' || first === 'r') && args[1]) out.push(args[1]);
        break;
      case 'vdx':
        if (first && (LIFECYCLE_VOCABULARY as readonly string[]).includes(first)) out.push(first);
        break;
      case 'composer':
        if ((first === 'run-script' || first === 'run') && args[1]) out.push(args[1]);
        else if (first) out.push(first);
        break;
      case 'npm':
        if ((first === 'run' || first === 'run-script') && args[1]) out.push(args[1]);
        else if (first === 'test' || first === 't' || first === 'tst') out.push('test');
        break;
      case 'pnpm':
      case 'yarn':
        if ((first === 'run' || first === 'run-script') && args[1]) out.push(args[1]);
        else if (first) out.push(first);
        break;
      case 'bun':
        // `bun test` is bun's own runner, not the project's script.
        if (first === 'run' && args[1]) out.push(args[1]);
        break;
      case 'make':
      case 'just':
      case 'task':
        if (first) out.push(first);
        break;
      default:
        break;
    }
  }
  return out;
}

/** Calls of tasks the project actually has (a runner word that is no task — `composer install` — is dropped). */
export function projectTaskCalls(command: string, ctx: Ctx): string[] {
  const tasks = listAllTasks(ctx);
  return runnerCalls(command).filter((t) => tasks.has(t));
}

/** A name of the lifecycle vocabulary, or its namespaced form: `test`, `check:lint`. */
export function isVocabularyTask(name: string, words: readonly string[] = ['test', 'check']): boolean {
  return words.some((w) => name === w || name.startsWith(`${w}:`));
}

/** Tasks a task's definition calls: composer `@refs`, `npm run X` inside a script, mise `depends`/`run`. */
export function taskChildren(ctx: Ctx, name: string): string[] {
  const out: string[] = [];
  const composer = readJson(ctx, 'composer.json');
  const entry = composer?.scripts?.[name];
  if (entry !== undefined) {
    const list = Array.isArray(entry) ? entry : [entry];
    for (const e of list) {
      if (typeof e !== 'string') continue;
      if (e.startsWith('@')) {
        const [ref, ...rest] = e.slice(1).trim().split(/\s+/);
        if (ref === 'composer') out.push(...runnerCalls(`composer ${rest.join(' ')}`));
        else if (ref && ref !== 'php' && ref !== 'putenv') out.push(ref);
      } else {
        out.push(...runnerCalls(e));
      }
    }
  }
  const pkg = readJson(ctx, 'package.json');
  const script = pkg?.scripts?.[name];
  if (typeof script === 'string') out.push(...runnerCalls(script));
  const mise = readToml(ctx, 'mise.toml');
  const task = mise?.tasks?.[name];
  if (task && typeof task === 'object') {
    if (Array.isArray(task.depends)) out.push(...task.depends.filter((d: unknown): d is string => typeof d === 'string'));
    const runs = Array.isArray(task.run) ? task.run : [task.run];
    for (const r of runs) if (typeof r === 'string') out.push(...runnerCalls(r));
  }
  const tasks = listAllTasks(ctx);
  return [...new Set(out.filter((t) => t !== name && tasks.has(t)))];
}

/** A set of task names together with everything they call, transitively. */
export function expandTasks(ctx: Ctx, names: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...names];
  while (queue.length > 0) {
    const t = queue.shift()!;
    if (seen.has(t)) continue;
    seen.add(t);
    queue.push(...taskChildren(ctx, t));
  }
  return seen;
}

/**
 * Does `have` cover task `t`: it is called itself, or every task it calls is
 * covered (CI calls `check`, the hook calls the `check:*` it consists of).
 */
export function covers(ctx: Ctx, have: Set<string>, t: string, seen = new Set<string>()): boolean {
  if (have.has(t)) return true;
  if (seen.has(t)) return false;
  seen.add(t);
  const children = taskChildren(ctx, t);
  return children.length > 0 && children.every((c) => covers(ctx, have, c, seen));
}
