import * as fs from 'node:fs';
import * as path from 'node:path';
import { shellQuote } from './ai.ts';
import type { MoveDeps } from './move.ts';

/**
 * What is a project's own, not its repo's — commits no remote branch has, stashes, uncommitted and
 * untracked files, files git ignores that Syncthing carries — kept beside its clone on the shelf, in
 * `<place>.own/<date> shelve/`, so the shelf stays a mirror of the server and the next `vdx take` brings it
 * all back (claude-memory-in-project DL #27, the owner 2026-11-22: «взял поработал вернул … через месяц могу
 * снова взять в работу и хочется чтобы ничего не потерялось»). A second clone's ignored files, whose place a
 * link takes, go into `<place>.own/<date> second clone/`.
 *
 * Nothing in the project is removed before what goes beside it is written and read back: the bundle by
 * `git bundle verify`, the files by `diff -r`.
 */

export const OWN_SUFFIX = '.own';

/** What in a repository is its own: what the server does not have, and what git ignores. */
export interface Own {
  /** Commits on its branches (or HEAD) that no remote branch has; null — git could not tell. */
  commits: number | null;
  /** Changed and untracked files (git status). */
  uncommitted: number;
  stashes: number;
  /** Files and folders git ignores that Syncthing carries — they would be lost with the folder. */
  carried: string[];
  /** Ones Syncthing does not carry (node_modules and the like): each machine's own. */
  skipped: string[];
}

/** What a set beside the clone holds, in its `state.json`. */
interface OwnState {
  kind: 'shelve' | 'second clone';
  date: string;
  /** Where the project was when the set was made. */
  from: string;
  /** The branch checked out then; null — HEAD was detached. */
  branch: string | null;
  head: string | null;
  /** Branches with commits no remote branch has: in the bundle as they were. */
  branches: string[];
  /** Every stash entry, newest first, as `refs/vdx-own/stash/<n>` in the bundle. */
  stashes: { sha: string; message: string }[];
  /** The uncommitted work, made the newest stash entry at the shelve. */
  work: boolean;
  /** A detached HEAD with commits of its own: `refs/vdx-own/head` in the bundle. */
  detached: boolean;
  files: string[];
  skipped: string[];
}

type Sh = MoveDeps['sh'];

/**
 * git in the repository, each argument quoted — branch names, shas and messages come from the repository and from
 * state.json in a synced folder, and git allows `$`, `;`, `(` in a branch name. A read does not write the index
 * (`--no-optional-locks`: a synced folder).
 */
function gitIn(repo: string, sh: Sh) {
  return (args: string[], read = true): { ok: boolean; out: string } => {
    const ran = sh(
      `cd ${shellQuote(repo)} && git ${read ? '--no-optional-locks ' : ''}${args.map(shellQuote).join(' ')} 2>/dev/null`,
    );
    return { ok: !!ran && ran.status === 0, out: (ran?.stdout ?? '').trim() };
  };
}

/** Removes every ref under `prefix`, one `update-ref -d` each. */
function dropRefs(git: ReturnType<typeof gitIn>, prefix: string): void {
  for (const ref of git(['for-each-ref', '--format=%(refname)', prefix]).out.split('\n').filter(Boolean))
    git(['update-ref', '-d', ref], false);
}

const SHA = /^[0-9a-f]{40,64}$/;

