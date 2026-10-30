import * as fs from 'node:fs';
import * as path from 'node:path';
import { at, dict, str } from './narrow.ts';

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
const MACHINE_LINE_PREFIX = 'vdx ai: this machine is';
const MACHINE_LINE_RE = /^vdx ai: this machine is `([^`]+)`/m;
/** The opening of the line `vdx ai --check` adds in a mail session (`vdx ai --intercom`). */
export const MAIL_LINE_PREFIX = "· this is the project's mail session";
/**
 * A focused session's topic, on a line of its own: `vdx ai --check` and the vdx plugin's
 * prompt hook give it, and `--focused --conversation <id>` reads the last one back
 * (focused-topic DL #2). The topic is one line: `normalizeTopic` in ai.ts.
 */
const TOPIC_LINE_PREFIX = 'vdx ai: the topic of this focused session is';
const TOPIC_LINE_RE = /^vdx ai: the topic of this focused session is «(.+)»$/m;
/** A label read from a synced file goes to ssh: it must not be able to read as an option. */
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function machineLine(label: string): string {
  return `${MACHINE_LINE_PREFIX} \`${label}\``;
}

export function topicLine(topic: string): string {
  return `${TOPIC_LINE_PREFIX} «${topic}»`;
}

/** A machine label vdx may hand to ssh as the destination. */
export function isMachineLabel(s: string): boolean {
  return LABEL_RE.test(s);
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
  /** Last started as the project's mail session (`vdx ai --intercom`): not the person's to continue. */
  mail: boolean;
  /** A focused conversation's last topic; null — it never had one. */
  topic: string | null;
  /** Begun by `/clear` in a running agent: the pane stayed, the conversation is a new one. */
  bornClear: boolean;
  /** Prompts the person typed: not a `!` command, a hook's text or a channel event. */
  typed: number;
  /**
   * A wrap skill (`session.wrap_skills` of the profile) ran, and nothing was typed after it —
   * at most the `!` command it handed over: the conversation is done (vdx-ai-predictable DL #3).
   */
  finished: boolean;
}

/** Nothing typed in it since `/clear`: a pane waiting for a first prompt, with nothing to continue. */
export function isEmpty(c: Conversation): boolean {
  return c.bornClear && c.typed === 0;
}

export function claudeConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  const dir = env['CLAUDE_CONFIG_DIR']?.trim();
  return dir ? path.resolve(dir.replace(/^~(?=$|\/)/, home)) : path.join(home, '.claude');
}

/**
 * Whether Claude Code trusts a folder (2.1.308, claude-memory-in-project DL #13): its global
 * config, `.claude.json` in `CLAUDE_CONFIG_DIR` or the home directory, marks
 * `projects[<folder>].hasTrustDialogAccepted` for the folder or one above it — inside a git
 * checkout only up to the checkout's top. A start in a folder it does not trust stops on the
 * trust window until somebody answers. Null: the config cannot be read, nobody knows.
 */
export function claudeTrusts(folder: string, env: NodeJS.ProcessEnv, home: string): boolean | null {
  const dir = env['CLAUDE_CONFIG_DIR']?.trim();
  let projects: Record<string, unknown> | undefined;
  try {
    const file = path.join(dir ? path.resolve(dir.replace(/^~(?=$|\/)/, home)) : home, '.claude.json');
    projects = dict(at(JSON.parse(fs.readFileSync(file, 'utf8')), 'projects'));
  } catch {
    return null;
  }
  let d = path.resolve(folder);
  try {
    d = fs.realpathSync(d);
  } catch {
    // A folder that is not there is trusted by nothing but its own record.
  }
  let top: string | null = null;
  for (let p = d; top === null; p = path.dirname(p)) {
    if (fs.existsSync(path.join(p, '.git'))) top = p;
    if (path.dirname(p) === p) break;
  }
  for (;;) {
    if (at(projects?.[d.normalize('NFC')], 'hasTrustDialogAccepted') === true) return true;
    const up = path.dirname(d);
    if (d === top || up === d) return false;
    d = up;
  }
}

export function projectDirName(projectRoot: string): string {
  return projectRoot.replace(/[^A-Za-z0-9]/g, '-');
}

