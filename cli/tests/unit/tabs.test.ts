import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type CmuxPanel,
  type CmuxSnapshot,
  type TabRecord,
  cmuxBeforeStart,
  cmuxDir,
  currentCmux,
  planTabs,
  readTabRecord,
  returnTabs,
  writeTabRecord,
} from '../../src/tabs.ts';

const tmpDir = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

/**
 * A terminal tab as cmux 0.65.2 writes it (lft, 2026-11-17, `session-com.cmuxterm.app.json`): the panel's `id`
 * is the tab's CMUX_SURFACE_ID, `ttyName` its terminal, and a `tmux attach` cmux noticed is `resumeBinding`.
 */
const panel = (id: string, tty: string, binding?: string, command?: string) => ({
  directory: '/work/proj',
  directoryIsTrustedRemoteReport: false,
  gitBranch: { branch: 'main', isDirty: false },
  hasUnreadIndicator: false,
  id,
  isManuallyUnread: false,
  isPinned: false,
  listeningPorts: [],
  stableSurfaceId: `STABLE-${id}`,
  terminal: {
    hasReceivedExplicitInput: true,
    isRemoteTerminal: false,
    workingDirectory: '/work/proj',
    ...(binding
      ? {
          resumeBinding: {
            autoResume: true,
            checkpointId: `=${binding}`,
            command: command ?? `'tmux' 'attach' '-t' '=${binding}'`,
            kind: 'tmux',
            source: 'process-detected',
          },
        }
      : {}),
  },
  title: `tab ${id}`,
  ttyName: `/dev/${tty}`,
  type: 'terminal',
});
const snapshotFile = (panels: unknown[]) =>
  JSON.stringify({
    createdAt: 1,
    version: 1,
    windows: [
      {
        windowId: 'W',
        tabManager: {
          selectedWorkspaceIndex: 0,
          workspaceGroups: [],
          workspaces: [{ workspaceId: 'WS-1', currentDirectory: '/work/proj', panels }],
        },
      },
    ],
  });

describe('cmux snapshots: now, and before cmux last started', () => {
  let home: string;
  beforeEach(() => (home = tmpDir('vdx-tabs-')));
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('reads the tabs, their terminals and the tmux session cmux noticed; one on another socket is not taken', () => {
    fs.mkdirSync(cmuxDir(home), { recursive: true });
    fs.writeFileSync(
      path.join(cmuxDir(home), 'session-com.cmuxterm.app.json'),
      snapshotFile([
        panel('A', 'ttys001', 'proj@lft'),
        panel('B', 'ttys002'),
        panel('C', 'ttys003', 'x@lft', "'tmux' '-L' 'other' 'attach' '-t' '=x@lft'"),
      ]),
    );
    const now = currentCmux(home)!;
    expect([...now.panels.keys()]).toEqual(['A', 'B', 'C']);
    expect(now.panels.get('A')).toEqual({
      surface: 'A',
      workspace: 'WS-1',
      directory: '/work/proj',
      title: 'tab A',
      tty: 'ttys001',
      tmuxSession: 'proj@lft',
    });
    expect(now.panels.get('B')!.tmuxSession).toBeNull();
    expect(now.panels.get('C')!.tmuxSession).toBeNull();
  });

  it('before the start: the newest copy in session-history, its start from the name', () => {
    const dir = path.join(cmuxDir(home), 'session-history');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session-com.cmuxterm.app-1794523788761-w23-p23.json'), snapshotFile([]));
    fs.writeFileSync(
      path.join(dir, 'session-com.cmuxterm.app-1794937350065-w14-p14.json'),
      snapshotFile([panel('A', 'ttys001', 'proj@lft')]),
    );
    const before = cmuxBeforeStart(home)!;
    expect(before.startedAt).toBe(1794937350065);
    expect(before.panels.get('A')!.tmuxSession).toBe('proj@lft');
    expect(cmuxBeforeStart(tmpDir('vdx-tabs-none-'))).toBeNull();
  });
});

