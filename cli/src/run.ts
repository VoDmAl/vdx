import * as fs from 'node:fs';
import * as path from 'node:path';
import * as TOML from 'smol-toml';

export const LIFECYCLE_VERBS = ['up', 'down', 'build', 'test', 'check', 'fix'] as const;
export type LifecycleVerb = (typeof LIFECYCLE_VERBS)[number];

export type VerbResolveResult =
  | { ok: true; miseTomlPath: string }
  | {
      ok: false;
      reason: 'no-mise-toml' | 'parse-error' | 'no-task';
      detail?: string;
    };

export function resolveLifecycleVerb(
  projectRoot: string,
  verb: string,
): VerbResolveResult {
  const miseTomlPath = path.join(projectRoot, 'mise.toml');
  if (!fs.existsSync(miseTomlPath)) {
    return { ok: false, reason: 'no-mise-toml' };
  }
  let parsed: unknown;
  try {
    parsed = TOML.parse(fs.readFileSync(miseTomlPath, 'utf8'));
  } catch (e: any) {
    return { ok: false, reason: 'parse-error', detail: e?.message ?? String(e) };
  }
  const tasks = (parsed as { tasks?: Record<string, unknown> })?.tasks;
  if (!tasks || typeof tasks !== 'object' || !(verb in tasks)) {
    return { ok: false, reason: 'no-task' };
  }
  return { ok: true, miseTomlPath };
}

export function renderResolveError(
  res: Exclude<VerbResolveResult, { ok: true }>,
  projectRoot: string,
  verb: string,
): string {
  switch (res.reason) {
    case 'no-mise-toml':
      return (
        `vdx: no mise.toml in ${projectRoot}\n` +
        `hint: run \`vdx init\` to generate one, or define it manually.\n`
      );
    case 'parse-error':
      return `vdx: failed to parse mise.toml: ${res.detail ?? 'unknown error'}\n`;
    case 'no-task':
      return (
        `vdx: no \`[tasks.${verb}]\` in mise.toml\n` +
        `hint: run \`vdx init --force\` to re-detect, or add the task manually.\n`
      );
  }
}
