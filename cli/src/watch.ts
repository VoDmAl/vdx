import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * `vdx ai --watch` — the cmux tab that shows every tmux session of the machines (crystal
 * cmux-sidebar-all-tmux-sessions, DL #2, #3). It runs in a tab of its own, the anchor of the cmux group «tmux»,
 * and every few seconds compares the tmux sessions of this machine and of the profile's others with what the
 * terminals of this seat show: a session no terminal here shows gets a tab in the group, attached with a plain
 * `tmux attach`; a session that ended has its tab closed; a tab the person closed is not opened again while its
 * session is the same one. cmux, tmux and ssh come in as functions — the passes are tested without them.
 */

/** A tmux session as the watcher sees it: where it runs, since when, its folder, the seats whose terminals show it. */
export interface WatchedSession {
  machine: string;
  session: string;
  /** `#{session_created}`, seconds: a session started again under the same name is another one. */
  created: number;
  path: string | null;
  openAt: string[];
}

/** A tab the watcher opened: cmux's `id` of the workspace (its `ref` lives one run of cmux) and the session it shows. */
export interface WatchTab {
  id: string;
  ref: string;
  key: string;
  /** A terminal of this seat showed its session since the tab opened: the attach took. */
  seen?: boolean;
  /** Passes since it opened with no terminal of this seat on its session. */
  passes?: number;
}

/** What the watcher keeps between its passes and its runs: its tabs, the tabs closed by hand, sessions not shown yet. */
export interface WatchMemory {
  tabs: WatchTab[];
  /** Sessions whose tab the person closed: not opened again while the session is the same one (DL #2). */
  closed: string[];
  /** Passes in a row a session has gone with no terminal of this seat on it. */
  unshown: Record<string, number>;
  /** Sessions whose tab did not attach: not opened again before this moment, ms. */
  retryAt?: Record<string, number>;
}

export const emptyMemory = (): WatchMemory => ({ tabs: [], closed: [], unshown: {} });

/** One session, whatever its name says: the machine, the name and the moment it was created. */
export const keyOf = (s: { machine: string; session: string; created: number }): string =>
  `${s.machine}\t${s.session}\t${s.created}`;

const machineOfKey = (key: string): string => key.split('\t')[0] ?? '';

/** Passes in a row with no terminal of this seat before a session gets a tab: a start attaches within one. */
const UNSHOWN_PASSES = 2;
/** Passes a new tab has to show its session; after them, the attach did not take. */
const ATTACH_PASSES = 2;
/** A tab whose attach did not take is opened again after this long, not at once — no tab after tab. */
const RETRY_MS = 300_000;

/**
 * One pass, decided from what the machines and cmux said (DL #3). A machine that did not answer says nothing: its
 * sessions get no tab, its tabs are not closed, what the person closed there is remembered as it was. `warm` — past
 * the first seconds of the watcher's run: after cmux restarts, `--restore` and `--tab` bring the tabs back first
 * (п. 7), and the watcher opens nothing before them.
 */
export function planPass(input: {
  seat: string;
  /** The machines whose sessions came this pass. */
  answered: string[];
  sessions: WatchedSession[];
  /** The `id`s of the workspaces cmux has now. */
  workspaces: Set<string>;
  memory: WatchMemory;
  warm: boolean;
  now: number;
}): {
  open: WatchedSession[];
  close: WatchTab[];
  closedByHand: WatchTab[];
  /** Its session was shown, then no longer: detached in it — closed, and remembered as closed by hand. */
  detached: WatchTab[];
  /** It never showed its session: the attach did not take — closed, opened again after RETRY_MS. */
  failed: WatchTab[];
  memory: WatchMemory;
} {
  const answered = new Set(input.answered);
  const byKey = new Map(input.sessions.map((s) => [keyOf(s), s]));
  const known = (key: string) => answered.has(machineOfKey(key));
  const tabs: WatchTab[] = [];
  const close: WatchTab[] = [];
  const closedByHand: WatchTab[] = [];
  const detached: WatchTab[] = [];
  const failed: WatchTab[] = [];
  const closed = new Set(input.memory.closed);
  const retryAt: Record<string, number> = {};
  for (const [key, at] of Object.entries(input.memory.retryAt ?? {}))
    if (at > input.now && !(known(key) && !byKey.has(key))) retryAt[key] = at;
  for (const tab of input.memory.tabs) {
    const s = byKey.get(tab.key);
    if (!input.workspaces.has(tab.id)) {
      // The tab is gone and its session is the same one: the person closed it.
      if (s) {
        closed.add(tab.key);
        closedByHand.push(tab);
      }
    } else if (known(tab.key) && !s) close.push(tab);
    else if (!s) tabs.push(tab);
    else if (s.openAt.includes(input.seat)) tabs.push({ ...tab, seen: true, passes: 0 });
    else if (tab.seen) {
      // Shown, then no longer: detached in it — the person's leaving, as a tab closed by hand.
      close.push(tab);
      detached.push(tab);
      closed.add(tab.key);
    } else if ((tab.passes ?? 0) + 1 >= ATTACH_PASSES) {
      // Never shown: the attach in it did not take — no dead tab left; tried again later.
      close.push(tab);
      failed.push(tab);
      retryAt[tab.key] = input.now + RETRY_MS;
    } else tabs.push({ ...tab, passes: (tab.passes ?? 0) + 1 });
  }
  // A session that ended, or was started again, is a new one: what was closed of the old one is forgotten.
  for (const key of [...closed]) if (known(key) && !byKey.has(key)) closed.delete(key);
  const withTab = new Set(tabs.map((t) => t.key));
  const unshown: Record<string, number> = {};
  const open: WatchedSession[] = [];
  for (const s of input.sessions) {
    const key = keyOf(s);
    if (s.openAt.includes(input.seat) || withTab.has(key) || closed.has(key) || retryAt[key] !== undefined) continue;
    const passes = (input.memory.unshown[key] ?? 0) + 1;
    if (passes >= UNSHOWN_PASSES && input.warm) open.push(s);
    else unshown[key] = passes;
  }
  // The count of a machine that did not answer stays as it was.
  for (const [key, n] of Object.entries(input.memory.unshown)) if (!known(key)) unshown[key] = n;
  return { open, close, closedByHand, detached, failed, memory: { tabs, closed: [...closed], unshown, retryAt } };
}

/** The `id` and `ref` of each workspace in the output of `cmux workspace list --json` (cmux 0.65). */
export function parseWorkspaces(out: string): { id: string; ref: string }[] | null {
  try {
    const parsed = JSON.parse(out) as { workspaces?: unknown };
    if (!Array.isArray(parsed.workspaces)) return null;
    return (parsed.workspaces as unknown[]).flatMap((w) => {
      const id = (w as { id?: unknown }).id;
      const ref = (w as { ref?: unknown }).ref;
      return typeof id === 'string' && typeof ref === 'string' ? [{ id, ref }] : [];
    });
  } catch {
    return null;
  }
}

/** The ref cmux prints for a workspace it made: `OK workspace:1000050059`. */
export function parseCreated(out: string): string | null {
  return out.match(/\bOK (workspace:\d+)/)?.[1] ?? null;
}

/** The group named `name` in `cmux workspace-group list --json`: its ref and the refs of its members. */
export function findGroup(out: string, name: string): { ref: string; members: string[] } | null {
  try {
    const parsed = JSON.parse(out) as { groups?: unknown };
    if (!Array.isArray(parsed.groups)) return null;
    for (const g of parsed.groups as { name?: unknown; ref?: unknown; member_workspace_refs?: unknown }[]) {
      if (g.name !== name || typeof g.ref !== 'string') continue;
      const members = Array.isArray(g.member_workspace_refs)
        ? g.member_workspace_refs.filter((m): m is string => typeof m === 'string')
        : [];
      return { ref: g.ref, members };
    }
    return null;
  } catch {
    return null;
  }
}

// A word that starts with `=` is quoted: zsh, the shell of a cmux tab and of ssh there, takes a bare `=name` for the
// path of the command `name` — `tmux attach -t =main@m3` failed with «main@m3 not found» (2026-11-28).
const shellQuote = (s: string) =>
  /^[A-Za-z0-9_./:@%+-][A-Za-z0-9_./:=@%+-]*$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * What the tab of `s` runs: a plain `tmux attach` with this seat's mark, so the session counts as shown here and
 * carries no `@vdx_stays` (п. 2, п. 4); another machine's — through `ssh -t`, as `vdx ai@` does. A tab cmux opens
 * with a command has cmux's PATH, not the person's shell's: tmux and ssh go by their paths here (`tmux` — the one
 * the watcher found). A terminal tmux has no entry for — cmux's `xterm-ghostty` — is `xterm-256color`, here and
 * there. `exec`: the tab's shell gives way to it, and a detach ends the terminal.
 */
