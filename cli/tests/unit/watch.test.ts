import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  attachCommand,
  emptyMemory,
  findGroup,
  keyOf,
  parseCreated,
  parseWorkspaces,
  planPass,
  startWatch,
  watch,
  type WatchConfig,
  type WatchDeps,
  type WatchedSession,
} from '../../src/watch.ts';

// The shapes of cmux 0.65.2's answers, from the owner's probe in a cmux tab on m3, 2026-11-28 (crystal
// cmux-sidebar-all-tmux-sessions, DL #3); the names are neutral.
const workspace = (id: string, ref: string, title: string, custom = false) => ({
  current_directory: '/Users/me/proj',
  custom_color: null,
  custom_title: custom ? title : null,
  description: null,
  has_custom_title: custom,
  id,
  index: 0,
  latest_conversation_message: null,
  listening_ports: [],
  pinned: false,
  ref,
  remote: { connected: false, terminal_tmux_session: null },
  selected: false,
  title,
});
const workspaceList = (...ws: ReturnType<typeof workspace>[]) =>
  JSON.stringify({ window_ref: 'window:1000050000', workspaces: ws }, null, 2);
const groupList = (...groups: { ref: string; name: string; members: string[] }[]) =>
  JSON.stringify({
    window_ref: 'window:1000050000',
    groups: groups.map((g) => ({
      anchor_workspace_is_generated: false,
      anchor_workspace_ref: g.members[0] ?? null,
      custom_color: null,
      is_collapsed: false,
      member_count: g.members.length,
      member_workspace_refs: g.members,
      name: g.name,
      ref: g.ref,
    })),
  });
const identify = (ref: string) =>
  JSON.stringify({ app: 'cmux', caller: { workspace_ref: ref, surface_ref: 'surface:1' }, version: '0.65.2' });

const session = (over: Partial<WatchedSession> = {}): WatchedSession => ({
  machine: 'm3',
  session: 'proj@m3',
  created: 1_800_000_000,
  path: null,
  openAt: [],
  ...over,
});

describe('cmux answers, as cmux 0.65.2 gives them', () => {
  it('the workspaces, the ref of a new one, a group by name', () => {
    expect(parseWorkspaces(workspaceList(workspace('A-1', 'workspace:1', 'HQ', true)))).toEqual([
      { id: 'A-1', ref: 'workspace:1' },
    ]);
    expect(parseWorkspaces('Error: ERROR: Access denied')).toBeNull();
    expect(parseCreated('OK workspace:1000050059\n')).toBe('workspace:1000050059');
    expect(parseCreated('Error: no such group')).toBeNull();
    const groups = groupList(
      { ref: 'workspace_group:1', name: 'HQ', members: ['workspace:1'] },
      { ref: 'workspace_group:2', name: 'tmux', members: ['workspace:7', 'workspace:8'] },
    );
    expect(findGroup(groups, 'tmux')).toEqual({ ref: 'workspace_group:2', members: ['workspace:7', 'workspace:8'] });
    expect(findGroup(groups, 'other')).toBeNull();
  });
});

