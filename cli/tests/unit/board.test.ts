import { describe, expect, it } from 'vitest';
import {
  type AgentFact,
  agentState,
  buildBoard,
  cells,
  clip,
  enterKey,
  inputDraft,
  readAnswer,
  readPicked,
  stateIcon,
} from '../../src/board.ts';
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
  hq: false,
  topic: null,
  bornClear: false,
  typed: 3,
  finished: false,
  automated: false,
  ...over,
});
const board = (agents: AgentFact[], conversations: Conversation[] = [], extra = {}) =>
  buildBoard({
    project: 'proj',
    host: 'm3',
    seat: 'm3',
    agents,
    conversations,
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
    expect(b.lines.join('\n')).toContain('open on m3 (here)');
    expect(board([agent({ openAt: ['m3', 'lft'] })]).lines.join('\n')).toContain('open on m3 (here), lft');
    expect(board([agent({ openAt: ['lft', '?'] })]).lines.join('\n')).toContain('open on lft, another machine');
    // Enter's row has the arrow the keys line names; the other has none.
    expect(b.lines.filter((l) => l.startsWith('→'))).toEqual(['→ 2  proj@m3-2  💤 idle  🎯  Work']);
    expect(b.lines.at(-1)).toContain('Enter → 2');
  });

  it('…nor a wrapped or empty one while a conversation is unfinished; then an empty pane; then a new one', () => {
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

  it('a conversation left after a look says so, and Enter passes it by like a wrapped one (Sidetrack #18)', () => {
    const b = board([], [conv(ID.a, { leftAfterLook: true }), conv(ID.b)]);
    expect(b.lines.join('\n')).toContain('left after a look  t aaaa');
    expect(b.rows[b.enter as number]).toEqual({ kind: 'conversation', conversation: conv(ID.b), machine: 'lft' });
    expect(board([], [conv(ID.a, { leftAfterLook: true })]).enter).toBe('new');
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
      machineOf: (c) => c.machine,
      now,
    });
    expect(b.lines.slice(0, 5)).toEqual([
      'proj',
      '',
      'nothing runs now',
      '',
      'CONVERSATIONS NOBODY RUNS · 5 newest of 6',
    ]);
    expect(b.lines.at(-1)).toContain('a all (1 more)');
    // Some not read: how many there are is a bound.
    const unread = buildBoard({
      project: 'proj',
      host: 'm3',
      seat: 'm3',
      agents: [],
      conversations: many,
      unread: 3,
      machineOf: (c) => c.machine,
      now,
    });
    expect(unread.lines[4]).toBe('CONVERSATIONS NOBODY RUNS · 5 newest of up to 9');
    expect(unread.lines.at(-1)).toContain('a all (up to 4 more)');
    expect(b.rows).toHaveLength(5);
  });

  it("leaves out an empty conversation and the running ones'; one of no known machine is marked", () => {
    const b = board(
      [agent({ conversation: ID.a })],
      [conv(ID.a), conv(ID.b, { machine: null }), conv(ID.c, { bornClear: true, typed: 0 }), conv(ID.d)],
    );
    expect(b.rows.map((r) => (r.kind === 'conversation' ? r.conversation.id : r.kind))).toEqual(['agent', ID.b, ID.d]);
    expect(b.lines.slice(5)).toEqual([
      'CONVERSATIONS NOBODY RUNS · 2',
      '  2  ?    today 11:00  unfinished, machine unknown  t bbbb',
      '  3  lft  today 11:00  unfinished  t dddd',
      '',
      '  Enter → 1 · /<phrase> find · n new · f new focused',
    ]);
  });

  it('a conversation whose copy here is behind continues on its machine, and the list says so', () => {
    const b = board([], [conv(ID.a, { machine: 'm3' })], { behind: new Map([[ID.a, 'lft']]) });
    expect(b.rows[0]).toMatchObject({ kind: 'conversation', machine: 'lft' });
    expect(b.lines.join('\n')).toContain('not here yet from lft');
  });

  it('the intercom session is a line, not a row', () => {
    const b = board([agent({ mail: true, session: 'proj@m3-intercom' }), agent({ pid: 2, conversation: ID.b })]);
    expect(b.rows).toHaveLength(1);
    expect(b.lines.slice(2)).toEqual([
      'RUNNING NOW · 1',
      '→ 1  proj@m3           💤 idle      Work',
      '',
      'INTERCOM SESSION',
      '     proj@m3-intercom  💤 idle  📬  not yours to attach',
      '',
      '  Enter → 1 · /<phrase> find · n new · f new focused',
    ]);
  });
});

