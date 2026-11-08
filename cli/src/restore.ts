import * as fs from 'node:fs';
import * as path from 'node:path';
import { isConversationId } from './conversations.ts';
import { at, str } from './narrow.ts';

/**
 * What ran in tmux, written down before tmux falls (vdx-ai-predictable P6). When the tmux server
 * goes — a crash, a kill-server, a reboot — the agents in it end with it, and Claude Code removes
 * their session files: nothing on the machine says any more which agents ran, in which
 * conversation, mode and topic. vdx keeps that itself. The vdx plugin's SessionStart hook
 * (`vdx ai --check`, on every start, resume, /clear and compact) writes a record of the agent's
 * pane under the tmux server it runs in. A server is its pid and its start time: one started
 * again is another, and the records of a server that is gone are the agents it took down.
 *
 * The records are this machine's — `${XDG_STATE_HOME:-~/.local/state}/vdx/tmux/<socket>/<pid>-<start>/`,
 * outside the synced folders. Only the records live here; starting the agents again is ai.ts's.
 */

/** A tmux server: one started again has another pid and start time. */
export interface TmuxServer {
  /** The socket's name: `default`, or the one given with `-L`. */
  socket: string;
  pid: number;
  /** Seconds since the epoch, as tmux's `#{start_time}`. */
  started: number;
}

/** How the agent was started: plain, `vdx ai --focused`, `vdx ai --intercom`, or `vdx ai --hq`. */
export type RecordMode = 'plain' | 'focused' | 'mail' | 'hq';

/** One agent pane, as the hook last saw it. */
export interface SessionRecord {
  session: string;
  /** `%12`: the pane's id on its server. */
  pane: string;
  /** The project's root on this machine. */
  project: string;
  /** The Claude Code conversation in it; null — not known. */
  conversation: string | null;
  mode: RecordMode;
  /** A focused session's topic; null — none. */
  topic: string | null;
  /** An intercom session the person started or attached to: it stays, and a restore brings it back. */
  stays?: boolean;
  /** The agent's process. */
  pid: number;
  /** When the hook wrote it, ms. */
  written: number;
}

/** A record of a server that is gone: an agent it took down. */
export interface LostRecord extends SessionRecord {
  server: TmuxServer;
  file: string;
}

/** What vdx needs of tmux here: ai.ts's Tmux. */
interface TmuxLike {
  tryRun(args: string[]): string | null;
  readonly socketName: string | null;
}

/** Records of servers gone this long before the current one started are forgotten. */
const FORGET_AFTER_MS = 7 * 86_400_000;
const SERVER_DIR_RE = /^(\d+)-(\d+)$/;
const MODES: readonly RecordMode[] = ['plain', 'focused', 'mail', 'hq'];

/** The server tmux talks to from here; null — none runs. */
export function currentServer(tmux: TmuxLike): TmuxServer | null {
  const out = tmux.tryRun(['display-message', '-p', '#{pid}\t#{start_time}\t#{socket_path}']);
  const [pid, started, socket] = (out ?? '').trim().split('\t');
  if (!pid || !/^\d+$/.test(pid) || !started || !/^\d+$/.test(started)) return null;
  return {
    socket: socket ? path.basename(socket) : (tmux.socketName ?? 'default'),
    pid: Number(pid),
    started: Number(started),
  };
}

/** The socket's records: one folder per server. */
export function socketDir(env: NodeJS.ProcessEnv, home: string, socket: string): string {
  const state = env['XDG_STATE_HOME']?.trim();
  return path.join(state ? path.resolve(state) : path.join(home, '.local', 'state'), 'vdx', 'tmux', socket);
}

function serverDir(env: NodeJS.ProcessEnv, home: string, server: TmuxServer): string {
  return path.join(socketDir(env, home, server.socket), `${server.pid}-${server.started}`);
}

function recordFile(dir: string, pane: string): string {
  return path.join(dir, `${pane.replace(/^%/, '')}.json`);
}

