import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Claude Code conversations of a project, and the machine each one was last
 * started on.
 *
 * Claude Code keeps a conversation as `<config>/projects/<dir>/<id>.jsonl`,
 * where `<dir>` is the working directory with every character other than a
 * letter or a digit turned into `-`. That folder may be synced between
 * machines (it is on the owner's: Syncthing), so the newest conversation of a
 * project can be another machine's — and `claude --continue` would take it
 * there, while that machine still writes to it.
 *
 * The transcript has no field for the machine. The machine comes from vdx
 * itself: `vdx ai --check`, run by the vdx plugin's SessionStart hook, names
 * it, and Claude Code keeps the hook's text in the transcript — on every
 * start, resume, /clear and compact. The last such line is where the
 * conversation was last started. Derived from the synced transcript, never
 * stored apart from it.
 *
 * A conversation from before vdx named the machine has no such line. For it
 * the machine's own `<config>/history.jsonl` answers half the question: it
 * records the conversation of every prompt typed here, and it is not synced
 * (the owner's Syncthing ignores it; unsynced setups have nothing to sync). A
 * conversation typed in here is this machine's; one never typed in here is
 * another machine's — which one, nothing says.
 */

/** The opening of `vdx ai --check`'s text; the label is an ssh destination from the other machines. */
export const MACHINE_LINE_PREFIX = 'vdx ai: this machine is';
const MACHINE_LINE_RE = /^vdx ai: this machine is `([^`]+)`/m;
/** A label read from a synced file goes to ssh: it must not be able to read as an option. */
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function machineLine(label: string): string {
  return `${MACHINE_LINE_PREFIX} \`${label}\``;
}

export function isConversationId(s: string): boolean {
  return ID_RE.test(s);
}

export interface Conversation {
  id: string;
  /** Last write — the file's mtime, which Syncthing carries over from the writer. */
  updated: Date;
  /** Where it was last started; null for a conversation from before vdx named the machine. */
  machine: string | null;
  /** A prompt was typed in it on this machine (history.jsonl). */
  typedHere: boolean;
  /** Claude's title for it, else the last prompt. */
  title: string | null;
}

export function claudeConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  const dir = env['CLAUDE_CONFIG_DIR']?.trim();
  return dir ? path.resolve(dir.replace(/^~(?=$|\/)/, home)) : path.join(home, '.claude');
}

export function projectDirName(projectRoot: string): string {
  return projectRoot.replace(/[^A-Za-z0-9]/g, '-');
}

/** Read one transcript; null when nobody ever wrote in it — there is nothing to continue. */
export function readConversation(file: string, updated: Date): Conversation | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let machine: string | null = null;
  let aiTitle: string | null = null;
  let lastPrompt: string | null = null;
  let turns = false;
  for (const line of text.split('\n')) {
    // Cheap filters first: transcripts run to megabytes, and only these lines matter.
    const isHook = line.includes('"hook_additional_context"') && line.includes(MACHINE_LINE_PREFIX);
    const isTitle = line.includes('"ai-title"') || line.includes('"last-prompt"');
    if (!turns && line.includes('"type":"user"')) turns = true;
    if (!isHook && !isTitle) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type === 'ai-title' && typeof entry.aiTitle === 'string') aiTitle = entry.aiTitle;
    else if (entry?.type === 'last-prompt' && typeof entry.lastPrompt === 'string') lastPrompt = entry.lastPrompt;
    else if (entry?.type === 'attachment' && entry.attachment?.type === 'hook_additional_context') {
      const content = entry.attachment.content;
      for (const part of Array.isArray(content) ? content : [content]) {
        const label = typeof part === 'string' ? part.match(MACHINE_LINE_RE)?.[1] : undefined;
        if (label && LABEL_RE.test(label)) machine = label;
      }
    }
  }
  if (!turns) return null;
  const id = path.basename(file, '.jsonl');
  return { id, updated, machine, typedHere: false, title: aiTitle ?? lastPrompt };
}

/** Which of `ids` had a prompt typed in them on this machine. */
export function typedHere(env: NodeJS.ProcessEnv, home: string, ids: Set<string>): Set<string> {
  const found = new Set<string>();
  let text: string;
  try {
    text = fs.readFileSync(path.join(claudeConfigDir(env, home), 'history.jsonl'), 'utf8');
  } catch {
    return found;
  }
  for (const m of text.matchAll(/"sessionId":"([0-9a-f-]{36})"/g)) {
    if (ids.has(m[1]!)) found.add(m[1]!);
  }
  return found;
}

/** The project's conversations, newest first; at most `limit` files are read. */
export function listConversations(input: {
  env: NodeJS.ProcessEnv;
  home: string;
  projectRoot: string;
  limit?: number;
}): Conversation[] {
  const roots = new Set([input.projectRoot]);
  try {
    roots.add(fs.realpathSync(input.projectRoot));
  } catch {
    /* the plain path is enough */
  }
  const files: { file: string; updated: Date }[] = [];
  for (const root of roots) {
    const dir = path.join(claudeConfigDir(input.env, input.home), 'projects', projectDirName(root));
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      // `<id>.sync-conflict-….jsonl` is Syncthing's copy of a losing side, not a conversation.
      if (!name.endsWith('.jsonl') || !isConversationId(name.slice(0, -'.jsonl'.length))) continue;
      const file = path.join(dir, name);
      try {
        files.push({ file, updated: fs.statSync(file).mtime });
      } catch {
        /* gone since the listing */
      }
    }
  }
  files.sort((a, b) => b.updated.getTime() - a.updated.getTime());
  const seen = new Set<string>();
  const out: Conversation[] = [];
  for (const f of files.slice(0, input.limit ?? 30)) {
    const c = readConversation(f.file, f.updated);
    if (c && !seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  }
  const typed = typedHere(input.env, input.home, seen);
  return out.map((c) => ({ ...c, typedHere: typed.has(c.id) }));
}

