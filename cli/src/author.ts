import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Who commits in a repo. The rule this serves: every repo carries its own
 * author in `.git/config`, and git refuses where there is none
 * (`user.useConfigOnly`). When a repo has none, vdx proposes one — the
 * addresses some repo in the pool already carries, ranked by this repo's
 * history, repos in the same remote group, and repos with a similar name.
 */

export interface Author {
  name: string;
  email: string;
}

export interface PoolRepo {
  dir: string;
  author: Author | null;
  host: string;
  group: string;
  tokens: Set<string>;
}

export interface AuthorCandidate extends Author {
  score: number;
  why: string[];
}

function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['--no-optional-locks', '-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function isGitRepo(dir: string): boolean {
  return git(dir, ['rev-parse', '--git-dir']) !== null;
}

/** The address git would commit with here, and the scope it comes from; null when git knows none. */
export function effectiveAuthor(dir: string): { email: string; scope: string } | null {
  const out = git(dir, ['config', '--show-scope', '--get', 'user.email']);
  if (!out) return null;
  const [scope, email] = out.split('\t');
  return email ? { email, scope: scope ?? '' } : null;
}

/** `git@host:group/repo.git`, `ssh://git@host:7999/group/repo.git` → host and group ("" when none). */
export function remoteParts(url: string): { host: string; group: string; path: string } {
  const m = url.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.*?)(?:\.git)?\/?$/);
  if (!m) return { host: '', group: '', path: '' };
  const p = m[2]!;
  return { host: m[1]!, group: p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '', path: p };
}

/** Words that say nothing about whose repo it is. */
const GENERIC = new Set([
  'git', 'com', 'org', 'name', 'www', 'ssh', 'http', 'https', 'the', 'app', 'mcp',
  'github', 'gitlab', 'dev', 'net', 'vorobyev', 'vodmal', 'dmitry',
]);

export function nameTokens(dir: string, remotePath: string): Set<string> {
  return new Set(
    `${path.basename(dir)} ${remotePath}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !GENERIC.has(t)),
  );
}

function describe(dir: string): PoolRepo {
  const cfg = git(dir, ['config', '--local', '--get-regexp', '^(user\\.(name|email)|remote\\.origin\\.url)$']) ?? '';
  const val = (key: string) =>
    cfg.split('\n').find((l) => l.toLowerCase().startsWith(`${key} `))?.slice(key.length + 1).trim() ?? '';
  const email = val('user.email');
  const remote = remoteParts(val('remote.origin.url'));
  return {
    dir,
    author: email ? { name: val('user.name'), email: email.toLowerCase() } : null,
    host: remote.host,
    group: remote.group,
    tokens: nameTokens(dir, remote.path),
  };
}

/** Git repos one level under each directory; the directories themselves are not repos. */
export function scanPool(dirs: string[]): PoolRepo[] {
  const seen = new Set<string>();
  const out: PoolRepo[] = [];
  for (const d of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const dir = path.join(d, e.name);
      if (!e.isDirectory() || seen.has(dir) || !fs.existsSync(path.join(dir, '.git'))) continue;
      seen.add(dir);
      out.push(describe(dir));
    }
  }
  return out;
}

/**
 * Weights measured 2026-09-30 against the owner's 38 repos with their own
 * author, each guessed from the others: the right address came first in 31,
 * among the first three in 37.
 */
const W_HISTORY = 1.0;
const W_GROUP = 0.3;
const W_HOST = 0.1;
const W_TOKEN = 0.4;

/** The pool's addresses, best first. Only addresses some pool repo carries are proposed. */
export function rankAuthors(dir: string, pool: PoolRepo[]): AuthorCandidate[] {
  const self = describe(dir);
  const others = pool.filter((p) => p.author && path.resolve(p.dir) !== path.resolve(dir));
  const names = new Map<string, Map<string, number>>();
  for (const p of others) {
    const byName = names.get(p.author!.email) ?? new Map<string, number>();
    if (p.author!.name) byName.set(p.author!.name, (byName.get(p.author!.name) ?? 0) + 1);
    names.set(p.author!.email, byName);
  }
  if (names.size === 0) return [];

  const score = new Map<string, number>();
  const why = new Map<string, string[]>();
  const add = (email: string, s: number, reason?: string) => {
    score.set(email, (score.get(email) ?? 0) + s);
    if (reason) why.set(email, [...(why.get(email) ?? []), reason]);
  };

  // Counted by git: a per-commit log of a large repo overflows the output buffer.
  const history = new Map<string, number>();
  for (const line of (git(dir, ['shortlog', '-se', '--all']) ?? '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+.*<([^>]*)>\s*$/);
    const e = m?.[2]?.toLowerCase();
    if (e && names.has(e)) history.set(e, (history.get(e) ?? 0) + Number(m![1]));
  }
  const total = [...history.values()].reduce((a, b) => a + b, 0);
  for (const [e, n] of history) add(e, (W_HISTORY * n) / total, `history ${n}`);

  const group = new Map<string, number>();
  const similar = new Map<string, string[]>();
  for (const p of others) {
    const e = p.author!.email;
    if (self.host && p.host === self.host) {
      const same = Boolean(self.group) && p.group === self.group;
      add(e, same ? W_GROUP : W_HOST);
      if (same) group.set(e, (group.get(e) ?? 0) + 1);
    }
    const overlap = [...self.tokens].filter((t) => p.tokens.has(t)).length;
    if (overlap > 0) {
      add(e, W_TOKEN * overlap);
      similar.set(e, [...(similar.get(e) ?? []), path.basename(p.dir)]);
    }
  }
  for (const [e, n] of group) add(e, 0, `same group ${self.host}/${self.group}: ${n}`);
  for (const [e, list] of similar) add(e, 0, `similar: ${list.slice(0, 3).join(', ')}`);

  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
  // Addresses with no signal still belong in the menu, after the rest, by how many repos carry them.
  const repos = (e: string) => [...(names.get(e)?.values() ?? [])].reduce((a, b) => a + b, 0);
  const unsignalled = [...names.keys()].filter((e) => !score.has(e)).sort((a, b) => repos(b) - repos(a));
  for (const e of unsignalled) {
    ranked.push([e, 0]);
    why.set(e, [`in ${repos(e)} repos`]);
  }

  const fallbackName = [...names.values()].flatMap((m) => [...m.entries()]).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  return ranked
    .map(([email, s]) => {
      const byName = [...(names.get(email)?.entries() ?? [])].sort((a, b) => b[1] - a[1]);
      return { email, name: byName[0]?.[0] ?? fallbackName, score: s, why: why.get(email) ?? [] };
    });
}

export function writeAuthor(dir: string, author: Author): boolean {
  return (
    git(dir, ['config', '--local', 'user.name', author.name]) !== null &&
    git(dir, ['config', '--local', 'user.email', author.email]) !== null
  );
}