export function attachCommand(s: WatchedSession, here: string, seat: string, seatVar: string, tmux: string): string {
  const term = `infocmp "$TERM" >/dev/null 2>&1 || export TERM=xterm-256color; `;
  const target = shellQuote(`=${s.session}`);
  if (s.machine === here)
    return `${term}exec env ${seatVar}=${shellQuote(seat)} ${shellQuote(tmux)} attach -t ${target}`;
  const there = `${term}export ${seatVar}=${shellQuote(seat)}; exec tmux attach -t ${target}`;
  return `exec /usr/bin/ssh -t ${shellQuote(s.machine)} ${shellQuote(there)}`;
}

export interface WatchDeps {
  /** The cmux command line: status and what it said. */
  cmux: (args: string[]) => { status: number; out: string };
  /** This machine's sessions, null — tmux does not answer. */
  local: () => WatchedSession[] | null;
  /** Another machine's sessions (its `vdx ai --sessions`); null — it did not answer, or its vdx has no such report. */
  remote: (host: string) => WatchedSession[] | null;
  log: (line: string) => void;
  sleep: (ms: number) => void;
  now: () => number;
  /** Where the watcher keeps its memory and the pid of the one running. */
  stateFile: string;
  pidAlive: (pid: number) => boolean;
  pid: number;
}

