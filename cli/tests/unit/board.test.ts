import { describe, expect, it } from 'vitest';
import { type AgentFact, agentState, buildBoard, inputDraft, readAnswer } from '../../src/board.ts';
import type { Conversation } from '../../src/conversations.ts';
import { ID } from './transcripts.ts';

const now = new Date(2026, 9, 30, 12, 0);
const rule = '\x1b[38;5;244m' + '─'.repeat(40);
const screen = (input: string) =>
  ['⏺ Done.', '', rule, `\x1b[39m❯\xa0${input}`, rule, '  📁 ~/AI Projects/x  🌿 main'].join('\n');

const agent = (over: Partial<AgentFact> = {}): AgentFact => ({
  machine: 'm3',
  session: 'proj@m3',
  pid: 100,
  conversation: ID.a,
  status: 'idle',
  activeAt: now.getTime() - 60_000,
  draft: 0,
  focused: false,
  topic: null,
  mail: false,
  openAt: [],
  title: 'Work',
  empty: false,
  finished: false,
  ...over,
});
const conv = (id: string, over: Partial<Conversation> = {}): Conversation => ({
  id,
  updated: new Date(now.getTime() - 3_600_000),
  machine: 'lft',
  typedHere: false,
  title: `t ${id.slice(0, 4)}`,
  mail: false,
  topic: null,
  bornClear: false,
  typed: 3,
  finished: false,
  ...over,
});
const board = (agents: AgentFact[], conversations: Conversation[] = [], extra = {}) =>
  buildBoard({
    project: 'proj',
    host: 'm3',
    seat: 'm3',
    agents,
    conversations,
    total: conversations.length + agents.length,
    machineOf: (c) => c.machine,
    now,
    ...extra,
  });

describe('inputDraft: what the person typed and did not send', () => {
  it("counts the text after the prompt sign; Claude Code's dim suggestion is not the person's", () => {
    expect(inputDraft(screen('go on with the crystal'))).toBe(22);
    expect(inputDraft(screen('\x1b[2mTry "refactor index.html"\x1b[0m'))).toBe(0);
    expect(inputDraft(screen(''))).toBe(0);
  });

  it('a draft over several lines; no input line on screen — none', () => {
    const two = ['x', rule, '\x1b[39m❯\xa0first line', '  second', rule].join('\n');
    expect(inputDraft(two)).toBe('first line second'.length);
    expect(inputDraft('just output\nno rules')).toBe(0);
    expect(inputDraft(null)).toBe(0);
  });
});

describe('agentState', () => {
  it('working and waiting from Claude Code, then a draft, an empty pane, a wrapped one', () => {
    expect(agentState(agent({ status: 'busy', draft: 5 }))).toBe('working');
    expect(agentState(agent({ status: 'shell' }))).toBe('working');
    expect(agentState(agent({ status: 'waiting' }))).toBe('waiting');
    expect(agentState(agent({ draft: 5, empty: true }))).toBe('draft');
    expect(agentState(agent({ empty: true }))).toBe('empty');
    expect(agentState(agent({ finished: true }))).toBe('finished');
    expect(agentState(agent())).toBe('idle');
  });
});

describe('buildBoard: one list, Enter marked', () => {
  it('Enter never takes an agent a terminal at this seat shows already (DL #2)', () => {
    const b = board([
      agent({ session: 'proj@m3', openAt: ['m3'], activeAt: now.getTime() }),
      agent({ session: 'proj@m3-2', pid: 101, conversation: ID.b, focused: true, topic: 'search' }),
    ]);
    expect(b.enter).toBe(1);
    expect(b.lines.join('\n')).toContain('open here');
    expect(b.lines.join('\n')).toContain('focused «search»');
  });

  it('…nor a wrapped or empty one while a conversation is cut off; then an empty pane; then a new one', () => {
    const wrapped = agent({ finished: true });
    const empty = agent({ session: 'proj@m3-2', pid: 101, conversation: ID.b, empty: true });
    expect(board([wrapped, empty], [conv(ID.c)]).rows[board([wrapped, empty], [conv(ID.c)]).enter as number]).toEqual({
      kind: 'conversation',
      conversation: conv(ID.c),
      machine: 'lft',
    });
    const b = board([wrapped, empty], [conv(ID.c, { finished: true })]);
    expect(b.rows[b.enter as number]).toEqual({ kind: 'agent', agent: empty });
    expect(board([wrapped], [conv(ID.c, { finished: true })]).enter).toBe('new');
  });

  it('says how many there are and how many it shows; `a` shows the rest', () => {
    const many = [
      ID.a,
      ID.b,
      ID.c,
      ID.d,
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ].map((id) => conv(id));
    const b = buildBoard({
      project: 'proj',
      host: 'm3',
      seat: 'm3',
      agents: [],
      conversations: many,
      total: 54,
      machineOf: (c) => c.machine,
      now,
    });
    expect(b.lines[0]).toBe('proj — 0 running, 54 conversations (5 shown)');
    expect(b.lines.at(-1)).toContain('a all (1 more)');
    expect(b.rows).toHaveLength(5);
  });

  it("leaves out an empty conversation and the running ones'; one of no known machine is marked", () => {
    const b = board(
      [agent({ conversation: ID.a })],
      [conv(ID.a), conv(ID.b, { machine: null }), conv(ID.c, { bornClear: true, typed: 0 }), conv(ID.d)],
    );
    expect(b.rows.map((r) => (r.kind === 'conversation' ? r.conversation.id : r.kind))).toEqual(['agent', ID.b, ID.d]);
    expect(b.lines.join('\n')).toMatch(/\? .*bbbbbbbb {2}cut off, machine unknown/);
  });

  it('a conversation whose copy here is behind continues on its machine, and the list says so', () => {
    const b = board([], [conv(ID.a, { machine: 'm3' })], { behind: new Map([[ID.a, 'lft']]) });
    expect(b.rows[0]).toMatchObject({ kind: 'conversation', machine: 'lft' });
    expect(b.lines.join('\n')).toContain('not here yet from lft');
  });

  it('the mail session is a line, not a row', () => {
    const b = board([agent({ mail: true, session: 'proj@m3-mail' }), agent({ pid: 2, conversation: ID.b })]);
    expect(b.rows).toHaveLength(1);
    expect(b.lines.join('\n')).toContain('the mail session');
  });
});

describe('readAnswer', () => {
  it('Enter is the marked row; a number, n, f, a', () => {
    const b = board([agent()], [conv(ID.b)]);
    expect(readAnswer('', b)).toEqual(b.rows[0]);
    expect(readAnswer('2', b)).toEqual(b.rows[1]);
    expect(readAnswer('n', b)).toEqual({ kind: 'new', focused: false });
    expect(readAnswer('f', b)).toEqual({ kind: 'new', focused: true });
    expect(readAnswer('a', b)).toEqual({ kind: 'all' });
    expect(readAnswer('9', b)).toBeNull();
  });
});