describe('the marks of the cmux sidebar on the list (vdx-ai-predictable Sidetrack #4)', () => {
  const day = 86_400_000;
  it('each state has the mark the sidebar shows for it; a draft — the one its age gives', () => {
    expect(stateIcon(agent({ status: 'busy' }), now)).toBe('⏳');
    expect(stateIcon(agent({ status: 'shell' }), now)).toBe('⏳');
    expect(stateIcon(agent({ status: 'waiting' }), now)).toBe('✋');
    expect(stateIcon(agent({ finished: true }), now)).toBe('✅');
    // Empty and finished keep their mark however long they wait (the owner's rule, 2026-11-04).
    expect(stateIcon(agent({ empty: true, activeAt: now.getTime() - 6 * day }), now)).toBe('🆕');
    expect(stateIcon(agent({ finished: true, activeAt: now.getTime() - 6 * day }), now)).toBe('✅');
    expect(stateIcon(agent(), now)).toBe('💤');
    expect(stateIcon(agent({ activeAt: now.getTime() - day }), now)).toBe('🕸️');
    expect(stateIcon(agent({ draft: 12, activeAt: now.getTime() - 2 * day }), now)).toBe('🕸️');
    expect(stateIcon(agent({ draft: 12, empty: true }), now)).toBe('🆕');
    expect(stateIcon(agent({ activeAt: null }), now)).toBe('💤');
  });

  it('the mode marks follow the state, as in the sidebar; a finished conversation nobody runs is ✅', () => {
    const text = board(
      [
        agent({ focused: true, topic: 'search', status: 'busy' }),
        agent({ session: 'proj@m3-intercom', pid: 101, mail: true }),
        agent({ session: 'proj@m3-hq', pid: 102, hq: true, empty: true }),
      ],
      [conv(ID.b, { finished: true }), conv(ID.c)],
    ).lines;
    // Each group under its title, the state and the mode in columns of their own (Sidetrack #15).
    expect(text.slice(2, -2)).toEqual([
      'RUNNING NOW · 1',
      '→ 1  proj@m3           ⏳ working  🎯  Work',
      '',
      'HQ AND INTERCOM SESSIONS',
      '     proj@m3-intercom  💤 idle     📬  not yours to attach',
      '  2  proj@m3-hq        🆕 empty    👑',
      '',
      'CONVERSATIONS NOBODY RUNS · 2',
      '  3  lft  today 11:00  ✅ finished    t bbbb',
      '  4  lft  today 11:00     unfinished  t cccc',
    ]);
    // A focused session with no topic says so.
    expect(board([agent({ focused: true })]).lines[3]).toBe('→ 1  proj@m3  💤 idle  🎯  Work (no topic)');
  });

  it('one caption on a row: the title, and the topic of one with no title', () => {
    const titled = agent({ focused: true, topic: 'search' });
    expect(board([titled]).lines[3]).toBe('→ 1  proj@m3  💤 idle  🎯  Work');
    expect(board([{ ...titled, title: null }]).lines[3]).toBe('→ 1  proj@m3  💤 idle  🎯  search');
  });

  it('a focused conversation nobody runs shows its mode and its last topic; no id on the row', () => {
    const text = board(
      [],
      [conv(ID.b, { topic: 'sidebar marks', finished: true }), conv(ID.c, { topic: 'search', title: null })],
    ).lines.join('\n');
    expect(text).toContain('  1  lft  today 11:00  ✅ finished    🎯  t bbbb');
    expect(text).toContain('→ 2  lft  today 11:00     unfinished  🎯  search');
    expect(text).not.toMatch(/bbbbbbbb|cccccccc/);
  });

  // The owner, 2026-11-11: «яркие иконки в начале - супер. Но нихрена не ясно какая реально сейчас работает».
  it("a machine's mark stands only before what runs now, which is named as the sidebar names it (Sidetrack #11)", () => {
    const icons = { M3: '🔹', lft: '🟢' };
    const b = board(
      [
        agent({ focused: true, topic: 'cmux' }),
        agent({ machine: 'lft', session: 'proj@lft-2', pid: 200, conversation: ID.d }),
        agent({
          machine: 'other',
          session: 'proj@other',
          pid: 300,
          conversation: '55555555-5555-4555-8555-555555555555',
        }),
      ],
      [conv(ID.b), conv(ID.c, { machine: null })],
      { machineIcons: icons },
    );
    // The first line says once which mark is which machine — of the machines something runs on.
    expect(b.lines).toEqual([
      'proj   runs on: 🔹 m3 · 🟢 lft',
      '',
      'RUNNING NOW · 3',
      '→ 1  🔹 proj     💤 idle  🎯  Work',
      '  2  🟢 proj-2   💤 idle      Work',
      '  3  proj@other  💤 idle      Work',
      '',
      'CONVERSATIONS NOBODY RUNS · 2',
      '  4  lft  today 11:00  unfinished  t bbbb',
      '  5  ?    today 11:00  unfinished, machine unknown  t cccc',
      '',
      '  Enter → 1 · /<phrase> find · n new · f new focused',
    ]);
    // No marks in the profile: the session's whole name says the machine; one with no tmux, its pid.
    expect(board([agent()]).lines.slice(0, 4)).toEqual(['proj', '', 'RUNNING NOW · 1', '→ 1  proj@m3  💤 idle  Work']);
    expect(board([agent({ session: null })]).lines[3]).toBe('→ 1  pid 100 on m3  💤 idle  Work');
  });
});

