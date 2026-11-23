import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Environment, shellQuote } from './ai.ts';
import { remoteParts } from './author.ts';
import {
  dropSet,
  hasShelveSets,
  keepOwn,
  keepSecondClone,
  otherSets,
  type Own,
  OWN_SUFFIX,
  ownOf,
  restoreOwn,
} from './own.ts';
import {
  carryOut,
  EXIT_USAGE,
  expandHome,
  loadProfile,
  type MoveDeps,
  type Planned,
  projectRootOf,
  realish,
  type ShelfSteps,
  tilde,
  within,
} from './move.ts';

/**
 * `vdx take` and `vdx shelve` — a project from the shelf (every clone, by `<host>/<path from the remote>`) onto
 * the desk (projects at work, by name and the owner's groups) and back, on the mechanics of `vdx move`
 * (claude-memory-in-project DL #26–#28; nas-info `desk-and-shelf-take-shelve`).
 *
 * `take` leaves a relative link on the shelf at the project's place, so the shelf knows every project of the
 * desk that has a remote: where the project came from on the shelf, else at the second clone of its remote
 * (which goes, when nothing in it is its own), else at `<host>/<path from the remote>`. `shelve` puts the
 * project where the link to it is, else at `<host>/<path from the remote>`.
 */

/** How deep the shelf is walked for clones and links: host, groups, repo; clones are not walked into. */
const MAX_DEPTH = 6;

interface Remote {
  host: string;
  /** The path on the host, without `.git`. */
  path: string;
  /** host/path in lower case: two remotes of one repo compare equal. */
  key: string;
}

interface ShelfScan {
  clones: { path: string; key: string | null }[];
  links: { path: string; target: string }[];
}

/** The desk and the shelf from the profile (`move.desk`, `move.shelf`), or null after the reason is said. */
function deskAndShelf(verb: string, environment: Environment, deps: MoveDeps): { desk: string; shelf: string } | null {
  const desk = environment.move?.desk;
  const shelf = environment.move?.shelf;
  if (!desk || !shelf) {
    deps.log(
      `vdx ${verb}: the profile names no ${!desk ? 'desk (move.desk)' : 'shelf (move.shelf)'} — where projects at work and every clone live`,
    );
    return null;
  }
  return { desk: realish(expandHome(desk, deps.home)), shelf: realish(expandHome(shelf, deps.home)) };
}

/**
 * Remotes as `<host>/<path>`. A host without a dot is an ssh alias (`stash`, `github`): its HostName from
 * `ssh -G`. A dotted host stays as it is — the ssh config may point it at an address, not a name.
 */
function remotes(deps: MoveDeps): (url: string) => Remote | null {
  const hosts = new Map<string, string>();
  const real = (host: string): string => {
    if (host.includes('.')) return host;
    if (!hosts.has(host)) {
      const ran = deps.sh(`ssh -G ${shellQuote(host)} 2>/dev/null | sed -n 's/^hostname //p' | head -n 1`);
      hosts.set(host, ran?.stdout.trim() || host);
    }
    return hosts.get(host)!;
  };
  return (url) => {
    const parts = remoteParts(url.trim());
    const repoPath = parts.path.replace(/^\/+/, '');
    if (!parts.host || !repoPath) return null;
    const host = /^https?:\/\//i.test(url.trim()) ? parts.host : real(parts.host);
    return { host, path: repoPath, key: `${host}/${repoPath}`.toLowerCase() };
  };
}

/** `remote.origin.url` from a repository's `.git/config`; null — none, or `.git` is not a folder. */
function originOf(repo: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8');
  } catch {
    return null;
  }
  let inOrigin = false;
  for (const line of text.split('\n')) {
    const section = /^\s*\[(.+)\]\s*$/.exec(line);
    if (section) {
      inOrigin = /^remote\s+"origin"$/.test(section[1]!.trim());
      continue;
    }
    const url = inOrigin ? /^\s*url\s*=\s*(.+?)\s*$/.exec(line) : null;
    if (url) return url[1]!;
  }
  return null;
}

/** The project's origin, as git reads it (a worktree's too). */
function projectOrigin(root: string, deps: MoveDeps): string | null {
  const ran = deps.sh(`git -C ${shellQuote(root)} config --get remote.origin.url 2>/dev/null`);
  return ran && ran.status === 0 && ran.stdout.trim() ? ran.stdout.trim() : null;
}

