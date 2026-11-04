import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  currentServer,
  forget,
  lostRecords,
  pruneRecords,
  type SessionRecord,
  socketDir,
  type TmuxServer,
  updateTopic,
  writeRecord,
} from '../../src/restore.ts';
import { ID } from './transcripts.ts';

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  session: 'proj@m3',
  pane: '%3',
  project: '/projects/proj',
  conversation: ID.a,
  mode: 'plain',
  topic: null,
  pid: 4242,
  written: 1_790_000_000_000,
  ...over,
});
const server = (pid: number, started: number): TmuxServer => ({ socket: 'default', pid, started });

describe('restore records: what ran in tmux, by server', () => {
  let home: string;
  const env = {};
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-restore-'));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it("the server: tmux's pid, start time and socket; none — no server", () => {
    const tmux = (out: string | null, socketName: string | null = null) => ({ tryRun: () => out, socketName });
    expect(currentServer(tmux('70714\t1791429417\t/private/tmp/tmux-501/default\n'))).toEqual({
      socket: 'default',
      pid: 70714,
      started: 1791429417,
    });
    expect(currentServer(tmux('1\t2\t\n', 'vdx-test'))?.socket).toBe('vdx-test');
    expect(currentServer(tmux(null))).toBeNull();
    expect(currentServer(tmux('no server running\n'))).toBeNull();
  });

  it("lives under XDG_STATE_HOME, else ~/.local/state — this machine's, never a synced folder", () => {
    expect(socketDir({}, '/Users/x', 'default')).toBe('/Users/x/.local/state/vdx/tmux/default');
    expect(socketDir({ XDG_STATE_HOME: '/state' }, '/Users/x', 'vdx-test')).toBe('/state/vdx/tmux/vdx-test');
  });

  it("a record per pane under its server; the current server's are not lost, a gone server's are", () => {
    const old = server(100, 1_791_000_000);
    const now = server(200, 1_791_500_000);
    writeRecord(env, home, old, record());
    writeRecord(env, home, old, record({ pane: '%4', session: 'proj@m3-2', mode: 'focused', topic: 'search' }));
    writeRecord(env, home, now, record({ pane: '%1', session: 'other@m3' }));
    const lost = lostRecords(env, home, now, 'default', now.started * 1000);
    expect(lost.map((r) => [r.session, r.mode, r.topic, r.server.pid])).toEqual([
      ['proj@m3', 'plain', null, 100],
      ['proj@m3-2', 'focused', 'search', 100],
    ]);
    // No server at all: every one is lost.
    expect(lostRecords(env, home, null, 'default')).toHaveLength(3);
    // Another socket's are its own.
    expect(lostRecords(env, home, null, 'vdx-test')).toEqual([]);
  });

  it('a session two fallen servers held: the later one first — it ran last', () => {
    writeRecord(env, home, server(100, 1_791_000_000), record({ conversation: ID.a }));
    writeRecord(env, home, server(200, 1_791_500_000), record({ conversation: ID.b, pane: '%9' }));
    expect(lostRecords(env, home, null, 'default').map((r) => r.conversation)).toEqual([ID.b, ID.a]);
  });

  it('rewritten by the next hook in the same pane; a topic changed later goes into it', () => {
    const s = server(100, 1);
    writeRecord(env, home, s, record({ conversation: ID.a }));
    writeRecord(env, home, s, record({ conversation: ID.b, mode: 'focused' }));
    updateTopic(env, home, s, '%3', 'new topic');
    updateTopic(env, home, s, '%9', 'no such pane');
    const [only, ...rest] = lostRecords(env, home, null, 'default');
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ conversation: ID.b, topic: 'new topic' });
  });

  it('pruned while the server lives: a pane gone, or its agent gone, is not brought back later', () => {
    const s = server(100, 1);
    writeRecord(env, home, s, record({ pane: '%1', pid: 1 }));
    writeRecord(env, home, s, record({ pane: '%2', pid: 2 }));
    writeRecord(env, home, s, record({ pane: '%3', pid: 3 }));
    pruneRecords(env, home, s, new Set(['%1', '%2']), (pid) => pid !== 2);
    expect(lostRecords(env, home, null, 'default').map((r) => r.pane)).toEqual(['%1']);
  });

  it("forgotten once tried; the server's folder goes with its last record", () => {
    const s = server(100, 1);
    writeRecord(env, home, s, record({ pane: '%1' }));
    writeRecord(env, home, s, record({ pane: '%2' }));
    const [a, b] = lostRecords(env, home, null, 'default');
    forget(a!);
    expect(lostRecords(env, home, null, 'default')).toHaveLength(1);
    forget(b!);
    expect(fs.readdirSync(socketDir(env, home, 'default'))).toEqual([]);
  });

  it('a week after the current server started, the records of the ones before it are forgotten', () => {
    const now = server(200, 1_791_500_000);
    writeRecord(env, home, server(100, 1_791_000_000), record());
    const at = now.started * 1000;
    expect(lostRecords(env, home, now, 'default', at + 6 * 86_400_000)).toHaveLength(1);
    expect(lostRecords(env, home, now, 'default', at + 8 * 86_400_000)).toEqual([]);
    expect(fs.readdirSync(socketDir(env, home, 'default'))).toEqual([]);
  });

  it('a file that is not a record is skipped, not trusted', () => {
    const s = server(100, 1);
    writeRecord(env, home, s, record());
    const dir = path.join(socketDir(env, home, 'default'), '100-1');
    fs.writeFileSync(path.join(dir, '7.json'), '{"session":"x","pane":"%7","project":"relative","mode":"plain"}');
    fs.writeFileSync(path.join(dir, '8.json'), JSON.stringify({ ...record({ pane: '%8' }), conversation: '../x' }));
    fs.writeFileSync(path.join(dir, '9.json'), 'not json');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    expect(lostRecords(env, home, null, 'default').map((r) => r.pane)).toEqual(['%3']);
  });
});