// The owner, 2026-11-05 (nas-info): «I would expect to reach the HQ through vdx ai without --hq too;
// the flag should only narrow the choice».
describe('buildBoard: the HQ session', () => {
  it("is a row with a number after the person's agents, in the count; Enter does not go to it", () => {
    const b = board([
      agent({ hq: true, session: 'proj@m3-hq', status: 'busy', activeAt: now.getTime() }),
      agent({ pid: 2, conversation: ID.b }),
    ]);
    expect(b.rows.map((r) => r.kind === 'agent' && r.agent.session)).toEqual(['proj@m3', 'proj@m3-hq']);
    expect(b.lines.slice(2, 7)).toEqual([
      'RUNNING NOW · 1',
      '→ 1  proj@m3     💤 idle         Work',
      '',
      'HQ SESSION',
      '  2  proj@m3-hq  ⏳ working  👑',
    ]);
    expect(b.enter).toBe(0);
    // Alone, empty or with work in it, it is still not Enter's.
    expect(board([agent({ hq: true, session: 'proj@m3-hq', status: 'busy' })]).enter).toBe('new');
    expect(board([agent({ hq: true, session: 'proj@m3-hq', empty: true })]).enter).toBe('new');
  });

  it('on another machine, a row too; a terminal showing it is said', () => {
    const b = board([agent({ machine: 'lft', hq: true, session: 'proj@lft-hq', openAt: ['m3'] })]);
    expect(b.rows).toHaveLength(1);
    expect(b.lines.slice(2, 4)).toEqual(['HQ SESSION', '  1  proj@lft-hq  💤 idle  👑  open on m3 (here)']);
  });
});

describe('buildBoard: what a search found (vdx-ai-predictable P5)', () => {
  const around = new Map([
    [ID.a, 'you: «where is the needle?»'],
    [ID.c, 'agent: «the needle is here» (2 replies have it)'],
  ]);
  const find = { phrase: 'the  needle', searched: 29, around };

  it('every row it found, the text under it; Enter — the first a terminal here does not show, wrapped too', () => {
    const b = board([agent({ openAt: ['m3'] })], [conv(ID.c, { finished: true })], { find });
    const text = b.lines.join('\n');
    expect(b.lines[0]).toBe('proj — «the needle» in 2 of 29 conversations');
    expect(text).toContain('  1  proj@m3  💤 idle  Work · open on m3 (here)\n       you: «where is the needle?»');
    expect(text).toContain(
      '→ 2  lft  today 11:00  ✅ finished  t cccc\n       agent: «the needle is here» (2 replies have it)',
    );
    expect(b.enter).toBe(1);
    expect(b.lines.at(-1)).toBe('  Enter → 2 · a the whole list · /<phrase> another search · n new · f new focused');
  });

  it('nobody asked: the command under each row, no keys', () => {
    const b = board([], [conv(ID.c)], {
      find,
      reach: (p: { kind: string }) => (p.kind === 'conversation' ? `vdx ai@lft x --conversation ${ID.c}` : null),
    });
    expect(b.lines.slice(1)).toEqual([
      '',
      'CONVERSATIONS NOBODY RUNS · 1',
      '  1  lft  today 11:00  unfinished  t cccc',
      '       agent: «the needle is here» (2 replies have it)',
      `       vdx ai@lft x --conversation ${ID.c}`,
    ]);
  });

  it('at a terminal: titles bold, the lines under a row dim; nowhere else an escape', () => {
    const reach = () => 'vdx ai x';
    const plain = board([agent()], [], { reach }).lines;
    const painted = board([agent()], [], { reach, color: true }).lines;
    expect(plain.join('\n')).not.toContain('\x1b');
    expect(painted).toEqual([
      '\x1b[1mproj\x1b[22m',
      '',
      '\x1b[1mRUNNING NOW · 1\x1b[22m',
      '  1  proj@m3  💤 idle  Work',
      '\x1b[2m       vdx ai x\x1b[22m',
    ]);
  });

  it('a copy here behind its machine: the search says its latest part was not searched', () => {
    const b = board([], [conv(ID.c)], { find, behind: new Map([[ID.b, 'lft']]) });
    expect(b.lines.join('\n')).toContain(
      'note: 1 conversation not here yet from another machine (sync behind) — its latest part is not searched',
    );
  });
});