/** A file of state.json: a path inside the project — not absolute, no `..` (state.json lies in a synced folder). */
function insideProject(e: string): boolean {
  return e !== '' && !path.isAbsolute(e) && !e.split(/[\\/]/).includes('..');
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads what is a repository's own, on this machine. Whether Syncthing carries an ignored entry —
 * `syncthing cli debug file` of the Syncthing folder it lies in; no answer counts as carried.
 */
export function ownOf(repo: string, deps: MoveDeps): Own {
  const ran = deps.sh(
    [
      `cd ${shellQuote(repo)} || exit 1`,
      'g() { git --no-optional-locks "$@" 2>/dev/null; }',
      'printf "commits %s\\n" "$(g rev-list --count HEAD --branches --not --remotes || echo -)"',
      'printf "uncommitted %s\\n" "$(g status --porcelain | wc -l | tr -d " ")"',
      'printf "stashes %s\\n" "$(g stash list | wc -l | tr -d " ")"',
      // The Syncthing folder of the repository: its id, then the repository's path inside it (two lines).
      'here=$(pwd -P)',
      'f=$(syncthing cli config folders list 2>/dev/null | while IFS= read -r id; do',
      '  p=$(syncthing cli config folders "$id" path get 2>/dev/null) || continue',
      // Syncthing keeps a path under home as `~/…`.
      '  case "$p" in ("~"|"~/"*) p="$HOME${p#"~"}";; esac',
      '  p=$(cd "$p" 2>/dev/null && pwd -P) || continue',
      '  case "$here/" in ("$p"/*) printf "%s\\n%s\\n" "$id" "${here#"$p"}";; esac',
      'done | head -n 2)',
      'id=$(printf "%s\\n" "$f" | sed -n 1p); rel=$(printf "%s\\n" "$f" | sed -n 2p); rel=${rel#/}',
      'g ls-files --others --ignored --exclude-standard --directory | while IFS= read -r e; do',
      '  e=${e%/}',
      '  if [ -n "$id" ] && out=$(syncthing cli debug file "$id" "${rel:+$rel/}$e" 2>/dev/null); then',
      '    case "$out" in (*\'"ignored": true\'*) echo "skipped $e";; (*) echo "carried $e";; esac',
      '  else echo "carried $e"; fi',
      'done',
    ].join('\n'),
  );
  const own: Own = { commits: null, uncommitted: 0, stashes: 0, carried: [], skipped: [] };
  for (const line of (ran?.stdout ?? '').split('\n')) {
    const m = /^(commits|uncommitted|stashes|carried|skipped) (.*)$/.exec(line);
    if (!m) continue;
    const v = m[2]!;
    if (m[1] === 'carried' || m[1] === 'skipped') own[m[1]].push(v);
    else if (m[1] === 'commits') own.commits = /^\d+$/.test(v) ? Number(v) : null;
    else own[m[1] as 'uncommitted' | 'stashes'] = Number(v) || 0;
  }
  if (!ran || ran.status !== 0) own.commits = null;
  return own;
}

/** A new set's folder in `<place>.own/`: `<date> <kind>`, then ` 2`, ` 3` on the same day. */
function newSet(place: string, kind: OwnState['kind'], today: string): string {
  const base = path.join(`${place}${OWN_SUFFIX}`, `${today} ${kind}`);
  let dir = base;
  for (let n = 2; fs.existsSync(dir); n++) dir = `${base} ${n}`;
  return dir;
}

/** Copies the entries (files or folders, relative to `repo`) into `<set>/files/`, and reads them back. */
function copyFiles(repo: string, entries: string[], set: string, sh: Sh): string | null {
  for (const e of entries) {
    const from = path.join(repo, e);
    const to = path.join(set, 'files', e);
    const ran = sh(
      `mkdir -p ${shellQuote(path.dirname(to))} && cp -pR ${shellQuote(from)} ${shellQuote(to)} && diff -rq ${shellQuote(from)} ${shellQuote(to)} >/dev/null`,
    );
    if (!ran || ran.status !== 0) return `${e} did not copy`;
  }
  return null;
}

function readme(state: OwnState): string {
  return [
    `What was ${state.from}'s own when it went onto the shelf (${state.kind}, ${state.date}) — not its repo's.`,
    'vdx take of the project brings it back and removes this folder once all of it is back.',
    '',
    'By hand, in the project:',
    '  git fetch <this folder>/work.bundle "refs/*:refs/vdx-own/back/*"   # branches and stash entries',
    '  git stash store -m "<message>" <sha>                                 # each stash, oldest first (state.json)',
    '  git stash pop --index                                                # the uncommitted work, if "work": true',
    '  cp -pR <this folder>/files/. <project>/                              # files git ignores',
    '',
    'state.json names the branch that was checked out, the branches and stashes in the bundle, the files.',
    '',
  ].join('\n');
}

/** A set that did not come out whole goes, and `<place>.own/` with it when nothing else is there. */
export function dropSet(set: string): void {
  fs.rmSync(set, { recursive: true, force: true });
  try {
    fs.rmdirSync(path.dirname(set));
  } catch {
    // other sets are there
  }
}

function writeState(set: string, state: OwnState): void {
  fs.mkdirSync(set, { recursive: true });
  fs.writeFileSync(path.join(set, 'state.json'), JSON.stringify(state, null, 2) + '\n');
  fs.writeFileSync(path.join(set, 'README'), readme(state));
}

/**
 * `vdx take`, before the pause: a second clone's ignored files that Syncthing carries, beside its place, so the
 * link can take it. Returns the set's folder, or null after the reason is said.
 */
export function keepSecondClone(
  clone: string,
  own: Own,
  today: string,
  deps: MoveDeps,
): { set: string } | { error: string } {
  const set = newSet(clone, 'second clone', today);
  const state: OwnState = {
    kind: 'second clone',
    date: today,
    from: clone,
    branch: null,
    head: null,
    branches: [],
    stashes: [],
    work: false,
    detached: false,
    files: own.carried,
    skipped: own.skipped,
  };
  try {
    writeState(set, state);
  } catch (e) {
    dropSet(set);
    return { error: `${set}: ${String(e)}` };
  }
  const failed = copyFiles(clone, own.carried, set, deps.sh);
  if (!failed) return { set };
  dropSet(set);
  return { error: failed };
}

/** The server branch to put the clone on: the current branch's upstream, else origin's HEAD. */
function serverBranch(git: ReturnType<typeof gitIn>): { local: string; remote: string } | null {
  const up = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const head = up.ok && up.out ? up : git(['rev-parse', '--abbrev-ref', 'origin/HEAD']);
  if (!head.ok || !head.out || head.out === 'origin/HEAD') return null;
  const slash = head.out.indexOf('/');
  return slash > 0 ? { local: head.out.slice(slash + 1), remote: head.out } : null;
}

/**
 * `vdx shelve`, after the move, on this machine: what is the project's own goes beside it, then the clone goes
 * onto the server branch, clean. Lines for the person; ok false — a step failed, and what stays is said.
 */
export function keepOwn(repo: string, today: string, deps: MoveDeps): { ok: boolean; lines: string[] } {
  const own = ownOf(repo, deps);
  if (own.commits === null)
    return { ok: false, lines: [`✗ git cannot tell what of ${repo} is its own — it stays inside the clone`] };
  if (!own.commits && !own.uncommitted && !own.stashes && !own.carried.length)
    return {
      ok: true,
      lines: [`nothing of its own${own.skipped.length ? ` (Syncthing does not carry ${own.skipped.join(', ')})` : ''}`],
    };
  const git = gitIn(repo, deps.sh);
  // Without a server branch the clone has nowhere to go: its own stays inside, untouched.
  const server = serverBranch(git);
  if (!server)
    return {
      ok: true,
      lines: [
        '⚠ its own stays inside the clone: no server branch to put it on (no upstream, no origin/HEAD) — git fetch there, then vdx take and vdx shelve again',
      ],
    };
  const set = newSet(repo, 'shelve', today);
  const stays = (why: string) => {
    dropSet(set);
    return { ok: false, lines: [`✗ ${why} — its own stays inside the clone, as it was`] };
  };
  const branch = git(['symbolic-ref', '-q', '--short', 'HEAD']);
  const head = git(['rev-parse', 'HEAD']);
  const branches = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    .out.split('\n')
    .filter((b) => b && git(['rev-list', '-1', `refs/heads/${b}`, '--not', '--remotes']).out !== '');
  const detached = !branch.ok && git(['rev-list', '-1', 'HEAD', '--not', '--remotes']).out !== '';
  // The uncommitted work becomes the newest stash entry; untracked files with it.
  let work = false;
  if (own.uncommitted) {
    if (!git(['stash', 'push', '--include-untracked', '-m', `vdx shelve ${today}`], false).ok)
      return stays('git stash could not take the uncommitted work');
    work = true;
  }
  const undoWork = () => (work ? git(['stash', 'pop', '--index'], false) : null);
  const stashes = git(['stash', 'list', '--format=%H%x09%gs'])
    .out.split('\n')
    .filter(Boolean)
    .map((l) => ({ sha: l.split('\t')[0]!, message: l.split('\t').slice(1).join('\t') }));
  stashes.forEach((s, n) => git(['update-ref', `refs/vdx-own/stash/${n}`, s.sha], false));
  if (detached) git(['update-ref', 'refs/vdx-own/head', 'HEAD'], false);
  const refs = [
    ...branches.map((b) => `refs/heads/${b}`),
    ...(stashes.length || detached ? ['--glob=refs/vdx-own'] : []),
  ];
  const dropTemp = () => dropRefs(git, 'refs/vdx-own');
  fs.mkdirSync(set, { recursive: true });
  if (refs.length) {
    const bundle = path.join(set, 'work.bundle');
    const made = git(['bundle', 'create', '-q', bundle, ...refs, '--not', '--remotes'], false);
    if (!made.ok || !git(['bundle', 'verify', '-q', bundle]).ok) {
      dropTemp();
      undoWork();
      return stays('the bundle of its commits did not verify');
    }
  }
  const state: OwnState = {
    kind: 'shelve',
    date: today,
    from: repo,
    branch: branch.ok ? branch.out : null,
    head: head.ok ? head.out : null,
    branches,
    stashes,
    work,
    detached,
    files: own.carried,
    skipped: own.skipped,
  };
  writeState(set, state);
  const failed = copyFiles(repo, own.carried, set, deps.sh);
  if (failed) {
    dropTemp();
    undoWork();
    return stays(failed);
  }
  // All of it is beside the clone: now the clone goes onto the server branch, clean.
  dropTemp();
  if (stashes.length) git(['stash', 'clear'], false);
  for (const e of own.carried) deps.sh(`rm -rf ${shellQuote(path.join(repo, e))}`);
  const lines = [
    `⚠ its own — ${[
      ...(own.commits
        ? [`${own.commits} commit(s) on ${branches.length ? branches.join(', ') : 'a detached HEAD'}`]
        : []),
      ...(work ? [`${own.uncommitted} uncommitted`] : []),
      ...(stashes.length - (work ? 1 : 0) > 0 ? [`${stashes.length - (work ? 1 : 0)} stash(es)`] : []),
      ...(own.carried.length ? [own.carried.join(', ')] : []),
    ].join(
      ', ',
    )} — kept beside it in ${path.basename(path.dirname(set))}/${path.basename(set)}/; vdx take brings it back`,
  ];
  if (!git(['checkout', '-q', '-B', server.local, server.remote], false).ok) {
    lines.push(`✗ git checkout ${server.remote} failed — the clone stays on ${branch.out || 'HEAD'}`);
    return { ok: false, lines };
  }
  for (const b of branches.filter((x) => x !== server.local)) git(['branch', '-q', '-D', b], false);
  lines.push(`the clone is on ${server.remote}, as the server has it`);
  return { ok: true, lines };
}

/** The sets of kind `shelve` beside a place, oldest first. */
function shelveSets(place: string): string[] {
  const dir = `${place}${OWN_SUFFIX}`;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => / shelve( \d+)?$/.test(n) && fs.existsSync(path.join(dir, n, 'state.json')))
    .sort()
    .map((n) => path.join(dir, n));
}