export interface WatchConfig {
  /** This machine, the seat, and the profile's others. */
  here: string;
  seat: string;
  machines: string[];
  /** The variable whose value is the seat in a tmux client's environment (`VDX_AI_SEAT`). */
  seatVar: string;
  /** tmux here, by its path: a tab cmux opens has cmux's PATH. */
  tmux: string;
  /** Between passes; another machine is asked every `remoteEvery` passes. */
  passMs: number;
  remoteEvery: number;
  /** After the start, before the first tab is opened. */
  warmMs: number;
  /** Passes to run; none — for good. */
  passes?: number;
}

interface StateFile {
  pid: number;
  started: number;
  workspace: string | null;
  memory: WatchMemory;
}

function readState(file: string): StateFile | null {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as StateFile;
    return typeof s.pid === 'number' && s.memory ? s : null;
  } catch {
    return null;
  }
}

function writeState(file: string, state: StateFile): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state));
  } catch {
    /* the memory is a convenience: the passes go on without it */
  }
}

const WATCH_GROUP = 'tmux';

/** Set on the watcher's own tab: a tab cmux brings back after a restart knows it is that one (`--watch --detach`). */
const WATCH_ENV_VAR = 'VDX_WATCH';

/** A start asked this long ago or less is still under way: every tab of a cmux just started asks at once. */
const START_LOCK_MS = 60_000;

/**
 * `vdx ai --watch --detach`, for the line in `~/.zshrc` that runs in every new shell of cmux: a watcher runs, or
 * another shell asked for its tab in the last minute — nothing; else the watcher's tab, opened without focus and
 * marked VDX_WATCH=1: the same line there runs `vdx ai --watch` (so does a tab with the mark that cmux brings back
 * after a restart). Returns at once.
 */
export function startWatch(deps: Pick<WatchDeps, 'cmux' | 'log' | 'stateFile' | 'pidAlive' | 'now'>): number {
  const before = readState(deps.stateFile);
  if (before && deps.pidAlive(before.pid)) return 0;
  const lock = `${deps.stateFile}.start`;
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    if (fs.existsSync(lock) && deps.now() - fs.statSync(lock).mtimeMs > START_LOCK_MS) fs.rmSync(lock, { force: true });
    fs.closeSync(fs.openSync(lock, 'wx'));
  } catch {
    return 0;
  }
  const res = deps.cmux(['workspace', 'create', '--focus', 'false', '--env', `${WATCH_ENV_VAR}=1`]);
  if (res.status !== 0 || !parseCreated(res.out)) {
    deps.log(`✗ vdx ai --watch --detach: cmux did not open the watcher's tab — ${res.out.trim().split('\n')[0] ?? ''}`);
    return 4;
  }
  deps.log(`vdx ai --watch: its tab opened (${parseCreated(res.out)})`);
  return 0;
}

/**
 * The watcher's run: one per machine, in its own cmux tab, the anchor of the group «tmux». The exit code: 0 — the
 * passes ran (or another watcher runs, said so); 4 — cmux refused what the watcher needs.
 */