describe('readAnswer', () => {
  it('Enter is the marked row; a number, n, f, a, /<phrase>', () => {
    const b = board([agent()], [conv(ID.b)]);
    expect(readAnswer('', b)).toEqual(b.rows[0]);
    expect(readAnswer('2', b)).toEqual(b.rows[1]);
    expect(readAnswer('n', b)).toEqual({ kind: 'new', focused: false });
    expect(readAnswer('f', b)).toEqual({ kind: 'new', focused: true });
    expect(readAnswer('a', b)).toEqual({ kind: 'all' });
    expect(readAnswer('/ 17 незаявленных ', b)).toEqual({ kind: 'find', phrase: '17 незаявленных' });
    expect(readAnswer('/', b)).toBeNull();
    expect(readAnswer('9', b)).toBeNull();
    expect(b.lines.at(-1)).toContain('/<phrase> find');
  });
});

describe('buildBoard: after tmux fell, r brings back what it took down (DL #9)', () => {
  it('Enter is r; r is a key of its own; the rows stay as they are', () => {
    const b = board([agent()], [conv(ID.b)], { restore: 3 });
    expect(b.enter).toBe('restore');
    expect(enterKey(b)).toBe('r');
    expect(readAnswer('', b)).toEqual({ kind: 'restore' });
    expect(readAnswer('R', b)).toEqual({ kind: 'restore' });
    expect(readAnswer('1', b)).toEqual(b.rows[0]);
    expect(b.lines.at(-1)).toBe(
      '  Enter → r · r bring back the 3 agents tmux took down · /<phrase> find · n new · f new focused',
    );
    expect(board([], [], { restore: 1 }).lines.at(-1)).toContain('r bring back the agent tmux took down');
  });

  it('nothing taken down: r is no answer, and Enter is what it was', () => {
    const b = board([agent()], [conv(ID.b)]);
    expect(readAnswer('r', b)).toBeNull();
    expect(enterKey(b)).toBe('1');
    expect(enterKey(board([], []))).toBe('n');
    expect(b.lines.at(-1)).not.toContain(' r ');
  });

  it('a search asked for: Enter takes what it found, r still brings them back', () => {
    const find = { phrase: 'x', searched: 2, around: new Map<string, string>() };
    const b = board([], [conv(ID.c)], { restore: 2, find });
    expect(b.enter).toBe(0);
    expect(readAnswer('r', b)).toEqual({ kind: 'restore' });
  });
});

