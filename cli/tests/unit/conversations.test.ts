import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  bashLine,
  commandLine,
  compactLine,
  hookLine,
  ID,
  replyLine,
  thinkingLine,
  skillLine,
  startedOn,
  toolResultLine,
  userLine,
  promptLine,
  titleLine,
  writeConversation,
  writeHistory,
} from './transcripts.ts';
import {
  claudeConfigDir,
  claudeTrusts,
  describeAge,
  findInConversations,
  historyMarks,
  isEmpty,
  isLeftAfterLook,
  joinMarks,
  LOOK_GAP_MS,
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

// Claude Code 2.1.308 (claude-memory-in-project DL #13): the folder's record or one above it,
// inside a git checkout up to its top; no config — nobody knows.
describe('claudeTrusts', () => {
  let home: string;
  beforeEach(() => {
    home = tmpDir('vdx-trust-');
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  const trusted = (dirs: string[], file = path.join(home, '.claude.json')) =>
    fs.writeFileSync(
      file,
      JSON.stringify({ projects: Object.fromEntries(dirs.map((d) => [d, { hasTrustDialogAccepted: true }])) }),
    );

  it('the folder or one above it; inside a git checkout, up to its top only', () => {
    const projects = path.join(home, 'Projects');
    const plain = path.join(projects, 'notes');
    const repo = path.join(projects, 'repo');
    fs.mkdirSync(plain, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src'));
    expect(claudeTrusts(plain, {}, home)).toBeNull();
    trusted([projects]);
    expect(claudeTrusts(plain, {}, home)).toBe(true);
    expect(claudeTrusts(repo, {}, home)).toBe(false);
    trusted([repo]);
    expect(claudeTrusts(path.join(repo, 'src'), {}, home)).toBe(true);
    expect(claudeTrusts(plain, {}, home)).toBe(false);
  });

  it('reads .claude.json in $CLAUDE_CONFIG_DIR when it is set', () => {
    const cc = path.join(home, 'cc');
    fs.mkdirSync(cc);
    trusted([home], path.join(cc, '.claude.json'));
    expect(claudeTrusts(home, { CLAUDE_CONFIG_DIR: cc }, home)).toBe(true);
    expect(claudeTrusts(home, {}, home)).toBeNull();
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

  describe('how it began and how it ended (vdx-ai-predictable DL #3)', () => {
    const readWith = (lines: string[], wraps = ['vdm:wrap']) => {
      const file = path.join(dir, `${ID.a}.jsonl`);
      fs.writeFileSync(file, lines.join('\n') + '\n');
      return readConversation(file, new Date(), wraps)!;
    };

    it('begun by /clear with nothing typed is empty; the first prompt makes it a conversation', () => {
      const cleared = readWith([commandLine('clear'), startedOn('lft')]);
      expect([cleared.bornClear, cleared.typed, isEmpty(cleared)]).toEqual([true, 0, true]);
      const begun = readWith([commandLine('clear'), startedOn('lft'), userLine('go on with the crystal')]);
      expect([begun.bornClear, begun.typed, isEmpty(begun)]).toEqual([true, 1, false]);
      expect(isEmpty(readWith([startedOn('lft'), userLine('hi')]))).toBe(false);
    });

    it("counts what the person typed — not a `!` command, a tool's result or a tagged text", () => {
      const c = readWith([
        startedOn('lft'),
        userLine('first'),
        toolResultLine('ok'),
        bashLine('git status'),
        userLine('<task-notification>done</task-notification>'),
        userLine('<channel source="echelon" kind="jira">new task</channel>'),
        userLine('second'),
      ]);
      expect(c.typed).toBe(2);
    });

    it('finished: a wrap ran and nothing was typed after it — the `!` commit line does not count', () => {
      expect(
        readWith([startedOn('lft'), userLine('work'), skillLine('vdm:wrap'), bashLine('sh /tmp/c.sh')]).finished,
      ).toBe(true);
      expect(readWith([startedOn('lft'), userLine('work'), commandLine('vdm:wrap')]).finished).toBe(true);
      expect(readWith([startedOn('lft'), skillLine('vdm:wrap'), userLine('one more thing')]).finished).toBe(false);
      expect(readWith([startedOn('lft'), userLine('work'), skillLine('vdm:intercom')]).finished).toBe(false);
    });

    it("a program's run through the SDK is automated; one typed at a terminal is not", () => {
      expect(readWith([userLine('Review this change for security vulnerabilities.', 'sdk-py')]).automated).toBe(true);
      expect(readWith([userLine('go', 'sdk-cli')]).automated).toBe(true);
      expect(readWith([startedOn('lft'), userLine('hi')]).automated).toBe(false);
    });

    it('nothing is a wrap unless the profile names it', () => {
      expect(readWith([startedOn('lft'), userLine('work'), skillLine('vdm:wrap')], []).finished).toBe(false);
    });

    it("a compaction's summary is not a prompt: a wrapped conversation compacted after stays finished", () => {
      const c = readWith([
        startedOn('lft'),
        userLine('work'),
        skillLine('vdm:wrap'),
        compactLine('This session is being continued from a previous conversation.'),
      ]);
      expect([c.typed, c.finished]).toEqual([1, true]);
    });
  });
});

describe('findInConversations: a phrase from a screen finds its conversation (vdx-ai-predictable P5)', () => {
  let home: string;
  const root = '/Users/x/AI Projects/proj';
  const config = () => path.join(home, '.claude');
  const find = (phrase: string) => findInConversations({ env: {}, home, projectRoot: root, phrase });
  beforeEach(() => {
    home = tmpDir('vdx-find-home-');
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('case, punctuation, markdown and the line breaks of a screen do not count', () => {
    writeConversation(
      config(),
      root,
      ID.a,
      [
        startedOn('lft'),
        userLine('go'),
        replyLine('**Список для ответа** space-hq готов. У space-hq 17 незаявленных.'),
      ],
      30,
    );
    for (const phrase of ['17 незаявленных', 'список для\n  ответа SPACE-HQ', 'ответа space hq готов'])
      expect(
        find(phrase)?.map((f) => f.id),
        phrase,
      ).toEqual([ID.a]);
    expect(find('17 заявленных')).toEqual([]);
    const [f] = find('17 незаявленных')!;
    expect(f).toMatchObject({ who: 'agent', hits: 1 });
    expect(f!.around).toBe('**Список для ответа** space-hq готов. У space-hq 17 незаявленных.');
  });

  it('only what was said: not a hook, a tool result, a tagged text or a compaction summary', () => {
    writeConversation(
      config(),
      root,
      ID.a,
      [
        hookLine('the hook says needle here'),
        userLine('hi'),
        toolResultLine('a file with needle in it'),
        bashLine('grep needle'),
        userLine('<channel source="echelon">needle</channel>'),
        compactLine('Summary: we looked for the needle'),
      ],
      30,
    );
    writeConversation(config(), root, ID.b, [userLine('where is the needle?'), replyLine('No needle.')], 10);
    const found = find('needle')!;
    expect(found.map((f) => [f.id, f.hits, f.who])).toEqual([[ID.b, 2, 'agent']]);
  });

  it('the newest first; the text around the last match, cut to a line', () => {
    const long = 'word '.repeat(40) + 'the needle ' + 'tail '.repeat(40);
    writeConversation(config(), root, ID.a, [userLine('a needle, early'), replyLine(long)], 60);
    writeConversation(config(), root, ID.b, [userLine('the needle, later')], 5);
    const found = find('Needle')!;
    expect(found.map((f) => f.id)).toEqual([ID.b, ID.a]);
    expect(found[0]).toMatchObject({ who: 'you', around: 'the needle, later' });
    const around = found[1]!.around;
    expect(around).toMatch(/^….*the needle.*…$/);
    expect(around.length).toBeLessThanOrEqual(80);
  });

  it("the agent's updates Claude Code shows on the screen; thinking it does not show — not", () => {
    writeConversation(config(), root, ID.a, [userLine('go'), thinkingLine('Checking the crystal against npm')], 30);
    writeConversation(config(), root, ID.b, [userLine('go'), thinkingLine('Checking the crystal quietly', false)], 10);
    expect(find('checking the crystal')!.map((f) => [f.id, f.who])).toEqual([[ID.a, 'agent']]);
  });

  it('a phrase with no letters or digits is no search', () => {
    expect(find(' … ')).toBeNull();
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
    const latest = latestPerMachine(listConversations({ env: {}, home, projectRoot: root }), (c) =>
      machineOf(c, 'lft'),
    );
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

describe('left after a look: /clear long after the last word (vdx-ai-predictable Sidetrack #18)', () => {
  let home: string;
  beforeEach(() => (home = tmpDir('vdx-history-')));
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  // The lines as Claude Code writes them (m3, 2026-11-13): b9f7c508 got '!sh …' on 11-09 and '/clear' on 11-13.
  const line = (id: string, display: string, timestamp: number) =>
    JSON.stringify({ display, pastedContents: {}, timestamp, project: '/p', sessionId: id });
  const write = (lines: string[]) => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'history.jsonl'), lines.join('\n') + '\n');
  };
  const day = LOOK_GAP_MS;

  it('the last /clear and the last of anything else, per conversation; other ids and old lines without an id left out', () => {
    write([
      JSON.stringify({ display: '/model ', pastedContents: {}, timestamp: 5, project: '/p' }),
      line(ID.a, '!sh /x.sh', 1_000),
      line(ID.a, 'Ну поставь 8:00', 2_000),
      line(ID.a, '/clear', 2_000 + 5 * day),
      line(ID.b, '/clear ', 10),
      line(ID.b, 'go on', 20),
      line(ID.c, 'not asked', 30),
    ]);
    const m = historyMarks({}, home, new Set([ID.a, ID.b]));
    expect([...m]).toEqual([
      [ID.a, { typed: 2_000, cleared: 2_000 + 5 * day }],
      [ID.b, { typed: 20, cleared: 10 }],
    ]);
    expect(isLeftAfterLook(m.get(ID.a))).toBe(true);
    // Typed after the /clear: back at work in it.
    expect(isLeftAfterLook(m.get(ID.b))).toBe(false);
  });

  it('a /clear right after work is not a look — the wrap guards that; nothing typed anywhere is not judged', () => {
    expect(isLeftAfterLook({ typed: 1_000, cleared: 1_000 + day - 1 })).toBe(false);
    expect(isLeftAfterLook({ typed: 1_000, cleared: 1_000 + day + 1 })).toBe(true);
    expect(isLeftAfterLook({ typed: 0, cleared: 5 * day })).toBe(false);
    expect(isLeftAfterLook(undefined)).toBe(false);
  });

  it("another machine's marks join this one's: the latest of each decides", () => {
    const here = new Map([[ID.a, { typed: 1_000, cleared: 1_000 + 3 * day }]]);
    // Typed there after the /clear here: not left.
    joinMarks(here, [[ID.a, { typed: 2_000 + 3 * day, cleared: 0 }]]);
    expect(here.get(ID.a)).toEqual({ typed: 2_000 + 3 * day, cleared: 1_000 + 3 * day });
    expect(isLeftAfterLook(here.get(ID.a))).toBe(false);
    joinMarks(here, [[ID.b, { typed: 10, cleared: 10 + 2 * day }]]);
    expect(isLeftAfterLook(here.get(ID.b))).toBe(true);
  });

  it('no history.jsonl: nothing', () => {
    expect(historyMarks({}, home, new Set([ID.a])).size).toBe(0);
  });
});

describe('liveConversationId', () => {
  let home: string;
  beforeEach(() => {
    home = tmpDir('vdx-conv-live-');
    fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('reads the conversation a running process is in from its session file — /clear moves it', () => {
    fs.writeFileSync(
      path.join(home, '.claude', 'sessions', '4242.json'),
      JSON.stringify({ pid: 4242, sessionId: ID.c }),
    );
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
    fs.writeFileSync(
      path.join(sessions(), `${process.pid}.sync-conflict-20260514-163124-INHMB34.json`),
      '{"pid":1,"sessionId":"' + ID.c + '"}',
    );
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('this machine: the session files of processes alive, not a dead pid or a conflict copy', () => {
    expect(liveSessionsHere({}, home)).toEqual([
      {
        pid: process.pid,
        conversation: ID.a,
        tmux: 'proj@lft:@3.%3',
        status: 'waiting',
        cwd: '/Users/vdm/AI Projects/proj',
      },
    ]);
  });

  it('another machine: the script prints its home, then the same, one per line, under sh', () => {
    const res = spawnSync('/bin/sh', ['-c', LIVE_SESSIONS_SCRIPT], {
      encoding: 'utf8',
      env: { HOME: home, PATH: '/usr/bin:/bin' },
    });
    expect(res.status).toBe(0);
    expect(res.stdout.trim().split('\n')).toHaveLength(2);
    expect(parseMachineReport(res.stdout)).toEqual({ home, sessions: liveSessionsHere({}, home) });
  });

  it('…and only its home, exit 0, where Claude Code never ran', () => {
    const none = path.join(home, 'none');
    const res = spawnSync('/bin/sh', ['-c', LIVE_SESSIONS_SCRIPT], {
      encoding: 'utf8',
      env: { HOME: none, PATH: '/usr/bin:/bin' },
    });
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