/** Sets beside a place that `vdx take` does not bring back: a second clone's. */
export function otherSets(place: string): string[] {
  const dir = `${place}${OWN_SUFFIX}`;
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => !/ shelve( \d+)?$/.test(n))
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

export function hasShelveSets(place: string): boolean {
  return shelveSets(place).length > 0;
}

/**
 * `vdx take` of a project from the shelf, after the move: each set its `vdx shelve` kept beside its old place
 * comes back into the project — branches (one that went another way meanwhile: `<branch>-shelved-<date>`), stash
 * entries, the uncommitted work (`git stash pop --index`; a conflict leaves the entry, named), the files git
 * ignores (one already there and different stays in the set, named). A set is removed only when all of it is back.
 */
export function restoreOwn(repo: string, place: string, deps: MoveDeps): { ok: boolean; lines: string[] } {
  const git = gitIn(repo, deps.sh);
  const lines: string[] = [];
  let ok = true;
  for (const set of shelveSets(place)) {
    let state: OwnState;
    try {
      state = JSON.parse(fs.readFileSync(path.join(set, 'state.json'), 'utf8')) as OwnState;
    } catch {
      lines.push(`✗ ${set}: no readable state.json — left as it is`);
      ok = false;
      continue;
    }
    if (!DATE.test(state.date)) {
      lines.push(`✗ ${set}: state.json names no date — left as it is`);
      ok = false;
      continue;
    }
    const left: string[] = [];
    const bundle = path.join(set, 'work.bundle');
    if (fs.existsSync(bundle)) {
      if (
        !git(['bundle', 'verify', '-q', bundle]).ok ||
        !git(['fetch', '-q', bundle, 'refs/*:refs/vdx-own/back/*'], false).ok
      ) {
        lines.push(`✗ ${path.basename(set)}: the bundle did not come back — the set stays`);
        ok = false;
        continue;
      }
      for (const name of state.branches) {
        const sha = git(['rev-parse', '-q', '--verify', `refs/vdx-own/back/heads/${name}`]).out;
        if (!SHA.test(sha) || name.startsWith('-') || !git(['check-ref-format', '--branch', name]).ok) {
          left.push(`branch ${name}`);
          continue;
        }
        const local = git(['rev-parse', '-q', '--verify', `refs/heads/${name}`]);
        if (!local.ok) git(['branch', '-q', name, sha], false);
        else if (git(['merge-base', '--is-ancestor', local.out, sha]).ok) {
          const current = git(['symbolic-ref', '-q', '--short', 'HEAD']).out === name;
          if (
            current
              ? !git(['merge', '-q', '--ff-only', sha], false).ok
              : !git(['branch', '-q', '-f', name, sha], false).ok
          )
            left.push(`branch ${name}`);
        } else if (!git(['merge-base', '--is-ancestor', sha, local.out]).ok) {
          const aside = `${name}-shelved-${state.date}`;
          git(['branch', '-q', '-f', aside, sha], false);
          lines.push(`${name} went another way on the server meanwhile — its own commits are on ${aside}`);
        }
      }
      if (state.detached)
        git(['branch', '-q', '-f', `shelved-head-${state.date}`, 'refs/vdx-own/back/vdx-own/head'], false);
      if (state.branch && git(['symbolic-ref', '-q', '--short', 'HEAD']).out !== state.branch)
        if (
          state.branch.startsWith('-') ||
          !git(['check-ref-format', '--branch', state.branch]).ok ||
          !git(['checkout', '-q', state.branch], false).ok
        )
          left.push(`checkout ${state.branch}`);
      // Stash entries, oldest first, so the newest is stash@{0} again.
      for (let n = state.stashes.length - 1; n >= 0; n--) {
        const s = state.stashes[n]!;
        if (!SHA.test(s.sha) || !git(['stash', 'store', '-m', s.message, s.sha], false).ok)
          left.push(`stash ${s.message}`);
      }
      if (state.work && !git(['stash', 'pop', '-q', '--index'], false).ok)
        lines.push(`the uncommitted work did not apply cleanly — it is stash@{0} (${state.stashes[0]?.message ?? ''})`);
      dropRefs(git, 'refs/vdx-own/back');
    }
    for (const e of state.files) {
      if (!insideProject(e)) {
        left.push(`${e} (not a path inside the project)`);
        continue;
      }
      const from = path.join(set, 'files', e);
      const to = path.join(repo, e);
      const ran = fs.existsSync(to)
        ? deps.sh(`diff -rq ${shellQuote(from)} ${shellQuote(to)} >/dev/null`)
        : deps.sh(`mkdir -p ${shellQuote(path.dirname(to))} && cp -pR ${shellQuote(from)} ${shellQuote(to)}`);
      if (!ran || ran.status !== 0) left.push(e);
    }
    if (left.length) {
      lines.push(`✗ ${path.basename(set)}: not back — ${left.join(', ')}; the set stays in ${set}`);
      ok = false;
      continue;
    }
    fs.rmSync(set, { recursive: true, force: true });
    lines.push(`✓ ${path.basename(set)}: its own is back in the project`);
  }
  try {
    fs.rmdirSync(`${place}${OWN_SUFFIX}`);
  } catch {
    // other sets stay, or none was there
  }
  return { ok, lines };
}
