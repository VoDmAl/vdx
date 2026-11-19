import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Whether a path leads anywhere now (nas-info `projects-link-mount-race`, 2026-11-17). On lft
 * `~/.claude/projects` is a link to `/Volumes/Working/claude-projects`, on an encrypted volume unlocked at
 * login, and some projects live on that volume too; `vdx ai --restore` runs at login as well (10.11: the
 * volume came 7 s before it). Claude Code started while the link leads nowhere writes no transcript and says
 * nothing.
 *
 * - `ok` — it is there;
 * - `unreachable` — on the way, a volume is not mounted (its mount point under `/Volumes` is not there), or a
 *   link leads to such a place: it may come, so it is waited for;
 * - `missing` — not there, and nothing on the way waits.
 */
export type Reach = { kind: 'ok' } | { kind: 'missing' } | { kind: 'unreachable'; why: string };

/** Where macOS mounts volumes: a volume not mounted has no directory there. */
const VOLUMES = '/Volumes';

export function reach(p: string, volumes: string = VOLUMES, depth = 0): Reach {
  try {
    fs.statSync(p);
    return { kind: 'ok' };
  } catch {
    // below: why not
  }
  const abs = path.resolve(p);
  const root = path.resolve(volumes);
  const parts = abs.split(path.sep).filter(Boolean);
  let cur: string = path.sep;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]!);
    let link: boolean;
    try {
      link = fs.lstatSync(cur).isSymbolicLink();
    } catch {
      return path.dirname(cur) === root ? { kind: 'unreachable', why: `${cur} is not mounted` } : { kind: 'missing' };
    }
    if (!link) continue;
    try {
      fs.statSync(cur);
      continue;
    } catch {
      // a link that leads nowhere: where would it lead?
    }
    if (depth >= 8) return { kind: 'missing' };
    let to: string;
    try {
      to = fs.readlinkSync(cur);
    } catch {
      return { kind: 'missing' };
    }
    const target = path.resolve(path.dirname(cur), to);
    const there = reach(path.join(target, ...parts.slice(i + 1)), volumes, depth + 1);
    return there.kind === 'unreachable' ? { kind: 'unreachable', why: `${cur} → ${to}: ${there.why}` } : there;
  }
  return { kind: 'missing' };
}

/** How often a wait looks again. */
const LOOK_MS = 2_000;

/**
 * Wait while any of `paths` is unreachable, up to `waitMs`, looking every 2 s; `onWait` is told once, when the
 * wait begins. Returns what is still unreachable after it — empty, all there (or missing for good).
 */
export function awaitReach(
  paths: string[],
  waitMs: number,
  sleep: (ms: number) => void,
  onWait: (stuck: { path: string; why: string }[]) => void,
  volumes: string = VOLUMES,
): { path: string; why: string }[] {
  const stuckNow = () =>
    paths.flatMap((p) => {
      const r = reach(p, volumes);
      return r.kind === 'unreachable' ? [{ path: p, why: r.why }] : [];
    });
  let stuck = stuckNow();
  if (stuck.length === 0) return [];
  onWait(stuck);
  for (let waited = 0; waited < waitMs && stuck.length > 0; waited += LOOK_MS) {
    sleep(LOOK_MS);
    stuck = stuckNow();
  }
  return stuck;
}