function sameMachine(a: string | null, b: string | null): boolean {
  return (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
}

/** The machine a conversation belongs to: its last start, else this one if typed in here; null — unknown. */
export function machineOf(c: Conversation, host: string): string | null {
  return c.machine ?? (c.typedHere ? host : null);
}

/** The newest conversation of each machine (unknown counts as one), newest first. */
export function latestPerMachine(conversations: Conversation[], machine: (c: Conversation) => string | null): Conversation[] {
  const out: Conversation[] = [];
  for (const c of [...conversations].sort((a, b) => b.updated.getTime() - a.updated.getTime())) {
    if (!out.some((o) => sameMachine(machine(o), machine(c)))) out.push(c);
  }
  return out;
}


/**
 * The conversation a running Claude Code process is in, from its session file
 * `<config>/sessions/<pid>.json` — it follows /clear. That folder is per
 * machine, so the pid is this machine's.
 */
export function liveConversationId(env: NodeJS.ProcessEnv, home: string, pid: number): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(claudeConfigDir(env, home), 'sessions', `${pid}.json`), 'utf8'));
    const id = data?.sessionId;
    return typeof id === 'string' && isConversationId(id) ? id : null;
  } catch {
    return null;
  }
}

/** A Claude Code process running right now, and the conversation it is in. */
export interface LiveSession {
  pid: number;
  conversation: string;
  /** `session:@window.%pane`, when it runs in tmux. */
  tmux: string | null;
  /** Claude Code's own word for it: `busy`, `waiting`, … */
  status: string | null;
}

/** Session files, one JSON object per line — a file read here, or the output of LIVE_SESSIONS_SCRIPT. */
export function parseLiveSessions(text: string): LiveSession[] {
  const out: LiveSession[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let data: any;
    try {
      data = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Number.isInteger(data?.pid) || typeof data?.sessionId !== 'string' || !isConversationId(data.sessionId)) continue;
    out.push({
      pid: data.pid,
      conversation: data.sessionId,
      tmux: typeof data.tmux === 'string' ? data.tmux : null,
      status: typeof data.status === 'string' ? data.status : null,
    });
  }
  return out;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/**
 * Prints the session file of every Claude Code process alive on the machine it
 * runs on, one per line — what `vdx ai` asks another machine over ssh. Claude
 * removes the file of a process that ended, but not after a crash or a reboot:
 * the pid is checked. `<pid>.sync-conflict-….json` is not a session file.
 */
export const LIVE_SESSIONS_SCRIPT =
  'd="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions"; for f in "$d"/*.json; do ' +
  'p=${f##*/}; p=${p%.json}; case $p in ""|*[!0-9]*) continue;; esac; ' +
  'kill -0 "$p" 2>/dev/null && tr -d "\\n" < "$f" && echo; done; exit 0';

/** Claude Code processes alive on this machine. */
export function liveSessionsHere(env: NodeJS.ProcessEnv, home: string, alive: (pid: number) => boolean = pidAlive): LiveSession[] {
  const dir = path.join(claudeConfigDir(env, home), 'sessions');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const lines: string[] = [];
  for (const name of names) {
    const pid = name.match(/^(\d+)\.json$/)?.[1];
    if (!pid || !alive(Number(pid))) continue;
    try {
      lines.push(fs.readFileSync(path.join(dir, name), 'utf8').replace(/\n/g, ''));
    } catch {
      /* ended since the listing */
    }
  }
  return parseLiveSessions(lines.join('\n'));
}

/** "running on m3 now (t23b-program@m3, waiting)" — where a live session is, for a person choosing. */
export function describeLive(machine: string, live: LiveSession, here: boolean): string {
  const where = live.tmux ? live.tmux.replace(/:.*$/, '') : `pid ${live.pid}`;
  return `running ${here ? 'here' : `on ${machine}`} now (${where}${live.status ? `, ${live.status}` : ''})`;
}

/** "3 min ago", "yesterday 14:05", "2026-09-30 14:05" — for a person choosing. */
export function describeAge(when: Date, now: Date = new Date()): string {
  const min = Math.round((now.getTime() - when.getTime()) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hh = String(when.getHours()).padStart(2, '0');
  const mm = String(when.getMinutes()).padStart(2, '0');
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(when)) / 86_400_000);
  if (days === 0) return `today ${hh}:${mm}`;
  if (days === 1) return `yesterday ${hh}:${mm}`;
  const date = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`;
  return `${date} ${hh}:${mm}`;
}

export function describeConversation(c: Conversation, machine: string | null, now: Date = new Date()): string {
  const title = c.title ? ` «${c.title.replace(/\s+/g, ' ').trim().slice(0, 60)}»` : '';
  return `${machine ?? '?'}  ${describeAge(c.updated, now)}  ${c.id.slice(0, 8)}${title}`;
}