describe('planTabs: where each tab goes, and whether it can go now', () => {
  const p = (surface: string, tty: string | null, tmuxSession: string | null = null): CmuxPanel => ({
    surface,
    workspace: 'WS-1',
    directory: '/work/proj',
    title: `tab ${surface}`,
    tty,
    tmuxSession,
  });
  const snap = (panels: CmuxPanel[], startedAt: number | null = null): CmuxSnapshot => ({
    panels: new Map(panels.map((x) => [x.surface, x])),
    startedAt,
  });
  const here = (surface: string, session: string, at = 1): TabRecord => ({
    kind: 'here',
    surface,
    session,
    socket: null,
    at,
  });
  const base = {
    self: null,
    before: null,
    records: [] as TabRecord[],
    foreground: new Map<string, string[]>(),
    sessionsHere: () => new Map([['proj@lft', 0]]),
    marksThere: () => new Map([['abc123', 0]]),
  };
  const states = (input: Parameters<typeof planTabs>[0]) => planTabs(input).map((x) => [x.surface, x.state, x.from]);

  it('a tab at its shell whose session is there goes back; one holding an attach, or running something, does not', () => {
    expect(
      states({
        ...base,
        current: snap([p('A', 'ttys001'), p('B', 'ttys002'), p('C', 'ttys003'), p('D', 'ttys004')]),
        records: [here('A', 'proj@lft'), here('B', 'proj@lft'), here('C', 'proj@lft'), here('D', 'gone@lft')],
        foreground: new Map([
          ['ttys001', ['-zsh']],
          ['ttys002', ['zsh', 'tmux']],
          ['ttys003', ['vim']],
        ]),
      }),
    ).toEqual([
      ['A', 'ready', 'record'],
      ['B', 'shown', 'record'],
      ['C', 'busy', 'record'],
      ['D', 'no-session', 'record'],
    ]);
    // Its session is in another terminal here already: not typed into.
    expect(
      states({
        ...base,
        current: snap([p('A', 'ttys001')]),
        records: [here('A', 'proj@lft')],
        foreground: new Map([['ttys001', ['-zsh']]]),
        sessionsHere: () => new Map([['proj@lft', 1]]),
      }),
    ).toEqual([['A', 'shown', 'record']]);
  });

  it("the terminal its processes say comes first; a snapshot older than cmux's start does not say it", () => {
    const current: CmuxSnapshot = { ...snap([p('A', 'ttys001'), p('B', 'ttys002')]), writtenAt: 500 };
    const before = snap([], 1000);
    const foreground = new Map([
      ['ttys001', ['-zsh']],
      ['ttys007', ['tmux']],
    ]);
    const records = [here('A', 'proj@lft'), here('B', 'proj@lft')];
    // Written before cmux started: its terminals are of before — nothing typed by them.
    expect(states({ ...base, current, before, records, foreground })).toEqual([
      ['A', 'unknown', 'record'],
      ['B', 'unknown', 'record'],
    ]);
    // A's processes are on ttys007 now, where tmux holds the attach; B's are not seen.
    expect(states({ ...base, current, before, records, foreground, ttys: new Map([['A', 'ttys007']]) })).toEqual([
      ['A', 'shown', 'record'],
      ['B', 'unknown', 'record'],
    ]);
    // Written since the start: its terminals hold.
    expect(states({ ...base, current: { ...current, writtenAt: 2000 }, before, records, foreground })).toEqual([
      ['A', 'ready', 'record'],
      ['B', 'ready', 'record'],
    ]);
  });

  it('a tab of another machine: its mark there says whether the session is', () => {
    const there = (surface: string, token: string): TabRecord => ({
      kind: 'there',
      surface,
      host: 'm3',
      project: '/work/echelon',
      token,
      at: 1,
    });
    const current = snap([p('A', 'ttys001'), p('B', 'ttys002')]);
    expect(states({ ...base, current, records: [there('A', 'abc123'), there('B', 'fff999')] })).toEqual([
      ['A', 'ready', 'record'],
      ['B', 'no-session', 'record'],
    ]);
    expect(states({ ...base, current, records: [there('A', 'abc123')], marksThere: () => null })).toEqual([
      ['A', 'no-answer', 'record'],
    ]);
  });

  it('a tab without a record: the session cmux noticed in it before it started — only for a tab there now', () => {
    expect(
      states({
        ...base,
        current: snap([p('A', 'ttys001'), p('B', 'ttys002')]),
        // C: closed by hand since cmux started, or lost — cmux's binding cannot tell (m3, 2026-11-17: cmux up since
        // 10-07, 0.59.0 would have opened four tabs closed since).
        before: snap([p('A', 'ttys009', 'proj@lft'), p('B', 'ttys008'), p('C', 'ttys007', 'proj@lft')], 1000),
        records: [],
      }),
    ).toEqual([['A', 'ready', 'cmux']]);
  });

  it('a tab that is not there now: lost by cmux if it was open when cmux went down, closed by hand otherwise', () => {
    expect(
      states({
        ...base,
        current: snap([]),
        before: snap([p('G', 'ttys001'), p('L', 'ttys002')], 1000),
        // G: attached before this cmux started; L: attached during it, then the tab closed; X: never in it.
        records: [here('G', 'proj@lft', 500), here('L', 'proj@lft', 2000), here('X', 'proj@lft', 500)],
      }),
    ).toEqual([
      ['G', 'gone', 'record'],
      ['L', 'closed', 'record'],
      ['X', 'closed', 'record'],
    ]);
    // Its session is in another terminal now: the person has it elsewhere, nothing went missing.
    expect(
      states({
        ...base,
        current: snap([]),
        before: snap([p('G', 'ttys001')], 1000),
        records: [here('G', 'proj@lft', 500)],
        sessionsHere: () => new Map([['proj@lft', 1]]),
      }),
    ).toEqual([['G', 'closed', 'record']]);
  });

  it('the tab this runs in is itself; no cmux here, no tabs', () => {
    const current = snap([p('A', 'ttys001')]);
    expect(states({ ...base, current, self: 'A', records: [here('A', 'proj@lft')] })).toEqual([
      ['A', 'self', 'record'],
    ]);
    expect(planTabs({ ...base, current: null, records: [here('A', 'proj@lft')] })).toEqual([]);
  });
});

