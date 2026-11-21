import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { at, isStringList, str } from './narrow.ts';

/**
 * Whose HQ a project is, as the user's access layer says it (hq-session-mode DL #10). vdx keeps no name
 * of that agent and no path: the intercom directory says who holds the role `access-layer` and where its
 * checkout is, and its command `bin/<identity> hq <root>` names the project's HQ — echelon today
 * (`echelon hq`: one line, the HQ's name; empty — its own HQ, or none; exit 1 — its config is broken).
 */
export type ProjectHq =
  /** The project is its own HQ, has none, or nothing here can say: a start goes as it always did. */
  | { kind: 'own' }
  /** The access layer was asked and could not say: a start goes as before, with this line. */
  | { kind: 'unknown'; note: string }
  /** Another project is its HQ; `root` — its checkout on this machine, null — none here. */
  | { kind: 'hand'; hq: string; root: string | null };

/** The role the directory keeps for the agent through which projects reach the outside (skill intercom, «Roles»). */
const ACCESS_LAYER_ROLE = 'access-layer';
/** How long the access layer may take to answer: about 0.2 s on m3 (2026-11-20). */
const HQ_TIMEOUT_MS = 10_000;

interface Entry {
  identity: string;
  names: string[];
  aliases: string[];
  paths: string[];
  roles: string[];
}

/**
 * The intercom store, as intercom resolves it: `VDM_INTERCOM_ROOT`, else `intercom.root` in
 * `~/.claude/vdm-plugins.json`, else `~/.claude/vdm/intercom`; a leading `~` is the home.
 */
function intercomStore(env: NodeJS.ProcessEnv, home: string): string {
  let root = env['VDM_INTERCOM_ROOT'] || '';
  if (!root) {
    try {
      const cfg: unknown = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'vdm-plugins.json'), 'utf8'));
      root = str(at(cfg, 'intercom', 'root')) ?? '';
    } catch {
      // no global config: the default store
    }
  }
  if (!root) root = path.join(home, '.claude', 'vdm', 'intercom');
  if (root === '~') return home;
  return root.startsWith('~/') ? path.join(home, root.slice(2)) : root;
}

/** The directory's entries; a Syncthing copy of an entry (`<id>.sync-conflict-*.json`) is not one, as for intercom. */
function registry(store: string): Entry[] {
  const dir = path.join(store, '_registry');
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith('.json') && !f.includes('.sync-conflict-'))
    .flatMap((f) => {
      try {
        const e: unknown = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const identity = str(at(e, 'identity'));
        if (!identity) return [];
        const list = (k: string) => {
          const v = at(e, k);
          return isStringList(v) ? v : [];
        };
        return [
          { identity, names: list('names'), aliases: list('aliases'), paths: list('paths'), roles: list('roles') },
        ];
      } catch {
        return [];
      }
    });
}

/** A name as intercom compares names: ASCII lowercase, runs of spaces, tabs and `_` → `-`, no `-` at the ends. */
function foldName(name: string): string {
  return name
    .replace(/[A-Z]/g, (c) => c.toLowerCase())
    .replace(/[ \t_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The entry's checkouts on this machine, in its order: the directory is shared between the machines and
 * keeps every path a session ran in, and the harness's own copy of a plugin's repository is nobody's
 * working one (intercom `intercom_checkouts`).
 */
function checkoutsHere(e: Entry): string[] {
  return e.paths.filter((p) => {
    if (/\/plugins\/(marketplaces|cache)\//.test(p)) return false;
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Two paths name one folder, links followed. */
export function sameDir(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

/** The access layer's command on this machine: `<its checkout>/bin/<its identity>`; null — no one holds the role here. */
function accessLayerCommand(entries: Entry[]): string | null {
  const holders = entries.filter((e) => e.roles.includes(ACCESS_LAYER_ROLE));
  // A role has one holder; two is a directory to fix, and neither of them is asked.
  const holder = holders.length === 1 ? holders[0] : undefined;
  if (!holder) return null;
  for (const dir of checkoutsHere(holder)) {
    const cmd = path.join(dir, 'bin', holder.identity);
    try {
      fs.accessSync(cmd, fs.constants.X_OK);
      return cmd;
    } catch {
      // no command in this checkout
    }
  }
  return null;
}

/** What the access layer says of the project's HQ; see `ProjectHq`. */
export function projectHq(
  projectRoot: string,
  env: NodeJS.ProcessEnv,
  home: string,
  timeoutMs: number = HQ_TIMEOUT_MS,
): ProjectHq {
  const entries = registry(intercomStore(env, home));
  const cmd = accessLayerCommand(entries);
  if (!cmd) return { kind: 'own' };
  const res = spawnSync(cmd, ['hq', projectRoot], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    env,
  });
  const who = `${path.basename(cmd)} hq`;
  if (res.error || res.status !== 0) {
    const why = res.error
      ? at(res.error, 'code') === 'ETIMEDOUT'
        ? `no answer in ${Math.round(timeoutMs / 1000)} s`
        : res.error.message
      : (res.stderr ?? '').trim().split('\n')[0] || `exit ${res.status ?? res.signal}`;
    return { kind: 'unknown', note: `${who} could not say whose HQ this project is (${why}) — started as it is` };
  }
  const hq = (res.stdout ?? '').split('\n')[0]?.trim() ?? '';
  if (!hq) return { kind: 'own' };
  const folded = foldName(hq);
  const matches = entries.filter((e) => [e.identity, ...e.names, ...e.aliases].some((n) => foldName(n) === folded));
  const entry = matches.length === 1 ? matches[0] : undefined;
  const root = entry ? (checkoutsHere(entry)[0] ?? null) : null;
  // The answer names this very project: it is its own HQ, whatever the name.
  if (root && sameDir(root, projectRoot)) return { kind: 'own' };
  return { kind: 'hand', hq, root };
}