// The owner, 2026-11-12: «заголовок есть "running now" но элементы идут ниже с тем же отступом» (Sidetrack #15).
describe('buildBoard: rows in columns', () => {
  it('numbers of one and two digits end in one column', () => {
    const ten = Array.from({ length: 10 }, (_, i) =>
      agent({ pid: i, session: `proj@m3-${i}`, conversation: null, activeAt: now.getTime() - i * 1000 }),
    );
    const lines = board(ten, [conv(ID.b)]).lines;
    expect(lines.slice(3, 5)).toEqual(['→  1  proj@m3-0  💤 idle  Work', '   2  proj@m3-1  💤 idle  Work']);
    expect(lines[12]).toBe('  10  proj@m3-9  💤 idle  Work');
    expect(lines[15]).toBe('  11  lft  today 11:00  unfinished  t bbbb');
  });

  it('a column is counted in terminal cells: an emoji two, its variation selector none', () => {
    expect(cells('idle')).toBe(4);
    expect(cells('💤')).toBe(2);
    expect(cells('🕸️')).toBe(2);
    expect(cells('⏳ тема')).toBe(7);
    const day = 86_400_000;
    const lines = board([
      agent({ activeAt: now.getTime() - day }),
      agent({ pid: 2, session: 'proj@m3-2', conversation: ID.b }),
    ]).lines;
    expect(lines.slice(3, 5)).toEqual(['→ 1  proj@m3-2  💤 idle      Work', '  2  proj@m3    🕸️ idle 1 d  Work']);
  });

  it('a caption is cut to the terminal with …, the terminal showing it stays; no width known — 60 cells', () => {
    expect(clip('  one\n two ', 20)).toBe('one two');
    expect(clip('abcdefgh', 5)).toBe('abcd…');
    const long = 'A very long title of a conversation that does not fit into a narrow terminal at all';
    const row = (extra: object) => board([agent({ title: long, openAt: ['m3'] })], [], extra).lines[3]!;
    expect(row({ columns: 60 })).toBe('  1  proj@m3  💤 idle  A very long titl… · open on m3 (here)');
    expect(cells(row({ columns: 60 }))).toBeLessThanOrEqual(60);
    expect(row({})).toBe(
      '  1  proj@m3  💤 idle  A very long title of a conversation that does not fit into… · open on m3 (here)',
    );
  });

  it('notes of the start come under the list, before the keys', () => {
    const lines = board([agent()], [], { silent: ['lft'], footnotes: ['2 agents of other projects went down'] }).lines;
    expect(lines.slice(-5)).toEqual([
      '',
      '  note: lft does not answer over ssh — what runs there is not known',
      '  note: 2 agents of other projects went down',
      '',
      '  Enter → 1 · /<phrase> find · n new · f new focused',
    ]);
  });
});

