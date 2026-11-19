import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * cmux tabs after cmux, tmux or the machine fell (restore-after-any-crash): which tab showed which session,
 * what runs in each tab now, and the plan that sends each one back. Two sources say where a tab went: the
 * record `vdx ai` keeps while it holds the attach in a tab (vdx-ai-predictable DL #19), and, for a tab
 * without one, the tmux binding cmux noticed in it — as cmux's snapshot held it before cmux last started.
 */

/**
 * What a cmux tab shows while `vdx ai` holds the attach in it: a session here, or one on another machine,
 * marked `@vdx_tab` = token. A `vdx ai` that goes down with cmux leaves it.
 */
export type TabRecord =
  | { kind: 'here'; surface: string; session: string; socket: string | null; at: number }
  | { kind: 'there'; surface: string; host: string; project: string; token: string; at: number };

/** Where a tab goes back to. */
export type TabTarget =
  | { kind: 'here'; session: string; socket: string | null }
  | { kind: 'there'; host: string; project: string; token: string };

export function tabRecordDir(home: string): string {
  return path.join(home, '.local', 'state', 'vdx', 'cmux-tabs');
}

function tabRecordFile(home: string, surface: string): string {
  return path.join(tabRecordDir(home), `${surface}.json`);
}

function parseTabRecord(text: string): TabRecord | null {
  try {
    const r = JSON.parse(text) as TabRecord;
    if (typeof r.surface !== 'string') return null;
    if (r.kind === 'here' && typeof r.session === 'string') return r;
    if (
      r.kind === 'there' &&
      typeof r.host === 'string' &&
      typeof r.project === 'string' &&
      /^[0-9a-f]+$/.test(r.token)
    )
      return r;
  } catch {
    // not a record
  }
  return null;
}

export function readTabRecord(home: string, surface: string): TabRecord | null {
  try {
    return parseTabRecord(fs.readFileSync(tabRecordFile(home, surface), 'utf8'));
  } catch {
    return null;
  }
}

/** Every record here. */
export function readTabRecords(home: string): TabRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(tabRecordDir(home));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => readTabRecord(home, n.slice(0, -'.json'.length)))
    .filter((r): r is TabRecord => r !== null);
}

export function writeTabRecord(home: string, record: TabRecord): void {
  fs.mkdirSync(tabRecordDir(home), { recursive: true });
  fs.writeFileSync(tabRecordFile(home, record.surface), JSON.stringify(record) + '\n');
}

export function forgetTabRecord(home: string, surface: string): void {
  fs.rmSync(tabRecordFile(home, surface), { force: true });
}

/** A terminal tab of cmux as its snapshot holds it. */
export interface CmuxPanel {
  surface: string;
  workspace: string | null;
  directory: string | null;
  title: string | null;
  /** Its terminal, `ttys010`; null — not written. */
  tty: string | null;
  /** The tmux session cmux noticed attached in it (`resumeBinding` kind tmux); null — none. */
  tmuxSession: string | null;
  /** cmux runs its binding at its start (`autoResume`): it types `cmux restore --surface` into the tab. */
  resumes?: boolean;
}

export interface CmuxSnapshot {
  panels: Map<string, CmuxPanel>;
  /** When cmux started: the copy cmux makes of its last snapshot at a start is named by it (ms). */
  startedAt: number | null;
  /** When the file was written (ms); null — not known. */
  writtenAt?: number | null;
}

export function cmuxDir(home: string): string {
  return path.join(home, 'Library', 'Application Support', 'cmux');
}

const SNAPSHOT_NAME = 'session-com.cmuxterm.app';

