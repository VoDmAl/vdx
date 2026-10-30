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
  if (a.empty) return 'empty';
  if (a.finished) return 'finished';
  return 'idle';
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
  | { kind: 'all' };

export interface BoardInput {
  project: string;
  /** The machine vdx runs on. */
  host: string;
  /** The machine the person sits at. */
  seat: string;
  agents: AgentFact[];
  /** The project's conversations as read here, newest first, the mail session's left out. */
  conversations: Conversation[];
  /** How many conversations the project has in all, read or not. */
  total: number;
  /** How many of them were not read: some may be the mail session's or empty ones. */
  unread?: number;
  machineOf: (c: Conversation) => string | null;
  /** Conversations whose copy here is behind the machine that writes them: id → that machine. */
  behind?: Map<string, string>;
  /** Machines that did not answer: what runs there is not known. */
  silent?: string[];
  /** How many conversations nobody runs to show; `all` — every one. */
  limit?: number | 'all';
  now?: Date;
}

export interface Board {
  lines: string[];
  rows: Pick[];
  /** The row Enter takes (index into rows), or the new conversation. */
  enter: number | 'new';
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

function openWord(a: AgentFact, seat: string): string {
  if (openAtSeat(a, seat)) return 'open here';
  const there = a.openAt.filter((s) => s !== '?');
  if (there.length) return `open on ${[...new Set(there)].join(', ')}`;
  return a.openAt.length ? 'open on another machine' : '';
}

const quoted = (t: string | null) => (t ? `«${t.replace(/\s+/g, ' ').trim().slice(0, 50)}»` : '');

/** A conversation nobody runs, with nothing in it to continue: left out of the list. */
function continuable(c: Conversation): boolean {
  return !isEmpty(c);
}

export function buildBoard(input: BoardInput): Board {
  const now = input.now ?? new Date();
  const seat = input.seat;
  const agents = input.agents.filter((a) => !a.mail).sort(byActivity);
  const mail = input.agents.filter((a) => a.mail);
  const runningIds = new Set(input.agents.map((a) => a.conversation).filter(Boolean));
  const idleAll = input.conversations.filter((c) => !runningIds.has(c.id) && continuable(c));
  const shown = input.limit === 'all' ? idleAll : idleAll.slice(0, input.limit ?? SHOWN);

  const rows: Pick[] = [];
  const lines: string[] = [];
  const width = Math.max(0, ...agents.map((a) => (a.session ?? `pid ${a.pid}`).length));
  for (const a of agents) {
    rows.push({ kind: 'agent', agent: a });
    const where = (a.session ?? `pid ${a.pid}`).padEnd(width);
    const what = [a.focused ? `focused${a.topic ? ` ${quoted(a.topic)}` : ''}` : '', stateWord(a, now), quoted(a.title)]
      .filter(Boolean)
      .join(' · ');
    const open = openWord(a, seat);
    lines.push(`  ${rows.length}) ${a.machine.padEnd(4)} ${where}  ${what}${open ? `   ${open}` : ''}`);
  }
  for (const a of mail)
    lines.push(`     ${a.machine.padEnd(4)} ${a.session ?? `pid ${a.pid}`}  the mail session — not yours to attach`);
  if (shown.length) lines.push('  conversations nobody runs:');
  for (const c of shown) {
    const machine = input.behind?.get(c.id) ?? input.machineOf(c);
    rows.push({ kind: 'conversation', conversation: c, machine });
    const state = [
      input.behind?.has(c.id)
        ? `not here yet from ${machine} — continues there`
        : c.finished
          ? 'finished (wrap)'
          : 'cut off',
      machine === null && 'machine unknown',
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(
      `  ${rows.length}) ${(machine ?? '?').padEnd(4)} ${describeAge(c.updated, now)}  ${c.id.slice(0, 8)}  ${state}${c.title ? ` · ${quoted(c.title)}` : ''}`,
    );
  }

  // Enter: the agent with work in it nobody at this seat looks at, the last active; else the
  // newest conversation cut off; else an agent waiting for a first prompt; else a new one.
  // Never one a terminal here shows already (DL #2), never a wrapped one.
  const pickAt = (ok: (p: Pick) => boolean) => {
    const i = rows.findIndex(ok);
    return i < 0 ? null : i;
  };
  const enter =
    pickAt((p) => p.kind === 'agent' && freeWork(p.agent, seat)) ??
    pickAt((p) => p.kind === 'conversation' && !p.conversation.finished) ??
    pickAt((p) => p.kind === 'agent' && !openAtSeat(p.agent, seat) && agentState(p.agent) === 'empty') ??
    'new';

  const unread = input.limit === 'all' ? 0 : (input.unread ?? 0);
  const hidden = idleAll.length - shown.length + unread;
  const head =
    `${input.project} — ${agents.length} running, ${input.total} conversation${input.total === 1 ? '' : 's'}` +
    (input.limit === 'all' ? '' : ` (${shown.length} shown)`);
  const behind = input.behind?.size ?? 0;
  const notes = [
    ...(input.silent ?? []).map((m) => `  note: ${m} does not answer over ssh — what runs there is not known`),
    ...(behind
      ? [`  note: ${behind} conversation${behind === 1 ? '' : 's'} not here yet from another machine (sync behind)`]
      : []),
  ];
  const keys = [
    `Enter → ${enter === 'new' ? 'n' : enter + 1}`,
    ...(hidden > 0 ? [`a all (${unread ? 'up to ' : ''}${hidden} more)`] : []),
    'n new',
    'f new focused',
  ];
  return { lines: [head, ...lines, ...notes, `  ${keys.join(' · ')}`], rows, enter };
}

/** The person's answer: a row, `a`, `n`, `f`; Enter is the marked one. Null — not understood. */
export function readAnswer(answer: string, board: Board): Pick | null {
  const a = answer.trim();
  if (a === '') return board.enter === 'new' ? { kind: 'new', focused: false } : board.rows[board.enter]!;
  if (/^n(ew)?$/i.test(a)) return { kind: 'new', focused: false };
  if (/^f$/i.test(a)) return { kind: 'new', focused: true };
  if (/^a(ll)?$/i.test(a)) return { kind: 'all' };
  if (/^\d+$/.test(a)) return board.rows[Number(a) - 1] ?? null;
  return null;
}