describe('planPass: which sessions get a tab, which tabs go (DL #2, #3)', () => {
  const pass = (over: Partial<Parameters<typeof planPass>[0]>) =>
    planPass({
      seat: 'm3',
      answered: ['m3', 'lft'],
      sessions: [],
      workspaces: new Set(),
      memory: emptyMemory(),
      warm: true,
      ...over,
    });

  it('a session no terminal here shows: a tab on its second pass, never while the watch is new; one shown here — none', () => {
    const s = session();
    const first = pass({ sessions: [s, session({ session: 'other@m3', openAt: ['m3'] })] });
    expect(first.open).toEqual([]);
    expect(first.memory.unshown).toEqual({ [keyOf(s)]: 1 });
    expect(pass({ sessions: [s], memory: first.memory, warm: false }).open).toEqual([]);
    expect(pass({ sessions: [s], memory: first.memory }).open).toEqual([s]);
    // Shown on another machine's terminal only: not shown here.
    const there = session({ machine: 'lft', session: 'proj@lft', openAt: ['lft'] });
    expect(pass({ sessions: [there], memory: { ...emptyMemory(), unshown: { [keyOf(there)]: 1 } } }).open).toEqual([
      there,
    ]);
  });

  it('the session ended: its tab closes; the tab gone while the session runs: closed by hand, and stays closed', () => {
    const s = session();
    const tab = { id: 'W-1', ref: 'workspace:9', key: keyOf(s) };
    const memory = { ...emptyMemory(), tabs: [tab] };
    expect(pass({ sessions: [], workspaces: new Set(['W-1']), memory }).close).toEqual([tab]);
    const byHand = pass({ sessions: [s], workspaces: new Set(), memory });
    expect(byHand.closedByHand).toEqual([tab]);
    expect(byHand.memory.closed).toEqual([keyOf(s)]);
    let m = byHand.memory;
    for (let i = 0; i < 3; i++) {
      const p = pass({ sessions: [s], memory: m });
      expect(p.open).toEqual([]);
      m = p.memory;
    }
    // Started again under the same name: another session, and the memory of the old one goes.
    const again = session({ created: s.created + 60 });
    const p1 = pass({ sessions: [again], memory: m });
    expect(p1.memory.closed).toEqual([]);
    expect(pass({ sessions: [again], memory: p1.memory }).open).toEqual([again]);
  });

  it('a machine that did not answer: its tabs stay, its sessions wait, what was closed there is remembered', () => {
    const there = session({ machine: 'lft', session: 'proj@lft' });
    const tab = { id: 'W-2', ref: 'workspace:10', key: keyOf(there) };
    const p = pass({
      answered: ['m3'],
      sessions: [],
      workspaces: new Set(['W-2']),
      memory: {
        tabs: [tab],
        closed: [keyOf(session({ machine: 'lft', session: 'x@lft' }))],
        unshown: { [keyOf(there)]: 1 },
      },
    });
    expect(p.close).toEqual([]);
    expect(p.memory.tabs).toEqual([tab]);
    expect(p.memory.closed).toHaveLength(1);
    expect(p.memory.unshown).toEqual({ [keyOf(there)]: 1 });
  });

  it('a session with a tab of the watcher is not opened twice, though the tab was detached', () => {
    const s = session();
    const memory = {
      ...emptyMemory(),
      tabs: [{ id: 'W-1', ref: 'workspace:9', key: keyOf(s) }],
      unshown: { [keyOf(s)]: 5 },
    };
    const p = pass({ sessions: [s], workspaces: new Set(['W-1']), memory });
    expect(p.open).toEqual([]);
    expect(p.memory.unshown).toEqual({});
  });
});

