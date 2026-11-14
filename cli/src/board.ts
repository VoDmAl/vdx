import { type Conversation, describeAge, isEmpty } from './conversations.ts';

/**
 * The one list `vdx ai` shows when a start is not plain (vdx-ai-predictable): the project's
 * agents running on every machine, then its conversations nobody runs — each group under its
 * title, its rows in columns: the machine, the state, the mode, one caption; the row Enter takes
 * has an arrow. Before it, one line said which
 * agent ran here, another which conversations there were, and a start could attach to an
 * agent a terminal at the same seat already showed.
 *
 * Only the facts and the choice live here; gathering them (tmux, ssh, the session files) is
 * ai.ts's.
 */

/** A running agent of the project, here or on another machine. */
export interface AgentFact {
  /** The machine it runs on. */
  machine: string;
  /** Its tmux session; null — it runs in a terminal of its own. */
  session: string | null;
  pid: number;
  conversation: string | null;
  /** Claude Code's word for it (its session file): `busy`, `idle`, `waiting`, `shell`. */
  status: string | null;
  /** When that word last changed, ms; null — not known. */
  activeAt: number | null;
  /** Characters the person typed into its input line and has not sent. */
  draft: number;
  focused: boolean;
  topic: string | null;
  mail: boolean;
  /** The project's HQ session (`vdx ai --hq`); a vdx there older than it does not say. */
  hq?: boolean;
  /** The seats whose terminals show its session: machine labels; `?` — another machine, which not known. */
  openAt: string[];
  title: string | null;
  /** Nothing typed in it since /clear. */
  empty: boolean;
  /** A wrap ran in it and nothing was typed since. */
  finished: boolean;
}

export type AgentState = 'working' | 'waiting' | 'draft' | 'empty' | 'finished' | 'idle';

export function agentState(a: AgentFact): AgentState {
  if (a.status === 'busy' || a.status === 'shell') return 'working';
  if (a.status === 'waiting') return 'waiting';
  if (a.draft > 0) return 'draft';
  return settledState(a) ?? 'idle';
}

/**
 * What its transcript says of a quiet agent: empty since /clear, or finished with a wrap; null —
 * neither. The same word goes into the tmux option `@vdx_state`, which the cmux sidebar shows
 * (vdx-ai-predictable Sidetrack #4): one definition for the list and the sidebar.
 */
export function settledState(a: { empty: boolean; finished: boolean }): 'empty' | 'finished' | null {
  if (a.empty) return 'empty';
  if (a.finished) return 'finished';
  return null;
}