/** The shelf's clones (with their origin) and links; a clone is not walked into, nor what keeps a project's own. */
function scanShelf(shelf: string, keyOf: (url: string) => Remote | null): ShelfScan {
  const out: ShelfScan = { clones: [], links: [] };
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === '.git' || e.name.startsWith('.st') || e.name.endsWith(OWN_SUFFIX)) continue;
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        try {
          out.links.push({ path: p, target: fs.readlinkSync(p) });
        } catch {
          // gone while walked
        }
        continue;
      }
      if (!e.isDirectory()) continue;
      if (fs.existsSync(path.join(p, '.git'))) {
        const url = originOf(p);
        out.clones.push({ path: p, key: url ? (keyOf(url)?.key ?? null) : null });
        continue;
      }
      if (depth < MAX_DEPTH) walk(p, depth + 1);
    }
  };
  walk(shelf, 1);
  return out;
}

/** `<shelf>/<host>/<path>`, each part spelled as a folder already there spells it (the volume may ignore case). */
function placeFor(shelf: string, remote: Remote): string {
  let at = shelf;
  for (const part of [remote.host, ...remote.path.split('/').filter(Boolean)]) {
    let name = part;
    try {
      name = fs.readdirSync(at).find((n) => n.toLowerCase() === part.toLowerCase()) ?? part;
    } catch {
      // not there yet
    }
    at = path.join(at, name);
  }
  return at;
}

/** Where a link leads, its existing part resolved through links. */
function linkLeadsTo(link: { path: string; target: string }): string {
  return realish(path.resolve(path.dirname(link.path), link.target));
}

/** "2 commits not on the server, 3 uncommitted, 1 stash" — what blocks replacing a clone; [] — nothing. */
function workOf(own: Own): string[] {
  const out: string[] = [];
  if (own.commits === null) out.push('git cannot tell which commits the server has');
  else if (own.commits) out.push(`${own.commits} commit(s) on no remote branch it knows`);
  if (own.uncommitted) out.push(`${own.uncommitted} uncommitted`);
  if (own.stashes) out.push(`${own.stashes} stash(es)`);
  return out;
}

/** A step's lines, under the project in the output; whether it went through. */
function said(result: { ok: boolean; lines: string[] }, deps: MoveDeps): boolean {
  for (const l of result.lines) deps.log(`  ${l}`);
  return result.ok;
}

function named(list: string[], max = 4): string {
  return list.length <= max ? list.join(', ') : `${list.slice(0, max).join(', ')} and ${list.length - max} more`;
}

/** Before the pause: a second clone's ignored files beside it; the undo removes them if the take does not happen. */
function keepBeside(clone: string, own: Own, deps: MoveDeps): (() => void) | null {
  const kept = keepSecondClone(clone, own, deps.today, deps);
  if ('error' in kept) {
    deps.log(`✗ ${path.basename(clone)}: its ignored files did not go beside it — ${kept.error}`);
    return null;
  }
  deps.log(`✓ ${path.basename(clone)}: ${named(own.carried)} → ${tilde(kept.set, deps.home)}/`);
  return () => dropSet(kept.set);
}

/** The link `vdx take` leaves on the shelf for a project going to `to`, or null with the reason in `notes`. */
function takeLink(
  root: string,
  to: string,
  remote: Remote,
  places: { desk: string; shelf: string },
  scan: ShelfScan,
  deps: MoveDeps,
  planned: Planned,
): ShelfSteps | null {
  const { home } = deps;
  const notes = planned.notes!;
  const { desk, shelf } = places;
  const target = (at: string) => path.relative(path.dirname(at), to);
  const base = { root: shelf, replaceLinksInto: desk };
  // From the shelf: the link takes the project's own place.
  if (within(root, shelf)) return { ...base, link: { path: root, target: target(root) } };
  // Its link already: it follows the project.
  const ours = scan.links.filter((l) => linkLeadsTo(l) === root);
  if (ours.length > 1) {
    notes.push(`links to it on the shelf: ${named(ours.map((l) => tilde(l.path, home)))} — keep one; no link made`);
    return null;
  }
  if (ours.length === 1) return { ...base, link: { path: ours[0]!.path, target: target(ours[0]!.path) } };
  const same = scan.clones.filter((c) => c.key === remote.key);
  if (same.length > 1) {
    notes.push(`clones of its origin on the shelf: ${named(same.map((c) => tilde(c.path, home)))} — no link made`);
    return null;
  }
  if (same.length === 1) {
    const clone = same[0]!.path;
    const own = ownOf(clone, deps);
    const work = workOf(own);
    if (work.length) {
      notes.push(`second clone ${tilde(clone, home)}: ${work.join(', ')} — its own, left as it is; no link made`);
      return null;
    }
    const beside = `${path.basename(clone)}${OWN_SUFFIX}/${deps.today} second clone/`;
    notes.push(
      `second clone ${tilde(clone, home)}: nothing of its own — the link takes its place${
        own.carried.length
          ? `; files git ignores, which Syncthing carries, go beside it into ${beside}: ${named(own.carried)}`
          : ''
      }${own.skipped.length ? `; gone with it, as Syncthing does not carry them: ${named(own.skipped)}` : ''}`,
    );
    if (own.carried.length) planned.prepare = () => keepBeside(clone, own, deps);
    return { ...base, link: { path: clone, target: target(clone) }, dropClone: true };
  }
  const place = placeFor(shelf, remote);
  let taken: fs.Stats | null = null;
  try {
    taken = fs.lstatSync(place);
  } catch {
    // free
  }
  if (taken) {
    const what = taken.isSymbolicLink()
      ? `a link to ${fs.readlinkSync(place)}`
      : fs.existsSync(path.join(place, '.git'))
        ? `a clone of ${originOf(place) ?? 'no origin'}`
        : 'not a clone';
    notes.push(`${tilde(place, home)} on the shelf is ${what} — no link made`);
    return null;
  }
  return { ...base, link: { path: place, target: target(place) } };
}