export function watch(config: WatchConfig, deps: WatchDeps): number {
  const before = readState(deps.stateFile);
  if (before && before.pid !== deps.pid && deps.pidAlive(before.pid)) {
    deps.log(`vdx ai --watch already runs (pid ${before.pid}${before.workspace ? `, tab ${before.workspace}` : ''})`);
    return 0;
  }
  const own = (() => {
    const res = deps.cmux(['identify']);
    try {
      return (JSON.parse(res.out) as { caller?: { workspace_ref?: string } }).caller?.workspace_ref ?? null;
    } catch {
      return null;
    }
  })();
  if (!own) {
    deps.log('✗ vdx ai --watch: cmux did not say which tab this is (cmux identify)');
    return 4;
  }
  const group = ensureGroup(own, deps);
  if (!group) {
    deps.log(`✗ vdx ai --watch: cmux did not make the group «${WATCH_GROUP}»`);
    return 4;
  }
  const started = deps.now();
  // Its tabs from a run before, while cmux is the same: an `id` cmux no longer has is simply forgotten.
  let memory: WatchMemory = before?.memory ?? emptyMemory();
  const firstList = parseWorkspaces(deps.cmux(['workspace', 'list', '--json']).out);
  if (firstList) {
    const ids = new Set(firstList.map((w) => w.id));
    memory = { ...memory, tabs: memory.tabs.filter((t) => ids.has(t.id)) };
  }
  const others = config.machines.filter((m) => m !== config.here);
  deps.log(
    `vdx ai --watch: the tmux sessions of ${[config.here, ...others].join(', ')} that no terminal here shows get a tab ` +
      `in the group «${WATCH_GROUP}»; a tab you close stays closed while its session runs. Ctrl-C ends the watch`,
  );
  let remoteCache = new Map<string, WatchedSession[] | null>();
  const silentSaid = new Set<string>();
  for (let pass = 0; config.passes === undefined || pass < config.passes; pass++) {
    if (pass > 0) deps.sleep(config.passMs);
    const sessions: WatchedSession[] = [];
    const answered: string[] = [];
    const local = deps.local();
    if (local) {
      sessions.push(...local);
      answered.push(config.here);
    }
    if (pass % config.remoteEvery === 0) remoteCache = new Map(others.map((m) => [m, deps.remote(m)]));
    for (const m of others) {
      const theirs = remoteCache.get(m) ?? null;
      if (theirs) {
        sessions.push(...theirs);
        answered.push(m);
        silentSaid.delete(m);
      } else if (!silentSaid.has(m)) {
        deps.log(`  ${m} does not answer (or its vdx is older than --sessions): its sessions wait`);
        silentSaid.add(m);
      }
    }
    const list = parseWorkspaces(deps.cmux(['workspace', 'list', '--json']).out);
    if (!list) continue;
    const plan = planPass({
      seat: config.seat,
      answered,
      sessions,
      workspaces: new Set(list.map((w) => w.id)),
      memory,
      warm: deps.now() - started >= config.warmMs,
      now: deps.now(),
    });
    memory = plan.memory;
    for (const tab of plan.closedByHand)
      deps.log(`  ${label(tab.key)}: tab closed — not opened again while the session is the same one`);
    for (const tab of plan.detached)
      deps.log(`  ${label(tab.key)}: detached in its tab — closed, not opened again while the session is the same one`);
    for (const tab of plan.failed)
      deps.log(`  ✗ ${label(tab.key)}: its tab did not attach — closed; tried again in ${RETRY_MS / 60_000} min`);
    const quiet = new Set([...plan.detached, ...plan.failed]);
    for (const tab of plan.close) {
      deps.cmux(['workspace', 'close', tab.ref]);
      if (!quiet.has(tab)) deps.log(`  ${label(tab.key)}: the session ended — its tab closed`);
    }
    for (const s of plan.open) {
      const args = [
        'workspace',
        'create',
        '--focus',
        'false',
        '--group',
        group,
        ...(s.machine === config.here && s.path && isDir(s.path) ? ['--cwd', s.path] : []),
        '--command',
        attachCommand(s, config.here, config.seat, config.seatVar, config.tmux),
      ];
      const res = deps.cmux(args);
      const ref = res.status === 0 ? parseCreated(res.out) : null;
      const id = ref
        ? parseWorkspaces(deps.cmux(['workspace', 'list', '--json']).out)?.find((w) => w.ref === ref)?.id
        : undefined;
      if (!ref || !id) {
        deps.log(`  ✗ ${label(keyOf(s))}: cmux did not open its tab — ${res.out.trim().split('\n')[0] ?? ''}`);
        continue;
      }
      memory.tabs.push({ id, ref, key: keyOf(s) });
      deps.log(`  ${label(keyOf(s))}: no terminal here showed it — a tab in «${WATCH_GROUP}»`);
    }
    writeState(deps.stateFile, { pid: deps.pid, started, workspace: own, memory });
  }
  return 0;
}

/** `<session>` or `<session> (<machine>)` when its name does not say the machine. */
function label(key: string): string {
  const [machine = '', session = ''] = key.split('\t');
  return session.endsWith(`@${machine}`) || session.includes(`@${machine}-`) ? session : `${session} (${machine})`;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The group «tmux» with this tab in it — found by name, or made with this tab as its anchor. Null — cmux refused. */
function ensureGroup(own: string, deps: WatchDeps): string | null {
  const list = () => findGroup(deps.cmux(['workspace-group', 'list', '--json']).out, WATCH_GROUP);
  let found = list();
  if (!found) {
    deps.cmux(['workspace-group', 'create', '--name', WATCH_GROUP, '--from', own]);
    found = list();
  } else if (!found.members.includes(own)) {
    deps.cmux(['workspace-group', 'add', '--group', found.ref, '--workspace', own]);
  }
  return found?.ref ?? null;
}