function readSnapshot(file: string, startedAt: number | null): CmuxSnapshot | null {
  let data: unknown;
  let writtenAt: number;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
    writtenAt = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const list = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : [];
  const obj = (v: unknown): Record<string, unknown> =>
    typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
  const panels = new Map<string, CmuxPanel>();
  for (const w of list(obj(data)['windows']))
    for (const ws of list(obj(w['tabManager'])['workspaces']))
      for (const panel of list(ws['panels'])) {
        const surface = text(panel['id']);
        if (!surface || (panel['type'] !== undefined && panel['type'] !== 'terminal')) continue;
        const b = obj(obj(panel['terminal'])['resumeBinding']);
        const checkpoint = text(b['checkpointId']);
        // `tmux attach -t '=<session>'` on the default server: one on another socket is not this vdx's to say.
        const command = typeof b['command'] === 'string' ? b['command'] : '';
        const tmuxSession =
          b['kind'] === 'tmux' && checkpoint && !/'-[LS]'/.test(command) ? checkpoint.replace(/^=/, '') || null : null;
        panels.set(surface, {
          surface,
          workspace: text(ws['workspaceId']),
          directory: text(panel['directory']) ?? text(ws['currentDirectory']),
          title: text(panel['title']) ?? text(ws['customTitle']) ?? text(ws['processTitle']),
          tty: text(panel['ttyName'])?.replace(/^\/dev\//, '') ?? null,
          tmuxSession,
          resumes: b['autoResume'] === true,
        });
      }
  return { panels, startedAt, writtenAt };
}

/** cmux's windows now; null — no cmux here. */
export function currentCmux(home: string): CmuxSnapshot | null {
  return readSnapshot(path.join(cmuxDir(home), `${SNAPSHOT_NAME}.json`), null);
}

/**
 * cmux's windows when it last went down. At a start cmux copies its last snapshot into `session-history/`,
 * named by the start (lft 2026-11-17: `…-1794937350065-w14-p14.json` at 12:42:30, cmux up at 12:42:27, the
 * content written at 12:36:36): the newest copy is what the tabs showed before this run of cmux.
 */
export function cmuxBeforeStart(home: string): CmuxSnapshot | null {
  const dir = path.join(cmuxDir(home), 'session-history');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const newest = names
    .map((n) => ({ n, at: Number(new RegExp(`^${SNAPSHOT_NAME}-(\\d+)-`).exec(n)?.[1] ?? NaN) }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => b.at - a.at)[0];
  return newest ? readSnapshot(path.join(dir, newest.n), newest.at) : null;
}

/** How long after cmux started a tab's first shell still comes from that start: cmux brings ~20 tabs in seconds. */
const JUST_STARTED_MS = 10 * 60_000;

/**
 * cmux's windows before it started — only while that start is minutes old: a shell opened later (a new tab)
 * is no tab cmux brought back, and the snapshot of before says nothing of it.
 */
export function cmuxJustStarted(before: CmuxSnapshot | null, now: number = Date.now()): CmuxSnapshot | null {
  return before?.startedAt != null && now - before.startedAt >= 0 && now - before.startedAt < JUST_STARTED_MS
    ? before
    : null;
}

/** The processes a terminal runs in front, by the terminal: `ps` reads alike on macOS of either architecture. */
export function foregroundByTty(): Map<string, string[]> {
  const out = spawnSync('ps', ['-A', '-o', 'tty=,state=,comm='], { encoding: 'utf8' }).stdout ?? '';
  const map = new Map<string, string[]>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!m || !m[2]!.includes('+')) continue;
    const tty = m[1]!.replace(/^\/dev\//, '');
    map.set(tty, [...(map.get(tty) ?? []), path.basename(m[3]!)]);
  }
  return map;
}

/**
 * Each cmux tab's terminal by its processes: they carry the tab's CMUX_SURFACE_ID, which `ps -E` shows for
 * this user's own. Fresh where cmux's snapshot may not be: right after a start it can still hold the
 * terminals of before (lft, 2026-11-17: the last write came six minutes before cmux went down).
 */
export function ttyBySurface(): Map<string, string> {
  const out = spawnSync('ps', ['-Eww', '-A', '-o', 'tty=,command='], { encoding: 'utf8' }).stdout ?? '';
  const map = new Map<string, string>();
  for (const line of out.split('\n')) {
    const tty = /^\s*(\S+)/.exec(line)?.[1];
    const surface = /(?:^|\s)CMUX_SURFACE_ID=([A-Za-z0-9-]+)/.exec(line)?.[1];
    if (tty && surface && !tty.startsWith('?') && !map.has(surface)) map.set(surface, tty.replace(/^\/dev\//, ''));
  }
  return map;
}

const SHELLS = new Set(['zsh', '-zsh', 'bash', '-bash', 'sh', '-sh', 'fish', '-fish', 'login']);
/** In front, these hold an attach: tmux here, ssh to another machine, vdx itself. */
const ATTACHED = new Set(['tmux', 'ssh', 'node', 'vdx']);

/**
 * - `ready` — the tab is at its shell and its session is there: it goes back.
 * - `shown` — something holds an attach in it already, or its session here is in another terminal.
 * - `busy` — something else runs in front in it: typing there would go to that.
 * - `no-session` — the session it showed is not there (not brought back yet, or gone).
 * - `no-answer` — the other machine did not answer.
 * - `gone` — cmux lost the tab: it was there before cmux last started and is not now.
 * - `closed` — the person closed the tab: its record is left from before.
 * - `unknown` — its terminal is not known: what runs in it cannot be told, so nothing is typed there.
 * - `self` — the tab this runs in.
 */
type TabState = 'ready' | 'shown' | 'busy' | 'unknown' | 'no-session' | 'no-answer' | 'gone' | 'closed' | 'self';

export interface TabPlan {
  surface: string;
  target: TabTarget;
  /** `record` — vdx's; `cmux` — the binding cmux noticed, from its snapshot before it started. */
  from: 'record' | 'cmux';
  state: TabState;
  /** The tab as cmux holds it now — or held it before it started, for a tab cmux lost. */
  panel: CmuxPanel | null;
}

export interface TabsInput {
  /** The tab this process runs in (CMUX_SURFACE_ID outside tmux); null — none. */
  self: string | null;
  current: CmuxSnapshot | null;
  before: CmuxSnapshot | null;
  records: TabRecord[];
  foreground: Map<string, string[]>;
  /** Each tab's terminal by its processes (`ttyBySurface`); not given — cmux's snapshot alone. */
  ttys?: Map<string, string>;
  /** The sessions on a tmux server here, each with the terminals attached to it. */
  sessionsHere: (socket: string | null) => Map<string, number>;
  /**
   * The tab marks the sessions on another machine carry (`@vdx_tab`), each with the terminals attached to
   * its session; null — it did not answer.
   */
  marksThere: (host: string) => Map<string, number> | null;
}

/** A session a tab shows, named for a person: `vdm@lft`, `echelon on m3`. */
export function targetLabel(t: TabTarget): string {
  return t.kind === 'here' ? t.session : `${path.basename(t.project)} on ${t.host}`;
}

/**
 * Where each tab goes, and whether it can go now. Nothing here acts: `returnTabs` does. Without cmux's
 * windows (no cmux here) there are no tabs to say anything about.
 */
export function planTabs(input: TabsInput): TabPlan[] {
  const { current, before } = input;
  if (!current) return [];
  const here = new Map<string, Map<string, number>>();
  const sessions = (socket: string | null) => {
    const key = socket ?? '';
    if (!here.has(key)) here.set(key, input.sessionsHere(socket));
    return here.get(key)!;
  };
  /** Terminals on the session a tab showed: one shows it now, so no tab of it is missing. */
  const clients = (t: TabTarget) =>
    t.kind === 'here' ? (sessions(t.socket).get(t.session) ?? 0) : (marks(t.host)?.get(t.token) ?? 0);
  const there = new Map<string, Map<string, number> | null>();
  const marks = (host: string) => {
    if (!there.has(host)) there.set(host, input.marksThere(host));
    return there.get(host)!;
  };
  const wanted: { surface: string; target: TabTarget; from: 'record' | 'cmux'; at: number | null }[] = [];
  for (const r of input.records)
    wanted.push({
      surface: r.surface,
      target:
        r.kind === 'here'
          ? { kind: 'here', session: r.session, socket: r.socket }
          : { kind: 'there', host: r.host, project: r.project, token: r.token },
      from: 'record',
      at: r.at,
    });
  const recorded = new Set(input.records.map((r) => r.surface));
  // cmux's binding speaks only for a tab that is there now: one closed by hand since cmux started looks the same
  // as one cmux lost, and m3, up since 2026-10-07, would have opened every tab closed since (0.59.0, DL #6).
  for (const p of before?.panels.values() ?? [])
    if (p.tmuxSession && !recorded.has(p.surface) && current.panels.has(p.surface))
      wanted.push({
        surface: p.surface,
        target: { kind: 'here', session: p.tmuxSession, socket: null },
        from: 'cmux',
        at: null,
      });

  return wanted.map(({ surface, target, from, at }) => {
    const now = current.panels.get(surface) ?? null;
    const plan = (state: TabState, panel: CmuxPanel | null = now): TabPlan => ({ surface, target, from, state, panel });
    if (surface === input.self) return plan('self');
    if (!now) {
      // Lost by cmux: open when cmux last went down, the attach from before this run of cmux, and no terminal
      // shows its session now — one that does means the person has it in another tab.
      const was = before?.panels.get(surface) ?? null;
      const old = at !== null && before?.startedAt != null && at < before.startedAt;
      return was && old && clients(target) === 0 ? plan('gone', was) : plan('closed', was);
    }
    // The terminal its processes say, else the snapshot's — only one written since cmux started.
    const fresh = current.writtenAt == null || before?.startedAt == null || current.writtenAt >= before.startedAt;
    const tty = input.ttys?.get(surface) ?? (fresh ? now.tty : null);
    if (!tty) return plan('unknown');
    const front = input.foreground.get(tty) ?? [];
    const running = front.filter((c) => !SHELLS.has(c));
    if (running.some((c) => ATTACHED.has(c))) return plan('shown');
    if (running.length > 0) return plan('busy');
    if (target.kind === 'here') {
      if (!sessions(target.socket).has(target.session)) return plan('no-session');
      // Its session is in another tab here already: a second terminal on it is not what went missing.
      return plan(clients(target) > 0 ? 'shown' : 'ready');
    }
    const m = marks(target.host);
    return plan(m === null ? 'no-answer' : m.has(target.token) ? 'ready' : 'no-session');
  });
}

/** The cmux command line: `CMUX_BUNDLED_CLI_PATH`, which cmux sets in its tabs, else `cmux` on PATH. */
export function cmuxCli(env: NodeJS.ProcessEnv): string {
  const bundled = env['CMUX_BUNDLED_CLI_PATH']?.trim();
  return bundled && fs.existsSync(bundled) ? bundled : 'cmux';
}

/** Set on what a restore types into a tab: `vdx ai --tab` then goes back at once, not leaving it to cmux. */
export const TAB_NOW_ENV_VAR = 'VDX_TAB_NOW';
/** Set on a tab a restore opens in place of one cmux lost: the record of that one is this one's. */
export const TAB_FROM_ENV_VAR = 'VDX_TAB_FROM';

export interface ReturnDeps {
  home: string;
  /** Runs the cmux command line with these arguments; status, and what it said. */
  cmux: (args: string[]) => { status: number; out: string };
  /** The command a new tab starts with: this vdx, by the paths it runs from. */
  tabCommand: string;
  log: (line: string) => void;
}

/**
 * Send back what `planTabs` found: a tab at its shell gets `vdx ai --tab` typed into it, one cmux lost is
 * opened again as a new workspace in its directory, starting `vdx ai --tab` on the old record. A tab
 * known only from cmux's binding gets a record first, so `--tab` finds it. Returns the tabs sent.
 */
export function returnTabs(plans: TabPlan[], deps: ReturnDeps): { sent: TabPlan[]; failed: TabPlan[] } {
  const sent: TabPlan[] = [];
  const failed: TabPlan[] = [];
  for (const p of plans) {
    if (p.state !== 'ready' && p.state !== 'gone') continue;
    if (p.from === 'cmux' && p.target.kind === 'here')
      writeTabRecord(deps.home, {
        kind: 'here',
        surface: p.surface,
        session: p.target.session,
        socket: p.target.socket,
        at: Date.now(),
      });
    const args =
      p.state === 'ready'
        ? [
            'send',
            ...(p.panel?.workspace ? ['--workspace', p.panel.workspace] : []),
            '--surface',
            p.surface,
            '--',
            `${TAB_NOW_ENV_VAR}=1 vdx ai --tab\\n`,
          ]
        : [
            'new-workspace',
            ...(p.panel?.directory && fs.existsSync(p.panel.directory) ? ['--cwd', p.panel.directory] : []),
            '--name',
            targetLabel(p.target),
            // A workspace keeps its variables for every terminal in it: only the one `--tab` reads once. A new
            // tab has no binding of cmux to give way to.
            '--env',
            `${TAB_FROM_ENV_VAR}=${p.surface}`,
            '--command',
            deps.tabCommand,
          ];
    const res = deps.cmux(args);
    if (res.status === 0) sent.push(p);
    else {
      failed.push(p);
      deps.log(`  ✗ ${targetLabel(p.target)}: cmux refused — ${res.out.trim().split('\n')[0] ?? `exit ${res.status}`}`);
    }
  }
  return { sent, failed };
}