describe('returnTabs: the keystrokes and the new tab', () => {
  let home: string;
  beforeEach(() => (home = tmpDir('vdx-tabs-ret-')));
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('types `vdx ai --tab` into a tab at its shell, opens one cmux lost, and gives a record to a tab cmux alone knew', () => {
    const calls: string[][] = [];
    const logs: string[] = [];
    const panelOf = (surface: string): CmuxPanel => ({
      surface,
      workspace: 'WS-1',
      directory: home,
      title: 't',
      tty: 'ttys001',
      tmuxSession: null,
    });
    const target = { kind: 'here' as const, session: 'proj@lft', socket: null };
    const { sent, failed } = returnTabs(
      [
        { surface: 'A', target, from: 'cmux', state: 'ready', panel: panelOf('A') },
        { surface: 'G', target, from: 'record', state: 'gone', panel: panelOf('G') },
        { surface: 'B', target, from: 'record', state: 'busy', panel: panelOf('B') },
        { surface: 'F', target, from: 'record', state: 'ready', panel: panelOf('F') },
      ],
      {
        home,
        cmux: (args) => {
          calls.push(args);
          return args.includes('F') ? { status: 1, out: 'Error: surface not found\n' } : { status: 0, out: 'OK' };
        },
        tabCommand: '/usr/local/bin/node /usr/local/bin/vdx ai --tab',
        log: (l) => logs.push(l),
      },
    );
    expect(calls).toEqual([
      ['send', '--workspace', 'WS-1', '--surface', 'A', '--', 'VDX_TAB_NOW=1 vdx ai --tab\\n'],
      [
        'new-workspace',
        '--cwd',
        home,
        '--name',
        'proj@lft',
        '--env',
        'VDX_TAB_FROM=G',
        '--command',
        '/usr/local/bin/node /usr/local/bin/vdx ai --tab',
      ],
      ['send', '--workspace', 'WS-1', '--surface', 'F', '--', 'VDX_TAB_NOW=1 vdx ai --tab\\n'],
    ]);
    expect(sent.map((x) => x.surface)).toEqual(['A', 'G']);
    expect(failed.map((x) => x.surface)).toEqual(['F']);
    expect(logs).toEqual(['  ✗ proj@lft: cmux refused — Error: surface not found']);
    expect(readTabRecord(home, 'A')).toMatchObject({ kind: 'here', surface: 'A', session: 'proj@lft', socket: null });
    // A record of its own is left as it was.
    writeTabRecord(home, { kind: 'here', surface: 'K', session: 'k@lft', socket: null, at: 7 });
    expect(readTabRecord(home, 'K')).toEqual({ kind: 'here', surface: 'K', session: 'k@lft', socket: null, at: 7 });
  });
});