/** The text of a user entry the person wrote, or a command; null — a tool's result or nothing. */
function userText(entry: unknown): string | null {
  if (at(entry, 'isMeta') === true) return null;
  const content = at(entry, 'message', 'content');
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = content as unknown[];
  if (parts.some((p) => at(p, 'type') === 'tool_result')) return null;
  return parts
    .map((p) => (at(p, 'type') === 'text' ? (str(at(p, 'text')) ?? '') : ''))
    .join(' ')
    .trim();
}

/** The skill an assistant entry ran, one per entry as Claude Code writes them; null — none. */
function skillRun(entry: unknown): string | null {
  const content = at(entry, 'message', 'content');
  if (!Array.isArray(content)) return null;
  for (const p of content as unknown[]) {
    if (at(p, 'type') === 'tool_use' && at(p, 'name') === 'Skill') return str(at(p, 'input', 'skill')) ?? null;
  }
  return null;
}

const COMMAND_RE = /<command-name>\/?([^<\s]+)<\/command-name>/;

/**
 * Read one transcript; null when nobody ever wrote in it — there is nothing to continue.
 * `wrapSkills` — the skills that end a conversation (`session.wrap_skills`), run by the agent
 * or typed as a command.
 */
export function readConversation(file: string, updated: Date, wrapSkills: readonly string[] = []): Conversation | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let machine: string | null = null;
  let mail = false;
  let topic: string | null = null;
  let aiTitle: string | null = null;
  let lastPrompt: string | null = null;
  let turns = false;
  let bornClear = false;
  let typed = 0;
  // Where the last wrap ran and the last prompt was typed: an order of entries, not of clocks.
  let wrapAt = -1;
  let typedAt = -1;
  const wraps = new Set(wrapSkills);
  let n = 0;
  for (const line of text.split('\n')) {
    n++;
    // Cheap filters first: transcripts run to megabytes, and only these lines matter.
    const isHook =
      line.includes('"hook_additional_context"') &&
      (line.includes(MACHINE_LINE_PREFIX) || line.includes(TOPIC_LINE_PREFIX));
    const isTitle = line.includes('"ai-title"') || line.includes('"last-prompt"');
    const isUser = line.includes('"type":"user"');
    if (!turns && isUser) turns = true;
    const isTurn = isUser && !line.includes('"tool_result"');
    const isSkill = wraps.size > 0 && line.includes('"name":"Skill"');
    if (!isHook && !isTitle && !isTurn && !isSkill) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const type = at(entry, 'type');
    const title = str(at(entry, 'aiTitle'));
    const prompt = str(at(entry, 'lastPrompt'));
    if (type === 'user') {
      const said = userText(entry);
      if (!said) continue;
      const command = said.match(COMMAND_RE)?.[1];
      if (command === 'clear' && typed === 0) bornClear = true;
      else if (command && wraps.has(command)) wrapAt = n;
      // `!` commands, hooks' and channels' texts come tagged; a prompt the person typed does not.
      else if (!command && !said.startsWith('<')) {
        typed++;
        typedAt = n;
      }
    } else if (type === 'assistant') {
      const skill = skillRun(entry);
      if (skill && wraps.has(skill)) wrapAt = n;
    } else if (type === 'ai-title' && title !== undefined) aiTitle = title;
    else if (type === 'last-prompt' && prompt !== undefined) lastPrompt = prompt;
    else if (type === 'attachment' && at(entry, 'attachment', 'type') === 'hook_additional_context') {
      const content = at(entry, 'attachment', 'content');
      for (const part of Array.isArray(content) ? (content as unknown[]) : [content]) {
        if (typeof part !== 'string') continue;
        const label = part.match(MACHINE_LINE_RE)?.[1];
        if (label && LABEL_RE.test(label)) {
          machine = label;
          // The same text says whether that start was a mail session's.
          mail = part.includes(MAIL_LINE_PREFIX);
        }
        topic = part.match(TOPIC_LINE_RE)?.[1] ?? topic;
      }
    }
  }
  if (!turns) return null;
  const id = path.basename(file, '.jsonl');
  return {
    id,
    updated,
    machine,
    typedHere: false,
    title: aiTitle ?? lastPrompt,
    mail,
    topic,
    bornClear,
    typed,
    finished: wrapAt > typedAt,
  };
}

