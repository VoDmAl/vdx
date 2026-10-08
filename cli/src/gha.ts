/**
 * GitHub Actions workflows as the `ci` axis reads them: which ones run on a
 * push to the main branch, which steps run tests, which failures are masked,
 * and which jobs ship something. Other CI systems are read as "present" (L1)
 * and answer "unknown" above it — vdx does not inspect them yet.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'js-yaml';
import { fileExists, readText, type Ctx } from './facts.ts';
import { projectTaskCalls } from './vocabulary.ts';

export interface GhaStep {
  run?: string;
  uses?: string;
  continueOnError: boolean;
}

export interface GhaJob {
  id: string;
  name?: string;
  needs: string[];
  steps: GhaStep[];
  continueOnError: boolean;
  matrix: boolean;
}

export interface GhaWorkflow {
  file: string;
  pushesMain: boolean;
  jobs: GhaJob[];
}

const MAIN_BRANCHES = ['main', 'master'];

/** GitHub's branch filter glob: `**` crosses `/`, `*` does not. */
function filterMatches(pattern: string, branch: string): boolean {
  const re = pattern
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*');
  return new RegExp(`^${re}$`).test(branch);
}

function branchSelected(filters: unknown, branch: string): boolean {
  const list = Array.isArray(filters) ? filters : [filters];
  let selected = false;
  for (const f of list) {
    if (typeof f !== 'string') continue;
    if (f.startsWith('!')) {
      if (filterMatches(f.slice(1), branch)) selected = false;
    } else if (filterMatches(f, branch)) {
      selected = true;
    }
  }
  return selected;
}

/** Does `on:` start the workflow on a push to main/master? */
export function pushesMain(on: unknown): boolean {
  if (on === 'push') return true;
  if (Array.isArray(on)) return on.includes('push');
  if (!on || typeof on !== 'object') return false;
  if (!('push' in on)) return false;
  const push = (on as Record<string, any>).push;
  if (push === null || push === undefined || typeof push !== 'object') return true;
  const hasBranchFilter = push.branches !== undefined || push['branches-ignore'] !== undefined;
  if (!hasBranchFilter && (push.tags !== undefined || push['tags-ignore'] !== undefined)) return false;
  return MAIN_BRANCHES.some((b) => {
    if (push.branches !== undefined) return branchSelected(push.branches, b);
    if (push['branches-ignore'] !== undefined) return !branchSelected(push['branches-ignore'], b);
    return true;
  });
}

function truthy(v: unknown): boolean {
  return v === true || v === 'true';
}

export function parseWorkflow(file: string, text: string): GhaWorkflow | null {
  let data: any;
  try {
    data = YAML.load(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const jobs: GhaJob[] = [];
  for (const [id, job] of Object.entries((data.jobs ?? {}) as Record<string, any>)) {
    if (!job || typeof job !== 'object') continue;
    const needs = job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];
    const steps: GhaStep[] = (Array.isArray(job.steps) ? job.steps : [])
      .filter((s: unknown) => s && typeof s === 'object')
      .map((s: any) => ({
        ...(typeof s.run === 'string' ? { run: s.run } : {}),
        ...(typeof s.uses === 'string' ? { uses: s.uses } : {}),
        continueOnError: truthy(s['continue-on-error']),
      }));
    jobs.push({
      id,
      ...(typeof job.name === 'string' ? { name: job.name } : {}),
      needs: needs.filter((n: unknown): n is string => typeof n === 'string'),
      steps,
      continueOnError: truthy(job['continue-on-error']),
      matrix: Boolean(job.strategy?.matrix),
    });
  }
  return { file, pushesMain: pushesMain(data.on), jobs };
}

export function readWorkflows(ctx: Ctx): GhaWorkflow[] {
  const key = 'gha:workflows';
  if (ctx.cache.has(key)) return ctx.cache.get(key) as GhaWorkflow[];
  const dir = path.join(ctx.projectRoot, '.github', 'workflows');
  const out: GhaWorkflow[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  } catch {
    files = [];
  }
  for (const f of files) {
    const rel = path.join('.github', 'workflows', f);
    const text = readText(ctx, rel);
    const wf = text === null ? null : parseWorkflow(rel, text);
    if (wf) out.push(wf);
  }
  ctx.cache.set(key, out);
  return out;
}

/** CI systems vdx sees but does not read beyond "a config exists". */
const OTHER_CI: Array<[string, string]> = [
  ['.gitlab-ci.yml', 'GitLab CI'],
  ['.circleci/config.yml', 'CircleCI'],
];

/** The CI systems a repository configures: `gha` for GitHub Actions workflows, others by name. */
export function ciSystems(ctx: Ctx): string[] {
  const out: string[] = [];
  if (readWorkflows(ctx).length > 0) out.push('gha');
  for (const [file, name] of OTHER_CI) if (fileExists(ctx, file)) out.push(name);
  return out;
}

/** `|| true` and its relatives: the step reports success whatever the command did. */
const MASK_RE = /\|\|\s*(true|:|exit\s+0)\b/;

export function stepMasked(step: GhaStep, job: GhaJob): boolean {
  if (job.continueOnError || step.continueOnError) return true;
  return step.run !== undefined && MASK_RE.test(step.run);
}

/** Unmasked `run:` steps of jobs in workflows started by a push to main. */
export function mainPushSteps(ctx: Ctx): Array<{ wf: GhaWorkflow; job: GhaJob; step: GhaStep }> {
  const out: Array<{ wf: GhaWorkflow; job: GhaJob; step: GhaStep }> = [];
  for (const wf of readWorkflows(ctx)) {
    if (!wf.pushesMain) continue;
    for (const job of wf.jobs) {
      for (const step of job.steps) {
        if (step.run === undefined || stepMasked(step, job)) continue;
        out.push({ wf, job, step });
      }
    }
  }
  return out;
}

/** Project tasks CI calls on a push to main, unmasked. */
export function ciTaskCalls(ctx: Ctx): Set<string> {
  const out = new Set<string>();
  for (const { step } of mainPushSteps(ctx)) for (const t of projectTaskCalls(step.run!, ctx)) out.add(t);
  return out;
}

/** Jobs that check: an unmasked step runs tests (`pattern`) or a `test`/`check` task. */
export function checkingJobs(ctx: Ctx, pattern: RegExp): Set<GhaJob> {
  const out = new Set<GhaJob>();
  for (const { job, step } of mainPushSteps(ctx)) {
    if (pattern.test(step.run!) || projectTaskCalls(step.run!, ctx).some((t) => /^(test|check)(:|$)/.test(t))) {
      out.add(job);
    }
  }
  return out;
}

const SHIP_RE = /deploy|release|publish/i;

/** Jobs that ship: deploy, release, publish — by id or name. */
export function shippingJobs(wf: GhaWorkflow): GhaJob[] {
  return wf.jobs.filter((j) => SHIP_RE.test(j.id) || (j.name !== undefined && SHIP_RE.test(j.name)));
}

/** Every job `job` waits for, transitively, within its workflow. */
export function upstream(wf: GhaWorkflow, job: GhaJob): Set<GhaJob> {
  const byId = new Map(wf.jobs.map((j) => [j.id, j] as const));
  const seen = new Set<GhaJob>();
  const queue = [...job.needs];
  while (queue.length > 0) {
    const j = byId.get(queue.shift()!);
    if (!j || seen.has(j)) continue;
    seen.add(j);
    queue.push(...j.needs);
  }
  return seen;
}
