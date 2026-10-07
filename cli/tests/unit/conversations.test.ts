import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ID, startedOn, userLine, promptLine, titleLine, writeConversation, writeHistory } from './transcripts.ts';
import {
  claudeConfigDir,
  describeAge,
  latestPerMachine,
  listConversations,
  LIVE_SESSIONS_SCRIPT,
  liveConversationId,
  liveSessionsHere,
  type LiveSession,
  machineLine,
  machineOf,
  parseMachineReport,
  projectDirName,
  readConversation,
  runsInProject,
} from '../../src/conversations.ts';

const tmpDir = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

describe('where Claude Code keeps conversations', () => {
  it('names the project folder by the path, every non-alphanumeric character a dash', () => {
    expect(projectDirName('/Users/vdm/AI Projects/vdx')).toBe('-Users-vdm-AI-Projects-vdx');
    expect(projectDirName('/Users/vdm/PhpstormProjects/git.vorobyev.name/ga-demo')).toBe(
      '-Users-vdm-PhpstormProjects-git-vorobyev-name-ga-demo',
    );
  });

  it('takes $CLAUDE_CONFIG_DIR over ~/.claude', () => {
    expect(claudeConfigDir({}, '/h')).toBe('/h/.claude');
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '~/cc' }, '/h')).toBe('/h/cc');
  });
});

describe('readConversation', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir('vdx-conv-');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const read = (lines: string[]) => {
    const file = path.join(dir, `${ID.a}.jsonl`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return readConversation(file, new Date());
  };

  it('takes the machine of the last start — a resume on another machine moves it there', () => {
    const c = read([startedOn('lft'), userLine('hi'), startedOn('m3'), userLine('again')]);
    expect(c?.machine).toBe('m3');
    expect(c?.id).toBe(ID.a);
  });

  it('reads the machine only from the hook — not from a turn that quotes the line', () => {
    const c = read([userLine(`${machineLine('m3')}; quoted by hand`), promptLine('x')]);
    expect(c?.machine).toBeNull();
  });

  it('refuses a label that would read as an ssh option', () => {
    expect(read([startedOn('-oProxyCommand=x'), userLine('hi')])?.machine).toBeNull();
  });

  it("titles it by Claude's title, else the last prompt", () => {
    expect(read([userLine('hi'), promptLine('first'), titleLine('Inbox'), promptLine('second')])?.title).toBe('Inbox');
    expect(read([userLine('hi'), promptLine('first'), promptLine('second')])?.title).toBe('second');
  });

  it('skips a conversation nobody wrote in — only the hook ran', () => {
    expect(read([startedOn('lft')])).toBeNull();
  });
});