/**
 * `vdx move` of a project of the desk: its link on the shelf would go on leading to the old place — said in the
 * plan, with the command that moves the project and its link together.
 */
export function deskLinkNotes(root: string, environment: Environment, deps: MoveDeps): string[] {
  const { home } = deps;
  const desk = environment.move?.desk;
  const shelf = environment.move?.shelf;
  if (!desk || !shelf || !within(root, realish(expandHome(desk, home)))) return [];
  const at = realish(expandHome(shelf, home));
  if (!fs.existsSync(at)) return [];
  return scanShelf(at, () => null)
    .links.filter((l) => linkLeadsTo(l) === root)
    .map(
      (l) =>
        `shelf: the link ${tilde(l.path, home)} leads here and would lead to the old place — vdx take ${shellQuote(tilde(root, home))} --in <group> moves it with the link`,
    );
}

function badGroup(group: string): boolean {
  return group.trim() === '' || path.isAbsolute(group) || group.split('/').includes('..');
}

export function runTake(input: { sources: string[]; group?: string; dryRun: boolean }, deps: MoveDeps): number {
  const { log, home } = deps;
  const environment = loadProfile('take', deps);
  if (!environment) return EXIT_USAGE;
  const places = deskAndShelf('take', environment, deps);
  if (!places) return EXIT_USAGE;
  if (input.group !== undefined && badGroup(input.group)) {
    log(`vdx take: --in names a group on the desk (GA, SPACE/limex) — not ${JSON.stringify(input.group)}`);
    return EXIT_USAGE;
  }
  const folder = input.group === undefined ? places.desk : path.join(places.desk, input.group);
  const keyOf = remotes(deps);
  let scan: ShelfScan | null = null;
  const moves: Planned[] = [];
  const refusals: string[] = [];
  for (const src of input.sources) {
    const found = projectRootOf(src, deps);
    if ('refusal' in found) {
      refusals.push(found.refusal);
      continue;
    }
    const { root } = found;
    const to = path.join(folder, path.basename(root));
    if (to !== root && within(folder, root)) {
      refusals.push(`${tilde(folder, home)} lies inside ${tilde(root, home)}`);
      continue;
    }
    if (moves.some((m) => m.from === root || m.to === to)) {
      refusals.push(`${tilde(root, home)}: named twice, or another project has its name`);
      continue;
    }
    const notes: string[] = [];
    const planned: Planned = {
      name: path.basename(root),
      from: root,
      to,
      notes,
      ...(to === root ? { stay: true } : {}),
    };
    const url = projectOrigin(root, deps);
    const remote = url ? keyOf(url) : null;
    if (!url) notes.push('no origin — it lives on the desk only, the shelf gets no link');
    else if (!remote) notes.push(`origin ${url} names no host and path — no link on the shelf`);
    else if (!fs.existsSync(places.shelf)) notes.push(`the shelf ${tilde(places.shelf, home)} is not here — no link`);
    else {
      scan ??= scanShelf(places.shelf, keyOf);
      const steps = takeLink(root, to, remote, places, scan, deps, planned);
      if (steps) planned.shelf = steps;
    }
    // Taken from the shelf: what vdx shelve kept beside it comes back after the move.
    if (within(root, places.shelf)) {
      if (hasShelveSets(root)) {
        notes.push(
          `its own, kept beside it by vdx shelve in ${path.basename(root)}${OWN_SUFFIX}/, comes back after the move`,
        );
        planned.finish = () => said(restoreOwn(to, root, deps), deps);
      }
      const others = otherSets(root);
      if (others.length)
        notes.push(
          `beside it, and not brought back: ${named(others.map((o) => path.basename(o)))} in ${path.basename(root)}${OWN_SUFFIX}/`,
        );
    }
    if (planned.stay && !planned.shelf) {
      log(`${planned.name}: on the desk already, in ${tilde(folder, home)}/ — ${notes.join('; ') || 'nothing to do'}`);
      continue;
    }
    moves.push(planned);
  }
  if (refusals.length) {
    for (const r of refusals) log(`vdx take: ${r}`);
    log('nothing moved');
    return EXIT_USAGE;
  }
  if (!moves.length) return 0;
  return carryOut({ verb: 'take', moves, environment, dryRun: input.dryRun, into: `${tilde(folder, home)}/` }, deps);
}