/** The last topic of the project's conversation `id`; null — none, or no such conversation here. */
export function conversationTopic(input: {
  env: NodeJS.ProcessEnv;
  home: string;
  projectRoot: string;
  id: string;
}): string | null {
  const roots = new Set([input.projectRoot]);
  try {
    roots.add(fs.realpathSync(input.projectRoot));
  } catch {
    /* the plain path is enough */
  }
  for (const root of roots) {
    const file = path.join(
      claudeConfigDir(input.env, input.home),
      'projects',
      projectDirName(root),
      `${input.id}.jsonl`,
    );
    const topic = readConversation(file, new Date())?.topic;
    if (topic) return topic;
  }
  return null;
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

interface ProjectInput {
  env: NodeJS.ProcessEnv;
  home: string;
  projectRoot: string;
}

/** The project's transcript files, newest first — Syncthing's conflict copies left out. */
export function conversationFiles(input: ProjectInput): { file: string; updated: Date; size: number }[] {
  const roots = new Set([input.projectRoot]);
  try {
    roots.add(fs.realpathSync(input.projectRoot));
  } catch {
    /* the plain path is enough */
  }
  const files: { file: string; updated: Date; size: number }[] = [];
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
        const st = fs.statSync(file);
        files.push({ file, updated: st.mtime, size: st.size });
      } catch {
        /* gone since the listing */
      }
    }
  }
  return files.sort((a, b) => b.updated.getTime() - a.updated.getTime());
}

/**
 * The project's conversations, newest first; at most `limit` files are read — the rest stay
 * unread, `conversationFiles` counts them. `wrapSkills` as in readConversation.
 */