/** An agent with work in it — not a pane waiting for its first prompt, not a wrapped one. */
function hasWork(a: AgentFact): boolean {
  const s = agentState(a);
  return s !== 'empty' && s !== 'finished';
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A terminal at the person's seat shows it already. */
export function openAtSeat(a: AgentFact, seat: string): boolean {
  return a.openAt.some((s) => same(s, seat));
}

/** Work in it, and no terminal at the seat shows it: what Enter goes to first. */
export function freeWork(a: AgentFact, seat: string): boolean {
  return !openAtSeat(a, seat) && hasWork(a);
}

const ESC = String.fromCharCode(27);
/** A dim stretch, to the escape that ends it or the line's end. */
const DIM_RE = new RegExp(`${ESC}\\[2m.*?(${ESC}\\[(0|22)m|$)`, 'g');
const SGR_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

/**
 * The characters typed into Claude Code's input line and not sent, from the pane's screen
 * with its escapes (`capture-pane -e`): the lines between the last two rules, the prompt
 * sign dropped. A suggestion Claude Code puts there is dim (`ESC[2m`) and is not the
 * person's: it is left out. 0 — the line is empty, or no input line is on the screen.
 */
export function inputDraft(screen: string | null): number {
  if (!screen) return 0;
  const plain = screen.split('\n').map((l) => l.replace(DIM_RE, '').replace(SGR_RE, ''));
  const rules = plain.flatMap((l, i) => (/^─{8,}\s*$/.test(l.trim()) ? [i] : []));
  if (rules.length < 2) return 0;
  const box = plain.slice(rules[rules.length - 2]! + 1, rules[rules.length - 1]);
  return box
    .join('\n')
    .replace(/^\s*[❯>]/, '')
    .replace(/\s+/g, ' ')
    .trim().length;
}

export type Pick =
  | { kind: 'agent'; agent: AgentFact }
  | { kind: 'conversation'; conversation: Conversation; machine: string | null }
  | { kind: 'new'; focused: boolean }
  | { kind: 'all' }
  | { kind: 'find'; phrase: string }
  | { kind: 'restore' };

export interface BoardInput {
  project: string;
  /** The machine vdx runs on. */
  host: string;
  /** The machine the person sits at. */
  seat: string;
  agents: AgentFact[];
  /** The project's conversations as read here, newest first, the intercom session's left out. */
  conversations: Conversation[];
  /** How many of them were not read: some may be the intercom session's or empty ones. */
  unread?: number;
  machineOf: (c: Conversation) => string | null;
  /** Conversations whose copy here is behind the machine that writes them: id → that machine. */
  behind?: Map<string, string>;
  /** Machines that did not answer: what runs there is not known. */
  silent?: string[];
  /** How many conversations nobody runs to show; `all` — every one. */
  limit?: number | 'all';
  /**
   * A search (`/<phrase>`, `--find`): the agents and conversations given are what it found, all
   * shown; under each row, the text around the phrase, by conversation id. `searched` — how many
   * conversations it read.
   */
  find?: { phrase: string; searched: number; around: Map<string, string> };
  /** Nobody is asked: under each row the command that reaches it, and no keys. */
  reach?: (p: Pick) => string | null;
  /** The command that reaches a row, for the picker's panel: the person is asked, and may want it for another terminal. */
  command?: (p: Pick) => string | null;
  /**
   * How many agents a fallen tmux server took down that `r` brings back (vdx-ai-predictable P6):
   * then Enter is `r`, unless a search was asked for.
   */
  restore?: number;
  /** The profile's `session.machine_icons`: a machine's mark before its label, as the cmux sidebar shows it. */
  machineIcons?: Record<string, string>;
  /** Lines the start adds under the list, each said as a note: what tmux took down of other projects. */
  footnotes?: string[];
  /** Who `r` brings back, as the start says it above the list: the panel of that row in the picker. */
  restoreDetail?: string[];
  /** The list goes to a terminal: group titles bold, the lines under a row dim. */
  color?: boolean;
  /** The terminal's width: a caption is cut so its row stays one line. Not known — 60 cells a caption. */
  columns?: number;
  /** The width the picker leaves its rows, beside its panel; not given — the terminal's. */
  pickerColumns?: number;
  now?: Date;
}

export interface Board {
  lines: string[];
  rows: Pick[];
  /** The row Enter takes (index into rows), the new conversation, or bringing back what tmux took down. */
  enter: number | 'new' | 'restore';
  /** What `r` brings back; 0 — nothing, no such key. */
  restore: number;
  /** The list for a picker with a cursor (picker.ts): its header, its rows, where the cursor starts. */
  picker: { header: string[]; items: PickerItem[]; cursor: number };
}

/** A row of the picker: a group's title takes nothing; `new`, `all` and `restore` are rows too. */
interface PickerItem {
  text: string;
  pick: Pick | null;
  /** The panel beside the list while the cursor is on the row. */
  detail: string[];
}

const SHOWN = 5;

/** The order of running agents: the last active first. */
function byActivity(a: AgentFact, b: AgentFact): number {
  return (b.activeAt ?? 0) - (a.activeAt ?? 0);
}

function stateWord(a: AgentFact, now: Date): string {
  const s = agentState(a);
  if (s === 'draft') return `draft (${a.draft} chars)`;
  if (s === 'idle' && a.activeAt !== null) {
    const days = Math.floor((now.getTime() - a.activeAt) / 86_400_000);
    if (days >= 1) return `idle ${days} d`;
  }
  return s;
}

/**
 * The mark the cmux sidebar shows for an agent in this state (nas-info's header; the icons the owner
 * chose, vdx-ai-predictable Sidetrack #4): ⏳ working, ✋ waiting, ✅ finished, 🆕 empty, 🕸️ idle a day
 * or more, 💤 idle. A draft has no mark there: its row gets the one its age gives. 🔔 — a turn ended
 * that nobody saw — the list does not know; it says which terminal shows the agent instead.
 */
export function stateIcon(a: AgentFact, now: Date): string {
  const s = agentState(a);
  if (s === 'working') return '⏳';
  if (s === 'waiting') return '✋';
  const settled = settledState(a);
  if (settled === 'finished') return '✅';
  if (settled === 'empty') return '🆕';
  return a.activeAt !== null && now.getTime() - a.activeAt >= 86_400_000 ? '🕸️' : '💤';
}

/** The sidebar's mark of how the agent was started: 🎯 focused, 📬 the intercom session, 👑 the HQ session. */
function modeIcon(a: { focused?: boolean; mail?: boolean; hq?: boolean }): string {
  return a.focused ? '🎯' : a.mail ? '📬' : a.hq ? '👑' : '';
}

/** The profile's mark of a machine (`session.machine_icons`); null — none for it. */
function machineIcon(machine: string | null, icons: Record<string, string>): string | null {
  if (machine === null) return null;
  return Object.entries(icons).find(([m]) => same(m, machine))?.[1] ?? null;
}

/**
 * A running agent named as the cmux sidebar names its tmux session: the machine's mark, then the
 * session without `@<machine>` (`~/.tmux.conf` of nas-info, `set-titles-string`). A machine with no
 * mark keeps the whole name, which says the machine (vdx-ai-predictable Sidetrack #11). The mark
 * stands only before what runs now: in the sidebar every row is a live session.
 */
export function agentLabel(
  a: { machine: string; session: string | null; pid: number },
  icons: Record<string, string>,
): string {
  const icon = machineIcon(a.machine, icons);
  if (a.session === null) return icon ? `${icon} pid ${a.pid}` : `pid ${a.pid} on ${a.machine}`;
  if (icon) return `${icon} ${a.session.replace(/@[A-Za-z0-9]+/, '')}`;
  return a.session.includes('@') ? a.session : `${a.session} on ${a.machine}`;
}

function openWord(a: AgentFact, seat: string): string {
  const places = [...new Set(a.openAt.filter((s) => s !== '?' && !same(s, seat)))];
  if (a.openAt.includes('?')) places.push('another machine');
  // The machine by its name, and the person's own marked: «open here» beside «open on m3» read as two
  // different things (the owner, 2026-11-12).
  const all = [...(openAtSeat(a, seat) ? [`${seat} (here)`] : []), ...places];
  return all.length ? `open on ${all.join(', ')}` : '';
}

/** A title or a topic inside a sentence: one line, at most 50 characters. */
export const quoted = (t: string | null) => (t ? `«${t.replace(/\s+/g, ' ').trim().slice(0, 50)}»` : '');

const EMOJI_RE = /\p{Emoji_Presentation}/u;

/**
 * The terminal cells a text takes: an emoji and a CJK character two, a variation selector or a
 * joiner none. `padEnd` counts UTF-16 units, and a column after 🕸️ or a Cyrillic title drifts.
 */
export function cells(text: string): number {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c === 0xfe0f || c === 0x200d) continue;
    const wide =
      c >= 0x1f000 ||
      EMOJI_RE.test(ch) ||
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xff00 && c <= 0xff60);
    n += wide ? 2 : 1;
  }
  return n;
}