function parseRecord(text: string): SessionRecord | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const session = str(at(data, 'session'));
  const pane = str(at(data, 'pane'));
  const project = str(at(data, 'project'));
  const conversation = at(data, 'conversation');
  const mode = at(data, 'mode');
  const topic = at(data, 'topic');
  const stays = at(data, 'stays');
  const pid = at(data, 'pid');
  const written = at(data, 'written');
  if (!session || !pane || !/^%\d+$/.test(pane) || !project || !path.isAbsolute(project)) return null;
  if (conversation !== null && !(typeof conversation === 'string' && isConversationId(conversation))) return null;
  if (!MODES.includes(mode as RecordMode)) return null;
  if (topic !== null && typeof topic !== 'string') return null;
  if (stays !== undefined && typeof stays !== 'boolean') return null;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || typeof written !== 'number') return null;
  const record: SessionRecord = { session, pane, project, conversation, mode: mode as RecordMode, topic, pid, written };
  return stays === true ? { ...record, stays } : record;
}

function readRecords(dir: string): { record: SessionRecord; file: string }[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    if (!/^\d+\.json$/.test(name)) return [];
    const file = path.join(dir, name);
    try {
      const record = parseRecord(fs.readFileSync(file, 'utf8'));
      return record ? [{ record, file }] : [];
    } catch {
      return [];
    }
  });
}

/** Write the agent pane's record under its server: a new file whole, never one half-written. */
export function writeRecord(env: NodeJS.ProcessEnv, home: string, server: TmuxServer, record: SessionRecord): void {
  const dir = serverDir(env, home, server);
  fs.mkdirSync(dir, { recursive: true });
  const file = recordFile(dir, record.pane);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record) + '\n');
  fs.renameSync(tmp, file);
}

/** The panes the server's records cover. */
export function recordedPanes(env: NodeJS.ProcessEnv, home: string, server: TmuxServer): Set<string> {
  return new Set(readRecords(serverDir(env, home, server)).map((r) => r.record.pane));
}

/** A focused session's new topic, in the record of its pane — if the hook wrote one. */
export function updateTopic(
  env: NodeJS.ProcessEnv,
  home: string,
  server: TmuxServer,
  pane: string,
  topic: string | null,
): void {
  const dir = serverDir(env, home, server);
  const found = readRecords(dir).find((r) => r.record.pane === pane);
  if (found) writeRecord(env, home, server, { ...found.record, topic });
}

/** The person attached to an intercom session that runs: the records of its panes say it stays. */
export function markStays(env: NodeJS.ProcessEnv, home: string, server: TmuxServer, session: string): void {
  for (const { record } of readRecords(serverDir(env, home, server)))
    if (record.session === session && record.mode === 'mail' && !record.stays)
      writeRecord(env, home, server, { ...record, stays: true });
}

/**
 * The current server's records of panes that are gone, or whose agent is: a session closed by
 * hand is not brought back when tmux falls later.
 */
export function pruneRecords(
  env: NodeJS.ProcessEnv,
  home: string,
  server: TmuxServer,
  panes: Set<string>,
  alive: (pid: number) => boolean,
): void {
  for (const { record, file } of readRecords(serverDir(env, home, server))) {
    if (!panes.has(record.pane) || !alive(record.pid)) fs.rmSync(file, { force: true });
  }
}

/**
 * The agents the servers that are gone took down: the records of every server but `current`, by
 * session, the later server first.
 * Once the current server is a week old, the records of the ones before it are forgotten —
 * nobody brought them back.
 */
export function lostRecords(
  env: NodeJS.ProcessEnv,
  home: string,
  current: TmuxServer | null,
  socket: string,
  now: number = Date.now(),
): LostRecord[] {
  const dir = socketDir(env, home, socket);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const stale = current !== null && now - current.started * 1000 > FORGET_AFTER_MS;
  const lost: LostRecord[] = [];
  for (const name of names) {
    const m = SERVER_DIR_RE.exec(name);
    if (!m) continue;
    const server: TmuxServer = { socket, pid: Number(m[1]), started: Number(m[2]) };
    if (current && server.pid === current.pid && server.started === current.started) continue;
    if (stale) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      continue;
    }
    lost.push(...readRecords(path.join(dir, name)).map(({ record, file }) => ({ ...record, server, file })));
  }
  // A session two fallen servers both held: the later one's record first — it is what ran last.
  return lost.sort(
    (a, b) => a.session.localeCompare(b.session) || b.server.started - a.server.started || a.pane.localeCompare(b.pane),
  );
}

/** The record is done with — brought back, or not to be: its file goes, and its server's folder once empty. */
export function forget(record: LostRecord): void {
  fs.rmSync(record.file, { force: true });
  try {
    fs.rmdirSync(path.dirname(record.file));
  } catch {
    // other records of that server are still there
  }
}
