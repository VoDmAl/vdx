import { type Conversation, describeAge, isEmpty } from './conversations.ts';

/**
 * The one list `vdx ai` shows when a start is not plain (vdx-ai-predictable): the project's
 * agents running on every machine, then its conversations nobody runs — each with its
 * machine and its state, and the row Enter takes marked. Before it, one line said which
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
  /** How many conversations the project has in all, read or not. */
  total: number;
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
  /**
   * How many agents a fallen tmux server took down that `r` brings back (vdx-ai-predictable P6):
   * then Enter is `r`, unless a search was asked for.
   */
  restore?: number;
  /** The profile's `session.machine_icons`: a machine's mark before its label, as the cmux sidebar shows it. */
  machineIcons?: Record<string, string>;
  now?: Date;
}

export interface Board {
  lines: string[];
  rows: Pick[];
  /** The row Enter takes (index into rows), the new conversation, or bringing back what tmux took down. */
  enter: number | 'new' | 'restore';
  /** What `r` brings back; 0 — nothing, no such key. */
  restore: number;
}

const SHOWN = 5;

/** The order of running agents: the last active first. */
function byActivity(a: AgentFact, b: AgentFact): number {
  return (b.activeAt ?? 0) - (a.activeAt ?? 0);
}

function stateWord(a: AgentFact, now: Date): string {
  const s = agentState(a);
  if (s === 'draft') return `draft (${a.draft} chars)`;
  if (s === 'finished') return 'finished (wrap)';
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
function modeIcon(a: AgentFact): string {
  return a.focused ? '🎯' : a.mail ? '📬' : a.hq ? '👑' : '';
}

function openWord(a: AgentFact, seat: string): string {
  const places = [...new Set(a.openAt.filter((s) => s !== '?' && !same(s, seat)))];
  if (a.openAt.includes('?')) places.push('another machine');
  if (openAtSeat(a, seat)) return `open here${places.length ? `, on ${places.join(', ')}` : ''}`;
  return places.length ? `open on ${places.join(', ')}` : '';
}

const quoted = (t: string | null) => (t ? `«${t.replace(/\s+/g, ' ').trim().slice(0, 50)}»` : '');

/** A conversation nobody runs, with nothing in it to continue: left out of the list. */
function continuable(c: Conversation): boolean {
  return !isEmpty(c);
}

export function buildBoard(input: BoardInput): Board {
  const now = input.now ?? new Date();
  const seat = input.seat;
  const agents = input.agents.filter((a) => !a.mail && !a.hq).sort(byActivity);
  const mail = input.agents.filter((a) => a.mail);
  const hq = input.agents.filter((a) => a.hq);
  const runningIds = new Set(input.agents.map((a) => a.conversation).filter(Boolean));
  const idleAll = input.conversations.filter((c) => !runningIds.has(c.id) && continuable(c));
  const all = input.limit === 'all' || input.find !== undefined;
  const shown = all ? idleAll : idleAll.slice(0, typeof input.limit === 'number' ? input.limit : SHOWN);

  const rows: Pick[] = [];
  const lines: string[] = [];
  // Under a row: what a search found in it, and the command that reaches it when nobody is asked.
  const under = (p: Pick, id: string | null) => {
    const found = id ? input.find?.around.get(id) : undefined;
    const command = input.reach?.(p);
    for (const l of [found, command]) if (l) lines.push(`       ${l}`);
  };
  const width = Math.max(0, ...[...agents, ...hq].map((a) => (a.session ?? `pid ${a.pid}`).length));
  // A machine's mark before its label; with marks in the profile, a machine without one keeps the column.
  const icons = Object.entries(input.machineIcons ?? {});
  const mark = (machine: string | null) => {
    if (icons.length === 0) return '';
    const icon = machine === null ? undefined : icons.find(([m]) => same(m, machine))?.[1];
    return icon ? `${icon} ` : '   ';
  };
  const signs = (a: AgentFact) => `${stateIcon(a, now)}${modeIcon(a)}`;
  for (const a of agents) {
    const row: Pick = { kind: 'agent', agent: a };
    rows.push(row);
    const where = (a.session ?? `pid ${a.pid}`).padEnd(width);
    // A focused session with no topic says so: started before topics (0.41), or the agent never set one.
    const what = [
      a.focused ? `focused ${a.topic ? quoted(a.topic) : '(no topic)'}` : '',
      stateWord(a, now),
      quoted(a.title),
    ]
      .filter(Boolean)
      .join(' · ');
    const open = openWord(a, seat);
    lines.push(
      `  ${rows.length}) ${mark(a.machine)}${a.machine.padEnd(4)} ${where}  ${signs(a)} ${what}${open ? `   ${open}` : ''}`,
    );
    under(row, a.conversation);
  }
  for (const a of mail)
    lines.push(
      `     ${mark(a.machine)}${a.machine.padEnd(4)} ${a.session ?? `pid ${a.pid}`}  ${signs(a)} the intercom session — not yours to attach`,
    );
  // The person sits at the HQ session too: a row with a number, after their agents, and its
  // number attaches to it as it is — `--hq` only narrows the choice to it (nas-info for the owner,
  // 2026-11-05). Enter does not go to it.
  for (const a of hq) {
    const row: Pick = { kind: 'agent', agent: a };
    rows.push(row);
    const where = (a.session ?? `pid ${a.pid}`).padEnd(width);
    const open = openWord(a, seat);
    lines.push(
      `  ${rows.length}) ${mark(a.machine)}${a.machine.padEnd(4)} ${where}  ${signs(a)} the HQ session · ${stateWord(a, now)}${open ? `   ${open}` : ''}`,
    );
    under(row, a.conversation);
  }
  if (shown.length) lines.push('  conversations nobody runs:');
  for (const c of shown) {
    const machine = input.behind?.get(c.id) ?? input.machineOf(c);
    const row: Pick = { kind: 'conversation', conversation: c, machine };
    rows.push(row);
    const state = [
      input.behind?.has(c.id)
        ? `not here yet from ${machine} — continues there`
        : c.finished
          ? '✅ finished (wrap)'
          : 'cut off',
      machine === null && 'machine unknown',
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(
      `  ${rows.length}) ${mark(machine)}${(machine ?? '?').padEnd(4)} ${describeAge(c.updated, now)}  ${c.id.slice(0, 8)}  ${state}${c.title ? ` · ${quoted(c.title)}` : ''}`,
    );
    under(row, c.id);
  }

  // Enter: the agent with work in it nobody at this seat looks at, the last active; else the
  // newest conversation cut off; else an agent waiting for a first prompt; else a new one.
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
        pickAt((p) => p.kind === 'conversation' && !p.conversation.finished) ??
        pickAt(
          (p) => p.kind === 'agent' && !p.agent.hq && !openAtSeat(p.agent, seat) && agentState(p.agent) === 'empty',
        ) ??
        'new');

  const unread = all ? 0 : (input.unread ?? 0);
  const hidden = idleAll.length - shown.length + unread;
  const head = input.find
    ? `${input.project} — ${quoted(input.find.phrase)} in ${rows.length} of ${input.find.searched} conversations`
    : `${input.project} — ${agents.length + hq.length} running, ${input.total} conversation${input.total === 1 ? '' : 's'}` +
      (input.limit === 'all' ? '' : ` (${shown.length} shown)`);
  const behind = input.behind?.size ?? 0;
  const notes = [
    ...(input.silent ?? []).map((m) => `  note: ${m} does not answer over ssh — what runs there is not known`),
    ...(behind
      ? [
          `  note: ${behind} conversation${behind === 1 ? '' : 's'} not here yet from another machine (sync behind)` +
            (input.find ? ` — ${behind === 1 ? 'its' : 'their'} latest part is not searched` : ''),
        ]
      : []),
  ];
  const keys = [
    `Enter → ${enterKey({ enter })}`,
    ...(restore > 0 ? [`r bring back ${restore === 1 ? 'the agent' : `the ${restore} agents`} tmux took down`] : []),
    ...(input.find ? ['a the whole list'] : hidden > 0 ? [`a all (${unread ? 'up to ' : ''}${hidden} more)`] : []),
    input.find ? '/<phrase> another search' : '/<phrase> find',
    'n new',
    'f new focused',
  ];
  return {
    lines: [head, ...lines, ...notes, ...(input.reach ? [] : [`  ${keys.join(' · ')}`])],
    rows,
    enter,
    restore,
  };
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
