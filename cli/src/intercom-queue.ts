import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * How many intercom sessions letters may keep running on one machine at once, and the queue of the projects
 * over it (intercom-session-mode DL #13). Since 17.11 a letter in any project starts its intercom session,
 * and each is a whole agent (~430 MB with its children, lft 2026-11-19); in a week lft ran up to 7 at once,
 * m3 up to 5, with lft's swap 80 % full. The limit comes from the machine's memory, so each machine has its
 * own without a key: one session per 5 GB, at least two — lft (16 GB) 3, m3 (24 GB) 4.
 */
export function intercomLimit(totalBytes: number = os.totalmem()): number {
  return Math.max(2, Math.floor(totalBytes / (5 * 1024 ** 3)));
}

/** A project waiting for a place: since when (ms). */
export interface Queued {
  project: string;
  at: number;
}

function queueDir(home: string): string {
  return path.join(home, '.local', 'state', 'vdx', 'intercom-queue');
}

function queueFile(home: string, project: string): string {
  return path.join(queueDir(home), `${createHash('sha1').update(project).digest('hex').slice(0, 16)}.json`);
}

/** The queue, oldest first. */
export function queued(home: string): Queued[] {
  let names: string[];
  try {
    names = fs.readdirSync(queueDir(home));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .flatMap((n) => {
      try {
        const q = JSON.parse(fs.readFileSync(path.join(queueDir(home), n), 'utf8')) as Queued;
        return typeof q.project === 'string' && typeof q.at === 'number' ? [q] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.at - b.at);
}

/** Put the project in the queue — one already there keeps its place. Its place, from 1. */
export function enqueue(home: string, project: string, now: number = Date.now()): number {
  const file = queueFile(home, project);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(queueDir(home), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ project, at: now }) + '\n');
  }
  return queued(home).findIndex((q) => q.project === project) + 1;
}

export function dequeue(home: string, project: string): void {
  fs.rmSync(queueFile(home, project), { force: true });
}

/**
 * The intercom sessions a letter started, out of `name<TAB>@vdx_stays` lines of `tmux list-sessions`: the
 * ones the limit counts. Not one the person started or joined (`@vdx_stays`): they keep it, as their focused
 * one. Not `freeing`: the session that is closing and makes the place.
 */
export function lettersSessions(listed: string, freeing: string | null = null): string[] {
  return listed
    .split('\n')
    .map((l) => l.split('\t'))
    .filter(([name, stays]) => name && /@[^@\s]+-intercom$/.test(name) && !stays?.trim() && name !== freeing)
    .map(([name]) => name!);
}