describe('attachCommand: a plain tmux attach with the seat’s mark', () => {
  it('here — tmux; another machine — through ssh -t, a terminal it does not know as xterm-256color; valid sh', () => {
    const here = attachCommand(session({ session: "it's@m3" }), 'm3', 'm3', 'VDX_AI_SEAT');
    expect(here).toBe(`exec env VDX_AI_SEAT=m3 tmux attach -t '=it'\\''s@m3'`);
    const there = attachCommand(session({ machine: 'lft', session: 'proj@lft' }), 'm3', 'm3', 'VDX_AI_SEAT');
    expect(there).toMatch(/^exec ssh -t lft '/);
    expect(there).toContain('export TERM=xterm-256color; export VDX_AI_SEAT=m3; exec tmux attach -t =proj@lft');
    for (const line of [here, there]) expect(spawnSync('sh', ['-n', '-c', line]).status).toBe(0);
  });
});

describe('watch: one watcher, its group, its passes (with cmux, tmux and ssh as functions)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-watch-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const config: WatchConfig = {
    here: 'm3',
    seat: 'm3',
    machines: ['m3', 'lft'],
    seatVar: 'VDX_AI_SEAT',
    passMs: 5_000,
    remoteEvery: 3,
    warmMs: 0,
    passes: 3,
  };
  /** A cmux with the watcher's tab, the group made on its first ask, and the tabs it opens; what was asked of it. */
  const fakeCmux = () => {
    const calls: string[][] = [];
    const tabs: ReturnType<typeof workspace>[] = [workspace('OWN', 'workspace:50', 'watch')];
    let group: { ref: string; name: string; members: string[] } | null = null;
    let next = 60;
    const cmux = (args: string[]) => {
      calls.push(args);
      const [a, b] = args;
      if (a === 'identify') return { status: 0, out: identify('workspace:50') };
      if (a === 'workspace-group' && b === 'list') return { status: 0, out: groupList(...(group ? [group] : [])) };
      if (a === 'workspace-group' && b === 'create') {
        group = { ref: 'workspace_group:5', name: 'tmux', members: ['workspace:50'] };
        return { status: 0, out: 'OK workspace_group:5\n' };
      }
      if (a === 'workspace' && b === 'list') return { status: 0, out: workspaceList(...tabs) };
      if (a === 'workspace' && b === 'create') {
        const ref = `workspace:${next++}`;
        tabs.push(workspace(`ID-${ref}`, ref, 'zsh'));
        return { status: 0, out: `OK ${ref}\n` };
      }
      return { status: 0, out: '' };
    };
    return { cmux, calls };
  };
  const deps = (over: Partial<WatchDeps>): WatchDeps => ({
    cmux: () => ({ status: 1, out: '' }),
    local: () => [],
    remote: () => null,
    log: () => {},
    sleep: () => {},
    now: () => 1_000,
    stateFile: path.join(dir, 'watch.json'),
    pidAlive: () => false,
    pid: 4242,
    ...over,
  });

  it("makes the group «tmux» with its own tab as the anchor, opens a tab there for a session nobody's terminal here shows", () => {
    const { cmux, calls } = fakeCmux();
    const said: string[] = [];
    const lft = session({ machine: 'lft', session: 'proj@lft', openAt: ['lft'] });
    const shown = session({ session: 'shown@m3', openAt: ['m3'] });
    const code = watch(config, deps({ cmux, local: () => [shown], remote: () => [lft], log: (l) => said.push(l) }));
    expect(code).toBe(0);
    expect(calls).toContainEqual(['workspace-group', 'create', '--name', 'tmux', '--from', 'workspace:50']);
    const creates = calls.filter((c) => c[0] === 'workspace' && c[1] === 'create');
    expect(creates).toHaveLength(1);
    expect(creates[0]).toEqual([
      'workspace',
      'create',
      '--focus',
      'false',
      '--group',
      'workspace_group:5',
      '--command',
      expect.stringMatching(/^exec ssh -t lft '.*exec tmux attach -t =proj@lft'$/),
    ]);
    expect(creates[0]).not.toContain('--name');
    expect(said.some((l) => l.includes('proj@lft: no terminal here showed it'))).toBe(true);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'watch.json'), 'utf8')) as {
      pid: number;
      memory: { tabs: { id: string; key: string }[] };
    };
    expect(state.pid).toBe(4242);
    expect(state.memory.tabs).toEqual([expect.objectContaining({ id: 'ID-workspace:60', key: keyOf(lft) })]);
  });

  it('a second watcher while the first runs: says where, and asks cmux nothing', () => {
    fs.writeFileSync(
      path.join(dir, 'watch.json'),
      JSON.stringify({ pid: 99, started: 1, workspace: 'workspace:50', memory: emptyMemory() }),
    );
    const { cmux, calls } = fakeCmux();
    const said: string[] = [];
    expect(watch(config, deps({ cmux, pidAlive: (pid) => pid === 99, log: (l) => said.push(l) }))).toBe(0);
    expect(said).toEqual(['vdx ai --watch already runs (pid 99, tab workspace:50)']);
    expect(calls).toEqual([]);
  });

  it("--watch --detach (the line in ~/.zshrc): the watcher's tab once — not while one runs, not twice in a minute", () => {
    const calls: string[][] = [];
    const cmux = (args: string[]) => (calls.push(args), { status: 0, out: 'OK workspace:70\n' });
    const stateFile = path.join(dir, 'watch.json');
    let now = Date.now();
    const start = (alive: (pid: number) => boolean) =>
      startWatch({ cmux, log: () => {}, stateFile, pidAlive: alive, now: () => now });
    expect(start(() => false)).toBe(0);
    expect(calls).toEqual([['workspace', 'create', '--focus', 'false', '--env', 'VDX_WATCH=1']]);
    // Every tab of a cmux just started asks at once: one tab.
    expect(start(() => false)).toBe(0);
    expect(calls).toHaveLength(1);
    // A minute on, with no watcher running, it is asked again; while one runs — never.
    now += 61_000;
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ pid: 99, started: 1, workspace: 'workspace:70', memory: emptyMemory() }),
    );
    expect(start((pid) => pid === 99)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(start(() => false)).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it('cmux that does not say which tab this is: exit 4, nothing opened', () => {
    const said: string[] = [];
    expect(watch(config, deps({ cmux: () => ({ status: 1, out: 'Error' }), log: (l) => said.push(l) }))).toBe(4);
    expect(said[0]).toContain('cmux did not say which tab this is');
  });
});