const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - cells(text)));

/** A row's caption: one line, cut to `room` cells with `…` — a cut that shows. */
export function clip(text: string | null, room: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (cells(t) <= room) return t;
  let out = '';
  for (const ch of t) {
    if (cells(out + ch) > room - 1) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

/** A conversation nobody runs, with nothing in it to continue: left out of the list. */
function continuable(c: Conversation): boolean {
  return !isEmpty(c);
}

/** One row before it is a line: the columns of its group, then the caption. */
interface Row {
  /** What its number takes; null — a line with no number (the intercom session). */
  pick: Pick | null;
  /** Its conversation: what a search found in it goes under the row. */
  id: string | null;
  /** The columns before the state: an agent's name; a conversation's machine and age. */
  lead: string[];
  icon: string;
  word: string;
  mode: string;
  /** The title, or the topic of one with no title. */
  text: string;
  /** Which terminal shows it. */
  tail: string;
}

/** A column is as wide as its widest cell — but one cell longer than this does not push the others away. */
const COLUMN_CAP = 24;
/** A caption's room when the terminal's width is not known. */
const CAPTION_ROOM = 60;

export function buildBoard(input: BoardInput): Board {
  const now = input.now ?? new Date();
  const seat = input.seat;
  const bold = (s: string) => (input.color ? `${ESC}[1m${s}${ESC}[22m` : s);
  const dim = (s: string) => (input.color ? `${ESC}[2m${s}${ESC}[22m` : s);
  const agents = input.agents.filter((a) => !a.mail && !a.hq).sort(byActivity);
  const mail = input.agents.filter((a) => a.mail);
  const hq = input.agents.filter((a) => a.hq);
  const runningIds = new Set(input.agents.map((a) => a.conversation).filter(Boolean));
  const idleAll = input.conversations.filter((c) => !runningIds.has(c.id) && continuable(c));
  const all = input.limit === 'all' || input.find !== undefined;
  const shown = all ? idleAll : idleAll.slice(0, typeof input.limit === 'number' ? input.limit : SHOWN);

  // A running agent as the sidebar names it; the conversations nobody runs — their machine as a word.
  const icons = input.machineIcons ?? {};
  const agentRow = (a: AgentFact): Row => ({
    pick: a.mail ? null : { kind: 'agent', agent: a },
    id: a.conversation,
    lead: [agentLabel(a, icons)],
    icon: stateIcon(a, now),
    word: stateWord(a, now),
    mode: modeIcon(a),
    // One caption: the title, else the topic. A focused session with no topic says so: started
    // before topics (0.41), or the agent never set one.
    text: a.mail
      ? 'not yours to attach'
      : a.hq
        ? ''
        : [a.title ?? a.topic ?? '', a.focused && !a.topic ? '(no topic)' : ''].filter(Boolean).join(' '),
    tail: a.mail ? '' : openWord(a, seat),
  });
  const machines = shown.map((c) => input.behind?.get(c.id) ?? input.machineOf(c));
  const conversationRow = (c: Conversation, i: number): Row => {
    const machine = machines[i]!;
    const behind = input.behind?.has(c.id) ?? false;
    return {
      pick: { kind: 'conversation', conversation: c, machine },
      id: c.id,
      lead: [machine ?? '?', describeAge(c.updated, now)],
      icon: c.finished && !behind ? '✅' : '',
      word: [
        behind
          ? `not here yet from ${machine} — continues there`
          : c.finished
            ? 'finished'
            : c.leftAfterLook
              ? 'left after a look'
              : 'unfinished',
        machine === null && 'machine unknown',
      ]
        .filter(Boolean)
        .join(', '),
      mode: modeIcon({ focused: c.topic !== null }),
      text: c.title ?? c.topic ?? '',
      tail: '',
    };
  };
  // The person sits at the HQ session too: a row with a number, after their agents, and its
  // number attaches to it as it is — `--hq` only narrows the choice to it (nas-info for the owner,
  // 2026-11-05). Enter does not go to it.
  const running = agents.map(agentRow);
  const service = [...mail, ...hq].map(agentRow);
  const idle = shown.map(conversationRow);
  const rows = [...running, ...service, ...idle].flatMap((r) => (r.pick ? [r.pick] : []));

  // Enter: the agent with work in it nobody at this seat looks at, the last active; else the
  // newest unfinished conversation; else an agent waiting for a first prompt; else a new one.
  // Never one a terminal here shows already (DL #2), never a wrapped one. What a search found
  // was asked for, wrapped or not: the first a terminal here does not show.
  const pickAt = (ok: (p: Pick) => boolean) => {
    const i = rows.findIndex(ok);
    return i < 0 ? null : i;
  };
  // After tmux fell, bringing back what it took down comes first (DL #9).
  const restore = input.restore ?? 0;
  const enter = input.find
    ? (pickAt((p) => !(p.kind === 'agent' && openAtSeat(p.agent, seat))) ?? (rows.length ? 0 : 'new'))
    : restore > 0
      ? 'restore'
      : (pickAt((p) => p.kind === 'agent' && !p.agent.hq && freeWork(p.agent, seat)) ??
        pickAt((p) => p.kind === 'conversation' && !p.conversation.finished && !p.conversation.leftAfterLook) ??
        pickAt(
          (p) => p.kind === 'agent' && !p.agent.hq && !openAtSeat(p.agent, seat) && agentState(p.agent) === 'empty',
        ) ??
        'new');

  // A group's rows in columns. In the list the number comes first, and Enter's row has the arrow the
  // keys line names; in the picker the cursor is the arrow, and a number would only catch the filter.
  const numberWidth = String(Math.max(rows.length, 1)).length;
  const under = ' '.repeat(2 + numberWidth + 4);
  const pickerColumns = input.pickerColumns ?? input.columns;
  const inColumns = (sized: Row[]) => {
    const anyIcon = sized.some((r) => r.icon);
    const anyMode = sized.some((r) => r.mode);
    const columns = (r: Row) => [
      ...r.lead,
      anyIcon ? `${r.icon || '  '} ${r.word}` : r.word,
      ...(anyMode ? [r.mode || '  '] : []),
    ];
    const widths = columns(sized[0]!).map((_, i) =>
      Math.max(0, ...sized.map((r) => cells(columns(r)[i]!)).filter((w) => w <= COLUMN_CAP)),
    );
    return (r: Row, lead: string, width: number | undefined) => {
      const before = `${lead}${columns(r)
        .map((c, i) => pad(c, widths[i]!))
        .join('  ')}`;
      const tail = r.tail ? cells(r.tail) + 3 : 0;
      const room = width ? Math.max(16, width - cells(before) - 2 - tail) : CAPTION_ROOM;
      return `${before}  ${[clip(r.text, room), r.tail].filter(Boolean).join(' · ')}`.trimEnd();
    };
  };
  // Under a row: what a search found in it, and the command that reaches it when nobody is asked —
  // deeper and dim, so the rows stay a table.
  const found = (r: Row) => (r.id ? input.find?.around.get(r.id) : undefined);
  const group = (title: string, members: Row[], sized: Row[] = members): string[] => {
    if (members.length === 0) return [];
    const line = inColumns(sized);
    const out = [bold(title)];
    for (const r of members) {
      const n = r.pick ? rows.indexOf(r.pick) : -1;
      const arrow = n >= 0 && n === enter && !input.reach ? '→' : ' ';
      const number = n >= 0 ? String(n + 1).padStart(numberWidth) : ' '.repeat(numberWidth);
      out.push(line(r, `${arrow} ${number}  `, input.columns));
      const command = r.pick ? input.reach?.(r.pick) : null;
      for (const l of [found(r), command]) if (l) out.push(dim(`${under}${l}`));
    }
    return out;
  };
  // The picker's panel for the row under the cursor: what the row had no room for.
  const detail = (r: Row): string[] => {
    const p = r.pick;
    const command = p ? (input.command ?? input.reach)?.(p) : null;
    // A card, not a paragraph: the title, then each fact under or beside its label.
    const block = (label: string, value: string | null | undefined) => (value ? [dim(label), value, ''] : []);
    const beside = (label: string, value: string | null | undefined) =>
      value ? [`${dim(label.padEnd(10))}${value}`] : [];
    const one = (text: string | null | undefined) => text?.replace(/\s+/g, ' ').trim();
    const facts =
      p?.kind === 'agent'
        ? [
            bold(one(p.agent.title) || '(no title yet)'),
            '',
            ...block('TOPIC', one(p.agent.topic) ?? (p.agent.focused ? 'none set' : null)),
            ...beside(
              'STATE',
              `${stateWord(p.agent, now)}${p.agent.focused ? ', focused' : p.agent.hq ? ', the HQ session' : ''}`,
            ),
            ...beside('SESSION', p.agent.session ?? `pid ${p.agent.pid}, no tmux`),
            ...beside('RUNS ON', p.agent.machine),
            ...beside('OPEN ON', r.tail ? r.tail.replace(/^open on /, '') : "nobody's terminal"),
            ...beside('ID', p.agent.conversation),
            '',
          ]
        : p?.kind === 'conversation'
          ? [
              bold(one(p.conversation.title) || '(no title)'),
              '',
              ...block('TOPIC', one(p.conversation.topic)),
              ...beside('STATE', r.word),
              ...beside('LAST ON', p.machine ?? 'a machine not known'),
              ...beside('WHEN', describeAge(p.conversation.updated, now)),
              ...beside('ID', p.conversation.id),
              '',
            ]
          : [bold('the intercom session'), '', 'letters wake it — not yours to attach', ''];
    return [...facts, ...block('FOUND', found(r)), ...block('COMMAND', command)];
  };
  const pickerGroup = (title: string, members: Row[], sized: Row[] = members): PickerItem[] => {
    if (members.length === 0) return [];
    const line = inColumns(sized);
    return [
      { text: bold(title), pick: null, detail: [] },
      ...members.map((r) => ({ text: line(r, '  ', pickerColumns), pick: r.pick, detail: detail(r) })),
    ];
  };

  const unread = all ? 0 : (input.unread ?? 0);
  const hidden = idleAll.length - shown.length + unread;
  const serviceTitle =
    mail.length && hq.length ? 'HQ AND INTERCOM SESSIONS' : hq.length ? 'HQ SESSION' : 'INTERCOM SESSION';
  const live = [...running, ...service];
  const runningTitle = `RUNNING NOW · ${running.length}`;
  const idleTitle = `CONVERSATIONS NOBODY RUNS · ${hidden > 0 ? `${idle.length} newest of ${unread ? 'up to ' : ''}${idleAll.length + unread}` : idle.length}`;
  // The marks the profile gives the machines (`session.machine_icons`), said once: which is which.
  const legend = [...new Set([...agents, ...mail, ...hq].map((a) => a.machine))]
    .flatMap((m) => {
      const icon = machineIcon(m, icons);
      return icon ? [`${icon} ${m}`] : [];
    })
    .join(' · ');
  const title = input.find
    ? `${input.project} — ${quoted(input.find.phrase)} in ${rows.length} of ${input.find.searched} conversations`
    : input.project;
  const head = legend ? `${bold(title)}   runs on: ${legend}` : bold(title);
  const nothing = live.length === 0 && !input.find ? ['nothing runs now'] : [];
  const behind = input.behind?.size ?? 0;
  const notes = [
    ...(input.silent ?? []).map((m) => `  note: ${m} does not answer over ssh — what runs there is not known`),
    ...(behind
      ? [
          `  note: ${behind} conversation${behind === 1 ? '' : 's'} not here yet from another machine (sync behind)` +
            (input.find ? ` — ${behind === 1 ? 'its' : 'their'} latest part is not searched` : ''),
        ]
      : []),
    ...(input.footnotes ?? []).map((n) => `  note: ${n}`),
  ];
  const back = `bring back ${restore === 1 ? 'the agent' : `the ${restore} agents`} tmux took down`;
  const more = input.find ? 'the whole list' : hidden > 0 ? `all (${unread ? 'up to ' : ''}${hidden} more)` : null;
  const keys = [
    `Enter → ${enterKey({ enter })}`,
    ...(restore > 0 ? [`r ${back}`] : []),
    ...(more ? [`a ${more}`] : []),
    input.find ? '/<phrase> another search' : '/<phrase> find',
    'n new',
    'f new focused',
  ];
  const blocks = [
    [head],
    nothing.length ? nothing : group(runningTitle, running, live),
    group(serviceTitle, service, live),
    group(idleTitle, idle),
    notes,
    input.reach ? [] : [`  ${keys.join(' · ')}`],
  ].filter((b) => b.length > 0);

  // The same list for the picker (picker.ts): what a key does in the list is a row here — the cursor
  // starts on the one Enter takes.
  const fresh: Pick = { kind: 'new', focused: false };
  const items: PickerItem[] = [
    ...(restore > 0
      ? [{ text: `▶ ${back}`, pick: { kind: 'restore' } as Pick, detail: input.restoreDetail ?? [] }]
      : []),
    ...pickerGroup(runningTitle, running, live),
    ...pickerGroup(serviceTitle, service, live),
    ...pickerGroup(idleTitle, idle),
    ...(more
      ? [
          {
            text: `  … ${input.find ? more : more.replace('all', 'all conversations')}`,
            pick: { kind: 'all' } as Pick,
            detail: [],
          },
        ]
      : []),
    { text: '+ new conversation', pick: fresh, detail: [] },
    { text: '+ new focused conversation', pick: { kind: 'new', focused: true }, detail: [] },
  ];
  const target = enter === 'new' ? fresh : enter === 'restore' ? items[0]!.pick : rows[enter]!;
  return {
    lines: blocks.flatMap((b, i) => (i === 0 ? b : ['', ...b])),
    rows,
    enter,
    restore,
    picker: {
      header: [
        head,
        ...nothing,
        ...notes.map((n) => n.trim()),
        `Enter takes the row · ${SEARCH_KEY} searches what was said for the typed words · ${COMMAND_KEY} prints the row's command · Esc leaves`,
      ],
      items,
      cursor: Math.max(
        0,
        items.findIndex((i) => i.pick === target),
      ),
    },
  };
}

/** The picker's key that asks for a search of the typed phrase. */
export const SEARCH_KEY = 'ctrl-s';
/**
 * The picker's key that prints the command of the row under the cursor and leaves: in the panel a long
 * command is folded inside a frame, and what the terminal copies from there is not a command.
 */
export const COMMAND_KEY = 'ctrl-y';

/**
 * What the person did in the picker: Enter on a row is that row; ctrl-s searches the conversations
 * for the phrase typed as the filter. Null — a title, or nothing typed to search: the list again.
 */
export function readPicked(answer: { key: string; index: number | null; query: string }, board: Board): Pick | null {
  if (answer.key === SEARCH_KEY) {
    const phrase = answer.query.trim();
    return phrase ? { kind: 'find', phrase } : null;
  }
  // Enter only: another key that ended the picker is not a choice of the row.
  if (answer.key !== '' || answer.index === null) return null;
  return board.picker.items[answer.index]?.pick ?? null;
}

/** The key Enter stands for: a row's number, `n` or `r`. */
export function enterKey(board: { enter: Board['enter'] }): string {
  return board.enter === 'new' ? 'n' : board.enter === 'restore' ? 'r' : String(board.enter + 1);
}

/** The person's answer: a row, `a`, `/<phrase>`, `n`, `f`, `r`; Enter is the marked one. Null — not understood. */
export function readAnswer(answer: string, board: Board): Pick | null {
  const a = answer.trim();
  if (a === '')
    return board.enter === 'new'
      ? { kind: 'new', focused: false }
      : board.enter === 'restore'
        ? { kind: 'restore' }
        : board.rows[board.enter]!;
  if (/^r$/i.test(a)) return board.restore > 0 ? { kind: 'restore' } : null;
  if (/^n(ew)?$/i.test(a)) return { kind: 'new', focused: false };
  if (/^f$/i.test(a)) return { kind: 'new', focused: true };
  if (/^a(ll)?$/i.test(a)) return { kind: 'all' };
  if (/^\d+$/.test(a)) return board.rows[Number(a) - 1] ?? null;
  const phrase = a.match(/^\/\s*(.+)$/)?.[1];
  return phrase ? { kind: 'find', phrase } : null;
}
