import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { remoteParts } from './author.ts';
import { claudeConfigDir, claudeTrusts, projectDirName } from './conversations.ts';
import { githubToken, machineIo, type HostingIo } from './hosting.ts';
import { at, dict, errorMessage, list, str } from './narrow.ts';

/**
 * Where Claude Code keeps a project's memory (docs/tasks/claude-memory-in-project).
 * Unset, it is `<config>/projects/<path, non-letters → "-">/memory/` — tied to the
 * folder's path, so a moved folder loses it, and its conversations with it. The
 * owner keeps it inside the project, `.claude/memory/`, named by
 * `autoMemoryDirectory`: an absolute path or `~/`, nothing relative, no variables
 * (Claude Code 2.1.308, DL #2). A path written there outlives a move as the trace of
 * the old place.
 */
export type MemoryState =
  /** In `.claude/memory/`, nothing left in the old place. */
  | { kind: 'inside' }
  /**
   * In `.claude/memory/`, and notes still lie in the old place — a move made by hand. `afterMove`:
   * vdx set the old place aside before, so a session that started before the move wrote them.
   */
  | { kind: 'leftovers'; old: string; notes: number; differ: number; onlyOld: number; afterMove: boolean }
  /** Not set: memory goes to the old place. */
  | { kind: 'outside'; old: string; notes: number }
  /**
   * Set to `<X>/.claude/memory/` of a folder that is gone: the project moved from X. `stray`: X
   * holds nothing but that memory — a session that read the old path wrote there after the move.
   */
  | { kind: 'moved'; setting: MemorySetting; from: string; conversations: string | null; stray: string | null }
  /** Set to `<X>/.claude/memory/` of another folder that exists. */
  | { kind: 'elsewhere'; setting: MemorySetting; from: string }
  /**
   * Set, in the repo's own `.claude/settings.json`, to the memory of another clone of the same
   * repo: the repo's choice — a deploy clone keeps no memory of its own (nas-info, 2026-10-24).
   */
  | { kind: 'shared'; setting: MemorySetting; from: string }
  /** Set to a path of the owner's own choosing. */
  | { kind: 'custom'; setting: MemorySetting };

interface MemorySetting {
  /** The settings file that names it. */
  file: string;
  /** The path it names, `~/` expanded, without the trailing slash. */
  dir: string;
}

export interface MemoryCtx {
  env: NodeJS.ProcessEnv;
  home: string;
}

const MEMORY = path.join('.claude', 'memory');

function realRoot(root: string): string {
  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

/**
 * A folder whose memory vdx may move: not the home directory or above it — its
 * `.claude/settings.json` is the user's own, read by every project — and not inside
 * Claude Code's configuration.
 */
export function memoryApplies(projectRoot: string, ctx: MemoryCtx): boolean {
  const root = realRoot(projectRoot);
  const home = realRoot(ctx.home);
  const config = realRoot(claudeConfigDir(ctx.env, ctx.home));
  const within = (a: string, b: string) => a === b || a.startsWith(b + path.sep);
  return !within(home, root) && !within(root, config);
}

/** Where the setting is read, in Claude Code's order: local settings, the project's, the user's. */
function settingFiles(root: string, ctx: MemoryCtx): string[] {
  return [
    path.join(root, '.claude', 'settings.local.json'),
    path.join(root, '.claude', 'settings.json'),
    path.join(claudeConfigDir(ctx.env, ctx.home), 'settings.json'),
  ];
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return dict(JSON.parse(fs.readFileSync(file, 'utf8'))) ?? null;
  } catch {
    return null;
  }
}

function readSetting(root: string, ctx: MemoryCtx): MemorySetting | null {
  for (const file of settingFiles(root, ctx)) {
    const value = str(readJson(file)?.['autoMemoryDirectory']);
    if (!value) continue;
    const expanded = value.startsWith('~/') ? path.join(ctx.home, value.slice(2)) : value;
    // Claude Code drops a relative path without a word (DL #2): it is no setting.
    if (!path.isAbsolute(expanded)) continue;
    return { file, dir: path.resolve(expanded) };
  }
  return null;
}