export function listConversations(
  input: ProjectInput & { limit?: number; wrapSkills?: readonly string[] },
): Conversation[] {
  const files = conversationFiles(input);
  const seen = new Set<string>();
  const out: Conversation[] = [];
  for (const f of files.slice(0, input.limit ?? 30)) {
    const c = readConversation(f.file, f.updated, input.wrapSkills);
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
export function latestPerMachine(
  conversations: Conversation[],
  machine: (c: Conversation) => string | null,
): Conversation[] {
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
    const data: unknown = JSON.parse(
      fs.readFileSync(path.join(claudeConfigDir(env, home), 'sessions', `${pid}.json`), 'utf8'),
    );
    const id = str(at(data, 'sessionId'));
    return id !== undefined && isConversationId(id) ? id : null;
  } catch {
    return null;
  }
}

/** A running Claude Code process as its session file has it; null — no file, or not one of its. */
export function liveSessionFile(
  env: NodeJS.ProcessEnv,
  home: string,
  pid: number,
): { conversation: string; status: string | null; activeAt: number | null; startedAt: number | null } | null {
  try {
    const data: unknown = JSON.parse(
      fs.readFileSync(path.join(claudeConfigDir(env, home), 'sessions', `${pid}.json`), 'utf8'),
    );
    const id = str(at(data, 'sessionId'));
    if (id === undefined || !isConversationId(id)) return null;
    const num = (v: unknown) => (typeof v === 'number' ? v : null);
    return {
      conversation: id,
      status: str(at(data, 'status')) ?? null,
      activeAt: num(at(data, 'statusUpdatedAt')) ?? num(at(data, 'updatedAt')),
      startedAt: num(at(data, 'startedAt')),
    };
  } catch {
    return null;
  }
}

/** The project's conversation `id` as read here; null — no such transcript here. */
export function conversationById(
  input: ProjectInput & { id: string; wrapSkills?: readonly string[] },
): Conversation | null {
  const roots = new Set([input.projectRoot]);
  try {
    roots.add(fs.realpathSync(input.projectRoot));
  } catch {
    /* the plain path is enough */
  }
  for (const root of roots) {
    const file = path.join(
      claudeConfigDir(input.env, input.home),
      'projects',
      projectDirName(root),
      `${input.id}.jsonl`,
    );
    let updated: Date;
    try {
      updated = fs.statSync(file).mtime;
    } catch {
      continue;
    }
    const c = readConversation(file, updated, input.wrapSkills);
    if (c) return { ...c, typedHere: typedHere(input.env, input.home, new Set([c.id])).has(c.id) };
  }
  return null;
}

/** When a running Claude Code process started (ms), from the same session file; null — not known. */
export function liveStartedAt(env: NodeJS.ProcessEnv, home: string, pid: number): number | null {
  try {
    const file = path.join(claudeConfigDir(env, home), 'sessions', `${pid}.json`);
    const started = at(JSON.parse(fs.readFileSync(file, 'utf8')), 'startedAt');
    return typeof started === 'number' ? started : null;
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
  /** The directory it was started in — on its own machine. */
  cwd: string | null;
}

/** Session files, one JSON object per line — a file read here, or the output of LIVE_SESSIONS_SCRIPT. */
function parseLiveSessions(text: string): LiveSession[] {
  const out: LiveSession[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let data: Record<string, unknown> | undefined;
    try {
      data = dict(JSON.parse(line));
    } catch {
      continue;
    }
    const pid = data?.['pid'];
    const conversation = str(data?.['sessionId']);
    if (typeof pid !== 'number' || !Number.isInteger(pid) || conversation === undefined) continue;
    if (!isConversationId(conversation)) continue;
    out.push({
      pid,
      conversation,
      tmux: str(data?.['tmux']) ?? null,
      status: str(data?.['status']) ?? null,
      cwd: str(data?.['cwd']) ?? null,
    });
  }
  return out;
}

/** `~/AI Projects/x` for a path under `home`; any other path as is. */
function fromHome(p: string, home: string): string {
  const rel = path.relative(home, p);
  if (rel === '') return '~';
  return rel.startsWith('..') || path.isAbsolute(rel) ? p : `~/${rel}`;
}

/**
 * The session runs in the project: its directory is the project's root or
 * below it. Paths of two machines are compared from their homes — `vdx
 * ai@<host>` puts a project under the same place in the other home; with that
 * home unknown, as they are.
 */
export function runsInProject(live: LiveSession, liveHome: string | null, projectRoot: string, home: string): boolean {
  if (!live.cwd) return false;
  const cwd = liveHome ? fromHome(live.cwd, liveHome) : live.cwd;
  const root = liveHome ? fromHome(projectRoot, home) : projectRoot;
  return cwd === root || cwd.startsWith(root.endsWith('/') ? root : `${root}/`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return at(e, 'code') === 'EPERM';
  }
}

/**
 * Prints the session file of every Claude Code process alive on the machine it
 * runs on, one per line — what `vdx ai` asks another machine over ssh. Claude
 * removes the file of a process that ended, but not after a crash or a reboot:
 * the pid is checked. `<pid>.sync-conflict-….json` is not a session file.
 * The first line, `home=<dir>`, places the sessions' directories in that
 * machine's home (see runsInProject).
 */
export const LIVE_SESSIONS_SCRIPT =
  'printf "home=%s\\n" "$HOME"; ' +
  'd="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions"; for f in "$d"/*.json; do ' +
  'p=${f##*/}; p=${p%.json}; case $p in ""|*[!0-9]*) continue;; esac; ' +
  'kill -0 "$p" 2>/dev/null && tr -d "\\n" < "$f" && echo; done; exit 0';

/** Claude Code processes alive on this machine. */
export function liveSessionsHere(
  env: NodeJS.ProcessEnv,
  home: string,
  alive: (pid: number) => boolean = pidAlive,
): LiveSession[] {
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

/** What another machine runs right now: its home and the Claude Code sessions alive there. */
export interface MachineReport {
  home: string | null;
  sessions: LiveSession[];
}

/** The output of LIVE_SESSIONS_SCRIPT. */
export function parseMachineReport(text: string): MachineReport {
  return { home: text.match(/^home=(.+)$/m)?.[1] ?? null, sessions: parseLiveSessions(text) };
}

/**
 * "running on m3 now (t23b-program@m3, waiting)" — where a live session is, for
 * a person choosing; `place` is the machine as they see it: "here", "on m3".
 */
export function describeLive(place: string, live: LiveSession): string {
  const where = live.tmux ? live.tmux.replace(/:.*$/, '') : `pid ${live.pid}`;
  return `running ${place} now (${where}${live.status ? `, ${live.status}` : ''})`;
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