export function runShelve(input: { sources: string[]; dryRun: boolean }, deps: MoveDeps): number {
  const { log, home } = deps;
  const environment = loadProfile('shelve', deps);
  if (!environment) return EXIT_USAGE;
  const places = deskAndShelf('shelve', environment, deps);
  if (!places) return EXIT_USAGE;
  const { shelf } = places;
  const keyOf = remotes(deps);
  let scan: ShelfScan | null = null;
  const moves: Planned[] = [];
  const refusals: string[] = [];
  for (const src of input.sources) {
    const found = projectRootOf(src, deps);
    if ('refusal' in found) {
      refusals.push(found.refusal);
      continue;
    }
    const { root } = found;
    if (within(root, shelf)) {
      refusals.push(`${tilde(root, home)} is on the shelf already`);
      continue;
    }
    const url = projectOrigin(root, deps);
    const remote = url ? keyOf(url) : null;
    if (!url || !remote) {
      refusals.push(
        `${tilde(root, home)}: ${url ? `origin ${url} names no host and path` : 'no origin'} — the shelf keeps clones by their remote; a project without one lives on the desk`,
      );
      continue;
    }
    if (!fs.existsSync(shelf)) {
      refusals.push(`the shelf ${tilde(shelf, home)} is not here`);
      continue;
    }
    scan ??= scanShelf(shelf, keyOf);
    const ours = scan.links.filter((l) => linkLeadsTo(l) === root);
    if (ours.length > 1) {
      refusals.push(
        `${tilde(root, home)}: links to it on the shelf — ${named(ours.map((l) => tilde(l.path, home)))}; keep one`,
      );
      continue;
    }
    const steps: ShelfSteps = { root: shelf };
    let to: string;
    if (ours.length === 1) {
      to = ours[0]!.path;
      steps.unlink = { path: to, target: ours[0]!.target };
    } else {
      to = placeFor(shelf, remote);
      if (fs.existsSync(to) || scan.links.some((l) => l.path === to)) {
        refusals.push(
          `${tilde(to, home)} on the shelf is taken${fs.existsSync(path.join(to, '.git')) ? ' by a clone of it' : ''} — nothing moved`,
        );
        continue;
      }
    }
    if (moves.some((m) => m.from === root || m.to === to)) {
      refusals.push(`${tilde(root, home)}: named twice, or another project has its place`);
      continue;
    }
    const notes: string[] = [];
    const others = scan.clones.filter((c) => c.key === remote.key && c.path !== to);
    if (others.length)
      notes.push(`another clone of its origin on the shelf: ${named(others.map((c) => tilde(c.path, home)))}`);
    const own = ownOf(root, deps);
    const mine = [...workOf(own), ...(own.carried.length ? [`git ignores ${named(own.carried)}`] : [])];
    if (mine.length)
      notes.push(
        `⚠ its own: ${mine.join(', ')} — after the move, beside it in ${path.basename(to)}${OWN_SUFFIX}/${deps.today} shelve/; the clone goes onto the server branch`,
      );
    moves.push({
      name: path.basename(root),
      from: root,
      to,
      shelf: steps,
      notes,
      finish: () => said(keepOwn(to, deps.today, deps), deps),
      fixMemory: false,
    });
  }
  if (refusals.length) {
    for (const r of refusals) log(`vdx shelve: ${r}`);
    log('nothing moved');
    return EXIT_USAGE;
  }
  return carryOut({ verb: 'shelve', moves, environment, dryRun: input.dryRun, into: `${tilde(shelf, home)}/` }, deps);
}