describe('listConversations and the newest of each machine', () => {
  let home: string;
  const root = '/Users/x/AI Projects/proj';
  beforeEach(() => {
    home = tmpDir('vdx-conv-home-');
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it("lists the project's conversations newest first, without Syncthing's conflict copies", () => {
    const config = path.join(home, '.claude');
    writeConversation(config, root, ID.a, [startedOn('lft'), userLine('a')], 30);
    writeConversation(config, root, ID.b, [startedOn('m3'), userLine('b')], 5);
    writeConversation(config, root, ID.c, [userLine('c')], 60);
    fs.copyFileSync(
      path.join(config, 'projects', projectDirName(root), `${ID.b}.jsonl`),
      path.join(config, 'projects', projectDirName(root), `${ID.b}.sync-conflict-20261004-161533-N223K43.jsonl`),
    );
    const list = listConversations({ env: {}, home, projectRoot: root });
    expect(list.map((c) => [c.id, c.machine])).toEqual([
      [ID.b, 'm3'],
      [ID.a, 'lft'],
      [ID.c, null],
    ]);
  });

  it('keeps the newest of each machine, an unknown machine counted as one', () => {
    const config = path.join(home, '.claude');
    writeConversation(config, root, ID.a, [startedOn('lft'), userLine('a')], 30);
    writeConversation(config, root, ID.b, [startedOn('LFT'), userLine('b')], 5);
    writeConversation(config, root, ID.c, [startedOn('m3'), userLine('c')], 10);
    writeConversation(config, root, ID.d, [userLine('d')], 1);
    const latest = latestPerMachine(listConversations({ env: {}, home, projectRoot: root }), (c) => machineOf(c, 'lft'));
    expect(latest.map((c) => c.id)).toEqual([ID.d, ID.b, ID.c]);
    // ID.d: from before vdx named the machine, never typed in here.
    expect(latest.map((c) => machineOf(c, 'lft'))).toEqual([null, 'LFT', 'm3']);
  });

  it("a conversation without the machine's line is this machine's when it was typed in here (history.jsonl)", () => {
    const config = path.join(home, '.claude');
    writeConversation(config, root, ID.a, [userLine('a')], 30);
    writeConversation(config, root, ID.b, [userLine('b')], 5);
    writeConversation(config, root, ID.c, [startedOn('m3'), userLine('c')], 1);
    writeHistory(config, root, [ID.a, ID.c]);
    const list = listConversations({ env: {}, home, projectRoot: root });
    expect(list.map((c) => [c.id, c.typedHere])).toEqual([
      [ID.c, true],
      [ID.b, false],
      [ID.a, true],
    ]);
    // The line of the last start wins over a prompt typed here earlier.
    expect(list.map((c) => machineOf(c, 'lft'))).toEqual(['m3', null, 'lft']);
    expect(latestPerMachine(list, (c) => machineOf(c, 'lft')).map((c) => c.id)).toEqual([ID.c, ID.b, ID.a]);
  });

  it('finds nothing for a project Claude Code never ran in', () => {
    expect(listConversations({ env: {}, home, projectRoot: root })).toEqual([]);
  });
});

describe('liveConversationId', () => {
  let home: string;
  beforeEach(() => {
    home = tmpDir('vdx-conv-live-');
    fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it("reads the conversation a running process is in from its session file — /clear moves it", () => {
    fs.writeFileSync(path.join(home, '.claude', 'sessions', '4242.json'), JSON.stringify({ pid: 4242, sessionId: ID.c }));
    expect(liveConversationId({}, home, 4242)).toBe(ID.c);
    expect(liveConversationId({}, home, 4243)).toBeNull();
  });
});

describe('describeAge', () => {
  const now = new Date(2026, 9, 6, 18, 30);
  it('minutes, then today / yesterday with the time, then the date', () => {
    expect(describeAge(new Date(2026, 9, 6, 18, 27), now)).toBe('3 min ago');
    expect(describeAge(new Date(2026, 9, 6, 9, 5), now)).toBe('today 09:05');
    expect(describeAge(new Date(2026, 9, 5, 0, 5), now)).toBe('yesterday 00:05');
    expect(describeAge(new Date(2026, 8, 30, 14, 5), now)).toBe('2026-09-30 14:05');
  });
});

describe('sessions running right now', () => {
  let home: string;
  const sessions = () => path.join(home, '.claude', 'sessions');
  beforeEach(() => {
    home = tmpDir('vdx-conv-sessions-');
    fs.mkdirSync(sessions(), { recursive: true });
    const file = (pid: number, id: string, extra: object = {}) =>
      fs.writeFileSync(path.join(sessions(), `${pid}.json`), JSON.stringify({ pid, sessionId: id, ...extra }, null, 2));
    file(process.pid, ID.a, { tmux: 'proj@lft:@3.%3', status: 'waiting', cwd: '/Users/vdm/AI Projects/proj' });
    file(999_999_9, ID.b); // its process is gone: Claude leaves the file after a crash or a reboot
    fs.writeFileSync(path.join(sessions(), `${process.pid}.sync-conflict-20260514-163124-INHMB34.json`), '{"pid":1,"sessionId":"' + ID.c + '"}');
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('this machine: the session files of processes alive, not a dead pid or a conflict copy', () => {
    expect(liveSessionsHere({}, home)).toEqual([
      { pid: process.pid, conversation: ID.a, tmux: 'proj@lft:@3.%3', status: 'waiting', cwd: '/Users/vdm/AI Projects/proj' },
    ]);
  });

  it('another machine: the script prints its home, then the same, one per line, under sh', () => {
    const res = spawnSync('/bin/sh', ['-c', LIVE_SESSIONS_SCRIPT], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' } });
    expect(res.status).toBe(0);
    expect(res.stdout.trim().split('\n')).toHaveLength(2);
    expect(parseMachineReport(res.stdout)).toEqual({ home, sessions: liveSessionsHere({}, home) });
  });

  it('…and only its home, exit 0, where Claude Code never ran', () => {
    const none = path.join(home, 'none');
    const res = spawnSync('/bin/sh', ['-c', LIVE_SESSIONS_SCRIPT], { encoding: 'utf8', env: { HOME: none, PATH: '/usr/bin:/bin' } });
    expect(res.status).toBe(0);
    expect(parseMachineReport(res.stdout)).toEqual({ home: none, sessions: [] });
  });
});

describe('runsInProject: a session of another machine, by the directory it runs in', () => {
  const at = (cwd: string | null): LiveSession => ({ pid: 1, conversation: ID.a, tmux: null, status: null, cwd });
  const root = '/Users/vdm/AI Projects/proj';

  it('compares the two machines from their homes', () => {
    expect(runsInProject(at('/Users/vdm/AI Projects/proj'), '/Users/vdm', root, '/Users/vdm')).toBe(true);
    expect(runsInProject(at('/home/dm/AI Projects/proj'), '/home/dm', root, '/Users/vdm')).toBe(true);
    expect(runsInProject(at('/home/dm/AI Projects/proj/cli'), '/home/dm', root, '/Users/vdm')).toBe(true);
  });

  it('not a sibling whose name starts the same, not another place under that home', () => {
    expect(runsInProject(at('/home/dm/AI Projects/proj2'), '/home/dm', root, '/Users/vdm')).toBe(false);
    expect(runsInProject(at('/home/dm/old/AI Projects/proj'), '/home/dm', root, '/Users/vdm')).toBe(false);
  });

  it('outside the homes, or with the other home unknown — the paths as they are', () => {
    expect(runsInProject(at('/srv/proj'), '/home/dm', '/srv/proj', '/Users/vdm')).toBe(true);
    expect(runsInProject(at('/Users/vdm/AI Projects/proj'), null, root, '/Users/vdm')).toBe(true);
    expect(runsInProject(at('/home/dm/AI Projects/proj'), null, root, '/Users/vdm')).toBe(false);
    expect(runsInProject(at(null), '/Users/vdm', root, '/Users/vdm')).toBe(false);
  });
});