// The owner, 2026-11-12: «Можно же сделать классный вывод реально удобный и понятный + заодно gui будет?»
describe('buildBoard: the same list for a picker with a cursor (Sidetrack #15)', () => {
  const command = (p: { kind: string }) => (p.kind === 'conversation' ? `vdx ai@lft x --conversation ${ID.b}` : null);
  const b = board(
    [agent({ openAt: ['m3'], focused: true, topic: 'the  topic\nwhole' })],
    [conv(ID.b, { topic: 'search' }), ...[ID.c, ID.d, '1', '2', '3'].map((id) => conv(id))],
    { command },
  );

  it("titles and rows without numbers; all, new and new focused are rows; the cursor starts on Enter's", () => {
    expect(b.picker.items.map((i) => i.text)).toEqual([
      'RUNNING NOW · 1',
      '  proj@m3  💤 idle  🎯  Work · open on m3 (here)',
      'CONVERSATIONS NOBODY RUNS · 5 newest of 6',
      '  lft  today 11:00  unfinished  🎯  t bbbb',
      '  lft  today 11:00  unfinished      t cccc',
      '  lft  today 11:00  unfinished      t dddd',
      '  lft  today 11:00  unfinished      t 1',
      '  lft  today 11:00  unfinished      t 2',
      '  … all conversations (1 more)',
      '+ new conversation',
      '+ new focused conversation',
    ]);
    // Enter in the list is row 2 — the newest conversation unfinished: the cursor is on it.
    expect(enterKey(b)).toBe('2');
    expect(b.picker.cursor).toBe(3);
    expect(b.picker.header).toEqual([
      'proj',
      "Enter takes the row · ctrl-s searches what was said for the typed words · ctrl-y prints the row's command · Esc leaves",
    ]);
    // Nothing to continue: the cursor is on the new conversation.
    const none = board([], []);
    expect(none.picker.items[none.picker.cursor]!.text).toBe('+ new conversation');
    expect(none.picker.header).toContain('nothing runs now');
  });

  it("a picker's row is cut to the width the picker leaves it, the list's — to the terminal's", () => {
    const long = 'A very long title of a conversation that does not fit into a narrow terminal at all';
    const wide = board([agent({ title: long })], [], { columns: 120, pickerColumns: 50 });
    expect(wide.picker.items[1]!.text).toBe('  proj@m3  💤 idle  A very long title of a conver…');
    expect(cells(wide.picker.items[1]!.text)).toBe(50);
    expect(wide.lines[3]).toBe(`→ 1  proj@m3  💤 idle  ${long}`);
  });

  // The owner, 2026-11-12, on the first panel: «огонь, но воспринимается как месиво текста» — it was a
  // run of `label: value` lines with a blank line after each.
  it("a row's panel is a card: the title, the topic under its label, the short facts beside theirs, the command last", () => {
    expect(b.picker.items[1]!.detail).toEqual([
      'Work',
      '',
      'TOPIC',
      'the topic whole',
      '',
      'STATE     idle, focused',
      'SESSION   proj@m3',
      'RUNS ON   m3',
      'OPEN ON   m3 (here)',
      `ID        ${ID.a}`,
      '',
    ]);
    expect(b.picker.items[3]!.detail).toEqual([
      't bbbb',
      '',
      'TOPIC',
      'search',
      '',
      'STATE     unfinished',
      'LAST ON   lft',
      'WHEN      today 11:00',
      `ID        ${ID.b}`,
      '',
      'COMMAND',
      `vdx ai@lft x --conversation ${ID.b}`,
      '',
    ]);
    expect(b.picker.items[0]!.detail).toEqual([]);
    // No terminal shows it, no topic: said, and left out.
    const bare = board([agent({ title: null })], []).picker.items[1]!.detail;
    expect(bare).toContain("OPEN ON   nobody's terminal");
    expect(bare[0]).toBe('(no title yet)');
    expect(bare).not.toContain('TOPIC');
    // At a terminal the title is bold and the labels dim.
    const painted = board([agent()], [], { color: true }).picker.items[1]!.detail;
    expect(painted[0]).toBe('\x1b[1mWork\x1b[22m');
    expect(painted).toContain('\x1b[2mSTATE     \x1b[22midle');
  });

  it('Enter on a row is its pick; on a title — nothing; ctrl-s searches for the typed phrase', () => {
    const on = (index: number | null, key = '', query = '') => readPicked({ key, index, query }, b);
    expect(on(1)).toEqual(b.rows[0]);
    expect(on(3)).toEqual(b.rows[1]);
    expect(on(0)).toBeNull();
    expect(on(null)).toBeNull();
    expect(on(8)).toEqual({ kind: 'all' });
    expect(on(9)).toEqual({ kind: 'new', focused: false });
    expect(on(10)).toEqual({ kind: 'new', focused: true });
    expect(on(3, 'ctrl-s', ' 17 незаявленных ')).toEqual({ kind: 'find', phrase: '17 незаявленных' });
    expect(on(3, 'ctrl-s', '  ')).toBeNull();
    // Another key that ended the picker is not a choice of the row: the command key is the start's.
    expect(on(3, 'ctrl-y')).toBeNull();
  });

  it('after tmux fell: bringing back is the first row, under the cursor, with who went down in its panel', () => {
    const fell = board([agent()], [conv(ID.b)], {
      restore: 2,
      restoreDetail: ['⚠ tmux here was started again', '  proj-2'],
    });
    expect(fell.picker.cursor).toBe(0);
    expect(fell.picker.items[0]).toEqual({
      text: '▶ bring back the 2 agents tmux took down',
      pick: { kind: 'restore' },
      detail: ['⚠ tmux here was started again', '  proj-2'],
    });
    expect(board([agent()], []).picker.items.map((i) => i.pick?.kind)).not.toContain('restore');
  });

  it('what a search found: the whole list is a row, the found text is in the panel', () => {
    const find = { phrase: 'needle', searched: 9, around: new Map([[ID.c, 'you: «the needle»']]) };
    const found = board([], [conv(ID.c)], { find });
    expect(found.picker.items.map((i) => i.text)).toEqual([
      'CONVERSATIONS NOBODY RUNS · 1',
      '  lft  today 11:00  unfinished  t cccc',
      '  … the whole list',
      '+ new conversation',
      '+ new focused conversation',
    ]);
    expect(found.picker.items[1]!.detail.slice(-3)).toEqual(['FOUND', 'you: «the needle»', '']);
    expect(found.picker.header[0]).toBe('proj — «needle» in 1 of 9 conversations');
  });
});