/** The old place: what Claude Code uses when nothing is set. */
export function defaultMemoryDir(root: string, ctx: MemoryCtx): string {
  return path.join(claudeConfigDir(ctx.env, ctx.home), 'projects', projectDirName(realRoot(root)), 'memory');
}

function entries(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((n) => n !== '.DS_Store');
  } catch {
    return [];
  }
}

/** vdx set this place aside once already (`asideName`): what lies there now came after (Sidetrack #5). */
function setAsideBefore(dir: string): boolean {
  return entries(path.dirname(dir)).some((n) => n.startsWith(`${path.basename(dir)}.moved-`));
}

function sameFile(a: string, b: string): boolean {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

export function memoryState(projectRoot: string, ctx: MemoryCtx): MemoryState {
  const root = realRoot(projectRoot);
  const target = path.join(root, MEMORY);
  const old = defaultMemoryDir(root, ctx);
  const setting = readSetting(root, ctx);
  const notes = entries(old);
  if (!setting) return { kind: 'outside', old, notes: notes.length };
  if (setting.dir === target) {
    if (notes.length === 0) return { kind: 'inside' };
    const differ = notes.filter(
      (n) => fs.existsSync(path.join(target, n)) && !sameFile(path.join(old, n), path.join(target, n)),
    );
    const onlyOld = notes.filter((n) => !fs.existsSync(path.join(target, n)));
    return {
      kind: 'leftovers',
      old,
      notes: notes.length,
      differ: differ.length,
      onlyOld: onlyOld.length,
      afterMove: setAsideBefore(old),
    };
  }
  if (path.basename(setting.dir) === 'memory' && path.basename(path.dirname(setting.dir)) === '.claude') {
    const from = path.dirname(path.dirname(setting.dir));
    const stub = entries(from).join() === '.claude' && entries(path.join(from, '.claude')).join() === 'memory';
    if (fs.existsSync(from) && !stub)
      return sameRepo(root, from) && tracked(root, setting.file)
        ? { kind: 'shared', setting, from }
        : { kind: 'elsewhere', setting, from };
    const conversations = path.join(claudeConfigDir(ctx.env, ctx.home), 'projects', projectDirName(from));
    return {
      kind: 'moved',
      setting,
      from,
      conversations: fs.existsSync(conversations) ? conversations : null,
      stray: stub ? setting.dir : null,
    };
  }
  return { kind: 'custom', setting };
}

/** Both folders are clones of one repo: the same `origin`, however it is spelled. */
function sameRepo(a: string, b: string): boolean {
  const origin = (dir: string) => {
    const url = git(dir, ['remote', 'get-url', 'origin']);
    if (!url) return null;
    const { host, path: repo } = remoteParts(url);
    return host ? `${host.toLowerCase()}:${repo.toLowerCase()}` : null;
  };
  const here = origin(a);
  return here !== null && here === origin(b);
}

/** A file of the repo, under git — every clone has it. */
function tracked(root: string, file: string): boolean {
  return git(root, ['ls-files', '--error-unmatch', '--', path.relative(root, file)]) !== null;
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** A host of `git.personal_hosts`: its repos are the owner's alone; `mirrors` — where its repos may be copied. */
export interface PersonalHost {
  host: string;
  /** `github.com/<owner>/{repo}`: a repo of the host may be mirrored there (gitolite's post-update hook). */
  mirrors: string[];
}

/** The profile's `git.personal_hosts`: a host name, or `{host, mirrors}`. */
export function personalHosts(
  listed: Array<string | { host: string; mirrors?: string[] }> | undefined,
): PersonalHost[] {
  return (listed ?? []).map((h) =>
    typeof h === 'string'
      ? { host: h.toLowerCase(), mirrors: [] }
      : { host: h.host.toLowerCase(), mirrors: h.mirrors ?? [] },
  );
}

/** Who may read where the repo's commits go: only its owner, or — why not. */
export type Readers = { only: true } | { only: false; why: string };

/**
 * Whether only the owner reads every place a commit of this repo reaches (DL #12 of
 * docs/tasks/claude-memory-in-project): origin on a host the profile names as the
 * owner's (`git.personal_hosts`), or a private GitHub repo with no other collaborator;
 * and every mirror the profile names for that host — absent, or private and nobody
 * else's. No origin: nothing leaves the machine. GitHub is asked with the token gh
 * keeps; no token, no answer, `VDX_OFFLINE` — not known, so not only.
 */
export function memoryReaders(io: HostingIo, hosts: PersonalHost[]): Readers {
  const url = io.git(['remote', 'get-url', 'origin']);
  if (!url) return { only: true };
  const { host, path: repo } = remoteParts(url);
  const lower = host.toLowerCase();
  const own = hosts.find((h) => h.host === lower);
  const places: string[] = [];
  if (lower === 'github.com') places.push(repo);
  else if (!own)
    return { only: false, why: `origin is on ${host} — not a host the profile names as yours (git.personal_hosts)` };
  for (const m of own?.mirrors ?? []) {
    const at = m.replace(/^https?:\/\//, '').replace('{repo}', repo);
    if (!at.startsWith('github.com/'))
      return { only: false, why: `the mirror ${m} is not on GitHub — vdx cannot tell who reads it` };
    places.push(at.slice('github.com/'.length));
  }
  if (places.length === 0) return { only: true };
  if (io.env.VDX_OFFLINE) return { only: false, why: 'VDX_OFFLINE is set — GitHub was not asked who reads' };
  const token = githubToken(io)?.token ?? null;
  if (!token) return { only: false, why: 'no GitHub token to ask who reads — gh auth login' };
  try {
    const me = str(at(io.get('/user', token).body, 'login'));
    if (!me) return { only: false, why: 'GitHub named no user for the token' };
    for (const p of places) {
      const r = io.get(`/repos/${p}`, token);
      if (r.status === 404 && p !== repo) continue; // that mirror does not exist
      if (r.status !== 200) return { only: false, why: `GitHub answered ${r.status} for ${p}` };
      if (at(r.body, 'private') !== true) return { only: false, why: `github.com/${p} is public` };
      const c = io.get(`/repos/${p}/collaborators?per_page=100`, token);
      if (c.status !== 200) return { only: false, why: `GitHub does not show who reads github.com/${p} (${c.status})` };
      const others = list(c.body)
        .map((x) => str(at(x, 'login')))
        .filter((l) => l && l !== me);
      if (others.length) return { only: false, why: `github.com/${p} is read by ${others.length} more besides ${me}` };
    }
    return { only: true };
  } catch (e) {
    return { only: false, why: `GitHub did not answer: ${errorMessage(e)}` };
  }
}

/** A personal project: its memory may go under git (DL #3, #4, #12). */
export function isPersonalProject(
  projectRoot: string,
  hosts: PersonalHost[],
  io: HostingIo = machineIo(projectRoot),
): boolean {
  return memoryReaders(io, hosts).only;
}

/** Needs `vdx doctor --fix`: anything but inside, a path of the owner's own, or the repo's shared one. */
export function memoryNeedsFix(state: MemoryState): boolean {
  return state.kind !== 'inside' && state.kind !== 'custom' && state.kind !== 'shared';
}

function tilde(p: string, home: string): string {
  return p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

/** One line on where the memory is, for doctor and `vdx ai`. */
export function describeMemory(state: MemoryState, ctx: MemoryCtx): string {
  switch (state.kind) {
    case 'inside':
      return 'in .claude/memory/';
    case 'leftovers': {
      if (state.afterMove)
        return `in .claude/memory/, and ${state.notes} note(s) written in the old place after the move, ${tilde(state.old, ctx.home)} — by a session that started before it; the fix brings them in`;
      const parts = [state.differ ? `${state.differ} differ` : '', state.onlyOld ? `${state.onlyOld} only there` : '']
        .filter(Boolean)
        .join(', ');
      return `in .claude/memory/, and ${state.notes} note(s) still in the old place, ${tilde(state.old, ctx.home)}${parts ? ` (${parts})` : ''} — the project's agent takes what it needs, vdx copies nothing back`;
    }
    case 'outside':
      return state.notes
        ? `outside the project: ${state.notes} note(s) in ${tilde(state.old, ctx.home)} — a moved folder loses them, and its conversations`
        : `not set: notes would go to ${tilde(state.old, ctx.home)}, by the folder's path — a moved folder loses them, and its conversations`;
    case 'moved':
      return `autoMemoryDirectory points to ${tilde(state.setting.dir, ctx.home)}/, ${state.stray ? 'in a folder that holds nothing else' : 'a folder that is gone'} — the project moved from ${tilde(state.from, ctx.home)}${state.conversations ? ', and its conversations stay under the old path' : ''}`;
    case 'elsewhere':
      return `autoMemoryDirectory points to the memory of another folder, ${tilde(state.from, ctx.home)} (set in ${tilde(state.setting.file, ctx.home)})`;
    case 'shared':
      return `in the memory of another clone of this repo, ${tilde(state.from, ctx.home)}/.claude/memory/ — the path comes from the repo's .claude/settings.json; a memory of its own: autoMemoryDirectory in .claude/settings.local.json`;
    case 'custom':
      return `in ${tilde(state.setting.dir, ctx.home)}/ (autoMemoryDirectory, set in ${tilde(state.setting.file, ctx.home)})`;
  }
}

export interface MemoryFixOptions {
  /** Personal project (`isPersonalProject`): the path goes into `.claude/settings.json`, the memory under git. */
  personal: boolean;
  /** Not personal: keep `.claude/memory/` under git anyway — the person said yes. */
  underGit: boolean;
  /** YYYY-MM-DD, for the name the old place is set aside under. */
  today: string;
}

/** A free name beside `dir`: `<dir>.moved-<date>`, then `-2`, `-3`… */
function asideName(dir: string, today: string): string {
  const base = `${dir}.moved-${today}`;
  let name = base;
  for (let i = 2; fs.existsSync(name); i++) name = `${base}-${i}`;
  return name;
}

/** Copies what `to` lacks; a name `to` already has stays as it is there. Returns the names copied and kept. */
function copyMissing(from: string, to: string): { copied: string[]; kept: string[] } {
  fs.mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  const kept: string[] = [];
  for (const name of entries(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    if (fs.existsSync(dst)) {
      if (!sameFile(src, dst)) kept.push(name);
      continue;
    }
    fs.cpSync(src, dst, { recursive: true, errorOnExist: true, force: false });
    copied.push(name);
  }
  return { copied, kept };
}

const INDEX = 'MEMORY.md';

/**
 * Notes a session wrote at the old place after the move, brought into `to`: the agent finds a
 * note by its line in MEMORY.md, so the lines of the old index that point at the notes
 * brought in join `to`'s — those alone. A line about a note `to` already has is the
 * project's agent's to judge (DL #8). Returns what was done, one line each, and the names kept.
 */
function bringIn(from: string, to: string, what: string, aside: string): { done: string[]; differ: string[] } {
  const { copied, kept } = copyMissing(from, to);
  const done = [`${copied.length} note(s) ${what} → .claude/memory/`];
  const notes = copied.filter((n) => n !== INDEX);
  const src = path.join(from, INDEX);
  const dst = path.join(to, INDEX);
  if (notes.length && !copied.includes(INDEX) && fs.existsSync(src)) {
    const have = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : '';
    const lines = fs
      .readFileSync(src, 'utf8')
      .split('\n')
      .filter((l) => notes.some((n) => l.includes(`](${n})`) && !have.includes(`(${n})`)));
    if (lines.length) {
      fs.writeFileSync(dst, have + (have && !have.endsWith('\n') ? '\n' : '') + lines.join('\n') + '\n');
      done.push(`${lines.length} line(s) of its MEMORY.md → .claude/memory/MEMORY.md, for the notes brought in`);
    }
  }
  const differ = kept.filter((n) => n !== INDEX);
  if (differ.length)
    done.push(`kept .claude/memory/ as it is for ${differ.join(', ')} — the later copy differs, it stays in ${aside}`);
  return { done, differ };
}

/** Sets `autoMemoryDirectory` in a settings file, keeping its other keys. */
function writeSetting(file: string, dir: string): void {
  let doc: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const parsed = readJson(file);
    if (!parsed)
      throw new Error(`${file} is not a JSON object — nothing written; set autoMemoryDirectory there by hand`);
    doc = parsed;
  }
  doc['autoMemoryDirectory'] = dir + '/';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
}

/** `/.claude/memory/` in the clone's own exclude file — the repository itself does not change. */
function excludeMemory(root: string): string | null {
  const file = git(root, ['rev-parse', '--git-path', 'info/exclude']);
  if (!file) return null;
  const abs = path.resolve(root, file);
  const line = '/.claude/memory/';
  const text = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  if (!text.split('\n').includes(line)) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text + (text && !text.endsWith('\n') ? '\n' : '') + line + '\n');
  }
  return abs;
}

/**
 * Moves the project's conversations to the folder's new path: Claude Code finds them
 * by the path, and a moved folder starts with none. What the new place already has
 * stays; the rest of the old place is set aside, never deleted.
 */
function moveConversations(from: string, to: string, today: string): string {
  if (!fs.existsSync(to)) {
    fs.renameSync(from, to);
    return `conversations ${path.basename(from)} → ${path.basename(to)}`;
  }
  let moved = 0;
  for (const name of entries(from)) {
    const dst = path.join(to, name);
    if (fs.existsSync(dst)) continue;
    fs.renameSync(path.join(from, name), dst);
    moved++;
  }
  const left = entries(from).length;
  const aside = left ? asideName(from, today) : null;
  if (aside) fs.renameSync(from, aside);
  else fs.rmdirSync(from);
  return `${moved} conversation file(s) ${path.basename(from)} → ${path.basename(to)}${aside ? `; ${left} already there, the rest set aside as ${path.basename(aside)}` : ''}`;
}

/**
 * Puts the project's memory inside it — `vdx doctor --fix` and the question in
 * `vdx ai`. Nothing is overwritten and nothing deleted: a name `.claude/memory/`
 * already has stays, the old place is renamed. Returns what was done, one line each.
 */
export function fixMemory(projectRoot: string, state: MemoryState, ctx: MemoryCtx, opts: MemoryFixOptions): string[] {
  if (!memoryApplies(projectRoot, ctx))
    throw new Error(`${projectRoot} is no project folder — its settings are the user's own`);
  const root = realRoot(projectRoot);
  const target = path.join(root, MEMORY);
  const done: string[] = [];
  const setAside = (old: string) => {
    if (!fs.existsSync(old)) return;
    const aside = asideName(old, opts.today);
    fs.renameSync(old, aside);
    done.push(`the old place set aside: ${tilde(aside, ctx.home)}`);
  };
  switch (state.kind) {
    case 'inside':
    case 'custom':
    case 'shared':
      return done;
    case 'leftovers':
      // Written after vdx's move by a session that started before it: newer than anything inside.
      if (state.afterMove)
        done.push(
          ...bringIn(
            state.old,
            target,
            'written in the old place after the move',
            tilde(asideName(state.old, opts.today), ctx.home),
          ).done,
        );
      setAside(state.old);
      return done;
    case 'outside': {
      const { copied, kept } = fs.existsSync(state.old) ? copyMissing(state.old, target) : { copied: [], kept: [] };
      if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
      done.push(`${copied.length} note(s) → .claude/memory/`);
      if (kept.length) done.push(`kept .claude/memory/ as it is for ${kept.join(', ')} — the old copy differs`);
      const file = path.join(root, '.claude', opts.personal ? 'settings.json' : 'settings.local.json');
      writeSetting(file, target);
      done.push(`autoMemoryDirectory → .claude/${path.basename(file)}`);
      if (!opts.personal && !opts.underGit && excludeMemory(root)) done.push('.claude/memory/ → .git/info/exclude');
      setAside(state.old);
      if (opts.personal && git(root, ['rev-parse', '--git-dir']) !== null) {
        // The project's own .gitignore may keep .claude/ out (mediko, 2026-10-23).
        const ignored = git(root, ['check-ignore', '-q', '.claude/memory/MEMORY.md']) !== null;
        done.push(
          ignored
            ? ".claude/memory/ stays out of git by the project's own .gitignore"
            : 'commit .claude/memory/ and .claude/settings.json with the project',
        );
      }
      return done;
    }
    case 'moved':
    case 'elsewhere': {
      // The path is rewritten where it was read — unless that file is the user's, read by every
      // project, or the repo's shared settings.json naming another folder: then this clone's own
      // local settings, read first (Sidetrack #4).
      const local = path.join(root, '.claude', 'settings.local.json');
      const inProject = path.dirname(state.setting.file) === path.join(root, '.claude');
      const shared = state.kind === 'elsewhere' && state.setting.file !== local && tracked(root, state.setting.file);
      const file = inProject && !shared ? state.setting.file : local;
      writeSetting(file, target);
      done.push(`autoMemoryDirectory → ${target}/ (${path.relative(root, file)})`);
      if (shared) done.push(`${path.relative(root, state.setting.file)} keeps the other clone's path — it is shared`);
      if (state.kind === 'moved' && state.stray) {
        const brought = bringIn(
          state.stray,
          target,
          'written at the old path after the move',
          tilde(state.stray, ctx.home),
        );
        done.push(
          ...brought.done,
          `${tilde(state.from, ctx.home)} holds only them — remove it${brought.differ.length ? ` once ${brought.differ.join(', ')} is settled` : ''}`,
        );
      }
      if (state.kind === 'moved' && state.conversations) {
        const here = path.join(claudeConfigDir(ctx.env, ctx.home), 'projects', projectDirName(root));
        done.push(moveConversations(state.conversations, here, opts.today));
      }
      // Claude Code trusts a folder by its path: the moved one is new to it (Sidetrack #2).
      if (state.kind === 'moved' && claudeTrusts(root, ctx.env, ctx.home) === false)
        done.push(
          'Claude Code has not trusted this folder yet: its first start here stops on the trust window — start vdx ai here once and answer it; a detached start (the mail session) is refused until then',
        );
      return done;
    }
  }
}

export interface ProjectMemoryDeps {
  /** One line from the person at the terminal; null without one. */
  ask: (prompt: string) => string | null;
  log: (line: string) => void;
  today: string;
  /** The profile's `git.personal_hosts`. */
  personalHosts: PersonalHost[];
  /** Asks GitHub who reads the repo; the machine's own by default. */
  io?: HostingIo;
}

/**
 * `fixMemory` with the question it needs: outside a personal project the memory stays
 * out of git unless the person says yes — a publication cannot be taken back (DL #3,
 * #4); without a terminal, out.
 */
export function fixProjectMemory(
  projectRoot: string,
  state: MemoryState,
  ctx: MemoryCtx,
  deps: ProjectMemoryDeps,
): string[] {
  const personal = isPersonalProject(projectRoot, deps.personalHosts, deps.io);
  let underGit = false;
  if (state.kind === 'outside' && !personal && git(projectRoot, ['rev-parse', '--git-dir']) !== null) {
    deps.log(`  ${path.basename(projectRoot)} is not a personal repo: memory under git reaches whoever clones it`);
    underGit = /^y(es)?$/i.test(deps.ask('  Keep .claude/memory/ under git? [y/N] ')?.trim() ?? '');
  }
  const done = fixMemory(projectRoot, state, ctx, { personal, underGit, today: deps.today });
  if (
    done.length &&
    (state.kind === 'outside' || state.kind === 'moved' || (state.kind === 'leftovers' && state.afterMove))
  ) {
    done.push('sessions of this project running now keep the old place until they restart');
  }
  return done;
}
