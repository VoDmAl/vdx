import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import YAML from 'js-yaml';
import { evalPredicate } from './evaluator.ts';
import { GIT_HOOK_EVENTS } from './hooks.ts';
import { autoDetectStack, readStructured, resolveConfigPath, type Ctx } from './facts.ts';
import { loadManifestAt } from './manifest.ts';
import { type Author, effectiveAuthor, isGitRepo, rankAuthors, scanPool, writeAuthor } from './author.ts';
import type { Predicate } from './rubric.ts';
import {
  claudeTrusts,
  type Conversation,
  conversationTopic,
  describeConversation,
  describeAge,
  describeLive,
  isMachineLabel,
  LIVE_SESSIONS_SCRIPT,
  type LiveSession,
  latestPerMachine,
  listConversations,
  liveConversationId,
  liveSessionsHere,
  liveStartedAt,
  MAIL_LINE_PREFIX,
  machineLine,
  type MachineReport,
  machineOf,
  conversationById,
  conversationFiles,
  isEmpty,
  liveSessionFile,
  typedHere,
  parseMachineReport,
  runsInProject,
  topicLine,
} from './conversations.ts';
import {
  describeMemory,
  fixProjectMemory,
  memoryApplies,
  memoryNeedsFix,
  memoryState,
  personalHosts,
  type PersonalHost,
} from './memory.ts';
import { at, errorMessage, isStringList, str } from './narrow.ts';
import { CMUX_TOKEN_ENV_VAR, CMUX_TOKEN_OPTION, cmuxToken, watchTopic } from './cmux.ts';
import { type Lag, sessionLag } from './session-versions.ts';
import {
  type AgentFact,
  type Board,
  buildBoard,
  freeWork,
  inputDraft,
  openAtSeat,
  type Pick,
  readAnswer,
} from './board.ts';

/**
 * `vdx ai` — start the person's agent in a project, with the flags their
 * profile asks for. vdx runs nothing itself: it builds the agent's command line
 * and hands it to tmux, or runs it in this terminal when tmux is not wanted or
 * not installed.
 *
 * A start continues the project's last conversation (the profile's
 * `resume_args`) — after a reboot `vdx ai` brings the agent back where it was;
 * `--new` starts a new conversation. For Claude Code vdx picks the
 * conversation itself, and continues another machine's on that machine
 * (see chooseConversation).
 *
 * The profile is personal (which agent, which permissions), so it is never
 * bundled into the CLI: it is read from `$VDX_ENVIRONMENT` or
 * `~/.vdx-environment.yaml`. Without one, vdx starts a plain `claude` or
 * `codex` with no flags. @see docs/specs/environment-format.md
 */

/** A prompt a conditional flag is known to cause, and the tmux keys that answer it. */
interface ConfirmRule {
  screen: string;
  keys: string[];
}

interface WhenRule {
  id: string;
  description?: string;
  if: Predicate;
  args?: string[];
  confirm?: ConfirmRule[];
  /** The rule is there to wake the agent: a focused session (`vdx ai --focused`) leaves it out. */
  wakes?: boolean;
}

export interface AgentProfile {
  command: string;
  args?: string[];
  resume_args?: string[];
  /** What a mail session (`vdx ai --intercom`) starts with, right after the command: its first prompt. */
  intercom_args?: string[];
  when?: WhenRule[];
}

type Multiplexer = 'tmux' | 'none';

/** A place a project's short name may come from: a structured file and a dot path into it. */
export interface NameSource {
  /** `{repo}` is the repository name; `~` the home directory; relative to the profile's directory. */
  file: string;
  jsonpath: string;
}

interface SessionProfile {
  multiplexer?: Multiplexer;
  name?: string;
  /** Tried after `[_.vdx] name` (or the older `[vdx]`) in the project's mise.toml; the first non-empty string wins. */
  project_names?: NameSource[];
  /** The machines a project's agent may run on, as ssh destinations; vdx asks the others what runs there. */
  machines?: string[];
  /** What to do when a session cannot read ~/Downloads, ~/Desktop or ~/Documents (macOS): shown after the warning. */
  folders_fix?: string;
  /**
   * Skills that end a conversation (`vdm:wrap`): run, and nothing typed after, the list calls it
   * finished, and Enter passes it by (vdx-ai-predictable DL #3).
   */
  wrap_skills?: string[];
}

/**
 * A personal hook: the owner's own gate, kept in git's user config
 * (`hook.<name>.event` / `.command`, Git 2.54) instead of in every repository.
 * `vdx doctor` checks it is there, `vdx doctor --fix` writes it.
 */
export interface PersonalHook {
  name: string;
  /** Git hook event(s): `pre-commit`, … */
  event: string | string[];
  /** Run by git through the shell; `$HOME` and quotes work as in a hook script. */
  command: string;
  /** The hook applies on a machine where this path exists (the tool is installed); `~` is home. */
  when_exists?: string;
  description?: string;
}

interface GitProfile {
  /** Directories whose repos are the neighbours an author is proposed from; default — the project's parent. */
  author_pool?: string[];
  hooks?: PersonalHook[];
  /**
   * Hosts whose repos are the owner's alone, and where their repos are mirrored: Claude Code's
   * memory goes under git only where nobody else reads (claude-memory-in-project).
   */
  personal_hosts?: Array<string | { host: string; mirrors?: string[] }>;
}

/**
 * A command `vdx move` runs here once a project's folder has moved, for a tool that
 * keeps the project's path in its own files (claude-memory-in-project DL #17).
 */
export interface MoveHook {
  name: string;
  /** Run through the shell, with VDX_MOVE_FROM and VDX_MOVE_TO set to the old and new path. */
  command: string;
  /** Runs on a machine where this path exists (the tool is installed); `~` is home. */
  when_exists?: string;
  description?: string;
}

interface MoveProfile {
  after?: MoveHook[];
}

export interface Environment {
  schema_version?: string;
  metadata?: Record<string, unknown>;
  agent?: AgentProfile;
  session?: SessionProfile;
  git?: GitProfile;
  move?: MoveProfile;
}

const ENVIRONMENT_ENV_VAR = 'VDX_ENVIRONMENT';
const HOST_ENV_VAR = 'VDX_HOST';
/** Set by `vdx ai@<host>` for the vdx it starts there: the machine the person sits at. */
const SEAT_ENV_VAR = 'VDX_AI_FROM';
/**
 * `1` in the environment of an agent started with `vdx ai --focused`, and so of
 * its hooks and MCP servers: nothing wakes this session or reads its inbox for it.
 */
const FOCUSED_ENV_VAR = 'VDX_FOCUSED';
/**
 * `1` in the environment of the project's mail session (`vdx ai --intercom`): the
 * session letters and wakes go to, so that the person's own session stays quiet.
 * Nobody sits at it; it ends itself with `vdx ai --close`.
 */
const INTERCOM_ENV_VAR = 'VDX_INTERCOM';
/**
 * In the environment of the tmux client `vdx ai` attaches: the seat — the machine the person
 * sits at — so that another start can tell a terminal at the same seat from one at another
 * (vdx-ai-predictable DL #2). tmux does not copy it into the session's environment.
 */
const SEAT_MARK_ENV_VAR = 'VDX_AI_SEAT';
/** The tmux session option `vdx ai --close --waiting <n>` sets: questions to the person still unanswered. */
const WAITING_OPTION = '@vdx_waiting';
/**
 * The tmux session option with a focused session's topic (focused-topic DL #2): set by `vdx ai`
 * at a start and by the session's own agent; read by the terminal's title, the vdx plugin's
 * prompt hook and intercom. Every agent has a tmux session of its own (vdx-ai DL #36).
 */
const TOPIC_OPTION = '@vdx_topic';
/** A mail session's pane closes this long after `--close`, so the call returns and the turn ends. */
const CLOSE_DELAY_S = 2;
const USER_ENVIRONMENT_FILE = '.vdx-environment.yaml';
/** Tried in order when no profile names an agent. Started plain, with no flags. */
const FALLBACK_AGENTS = ['claude', 'codex'] as const;
const DEFAULT_SESSION_NAME = '{project}';

export function resolveEnvironmentPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string | null {
  const explicit = env[ENVIRONMENT_ENV_VAR];
  if (explicit) return path.resolve(explicit.replace(/^~(?=$|\/)/, home));
  const user = path.join(home, USER_ENVIRONMENT_FILE);
  return fs.existsSync(user) ? user : null;
}

/** Parse and validate a profile. Throws with the offending key named. */
export function parseEnvironment(text: string, source: string): Environment {
  const data: unknown = YAML.load(text);
  if (data === null || data === undefined) return {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${source}: expected a YAML mapping at the top level`);
  }
  const envDoc = data as Environment;
  const fail = (key: string, what: string): never => {
    throw new Error(`${source}: ${key} ${what}`);
  };

  const agent = envDoc.agent;
  if (agent !== undefined) {
    if (typeof agent !== 'object' || agent === null) fail('agent', 'must be a mapping');
    if (typeof agent.command !== 'string' || agent.command.trim() === '') {
      fail('agent.command', 'must be a non-empty string');
    }
    for (const key of ['args', 'resume_args', 'intercom_args'] as const) {
      if (agent[key] !== undefined && !isStringList(agent[key])) {
        fail(`agent.${key}`, 'must be a list of strings');
      }
    }
    if (agent.when !== undefined) {
      if (!Array.isArray(agent.when)) fail('agent.when', 'must be a list');
      agent.when.forEach((rule, i) => {
        const at = `agent.when[${i}]`;
        if (typeof rule !== 'object' || rule === null) fail(at, 'must be a mapping');
        if (typeof rule.id !== 'string' || rule.id === '') fail(`${at}.id`, 'must be a non-empty string');
        if (rule.if === undefined) fail(`${at}.if`, 'is required (a rubric predicate)');
        if (rule.args !== undefined && !isStringList(rule.args)) {
          fail(`${at}.args`, 'must be a list of strings');
        }
        if (rule.wakes !== undefined && typeof rule.wakes !== 'boolean') fail(`${at}.wakes`, 'must be true or false');
        if (rule.confirm !== undefined) {
          if (!Array.isArray(rule.confirm)) fail(`${at}.confirm`, 'must be a list');
          rule.confirm.forEach((c, j) => {
            const cat = `${at}.confirm[${j}]`;
            if (typeof c?.screen !== 'string' || c.screen === '') {
              fail(`${cat}.screen`, 'must be a non-empty string');
            }
            if (!isStringList(c.keys) || c.keys.length === 0) {
              fail(`${cat}.keys`, 'must be a non-empty list of tmux key names');
            }
          });
        }
      });
    }
  }

  const session = envDoc.session;
  if (session !== undefined) {
    if (typeof session !== 'object' || session === null) fail('session', 'must be a mapping');
    if (session.multiplexer !== undefined && !['tmux', 'none'].includes(session.multiplexer)) {
      fail('session.multiplexer', 'must be "tmux" or "none"');
    }
    if (session.name !== undefined && typeof session.name !== 'string') {
      fail('session.name', 'must be a string');
    }
    if (session.project_names !== undefined) {
      if (!Array.isArray(session.project_names)) fail('session.project_names', 'must be a list');
      session.project_names.forEach((src, i) => {
        const at = `session.project_names[${i}]`;
        if (typeof src !== 'object' || src === null) fail(at, 'must be a mapping');
        if (typeof src.file !== 'string' || src.file === '') fail(`${at}.file`, 'must be a non-empty string');
        const unknown = src.file.match(/\{(?!repo\})\w+\}/);
        if (unknown) fail(`${at}.file`, `has an unknown placeholder ${unknown[0]} (only {repo})`);
        if (typeof src.jsonpath !== 'string' || src.jsonpath === '') {
          fail(`${at}.jsonpath`, 'must be a non-empty string (a dot path, e.g. names.0)');
        }
      });
    }
    if (session.machines !== undefined) {
      if (!isStringList(session.machines)) fail('session.machines', 'must be a list of machine names');
      session.machines.forEach((m, i) => {
        if (!isMachineLabel(m))
          fail(`session.machines[${i}]`, 'must be an ssh destination: letters, digits, . _ - and no leading -');
      });
    }
    if (
      session.folders_fix !== undefined &&
      (typeof session.folders_fix !== 'string' || session.folders_fix.trim() === '')
    ) {
      fail('session.folders_fix', 'must be a non-empty string');
    }
    if (session.wrap_skills !== undefined && !isStringList(session.wrap_skills)) {
      fail('session.wrap_skills', 'must be a list of skill names');
    }
  }

  const gitDoc = envDoc.git;
  if (gitDoc !== undefined) {
    if (typeof gitDoc !== 'object' || gitDoc === null) fail('git', 'must be a mapping');
    if (gitDoc.author_pool !== undefined && !isStringList(gitDoc.author_pool)) {
      fail('git.author_pool', 'must be a list of directories');
    }
    if (gitDoc.personal_hosts !== undefined) {
      if (!Array.isArray(gitDoc.personal_hosts)) fail('git.personal_hosts', 'must be a list');
      gitDoc.personal_hosts.forEach((h, i) => {
        const at = `git.personal_hosts[${i}]`;
        if (typeof h === 'string') {
          if (h.trim() === '') fail(at, 'must be a host name');
          return;
        }
        if (typeof h !== 'object' || h === null || typeof h.host !== 'string' || h.host.trim() === '') {
          fail(at, 'must be a host name, or a mapping with host');
        }
        if (h.mirrors !== undefined && (!isStringList(h.mirrors) || !h.mirrors.every((m) => m.includes('{repo}')))) {
          fail(`${at}.mirrors`, 'must be a list of places like github.com/<owner>/{repo}');
        }
      });
    }
    if (gitDoc.hooks !== undefined) {
      if (!Array.isArray(gitDoc.hooks)) fail('git.hooks', 'must be a list');
      const names = new Set<string>();
      gitDoc.hooks.forEach((h, i) => {
        const at = `git.hooks[${i}]`;
        if (typeof h !== 'object' || h === null) fail(at, 'must be a mapping');
        if (typeof h.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(h.name)) {
          fail(`${at}.name`, 'must be a name of letters, digits, . _ - (the git config subsection)');
        }
        if (names.has(h.name)) fail(`${at}.name`, `"${h.name}" is declared twice`);
        names.add(h.name);
        const events = Array.isArray(h.event) ? h.event : [h.event];
        if (events.length === 0 || !events.every((e) => typeof e === 'string' && GIT_HOOK_EVENTS.has(e))) {
          fail(`${at}.event`, 'must be a git hook event (pre-commit, pre-push, …) or a list of them');
        }
        if (typeof h.command !== 'string' || h.command.trim() === '')
          fail(`${at}.command`, 'must be a non-empty string');
        if (h.when_exists !== undefined && (typeof h.when_exists !== 'string' || h.when_exists === '')) {
          fail(`${at}.when_exists`, 'must be a path');
        }
      });
    }
  }

  const moveDoc = envDoc.move;
  if (moveDoc !== undefined) {
    if (typeof moveDoc !== 'object' || moveDoc === null || Array.isArray(moveDoc)) fail('move', 'must be a mapping');
    if (moveDoc.after !== undefined) {
      if (!Array.isArray(moveDoc.after)) fail('move.after', 'must be a list');
      moveDoc.after.forEach((h, i) => {
        const at = `move.after[${i}]`;
        if (typeof h !== 'object' || h === null) fail(at, 'must be a mapping');
        if (typeof h.name !== 'string' || h.name.trim() === '') fail(`${at}.name`, 'must be a non-empty string');
        if (typeof h.command !== 'string' || h.command.trim() === '')
          fail(`${at}.command`, 'must be a non-empty string');
        if (h.when_exists !== undefined && (typeof h.when_exists !== 'string' || h.when_exists === '')) {
          fail(`${at}.when_exists`, 'must be a path');
        }
      });
    }
  }
  return envDoc;
}

export function loadEnvironment(file: string): Environment {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`cannot read profile ${file}: ${str(at(e, 'code')) ?? errorMessage(e)}`, { cause: e });
  }
  return parseEnvironment(text, file);
}

export function fallbackAgent(onPath: (bin: string) => boolean): AgentProfile | null {
  const found = FALLBACK_AGENTS.find((bin) => onPath(bin));
  return found ? { command: found } : null;
}

/**
 * tmux turns `.` and `:` in a session name into `_`; doing it here keeps the
 * name vdx looks up equal to the name tmux stores.
 */
export function renderSessionName(template: string, vars: Record<string, string>): string {
  const name = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = vars[key];
    if (v === undefined) throw new Error(`session.name: unknown placeholder {${key}}`);
    return v;
  });
  return name.replace(/[.:]/g, '_');
}

/**
 * The session for an agent started next to running ones: `name`, `name-2`, `name-3`… — the
 * first no agent of the project runs in (absent, or a shell left behind). Each agent has a
 * session of its own: tmux keeps one current window per session, and an agent started as a
 * window next to another moved every terminal on the session to it (vdx-ai DL #36).
 */
export function freeSessionName(name: string, running: { pane: { session: string } }[]): string {
  const busy = new Set(running.map((a) => a.pane.session));
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name}-${n}`;
    if (!busy.has(candidate)) return candidate;
  }
}

export interface LaunchPlan {
  projectRoot: string;
  project: string;
  /** Where `project` came from: mise.toml, a profile source, or the repository name. */
  projectSource: string;
  host: string;
  /** The machine the person sits at: `host`, or the one that ran `vdx ai@<host>`. */
  seat: string;
  profilePath: string | null;
  command: string;
  /** agent.args plus the args of every matched `when` rule — what a running agent must carry. */
  args: string[];
  resumeArgs: string[];
  matched: string[];
  /** `vdx ai --focused`: the agent gets VDX_FOCUSED=1, and the rules that wake it are left out. */
  focused: boolean;
  /** Matched rules a focused session leaves out (`wakes: true`). */
  skipped: string[];
  /** `vdx ai --intercom`: the project's mail session — VDX_INTERCOM=1, a session `<name>-mail`. */
  intercom: boolean;
  /** agent.intercom_args: what a mail session starts with; not required of a running agent. */
  intercomArgs: string[];
  confirm: ConfirmRule[];
  multiplexer: Multiplexer;
  sessionName: string;
  /** The profile's other machines — asked over ssh what runs there before a start. */
  machines: string[];
}

export function planLaunch(input: {
  environment: Environment;
  profilePath: string | null;
  agent: AgentProfile;
  projectRoot: string;
  project: string;
  projectSource?: string;
  host: string;
  seat?: string;
  focused?: boolean;
  intercom?: boolean;
}): LaunchPlan {
  const { environment, agent, projectRoot } = input;
  const focused = input.focused === true;
  const intercom = input.intercom === true && !focused;
  const ctx: Ctx = { projectRoot, stack: autoDetectStack(projectRoot), cache: new Map() };
  const args = [...(agent.args ?? [])];
  const matched: string[] = [];
  const skipped: string[] = [];
  const confirm: ConfirmRule[] = [];
  for (const rule of agent.when ?? []) {
    if (!evalPredicate(rule.if, ctx)) continue;
    if (focused && rule.wakes) {
      skipped.push(rule.id);
      continue;
    }
    matched.push(rule.id);
    args.push(...(rule.args ?? []));
    confirm.push(...(rule.confirm ?? []));
  }
  return {
    projectRoot,
    project: input.project,
    projectSource: input.projectSource ?? 'repository name',
    host: input.host,
    seat: input.seat ?? input.host,
    profilePath: input.profilePath,
    command: agent.command,
    args,
    resumeArgs: [...(agent.resume_args ?? [])],
    matched,
    focused,
    skipped,
    intercom,
    intercomArgs: intercom ? [...(agent.intercom_args ?? [])] : [],
    confirm,
    multiplexer: environment.session?.multiplexer ?? 'none',
    sessionName:
      renderSessionName(environment.session?.name ?? DEFAULT_SESSION_NAME, {
        project: input.project,
        host: input.host,
      }) + (intercom ? '-mail' : ''),
    machines: (environment.session?.machines ?? []).filter((m) => m.toLowerCase() !== input.host.toLowerCase()),
  };
}

export function shellQuote(s: string): string {
  if (s !== '' && /^[A-Za-z0-9_/.:@%+=,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function commandLine(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(' ');
}

/**
 * The pane runs the agent inside the user's login shell, so the agent sees what
 * `.zshrc` sets up exactly as when it is typed by hand; the tmux server's own
 * environment does not have it. When the agent exits, the pane keeps a shell —
 * unless `keepShell` is false (a mail session: its tab goes when it is done).
 */
export function tmuxShellCommand(line: string, shell: string | null, keepShell = true): string {
  if (!shell) return line;
  const sh = shellQuote(shell);
  return `exec ${sh} -lic ${shellQuote(keepShell ? `${line}; exec ${sh} -l` : line)}`;
}

export interface PaneInfo {
  session: string;
  paneId: string;
  panePid: number;
  cwd: string;
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  args: string;
}

const PANE_FORMAT = '#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_path}';

export function parsePanes(out: string): PaneInfo[] {
  const panes: PaneInfo[] = [];
  for (const line of out.split('\n')) {
    const [session, paneId, pid, cwd] = line.split('\t');
    if (!session || !paneId || !pid || cwd === undefined) continue;
    panes.push({ session, paneId, panePid: Number(pid), cwd });
  }
  return panes;
}

export function parsePs(out: string): ProcInfo[] {
  const procs: ProcInfo[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3]!.trim() });
  }
  return procs;
}

/** `pid` itself and everything below it. */
export function processTree(procs: ProcInfo[], pid: number): ProcInfo[] {
  const byParent = new Map<number, ProcInfo[]>();
  for (const p of procs) {
    const list = byParent.get(p.ppid) ?? [];
    list.push(p);
    byParent.set(p.ppid, list);
  }
  const tree: ProcInfo[] = [];
  const self = procs.find((p) => p.pid === pid);
  if (self) tree.push(self);
  const queue = [pid];
  while (queue.length > 0) {
    for (const child of byParent.get(queue.shift()!) ?? []) {
      tree.push(child);
      queue.push(child.pid);
    }
  }
  return tree;
}

const INTERPRETERS = new Set(['node', 'bun', 'deno', 'python', 'python3', 'ruby', 'sh', 'bash', 'zsh', 'dash']);

/** Is this process the agent — run directly, or as a script under an interpreter? */
export function isAgentProcess(proc: ProcInfo, command: string): boolean {
  const want = path.basename(command);
  const [first, second] = proc.args.split(/\s+/);
  if (!first) return false;
  if (path.basename(first) === want) return true;
  return INTERPRETERS.has(path.basename(first)) && !!second && path.basename(second) === want;
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

export interface AgentPane {
  pane: PaneInfo;
  proc: ProcInfo;
}

/**
 * The project's running agent is found by what runs, not by session name: a
 * pane whose working directory lies in the project, with the agent below it.
 */
export function findAgentPanes(
  panes: PaneInfo[],
  procs: ProcInfo[],
  projectRoot: string,
  command: string,
): AgentPane[] {
  const root = realpathOr(projectRoot);
  const found: AgentPane[] = [];
  for (const pane of panes) {
    if (!isInside(realpathOr(pane.cwd), root)) continue;
    const proc = processTree(procs, pane.panePid).find((p) => isAgentProcess(p, command));
    if (proc) found.push({ pane, proc });
  }
  return found;
}

/** Required args absent from a process's command line (`ps` joins argv with spaces). */
export function missingArgs(procArgs: string, required: string[]): string[] {
  const tokens = new Set(procArgs.split(/\s+/));
  return required.filter((a) => (/\s/.test(a) ? !procArgs.includes(a) : !tokens.has(a)));
}

/** The git checkout `p` is in (its top), else the directory itself; null when `p` is no directory. */
export function resolveProjectRoot(p: string): string | null {
  const abs = path.resolve(p);
  try {
    if (!fs.statSync(abs).isDirectory()) return null;
  } catch {
    return null;
  }
  try {
    const top = execFileSync('git', ['-C', abs, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (top) return realpathOr(top);
  } catch {
    /* not a git checkout — the directory itself is the project */
  }
  return realpathOr(abs);
}

/** `{project}`: the origin remote's repository name, else the directory name. */
export function projectIdentity(projectRoot: string): string {
  try {
    const url = execFileSync('git', ['-C', projectRoot, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const slug = url
      .replace(/\/+$/, '')
      .replace(/\.git$/, '')
      .split(/[/:]/)
      .pop();
    if (slug) return slug.toLowerCase();
  } catch {
    /* no git or no origin */
  }
  return path.basename(projectRoot);
}

export interface ProjectName {
  name: string;
  source: string;
}

/**
 * `{project}`: `[_.vdx] name` (or the older `[vdx]`) in the project's mise.toml, else the first profile
 * source holding a non-empty string, else the repository name. A source that is
 * missing or unreadable is skipped — a name is a label, not a reason to fail.
 */
export function resolveProjectName(input: {
  projectRoot: string;
  repo: string;
  sources: NameSource[];
  home: string;
  profileDir: string;
}): ProjectName {
  const found = loadManifestAt(input.projectRoot);
  const own = found?.manifest.name;
  if (typeof own === 'string' && own.trim()) return { name: own.trim(), source: `mise.toml [${found!.place}] name` };
  for (const src of input.sources) {
    const file = path.resolve(
      input.profileDir,
      src.file.replace(/^~(?=$|\/)/, input.home).replace(/\{repo\}/g, input.repo),
    );
    // Readers take paths relative to a project root; from "/" an absolute path stays itself.
    const value = resolveConfigPath(
      readStructured({ projectRoot: '/', stack: '', cache: new Map() }, file),
      src.jsonpath,
    );
    if (typeof value === 'string' && value.trim()) {
      const shown = file.startsWith(input.home + path.sep) ? `~${file.slice(input.home.length)}` : file;
      return { name: value.trim(), source: `${shown} ${src.jsonpath}` };
    }
  }
  return { name: input.repo, source: 'repository name' };
}

/** `{host}`: `$VDX_HOST` when set (a machine label such as `lft`), else the short hostname. */
export function hostLabel(env: NodeJS.ProcessEnv = process.env): string {
  const label = env[HOST_ENV_VAR]?.trim();
  return label || os.hostname().split('.')[0]!;
}

/** The machine the person sits at: the one whose `vdx ai@<host>` started this vdx, else this one. */
function seatLabel(env: NodeJS.ProcessEnv = process.env): string {
  return env[SEAT_ENV_VAR]?.trim() || hostLabel(env);
}

/** Machine labels compare without case: `M3` in the profile is `m3` in a transcript. */
function sameMachine(a: string | null, b: string | null): boolean {
  return (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
}

export function onPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}

export function listProcesses(): ProcInfo[] {
  // -A (all processes) means the same on macOS and Linux; -e does not.
  return parsePs(execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' }));
}

export class Tmux {
  constructor(private readonly socket: string | null = null) {}

  /** `-L <name>`: the server's socket name; null — the default server. */
  get socketName(): string | null {
    return this.socket;
  }

  private argv(args: string[]): string[] {
    return this.socket ? ['-L', this.socket, ...args] : args;
  }

  available(): boolean {
    try {
      execFileSync('tmux', ['-V'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * `-u`: outside tmux and without a UTF-8 locale (`ssh host vdx ai`, launchd)
   * tmux prints the tabs of PANE_FORMAT as `_`, and every pane would be
   * dropped — the running agent unseen, a second one started.
   */
  run(args: string[]): string {
    return execFileSync('tmux', ['-u', ...this.argv(args)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  tryRun(args: string[]): string | null {
    try {
      return this.run(args);
    } catch {
      return null;
    }
  }

  /** Every pane on the server; none when no server is running. */
  panes(): PaneInfo[] {
    const out = this.tryRun(['list-panes', '-a', '-F', PANE_FORMAT]);
    return out ? parsePanes(out) : [];
  }

  hasSession(name: string): boolean {
    return this.tryRun(['has-session', '-t', `=${name}`]) !== null;
  }

  newSession(name: string, cwd: string, cmd: string): string {
    return this.run(['new-session', '-d', '-s', name, '-c', cwd, '-P', '-F', '#{pane_id}', cmd]).trim();
  }

  newWindow(session: string, cwd: string, cmd: string): string {
    return this.run(['new-window', '-d', '-t', `=${session}:`, '-c', cwd, '-P', '-F', '#{pane_id}', cmd]).trim();
  }

  respawn(paneId: string, cwd: string, cmd: string): void {
    this.run(['respawn-pane', '-k', '-t', paneId, '-c', cwd, cmd]);
  }

  /** Visible screen with wrapped lines joined, so a matched phrase is not split by the pane width. */
  capture(paneId: string): string | null {
    return this.tryRun(['capture-pane', '-p', '-J', '-t', paneId]);
  }

  /** The visible screen with its escapes: what is dim on it can be told apart (board.ts, inputDraft). */
  screen(paneId: string): string | null {
    return this.tryRun(['capture-pane', '-p', '-e', '-t', paneId]);
  }

  /** The terminals attached to the server: each one's session and its tmux client process. */
  clients(): { session: string; pid: number }[] {
    const out = this.tryRun(['list-clients', '-F', '#{client_session}\t#{client_pid}']);
    return (out ?? '').split('\n').flatMap((line) => {
      const [session, pid] = line.split('\t');
      return session && pid && /^\d+$/.test(pid) ? [{ session, pid: Number(pid) }] : [];
    });
  }

  sendKey(paneId: string, key: string): void {
    this.run(['send-keys', '-t', paneId, key]);
  }

  panePid(paneId: string): number | null {
    const out = this.tryRun(['display-message', '-p', '-t', paneId, '#{pane_pid}']);
    const pid = out ? Number(out.trim()) : NaN;
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  }

  /** Make the pane its session's current window and pane, so attaching lands on it. */
  focus(paneId: string): void {
    this.tryRun(['select-window', '-t', paneId]);
    this.tryRun(['select-pane', '-t', paneId]);
  }

  /** `env` — the client's own: SEAT_MARK_ENV_VAR in it says which seat the terminal is at. */
  attach(session: string, insideTmux: boolean, env?: NodeJS.ProcessEnv): number {
    const args = insideTmux ? ['switch-client', '-t', `=${session}`] : ['attach-session', '-t', `=${session}`];
    return spawnSync('tmux', this.argv(args), { stdio: 'inherit', env }).status ?? 1;
  }

  /** How a person reaches the session from another terminal. */
  attachHint(session: string): string {
    return `tmux ${this.socket ? `-L ${this.socket} ` : ''}attach -t ${shellQuote(`=${session}`)}`;
  }
}

export interface AiOptions {
  path: string;
  restart: boolean;
  /** `--new`: start a new conversation — leave out the profile's resume args. */
  fresh: boolean;
  /** `--conversation <id>`: continue this Claude Code conversation. */
  conversation?: string;
  detach: boolean;
  dryRun: boolean;
  /** `--focused`: a session nothing wakes — VDX_FOCUSED=1, the profile's `wakes` rules left out. */
  focused?: boolean;
  /** `--focused <topic>`: what the focused session is about; inside it, a new topic for it. */
  topic?: string;
  /** `--intercom`: the project's mail session — VDX_INTERCOM=1, one per project and machine. */
  intercom?: boolean;
  /** `--list`: the list of a plain start, printed; nothing is asked or started. */
  list?: boolean;
}

/** A topic is one line: it goes into a tmux option, a terminal's title and a transcript line. */
export function normalizeTopic(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** A tmux session's topic; null — it has none, or there is no such session. */
function sessionTopic(tmux: Tmux, session: string): string | null {
  // `=name:` — a session option needs the session as a target, `=name` alone is not found.
  return tmux.tryRun(['show-options', '-qv', '-t', `=${session}:`, TOPIC_OPTION])?.trim() || null;
}

/** Set the session's topic, or clear it: a session left by a focused agent keeps no stale one. */
function setSessionTopic(tmux: Tmux, session: string, topic: string | null): boolean {
  return (
    tmux.tryRun(
      topic
        ? ['set-option', '-t', `=${session}:`, TOPIC_OPTION, topic]
        : ['set-option', '-u', '-t', `=${session}:`, TOPIC_OPTION],
    ) !== null
  );
}

/** The pane whose processes hold the agent `pid`; none outside tmux. */
function paneOfAgent(tmux: Tmux, procs: ProcInfo[], pid: number): PaneInfo | undefined {
  return tmux.panes().find((p) => processTree(procs, p.panePid).some((x) => x.pid === pid));
}

export interface AiDeps {
  env: NodeJS.ProcessEnv;
  home: string;
  tmux: Tmux;
  /** stdin and stdout are a terminal: an interactive agent can run here and tmux can attach. */
  interactive: boolean;
  shell: string | null;
  log: (line: string) => void;
  out: (text: string) => void;
  onPath: (bin: string) => boolean;
  processes: () => ProcInfo[];
  /** Was this agent process started focused; default: its environment (`processFocused`). */
  agentFocused?: (pid: number) => boolean;
  /** Is this agent process a mail session; default: its environment (`processMode`). */
  agentMail?: (pid: number) => boolean;
  /** Default `process.platform`: the folder check is for macOS. */
  platform?: NodeJS.Platform;
  sleep: (ms: number) => void;
  confirmTimeoutMs: number;
  /** One line from the person at the terminal, or null when there is none. */
  ask: (prompt: string) => string | null;
  /** This vdx's version, named to the vdx on another machine. */
  version?: string;
  /** Run ssh — capturing its output, or on this terminal; null when ssh is not on PATH. */
  ssh?: (args: string[], capture: boolean) => { status: number; stdout: string } | null;
  /** Claude Code processes alive on this machine; read from its session files when not given. */
  liveHere?: () => LiveSession[];
  /** What the agent process `pid` lags behind; read from Claude Code's files when not given. */
  lag?: (pid: number, projectRoot: string, command: string) => Lag | null;
}

function machineLag(deps: AiDeps, pid: number, projectRoot: string, command: string): Lag | null {
  return sessionLag({
    env: deps.env,
    home: deps.home,
    pid,
    projectRoot,
    installedClaude: () => {
      try {
        return execFileSync(command, ['--version'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5_000,
        });
      } catch {
        return null;
      }
    },
  });
}

function runSsh(args: string[], capture: boolean): { status: number; stdout: string } | null {
  const res = spawnSync('ssh', args, { stdio: capture ? ['ignore', 'pipe', 'ignore'] : 'inherit', encoding: 'utf8' });
  if (at(res.error, 'code') === 'ENOENT') return null;
  return { status: res.status ?? 1, stdout: res.stdout ?? '' };
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Read one line from the terminal, synchronously: the prompt runs before tmux takes it. */
export function askLine(prompt: string): string | null {
  process.stderr.write(prompt);
  const buf = Buffer.alloc(256);
  let text = '';
  for (;;) {
    let n: number;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (at(e, 'code') === 'EAGAIN') {
        sleepSync(50);
        continue;
      }
      return null;
    }
    if (n === 0) return text === '' ? null : text.trim();
    text += buf.toString('utf8', 0, n);
    const nl = text.indexOf('\n');
    if (nl >= 0) return text.slice(0, nl).trim();
  }
}

export function defaultDeps(): AiDeps {
  return {
    env: process.env,
    home: os.homedir(),
    tmux: new Tmux(),
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    shell: process.env['SHELL'] || null,
    log: (line) => process.stderr.write(line + '\n'),
    out: (text) => process.stdout.write(text),
    onPath: (bin) => onPath(bin),
    processes: listProcesses,
    sleep: sleepSync,
    confirmTimeoutMs: 30_000,
    ask: askLine,
    ssh: runSsh,
  };
}

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_DRIFT = 3;
export const EXIT_LAUNCH_FAILED = 4;

/**
 * Without tmux the agent runs in the foreground. One that fails this soon after
 * a start with the resume args had nothing to resume (`claude --continue` exits
 * 1 at once); the window covers answering the channel prompt that comes first.
 */
const NOTHING_TO_RESUME_MS = 30_000;

function renderPlan(
  plan: LaunchPlan,
  multiplexer: Multiplexer,
  running: AgentPane[],
  focusedOf: (pid: number) => boolean,
  /** The session a start would make: next to running agents, one of its own. */
  session: string,
  /** The project's agents this start leaves alone: the mail session for the others, the others for it. */
  aside: AgentPane[] = [],
  topic: Topic | null = null,
): string {
  const lines = [
    `vdx ai — ${plan.projectRoot}`,
    `  name:     ${plan.project} (${plan.projectSource})`,
    `  profile:  ${plan.profilePath ?? `none — built-in default (${FALLBACK_AGENTS.join(' or ')}, no flags, no tmux)`}`,
    `  agent:    ${agentLine(plan, plan.args)}`,
    `  resume:   ${plan.resumeArgs.length ? plan.resumeArgs.join(' ') : '—'}`,
    `  matched:  ${plan.matched.length ? plan.matched.join(', ') : '—'}`,
  ];
  if (plan.focused)
    lines.push(`  focused:  nothing wakes it; left out: ${plan.skipped.length ? plan.skipped.join(', ') : '—'}`);
  if (topic) lines.push(`  topic:    ${topic.text ? `«${topic.text}» (${topic.from})` : `— ${topic.from}`}`);
  if (plan.intercom)
    lines.push(
      `  mail:     the project's mail session, a new conversation; first: ${
        plan.intercomArgs.length ? plan.intercomArgs.join(' ') : '— (no agent.intercom_args: it waits for a wake)'
      }`,
    );
  for (const c of plan.confirm) lines.push(`  confirm:  "${c.screen}" → ${c.keys.join(' ')}`);
  lines.push(
    multiplexer === 'tmux'
      ? `  session:  tmux; a new session is named "${session}"`
      : '  session:  this terminal (no tmux)',
  );
  if (multiplexer === 'tmux') {
    if (running.length === 0) lines.push('  running:  —');
    for (const r of running) {
      const missing = missingArgs(r.proc.args, plan.args);
      const focused = focusedOf(r.proc.pid);
      lines.push(
        `  running:  ${r.pane.session} ${r.pane.paneId} — ${
          missing.length ? `missing ${missing.join(' ')}` : 'matches the profile'
        }${focused ? ', focused' : plan.focused ? ', not focused' : ''}`,
      );
    }
    for (const a of aside) {
      lines.push(
        `  aside:    ${a.pane.session} ${a.pane.paneId} — ${plan.intercom ? 'not the mail session' : 'the mail session'}, left alone`,
      );
    }
  }
  return lines.join('\n') + '\n';
}

function lastLines(screen: string | null, n: number): string {
  const lines = (screen ?? '').split('\n').filter((l) => l.trim() !== '');
  return lines
    .slice(-n)
    .map((l) => `    | ${l}`)
    .join('\n');
}

function findAgentInPane(plan: LaunchPlan, paneId: string, deps: AiDeps): ProcInfo | null {
  const pid = deps.tmux.panePid(paneId);
  if (pid === null) return null;
  return processTree(deps.processes(), pid).find((p) => isAgentProcess(p, plan.command)) ?? null;
}

type SettleResult = 'ok' | 'not-running' | 'failed';

/**
 * After a start or restart: answer the prompts the profile says will appear,
 * then check the agent is alive and carries every required arg.
 */
function settle(plan: LaunchPlan, paneId: string, deps: AiDeps): SettleResult {
  const { tmux, log } = deps;
  const pending = [...plan.confirm];
  const deadline = Date.now() + deps.confirmTimeoutMs;
  const agentGrace = Date.now() + Math.min(5_000, deps.confirmTimeoutMs);
  let screen: string | null = null;

  while (pending.length > 0 && Date.now() < deadline) {
    screen = tmux.capture(paneId);
    const i = pending.findIndex((c) => screen?.includes(c.screen));
    if (i >= 0) {
      const rule = pending.splice(i, 1)[0]!;
      for (const key of rule.keys) {
        tmux.sendKey(paneId, key);
        deps.sleep(250);
      }
      const goneBy = Date.now() + 5_000;
      while (Date.now() < goneBy && tmux.capture(paneId)?.includes(rule.screen)) deps.sleep(200);
      if (tmux.capture(paneId)?.includes(rule.screen)) {
        log(`✗ "${rule.screen}" is still on screen after ${rule.keys.join(' ')}`);
        return 'failed';
      }
      log(`✓ answered "${rule.screen}" with ${rule.keys.join(' ')}`);
      continue;
    }
    if (Date.now() > agentGrace && !findAgentInPane(plan, paneId, deps)) break;
    deps.sleep(300);
  }

  // Seen twice a second apart: an agent can quit right after its first prompt
  // is answered (claude --continue with no conversation does).
  let proc: ProcInfo | null = null;
  const procBy = Date.now() + 10_000;
  for (;;) {
    const first = findAgentInPane(plan, paneId, deps);
    if (first) {
      deps.sleep(1_000);
      const again = findAgentInPane(plan, paneId, deps);
      if (again?.pid === first.pid) {
        proc = again;
        break;
      }
    }
    if (Date.now() >= procBy) break;
    deps.sleep(300);
  }
  if (!proc) {
    log(`✗ ${plan.command} is not running in the pane. The pane shows:`);
    log(lastLines(tmux.capture(paneId), 8));
    return 'not-running';
  }
  if (pending.length > 0) {
    log(
      `✗ expected prompt not seen: ${pending.map((c) => `"${c.screen}"`).join(', ')} — ` +
        'the agent may be waiting on another question. The pane shows:',
    );
    log(lastLines(screen ?? tmux.capture(paneId), 8));
    return 'failed';
  }
  const missing = missingArgs(proc.args, plan.args);
  if (missing.length > 0) {
    log(`✗ the agent is running without: ${missing.join(' ')}`);
    return 'failed';
  }
  log(`✓ running: ${proc.args}`);
  return 'ok';
}

/**
 * Settle a pane started with the plan's resume args, if it has any. An agent
 * with nothing to resume exits at once; start it once more without them rather
 * than leave the project without an agent.
 */
function settleResumed(plan: LaunchPlan, paneId: string, deps: AiDeps): boolean {
  const result = settle(plan, paneId, deps);
  if (result !== 'not-running' || plan.resumeArgs.length === 0) return result === 'ok';
  const line = agentLine(plan, plan.args);
  deps.log(`↻ nothing to resume — starting without ${plan.resumeArgs.join(' ')}: ${line}`);
  deps.tmux.respawn(paneId, plan.projectRoot, tmuxShellCommand(line, deps.shell, !plan.intercom));
  return settle(plan, paneId, deps) === 'ok';
}

/**
 * Attach to the session, or name how. Attached in cmux to a focused session, the workspace shows
 * its topic while vdx holds the attach (focused-topic DL #6); under `vdx ai@<host>` the session gets
 * the mark the vdx there watches it by.
 */
function finish(
  ok: boolean,
  session: string,
  paneId: string,
  opts: AiOptions,
  deps: AiDeps,
  focused = false,
  seat: string = hostLabel(deps.env),
): number {
  if (deps.interactive && !opts.detach) {
    if (!ok) deps.log('attaching so you can see the pane');
    deps.tmux.focus(paneId);
    const insideTmux = Boolean(deps.env['TMUX']);
    const token = deps.env[CMUX_TOKEN_ENV_VAR];
    if (focused && token && /^[0-9a-f]+$/.test(token))
      deps.tmux.tryRun(['set-option', '-t', `=${session}:`, CMUX_TOKEN_OPTION, token]);
    const watch =
      focused && !insideTmux ? watchTopic(deps.env, { session, socket: deps.tmux.socketName }, deps.home) : null;
    const status = deps.tmux.attach(session, insideTmux, { ...process.env, [SEAT_MARK_ENV_VAR]: seat });
    watch?.stop();
    return status;
  }
  deps.log(`attach: ${deps.tmux.attachHint(session)}`);
  return ok ? EXIT_OK : EXIT_LAUNCH_FAILED;
}

/** `vdx ai@<host>`: an ssh destination such as `m3` — never an option to ssh. */
export const REMOTE_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A path under the local home as a shell word under the remote home; any other path as is. */
export function remotePathWord(abs: string, home: string): string {
  const rel = path.relative(home, abs);
  if (rel === '') return '"$HOME"';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return shellQuote(abs);
  return `"$HOME"/${shellQuote(rel)}`;
}

/**
 * The ssh argv for `vdx ai@<host>`: the same `vdx ai` on the host, in its own
 * tmux there. The path goes first: an older vdx hands the token after a flag it
 * does not know to that flag. A different vdx version there is named, not fatal.
 * `from` — the machine the person sits at, so the vdx there speaks from it; an
 * older vdx leaves the variable alone.
 */
export function remoteAiArgs(input: {
  host: string;
  from: string;
  projectPath: string;
  home: string;
  version: string;
  opts: AiOptions;
  tty: boolean;
  /** Under cmux: the mark the vdx there puts on the focused session it attaches to (cmux.ts). */
  cmuxToken?: string | null;
}): string[] {
  const { host, opts, version } = input;
  const flags = [
    opts.fresh && '--new',
    // After the path: the word after --focused is then the topic there, never the path.
    opts.focused && (opts.topic ? `--focused ${shellQuote(opts.topic)}` : '--focused'),
    opts.intercom && '--intercom',
    opts.restart && '--restart',
    opts.detach && '--detach',
    opts.dryRun && '--dry-run',
    opts.list && '--list',
    opts.conversation && `--conversation ${shellQuote(opts.conversation)}`,
  ].filter((f): f is string => Boolean(f));
  const v = shellQuote(version);
  const script =
    `v=$(vdx --version 2>/dev/null) || v='older than 0.13.1'; ` +
    `[ "$v" = ${v} ] || echo "note: vdx on ${host} is $v, here "${v} >&2; ` +
    `export ${SEAT_ENV_VAR}=${shellQuote(input.from)}; ` +
    (input.cmuxToken ? `export ${CMUX_TOKEN_ENV_VAR}=${shellQuote(input.cmuxToken)}; ` : '') +
    `exec vdx ai ${[remotePathWord(input.projectPath, input.home), ...flags].join(' ')}`;
  return [input.tty ? '-t' : '-T', host, script];
}

/** Where neighbour repos live: the profile's `git.author_pool`, else the project's parent directory. */
export function authorPoolDirs(
  environment: Environment,
  projectRoot: string,
  home: string,
  profileDir: string,
): string[] {
  const listed = environment.git?.author_pool;
  if (!listed?.length) return [path.dirname(projectRoot)];
  return listed.map((d) => path.resolve(profileDir, d.replace(/^~(?=$|\/)/, home)));
}

/**
 * A repo without its own author makes git refuse to commit (`user.useConfigOnly`).
 * At a terminal vdx proposes the likely author and Enter takes the first;
 * without one it says so and goes on — a scripted start must not stop here.
 * A running agent needs no restart: git reads the author at each commit.
 */
export function ensureAuthor(projectRoot: string, poolDirs: string[], deps: AiDeps, dryRun: boolean): void {
  if (!isGitRepo(projectRoot)) return;
  const current = effectiveAuthor(projectRoot);
  if (current) {
    if (dryRun) deps.out(`  author:   ${current.email} (${current.scope})\n`);
    return;
  }
  const top = rankAuthors(projectRoot, scanPool(poolDirs)).slice(0, 3);
  const q = shellQuote(projectRoot);
  const command = (a: Author) =>
    `git -C ${q} config --local user.name ${shellQuote(a.name)} && git -C ${q} config --local user.email ${shellQuote(a.email)}`;
  if (dryRun) {
    const proposal = top.length ? `; would propose ${top.map((c) => c.email).join(', ')}` : '';
    deps.out(`  author:   none — git refuses to commit here${proposal}\n`);
    return;
  }
  deps.log(`⚠ ${path.basename(projectRoot)}: no commit author of its own — git will refuse to commit here`);
  if (!deps.interactive || top.length === 0) {
    deps.log(`  set it: ${top[0] ? command(top[0]) : `git -C ${q} config --local user.email <address>`}`);
    return;
  }
  top.forEach((c, i) => deps.log(`  ${i + 1}) ${c.name} <${c.email}>${c.why.length ? `   ${c.why.join('; ')}` : ''}`));
  deps.log('  s) skip');
  for (let tries = 0; tries < 2; tries++) {
    const answer = deps.ask('Author [1]: ');
    if (answer === null) return;
    const a = answer.trim();
    if (/^[sn]$/i.test(a)) {
      deps.log('  skipped');
      return;
    }
    const pick: Author | undefined =
      a === ''
        ? top[0]
        : /^\d+$/.test(a)
          ? top[Number(a) - 1]
          : a.includes('@')
            ? { name: top[0]!.name, email: a }
            : undefined;
    if (pick) {
      if (writeAuthor(projectRoot, pick)) deps.log(`✓ ${pick.name} <${pick.email}> → .git/config`);
      else deps.log(`✗ could not write .git/config — ${command(pick)}`);
      return;
    }
    deps.log(`  1–${top.length}, an address, or s`);
  }
}

/**
 * Claude Code's memory of the project lives inside it, `.claude/memory/`
 * (claude-memory-in-project): a start says when it does not, and at a terminal asks
 * to put it there — Enter does. With an agent of the project running it only says so:
 * that session keeps the old place until it restarts. Without a terminal it names
 * `vdx doctor --fix`, the same move.
 */
export function ensureMemory(
  projectRoot: string,
  command: string,
  hosts: PersonalHost[],
  deps: AiDeps,
  dryRun: boolean,
  agentRunning: boolean,
): void {
  const ctx = { env: deps.env, home: deps.home };
  if (!isClaude(command) || !memoryApplies(projectRoot, ctx)) return;
  const state = memoryState(projectRoot, ctx);
  if (dryRun) {
    deps.out(`  memory:   ${describeMemory(state, ctx)}\n`);
    return;
  }
  if (!memoryNeedsFix(state)) return;
  const fix = `vdx doctor --fix ${shellQuote(projectRoot)}`;
  deps.log(`⚠ ${path.basename(projectRoot)}: Claude memory ${describeMemory(state, ctx)}`);
  if (!deps.interactive || agentRunning) {
    deps.log(`  ${agentRunning ? 'once the running agent of the project ends' : 'put it there'}: ${fix}`);
    return;
  }
  const question =
    state.kind === 'outside'
      ? 'Move it into .claude/memory/ now?'
      : state.kind === 'leftovers'
        ? 'Set the old place aside?'
        : state.kind === 'moved' && state.conversations
          ? 'Point it here, and bring the conversations along?'
          : 'Point it here?';
  const answer = deps.ask(`  ${question} [Y/n] `);
  if (answer === null || /^n(o)?$/i.test(answer.trim())) {
    deps.log(`  skipped — later: ${fix}`);
    return;
  }
  try {
    const done = fixProjectMemory(projectRoot, state, ctx, {
      ask: deps.ask,
      log: deps.log,
      today: new Date().toLocaleDateString('sv-SE'),
      personalHosts: hosts,
    });
    for (const d of done) deps.log(`✓ ${d}`);
  } catch (e) {
    deps.log(`✗ ${errorMessage(e)} — ${fix}`);
  }
}

/** `from` — where the person sits; a vdx that `vdx ai@<host>` started passes its own on. */
export function runAiRemote(opts: AiOptions, host: string, deps: AiDeps, from: string = seatLabel(deps.env)): number {
  const projectPath = resolveProjectRoot(opts.path) ?? path.resolve(opts.path);
  const tty = deps.interactive && !opts.detach && !opts.dryRun;
  // In cmux the workspace shows the topic of the focused session the vdx there attaches to.
  const token = tty ? cmuxToken(deps.env) : null;
  const args = remoteAiArgs({
    host,
    from,
    projectPath,
    home: deps.home,
    version: deps.version ?? '',
    opts,
    tty,
    cmuxToken: token,
  });
  deps.log(
    `→ ${host}: vdx ai ${shellQuote(projectPath)}${opts.conversation ? ` --conversation ${opts.conversation}` : ''}`,
  );
  const watch = token ? watchTopic(deps.env, { host, token }, deps.home) : null;
  const res = (deps.ssh ?? runSsh)(args, false);
  watch?.stop();
  if (res === null) {
    deps.log('vdx ai: `ssh` not found on PATH');
    return 127;
  }
  if (opts.detach && res.status === EXIT_OK) {
    deps.log(`attach from here: vdx ai@${host} ${shellQuote(projectPath)}`);
  }
  return res.status;
}

/**
 * What `vdx ai --report <project>` prints on a machine — the vdx of another one asks for it over
 * ssh (vdx-ai-predictable): the Claude Code sessions alive there (as LIVE_SESSIONS_SCRIPT), the
 * project's agents with what only that machine sees (its terminals, the input line), which of
 * the project's conversations were typed in there, and its copies of their transcripts — the
 * asking machine finds where its own copies are behind.
 */
export interface RemoteReport {
  vdx: string;
  machine: string;
  home: string;
  sessions: LiveSession[];
  agents: AgentFact[];
  typed: string[];
  transcripts: { id: string; mtime: number; size: number }[];
}

/** What another machine answered: always the live sessions; the report when its vdx gives one. */
interface Reach extends MachineReport {
  report: RemoteReport | null;
}

function parseReach(stdout: string): Reach {
  const text = stdout.trim();
  if (text.startsWith('{')) {
    try {
      const r = JSON.parse(text) as RemoteReport;
      if (Array.isArray(r.sessions) && Array.isArray(r.agents))
        return { home: r.home ?? null, sessions: r.sessions, report: r };
    } catch {
      /* not a report: read it as the script's lines */
    }
  }
  return { ...parseMachineReport(stdout), report: null };
}

/**
 * What runs on `host` right now; null when it does not answer over ssh (BatchMode: a password
 * prompt counts as no answer). Its vdx reports on the project; a vdx there older than the
 * report, or none, — the script prints the live sessions alone.
 */
function askMachine(host: string, deps: AiDeps, projectRoot: string): Reach | null {
  const script = `vdx ai ${remotePathWord(projectRoot, deps.home)} --report 2>/dev/null || sh -c ${shellQuote(LIVE_SESSIONS_SCRIPT)}`;
  const res = (deps.ssh ?? runSsh)(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host, script], true);
  return res && res.status === 0 ? parseReach(res.stdout) : null;
}

/**
 * The facts of the project's agents running here (board.ts): its session file, its transcript,
 * the terminals on its tmux session and its input line.
 */
function agentFacts(
  agents: AgentPane[],
  plan: LaunchPlan,
  deps: AiDeps,
  procs: ProcInfo[],
  wrapSkills: readonly string[],
  modeOf: { focused: (pid: number) => boolean; mail: (pid: number) => boolean },
): AgentFact[] {
  if (agents.length === 0) return [];
  const clients = deps.tmux.clients();
  return agents.map((a) => {
    const live = liveSessionFile(deps.env, deps.home, a.proc.pid);
    const c = live
      ? conversationById({
          env: deps.env,
          home: deps.home,
          projectRoot: plan.projectRoot,
          id: live.conversation,
          wrapSkills,
        })
      : null;
    const focused = modeOf.focused(a.proc.pid);
    return {
      machine: plan.host,
      session: a.pane.session,
      pid: a.proc.pid,
      conversation: live?.conversation ?? null,
      status: live?.status ?? null,
      activeAt: live?.activeAt ?? null,
      draft: inputDraft(deps.tmux.screen(a.pane.paneId)),
      focused,
      topic: focused ? sessionTopic(deps.tmux, a.pane.session) : null,
      mail: modeOf.mail(a.proc.pid),
      openAt: clients.filter((k) => k.session === a.pane.session).map((k) => clientSeat(k.pid, procs, plan.host)),
      title: c?.title ?? null,
      // No transcript of the conversation it is in: nothing was written there yet.
      empty: c ? isEmpty(c) : live !== null,
      finished: c?.finished ?? false,
    };
  });
}

/** `vdx ai --report <path>`: this machine's RemoteReport on the project, as JSON on stdout. */
export function runAiReport(pathArg: string, deps: AiDeps): number {
  const prepared = prepare(pathArg, deps);
  if (typeof prepared === 'number') return prepared;
  const { plan, environment } = prepared;
  const wrapSkills = environment.session?.wrap_skills ?? [];
  const procs = deps.processes();
  const agents = deps.tmux.available() ? findAgentPanes(deps.tmux.panes(), procs, plan.projectRoot, plan.command) : [];
  const files = conversationFiles({ env: deps.env, home: deps.home, projectRoot: plan.projectRoot });
  const ids = new Set(files.map((f) => path.basename(f.file, '.jsonl')));
  const report: RemoteReport = {
    vdx: deps.version ?? '',
    machine: plan.host,
    home: deps.home,
    sessions: (deps.liveHere ?? (() => liveSessionsHere(deps.env, deps.home)))(),
    agents: agentFacts(agents, plan, deps, procs, wrapSkills, {
      focused: deps.agentFocused ?? processFocused,
      mail: deps.agentMail ?? ((pid) => processMode(pid) === 'mail'),
    }),
    typed: [...typedHere(deps.env, deps.home, ids)],
    transcripts: files.map((f) => ({ id: path.basename(f.file, '.jsonl'), mtime: f.updated.getTime(), size: f.size })),
  };
  deps.out(JSON.stringify(report) + '\n');
  return EXIT_OK;
}

/** What a start continues: resume args here, or a conversation on another machine. */
interface ConversationChoice {
  args: string[];
  /** Continue it on that machine (`vdx ai@<host>`); `reachable` — it answered over ssh just now. */
  remote?: { host: string; id: string; reachable: boolean };
  /** Continue it here only after a yes: another machine's that cannot be asked, or one running here already. */
  askHere?: { id: string; why: string };
  /** The person ended the question (Ctrl-D): start nothing. */
  abort?: boolean;
  /** A new conversation nobody picked, while an agent of the project runs on these machines: only after a yes. */
  elsewhere?: string[];
  /** For the person: what was found and what is taken. */
  lines: string[];
}

function isClaude(command: string): boolean {
  return path.basename(command) === 'claude';
}

const resumeId = (id: string) => ['--resume', id];

/**
 * What a choice of conversation stands on: what runs on every machine (this one from its
 * session files, the others over ssh), each conversation's machine, and how one is continued —
 * on its own machine (vdx-ai DL #27). chooseConversation and the list of a plain start
 * (vdx-ai-predictable) both decide from it.
 */
function conversationContext(plan: LaunchPlan, deps: AiDeps, wrapSkills: readonly string[] = []) {
  const host = plan.host;
  const same = sameMachine;
  // A mail session's conversations are its own: a start of the person's never continues one.
  const listed =
    plan.resumeArgs.length === 0
      ? []
      : listConversations({ env: deps.env, home: deps.home, projectRoot: plan.projectRoot, wrapSkills });
  const all = listed.filter((c) => !c.mail);
  const mailOnly = listed.length - all.length;
  const root = shellQuote(plan.projectRoot);
  // Said from where the person sits: under `vdx ai@<host>` that is not this machine.
  const atSeat = same(plan.seat, host);
  const on = (m: string) => (same(m, plan.seat) ? (atSeat ? 'here' : `on ${m}, where you are,`) : `on ${m}`);

  // Who runs what right now: this machine from its session files, the others over ssh.
  const reach = new Map<string, Reach | null>();
  for (const m of [...plan.machines, ...all.map((c) => c.machine)]) {
    if (m && !same(m, host) && ![...reach.keys()].some((k) => same(k, m)))
      reach.set(m, askMachine(m, deps, plan.projectRoot));
  }
  const silent = [...reach]
    .filter(([, r]) => r === null)
    .map(([m]) => `note: ${m} does not answer over ssh — what runs there is not known`);
  const elsewhere = [...reach].flatMap(([m, r]) =>
    (r?.sessions ?? []).filter((l) => runsInProject(l, r!.home, plan.projectRoot, deps.home)).map((l) => ({ m, l })),
  );
  // The project's path on the machine `m`, by its home: the person types it there.
  const rootOn = (m: string) => {
    const theirs = [...reach].find(([k]) => same(k, m))?.[1]?.home;
    const rel = path.relative(deps.home, plan.projectRoot);
    return theirs && !rel.startsWith('..') && !path.isAbsolute(rel) ? shellQuote(path.join(theirs, rel)) : root;
  };
  // `vdx ai` attaches to an agent in tmux; one in a terminal of its own has no command to reach it.
  const reachAgent = (m: string, l: LiveSession) =>
    !l.tmux ? '' : same(m, plan.seat) ? ` — attach: vdx ai ${rootOn(m)}` : ` — there: vdx ai@${m} ${root}`;
  const fresh = (lines: string[]): ConversationChoice => {
    if (elsewhere.length === 0) return { args: [], lines };
    const agents = elsewhere.map(
      ({ m, l }) => `an agent of this project is ${describeLive(on(m), l)}${reachAgent(m, l)}`,
    );
    return { args: [], elsewhere: [...new Set(elsewhere.map(({ m }) => m))], lines: [...lines, ...agents] };
  };

  const live = new Map<string, { machine: string; session: LiveSession; here: boolean }[]>();
  const addLive = (machine: string, session: LiveSession, here: boolean) =>
    live.set(session.conversation, [...(live.get(session.conversation) ?? []), { machine, session, here }]);
  for (const l of (deps.liveHere ?? (() => liveSessionsHere(deps.env, deps.home)))()) addLive(host, l, true);
  for (const [m, r] of reach) for (const l of r?.sessions ?? []) addLive(m, l, false);

  const machine = (c: Conversation) => live.get(c.id)?.find((l) => !l.here)?.machine ?? machineOf(c, host);
  const runsHere = (c: Conversation) => live.get(c.id)?.find((l) => l.here);
  const isOurs = (c: Conversation) => same(machine(c), host);
  const idleHere = (c: Conversation) => isOurs(c) && !runsHere(c);
  const found = [...new Set([...latestPerMachine(all, machine), ...all.filter((c) => live.has(c.id))])].sort(
    (a, b) => b.updated.getTime() - a.updated.getTime(),
  );
  const show = (c: Conversation) => describeConversation(c, machine(c));
  const running = (c: Conversation) => (live.get(c.id) ?? []).map((l) => describeLive(on(l.machine), l.session));

  const take = (c: Conversation): ConversationChoice => {
    const m = machine(c);
    const here = runsHere(c);
    if (here) {
      return {
        args: [],
        askHere: {
          id: c.id,
          why: `It runs ${on(host)} right now (${here.session.tmux ?? `pid ${here.session.pid}`}); two sessions would write to it`,
        },
        lines: [`chosen: ${show(c)}`],
      };
    }
    if (isOurs(c)) return { args: resumeId(c.id), lines: [`continuing ${show(c)}`] };
    if (m)
      return {
        args: [],
        remote: { host: m, id: c.id, reachable: reach.get(m) != null },
        lines: [`continuing on ${m}: ${show(c)}`],
      };
    return {
      args: [],
      askHere: {
        id: c.id,
        why: `Its machine is unknown (never typed in ${on(host)}); if it runs there, both machines will write to it`,
      },
      lines: [`chosen: ${show(c)}`],
    };
  };
  return {
    host,
    same,
    all,
    mailOnly,
    root,
    atSeat,
    on,
    reach,
    silent,
    elsewhere,
    rootOn,
    fresh,
    live,
    machine,
    runsHere,
    isOurs,
    idleHere,
    found,
    show,
    running,
    take,
  };
}

/**
 * Which conversation a start continues. Other agents keep the profile's
 * resume_args. For Claude Code vdx reads the project's conversations and the
 * machine each belongs to (conversations.ts): `--continue` would take the
 * newest one in the folder, and with the folder synced between machines that
 * can be a conversation another machine is still writing to.
 *
 * The profile's other machines, and every other machine this project's
 * conversations name, are asked over ssh what runs there right now; this
 * machine's running ones come from its own session files. A running
 * conversation is listed even when it is not its machine's newest.
 *
 * A new conversation the person did not pick from the list — `--new`, a
 * project with none yet, none of this machine's idle — while an agent of this
 * project runs on another machine (by the directory it runs in) is started
 * only after a yes: two agents would work in one repository from two machines.
 *
 * Another machine's conversation is continued on that machine, so two
 * machines never write to one conversation; one whose machine is unknown, or
 * cannot be reached, or that already runs here, is continued here only after a
 * yes. When the choice is not plain, a person at a terminal picks — Enter
 * takes the newest overall; without a terminal it is this machine's newest
 * idle one, never another's.
 */
function chooseConversation(plan: LaunchPlan, deps: AiDeps, canAsk: boolean): ConversationChoice {
  if (!isClaude(plan.command)) return { args: plan.resumeArgs, lines: [] };
  const {
    host,
    same,
    all,
    mailOnly,
    root,
    atSeat,
    on,
    silent,
    rootOn,
    fresh,
    machine,
    runsHere,
    idleHere,
    found,
    show,
    running,
    take,
  } = conversationContext(plan, deps);
  if (plan.resumeArgs.length === 0) return fresh(silent);
  if (all.length === 0) {
    return fresh([
      mailOnly
        ? `only the mail session's conversations here (${mailOnly}; vdx ai --conversation <id> opens one) — starting a new one`
        : 'no conversation of this project yet — starting a new one',
      ...silent,
    ]);
  }
  if (found.every(idleHere)) {
    const chosen = take(found[0]!);
    return { ...chosen, lines: [...chosen.lines, ...silent] };
  }

  const firstIdle = found.find(idleHere);
  if (canAsk && deps.interactive) {
    deps.log('conversations of this project:');
    found.forEach((c, i) => {
      const marks = [
        i === 0 && 'newest',
        c === firstIdle && (atSeat ? 'this machine' : `idle on ${host}`),
        !machine(c) && 'machine unknown',
        ...running(c),
      ];
      const m = marks.filter(Boolean);
      deps.log(`  ${i + 1}) ${show(c)}${m.length ? `   ← ${m.join(', ')}` : ''}`);
    });
    deps.log('  n) a new conversation');
    // A machine that did not answer may run any of these: say so before the person picks.
    for (const n of silent) deps.log(`  ${n}`);
    for (let tries = 0; tries < 2; tries++) {
      const answer = deps.ask(`Which one to continue? [1]: `);
      // Ctrl-D at the question is a cancel, not "no terminal": start nothing.
      if (answer === null) return { args: [], abort: true, lines: ['no answer — nothing started'] };
      const a = answer.trim();
      if (/^n(ew)?$/i.test(a)) return { args: [], lines: ['a new conversation'] };
      const c = a === '' ? found[0] : /^\d+$/.test(a) ? found[Number(a) - 1] : undefined;
      if (c) return take(c);
      deps.log(`  1–${found.length}, or n`);
    }
  }
  const notes = found
    .filter((c) => !idleHere(c))
    .map((c) => {
      const m = machine(c);
      const now = running(c);
      const which =
        `${c.updated > (firstIdle?.updated ?? new Date(0)) ? 'a newer' : 'another'} conversation ${c.id.slice(0, 8)}` +
        (now.length ? `, ${now.join(', ')}` : '');
      if (runsHere(c)) return `note: ${which} — not taken: it would have two sessions`;
      if (m && same(m, plan.seat))
        return `note: ${m} has ${which} — continue it where you are: vdx ai ${rootOn(m)} --conversation ${c.id}`;
      return m
        ? `note: ${m} has ${which} — continue it there: vdx ai@${m} ${root} --conversation ${c.id}`
        : `note: ${which} is of an unknown machine (never typed in ${on(host)}) — on its machine: vdx ai@<machine> ${root} --conversation ${c.id}`;
    });
  notes.push(...silent);
  if (firstIdle) {
    const chosen = take(firstIdle);
    return { ...chosen, lines: [...chosen.lines, ...notes] };
  }
  return fresh([`no idle conversation ${atSeat ? 'of this machine' : `on ${host}`} — starting a new one`, ...notes]);
}

/** What a plain start of Claude Code comes to, after the list or without it. */
type BoardOutcome =
  | { kind: 'attach'; agent: AgentPane; open: boolean; lines: string[] }
  | { kind: 'remote'; host: string; conversation: string | null; lines: string[] }
  | { kind: 'continue'; choice: ConversationChoice }
  | { kind: 'new'; focused: boolean; lines: string[] }
  | { kind: 'abort'; lines: string[] }
  | { kind: 'listed' };

/**
 * A plain start of Claude Code (vdx-ai-predictable): the project's agents on every machine and
 * its conversations nobody runs, in one list (board.ts). Silent in three cases only — one agent
 * runs on all the machines and no terminal at this seat shows it: attach; none runs, and the
 * newest conversation is this machine's and not finished: continue it; the project has no
 * conversation: a new one. `print` (`--list`, `--dry-run`) shows the list and decides nothing;
 * `auto` (no terminal) takes the marked row if it is this machine's.
 */
function boardStart(
  plan: LaunchPlan,
  deps: AiDeps,
  local: AgentPane[],
  procs: ProcInfo[],
  wrapSkills: readonly string[],
  modeOf: { focused: (pid: number) => boolean; mail: (pid: number) => boolean },
  mode: 'ask' | 'print' | 'auto',
): BoardOutcome {
  const k = conversationContext(plan, deps, wrapSkills);
  const here = agentFacts(local, plan, deps, procs, wrapSkills, modeOf);
  const paneOf = new Map(local.map((a) => [a.proc.pid, a]));
  const copy = (id: string | null) =>
    id ? conversationById({ env: deps.env, home: deps.home, projectRoot: plan.projectRoot, id, wrapSkills }) : null;
  const there: AgentFact[] = [];
  const typedOn = new Map<string, string>();
  const behind = new Map<string, string>();
  const files = new Map(
    conversationFiles({ env: deps.env, home: deps.home, projectRoot: plan.projectRoot }).map((f) => [
      path.basename(f.file, '.jsonl'),
      f,
    ]),
  );
  for (const [m, r] of k.reach) {
    if (!r) continue;
    if (r.report) {
      there.push(...r.report.agents.map((a) => ({ ...a, machine: m })));
      for (const id of r.report.typed) if (!typedOn.has(id)) typedOn.set(id, m);
      // Their copy newer or longer than ours: ours is behind, and that machine writes it.
      for (const t of r.report.transcripts) {
        const ours = files.get(t.id);
        if (!ours || t.mtime > ours.updated.getTime() + 2_000 || t.size > ours.size) behind.set(t.id, m);
      }
      continue;
    }
    // An older vdx there, or none: what its session files say, the rest from our copy.
    // The project's by the directory it runs in, or by its conversation being one of the project's.
    const ofProject = (l: LiveSession) =>
      runsInProject(l, r.home, plan.projectRoot, deps.home) || files.has(l.conversation);
    for (const l of r.sessions.filter(ofProject)) {
      const c = copy(l.conversation);
      there.push({
        machine: m,
        session: l.tmux?.replace(/:.*$/, '') ?? null,
        pid: l.pid,
        conversation: l.conversation,
        status: l.status,
        activeAt: null,
        draft: 0,
        focused: false,
        topic: c?.topic ?? null,
        mail: c?.mail ?? false,
        openAt: [],
        title: c?.title ?? null,
        empty: c ? isEmpty(c) : false,
        finished: c?.finished ?? false,
      });
    }
  }
  const machineOf = (c: Conversation) => behind.get(c.id) ?? k.machine(c) ?? typedOn.get(c.id) ?? null;
  // Claude Code running here outside tmux: no pane to attach to, and a second session in its
  // conversation would write to it — continued only after a yes (take).
  const outside: AgentFact[] = (deps.liveHere ?? (() => liveSessionsHere(deps.env, deps.home)))()
    .filter((l) => !paneOf.has(l.pid) && !local.some((a) => a.proc.pid === l.pid))
    .filter((l) => files.has(l.conversation) || runsInProject(l, deps.home, plan.projectRoot, deps.home))
    .filter((l) => !l.tmux)
    .map((l) => {
      const c = copy(l.conversation);
      const live = liveSessionFile(deps.env, deps.home, l.pid);
      return {
        machine: plan.host,
        session: null,
        pid: l.pid,
        conversation: l.conversation,
        status: l.status,
        activeAt: live?.activeAt ?? null,
        draft: 0,
        focused: modeOf.focused(l.pid),
        topic: c?.topic ?? null,
        mail: c?.mail ?? false,
        openAt: [plan.host],
        title: c?.title ?? null,
        empty: c ? isEmpty(c) : false,
        finished: c?.finished ?? false,
      };
    });
  const agents = [...here, ...outside, ...there];
  const working = agents.filter((a) => !a.mail);
  const busy = new Set(working.map((a) => a.conversation));
  const continuable = k.all.filter((c) => !isEmpty(c) && !busy.has(c.id));
  const conversationOf = (a: AgentFact) => k.all.find((c) => c.id === a.conversation) ?? copy(a.conversation);
  const outcomeOf = (pick: Pick, why: string[]): BoardOutcome => {
    if (pick.kind === 'agent') {
      const a = pick.agent;
      const pane = paneOf.get(a.pid);
      if (pane) return { kind: 'attach', agent: pane, open: openAtSeat(a, plan.seat), lines: why };
      if (sameMachine(a.machine, plan.host)) {
        const c = conversationOf(a);
        if (!c) return { kind: 'abort', lines: [...why, `vdx cannot read the conversation of pid ${a.pid}`] };
        const chosen = k.take(c);
        return { kind: 'continue', choice: { ...chosen, lines: [...why, ...chosen.lines] } };
      }
      return { kind: 'remote', host: a.machine, conversation: a.conversation, lines: why };
    }
    if (pick.kind === 'conversation') {
      const m = pick.machine;
      if (m && !sameMachine(m, plan.host)) {
        return {
          kind: 'continue',
          choice: {
            args: [],
            remote: { host: m, id: pick.conversation.id, reachable: k.reach.get(m) != null },
            lines: [...why, `continuing on ${m}: ${describeConversation(pick.conversation, m)}`],
          },
        };
      }
      const chosen = k.take(pick.conversation);
      return { kind: 'continue', choice: { ...chosen, lines: [...why, ...chosen.lines] } };
    }
    if (pick.kind === 'new') return { kind: 'new', focused: pick.focused, lines: why };
    return { kind: 'abort', lines: why };
  };

  // `a`: every conversation of the project, not only the newest the start read.
  const everyOne = () =>
    listConversations({
      env: deps.env,
      home: deps.home,
      projectRoot: plan.projectRoot,
      limit: Infinity,
      wrapSkills,
    }).filter((c) => !c.mail);
  const make = (limit: number | 'all') =>
    buildBoard({
      project: plan.project,
      host: plan.host,
      seat: plan.seat,
      agents,
      conversations: limit === 'all' ? everyOne() : k.all,
      total: files.size,
      unread: files.size - k.all.length - k.mailOnly,
      machineOf,
      behind,
      silent: [...k.reach].filter(([, r]) => r === null).map(([m]) => m),
      limit,
    });
  const show = (b: Board, to: (line: string) => void) => {
    for (const l of b.lines) to(l);
  };
  if (mode === 'print') {
    show(make(5), (t) => deps.out(t + '\n'));
    return { kind: 'listed' };
  }

  // Nobody to ask (no terminal, or --dry-run): this machine's agent, else its newest
  // conversation, else a new one — never another machine's, and a new one while the project's
  // agent runs elsewhere only after a yes (vdx-ai DL #29). The others are named with the command
  // that reaches them.
  if (mode === 'auto') {
    // Under --dry-run at a terminal the list is shown as well: what Enter would take.
    if (deps.interactive) show(make(5), (t) => deps.out(t + '\n'));
    const rank = (a: AgentFact) => (freeWork(a, plan.seat) ? 0 : 1);
    const mineAgent = here
      .filter((a) => !a.mail)
      .sort((a, b) => rank(a) - rank(b) || (b.activeAt ?? 0) - (a.activeAt ?? 0))[0];
    const ours = continuable.filter((c) => {
      const m = machineOf(c);
      return m !== null && sameMachine(m, plan.host) && !k.runsHere(c);
    });
    const mineConv = ours.find((c) => !c.finished) ?? ours[0];
    const chosenAt = mineConv?.updated ?? new Date(0);
    const notes: string[] = [];
    for (const a of [...outside, ...there].filter((x) => !x.mail)) {
      const c = conversationOf(a);
      const which = `${c && c.updated > chosenAt ? 'a newer' : 'another'} conversation ${(a.conversation ?? '?').slice(0, 8)}, ${describeLive(k.on(a.machine), { pid: a.pid, conversation: a.conversation ?? '', tmux: a.session, status: a.status, cwd: null })}`;
      if (sameMachine(a.machine, plan.host)) notes.push(`note: ${which} — not taken: it would have two sessions`);
      else if (sameMachine(a.machine, plan.seat))
        notes.push(
          `note: ${a.machine} has ${which} — continue it where you are: vdx ai ${k.rootOn(a.machine)} --conversation ${a.conversation}`,
        );
      else
        notes.push(
          `note: ${a.machine} has ${which} — continue it there: vdx ai@${a.machine} ${k.root} --conversation ${a.conversation}`,
        );
    }
    for (const c of continuable) {
      if (c === mineConv) continue;
      const m = machineOf(c);
      if (m && sameMachine(m, plan.host)) continue;
      const which = `${c.updated > chosenAt ? 'a newer' : 'another'} conversation ${c.id.slice(0, 8)}`;
      if (!m)
        notes.push(
          `note: ${which} is of an unknown machine (never typed in ${k.on(plan.host)}) — on its machine: vdx ai@<machine> ${k.root} --conversation ${c.id}`,
        );
      else if (sameMachine(m, plan.seat))
        notes.push(`note: ${m} has ${which} — continue it where you are: vdx ai ${k.rootOn(m)} --conversation ${c.id}`);
      else notes.push(`note: ${m} has ${which} — continue it there: vdx ai@${m} ${k.root} --conversation ${c.id}`);
    }
    notes.push(...k.silent);
    if (mineAgent) {
      const pane = paneOf.get(mineAgent.pid)!;
      const others = here.filter((a) => !a.mail).length;
      return {
        kind: 'attach',
        agent: pane,
        open: false,
        lines: [
          ...(others > 1 ? [`note: ${others} agents of this project run here — taking ${pane.pane.session}`] : []),
          ...notes,
        ],
      };
    }
    if (mineConv) {
      const chosen = k.take(mineConv);
      return { kind: 'continue', choice: { ...chosen, lines: [...chosen.lines, ...notes] } };
    }
    const why =
      k.all.length === 0
        ? k.mailOnly
          ? `only the mail session's conversations here (${k.mailOnly}; vdx ai --conversation <id> opens one) — starting a new one`
          : plan.resumeArgs.length
            ? 'no conversation of this project yet — starting a new one'
            : 'the profile has no resume_args — starting a new conversation'
        : `no idle conversation ${k.atSeat ? 'of this machine' : `on ${plan.host}`} — starting a new one`;
    return { kind: 'continue', choice: k.fresh([why, ...notes]) };
  }

  // At a terminal, the plain cases: nothing to choose, and nothing a terminal at this seat
  // shows already.
  const only = working.length === 1 ? working[0]! : null;
  if (only && !openAtSeat(only, plan.seat)) {
    const where = sameMachine(only.machine, plan.host) ? (k.atSeat ? 'here' : `on ${plan.host}`) : `on ${only.machine}`;
    return outcomeOf({ kind: 'agent', agent: only }, [
      `the only agent of ${plan.project} runs ${where}${only.session ? ` (${only.session})` : ` (pid ${only.pid})`}, and no terminal at your seat shows it`,
      ...k.silent,
    ]);
  }
  if (working.length === 0) {
    const newest = continuable[0];
    if (!newest)
      return outcomeOf({ kind: 'new', focused: false }, [
        k.mailOnly
          ? `only the mail session's conversations here (${k.mailOnly}; vdx ai --conversation <id> opens one) — starting a new one`
          : plan.resumeArgs.length
            ? 'no conversation of this project yet — starting a new one'
            : 'the profile has no resume_args — starting a new conversation',
        ...k.silent,
      ]);
    const m = machineOf(newest);
    if (m && sameMachine(m, plan.host) && !newest.finished && !behind.has(newest.id))
      return outcomeOf({ kind: 'conversation', conversation: newest, machine: m }, k.silent);
  }

  let board = make(5);
  show(board, deps.log);
  for (let tries = 0; tries < 3; tries++) {
    const answer = deps.ask(`Which one? [${board.enter === 'new' ? 'n' : board.enter + 1}]: `);
    // Ctrl-D at the question is a cancel, not "no terminal": start nothing.
    if (answer === null) return { kind: 'abort', lines: ['no answer — nothing started'] };
    const pick = readAnswer(answer, board);
    if (pick?.kind === 'all') {
      board = make('all');
      show(board, deps.log);
      continue;
    }
    if (pick) return outcomeOf(pick, []);
    deps.log(`  1–${board.rows.length}, a, n or f`);
  }
  return { kind: 'abort', lines: ['nothing started'] };
}

/**
 * Several agents of the project run here and the start is about one of them: a person
 * picks — Enter takes the newest; without a terminal, or under --dry-run, it is the newest.
 * null — the person left it.
 */
function pickAgent(
  running: AgentPane[],
  focusedOf: (pid: number) => boolean,
  deps: AiDeps,
  canAsk: boolean,
): AgentPane | null {
  if (running.length === 1) return running[0]!;
  const startedAt = (a: AgentPane) => liveStartedAt(deps.env, deps.home, a.proc.pid);
  const sorted = [...running].sort((a, b) => (startedAt(b) ?? 0) - (startedAt(a) ?? 0));
  const show = (a: AgentPane) => {
    const id = liveConversationId(deps.env, deps.home, a.proc.pid);
    const at = startedAt(a);
    const topic = focusedOf(a.proc.pid) ? sessionTopic(deps.tmux, a.pane.session) : null;
    const marks = [
      id && `conversation ${id.slice(0, 8)}`,
      focusedOf(a.proc.pid) && `focused${topic ? ` «${topic}»` : ''}`,
      at !== null && `started ${describeAge(new Date(at))}`,
    ].filter(Boolean);
    return `${a.pane.session} ${a.pane.paneId}${marks.length ? ` — ${marks.join(', ')}` : ''}`;
  };
  // Start times come from Claude Code's session files; without them, tmux's order.
  const newest = startedAt(sorted[0]!) !== null ? 'the newest' : 'the first';
  if (!canAsk || !deps.interactive) {
    deps.log(`note: ${sorted.length} agents of this project run here — taking ${newest}, ${show(sorted[0]!)}`);
    return sorted[0]!;
  }
  deps.log('agents of this project running here:');
  sorted.forEach((a, i) =>
    deps.log(`  ${i + 1}) ${show(a)}${i === 0 && newest === 'the newest' ? '   ← newest' : ''}`),
  );
  for (let tries = 0; tries < 2; tries++) {
    const answer = deps.ask('Which one? [1]: ');
    if (answer === null) return null;
    const a = answer.trim();
    const agent = a === '' ? sorted[0] : /^\d+$/.test(a) ? sorted[Number(a) - 1] : undefined;
    if (agent) return agent;
    deps.log(`  1–${sorted.length}`);
  }
  return null;
}

interface Prepared {
  projectRoot: string;
  environment: Environment;
  profilePath: string | null;
  profileDir: string;
  plan: LaunchPlan;
  /** The same plan for a focused session or a plain one. */
  replan: (focused: boolean) => LaunchPlan;
}

/** The project, the profile and the launch plan for `pathArg`; an exit code when there is none. */
function prepare(pathArg: string, deps: AiDeps, focused = false, intercom = false): Prepared | number {
  const { log } = deps;

  const projectRoot = resolveProjectRoot(pathArg);
  if (!projectRoot) {
    log(`vdx ai: ${path.resolve(pathArg)} is not a directory`);
    return EXIT_USAGE;
  }

  let environment: Environment = {};
  const profilePath = resolveEnvironmentPath(deps.env, deps.home);
  if (profilePath) {
    try {
      environment = loadEnvironment(profilePath);
    } catch (e) {
      log(`vdx ai: ${errorMessage(e)}`);
      return EXIT_USAGE;
    }
  }

  const agent = environment.agent ?? fallbackAgent(deps.onPath);
  if (!agent) {
    log(
      `vdx ai: no agent to start — ${FALLBACK_AGENTS.join(' / ')} not found on PATH and no profile names one.\n` +
        `hint: put an \`agent:\` section into ~/${USER_ENVIRONMENT_FILE} (or point $${ENVIRONMENT_ENV_VAR} at your profile).`,
    );
    return EXIT_USAGE;
  }

  const profileDir = profilePath ? path.dirname(profilePath) : deps.home;
  const named = resolveProjectName({
    projectRoot,
    repo: projectIdentity(projectRoot),
    sources: environment.session?.project_names ?? [],
    home: deps.home,
    profileDir,
  });

  const replan = (asFocused: boolean) =>
    planLaunch({
      environment,
      profilePath,
      agent,
      projectRoot,
      project: named.name,
      projectSource: named.source,
      host: hostLabel(deps.env),
      seat: seatLabel(deps.env),
      focused: asFocused,
      intercom,
    });
  let plan: LaunchPlan;
  try {
    plan = replan(focused);
  } catch (e) {
    log(`vdx ai: ${profilePath ?? 'profile'}: ${errorMessage(e)}`);
    return EXIT_USAGE;
  }
  return { projectRoot, environment, profilePath, profileDir, plan, replan };
}

/**
 * A process's environment as words (`ps -E` on macOS, /proc on Linux); null — not readable.
 * `ps -E` joins it to the command line: a word is an assignment or a piece of the command.
 */
function processEnvWords(pid: number): string[] | null {
  try {
    const environ = `/proc/${pid}/environ`;
    if (fs.existsSync(environ)) return fs.readFileSync(environ, 'utf8').split('\0');
    const out = execFileSync('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split(/\s+/);
  } catch {
    return null;
  }
}

/**
 * The seat of a tmux client: the mark `vdx ai` gave it at the attach; else a client under sshd
 * is another machine's — which one, nothing says (`?`); else this machine's.
 */
export function clientSeat(
  pid: number,
  procs: ProcInfo[],
  host: string,
  envOf: (pid: number) => string[] | null = processEnvWords,
): string {
  const mark = envOf(pid)
    ?.find((w) => w.startsWith(`${SEAT_MARK_ENV_VAR}=`))
    ?.slice(SEAT_MARK_ENV_VAR.length + 1);
  if (mark && isMachineLabel(mark)) return mark;
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  for (let p = byPid.get(pid), n = 0; p && n < 32; p = byPid.get(p.ppid), n++) {
    if (/\bsshd(-session)?\b/.test(p.args)) return '?';
  }
  return host;
}

/** How an agent process was started: `vdx ai --focused`, `vdx ai --intercom`, or neither. */
export type AgentMode = 'focused' | 'mail' | 'plain';

/**
 * The mode from the process's environment (`ps -E` on macOS, /proc on Linux). Both marks —
 * focused: deaf wins, as intercom reads it.
 */
export function processMode(pid: number): AgentMode {
  const words = processEnvWords(pid);
  if (!words) return 'plain';
  if (words.includes(`${FOCUSED_ENV_VAR}=1`)) return 'focused';
  return words.includes(`${INTERCOM_ENV_VAR}=1`) ? 'mail' : 'plain';
}

/** Was the process started focused — VDX_FOCUSED=1 in its environment? */
export function processFocused(pid: number): boolean {
  return processMode(pid) === 'focused';
}

/** macOS guards these folders on their own; a tmux server can hold a denial for every session under it. */
const GUARDED_FOLDERS = ['Downloads', 'Desktop', 'Documents'];

/**
 * The guarded folders an agent started here could not read. Through the tmux server
 * (`run-shell`): its sessions have the server's rights, not vdx's. Without a server, or
 * without tmux, this process's own — the agent gets the rights of this terminal. A folder
 * that does not exist is skipped.
 */
export function unreadableFolders(tmux: Tmux | null, home: string): string[] {
  const dirs = GUARDED_FOLDERS.map((f) => path.join(home, f));
  if (tmux) {
    // `ls`, not `[ -d ]`: a denied folder still passes -d. The answer comes back in a
    // file: tmux before 3.5 prints run-shell's output into a pane, not to the caller.
    const file = path.join(os.tmpdir(), `vdx-folders-${process.pid}-${Date.now()}`);
    const checks = dirs.map(
      (d) => `{ [ ! -d ${shellQuote(d)} ] || ls ${shellQuote(d)} >/dev/null 2>&1 || echo ${shellQuote(d)}; }`,
    );
    try {
      if (tmux.tryRun(['run-shell', `{ ${checks.join('; ')}; } > ${shellQuote(file)}`]) !== null) {
        return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      }
    } catch {
      // no answer from the server: this process's own check
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
  return dirs.filter((d) => {
    try {
      fs.readdirSync(d);
      return false;
    } catch (e) {
      const code = at(e, 'code');
      return code === 'EPERM' || code === 'EACCES';
    }
  });
}

/** One warning and its fix — the profile's `session.folders_fix`, else what works anywhere. */
export function foldersWarning(denied: string[], viaTmux: boolean, fix: string | undefined, home: string): string[] {
  const names = denied.map((d) => (d.startsWith(home + path.sep) ? `~${d.slice(home.length)}` : d)).join(', ');
  return [
    `⚠ this session cannot read ${names} — macOS holds the denial ${viaTmux ? 'in the tmux server' : 'for this terminal'}; ` +
      `files there are out of the agent's reach`,
    `  fix: ${
      fix ??
      (viaTmux
        ? 'restart the tmux server (it closes every session)'
        : 'allow this terminal app in System Settings → Privacy & Security → Files and Folders')
    }`,
  ];
}

/**
 * The agent's argv after the command. A mail session's intercom_args go first: its first
 * prompt after `--dangerously-load-development-channels <servers...>` would be read as a server.
 */
function launchArgs(plan: LaunchPlan, args: string[]): string[] {
  return [...plan.intercomArgs, ...args];
}

/** The mark of the agent's mode in its environment, if any: `VDX_FOCUSED` or `VDX_INTERCOM`. */
function modeEnvVar(plan: LaunchPlan): string | null {
  return plan.focused ? FOCUSED_ENV_VAR : plan.intercom ? INTERCOM_ENV_VAR : null;
}

/** The agent's command line; its mode's mark goes in front, for the shell in its tmux pane. */
function agentLine(plan: LaunchPlan, args: string[]): string {
  const mark = modeEnvVar(plan);
  return `${mark ? `${mark}=1 ` : ''}${commandLine(plan.command, launchArgs(plan, args))}`;
}

/** The nearest ancestor of `pid` that is the agent: the session a hook or a shell tool runs in. */
export function findOwnAgent(procs: ProcInfo[], pid: number, command: string): ProcInfo | null {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  let cur = byPid.get(pid);
  for (let hops = 0; cur && cur.ppid > 1 && hops < 64; hops++) {
    cur = byPid.get(cur.ppid);
    if (cur && isAgentProcess(cur, command)) return cur;
  }
  return null;
}

/**
 * What `vdx ai --check` tells a focused session about its topic: the topic on a line of its own —
 * the transcript keeps it for `--focused --conversation` — or that the agent sets it.
 */
function focusedTopicLines(projectRoot: string, tmux: Tmux, procs: ProcInfo[], agentPid: number): string[] {
  const pane = paneOfAgent(tmux, procs, agentPid);
  if (!pane) return ["· it runs outside tmux, so it has no topic: a topic lives in the agent's tmux session."];
  const set =
    `\`vdx ai ${shellQuote(projectRoot)} --focused "<topic>"\` ` +
    "(run here, it changes this session's topic and nothing else)";
  const topic = sessionTopic(tmux, pane.session);
  if (topic)
    return [
      topicLine(topic),
      "· keep the conversation in it: the vdx plugin (0.11+) repeats the topic with every message of the user's, " +
        `and says what to do with a message off it. When the user names another topic: ${set}.`,
    ];
  return [
    "· this focused session has no topic yet: take it from the user's first message — or the active crystal's " +
      `name, if the message is about its work — set it with ${set}, and say it to the user in one line.`,
  ];
}

/**
 * `vdx ai --check`: what an agent should know about how it is launched here,
 * and whether the session it runs in carries the profile's flags. Prints
 * nothing without a profile — on such a machine `vdx ai` decides nothing.
 */
export function runAiCheck(pathArg: string, deps: AiDeps, selfPid: number = process.pid): number {
  if (!resolveEnvironmentPath(deps.env, deps.home)) return EXIT_OK;
  // The hook runs in the agent's environment: a focused session's carries VDX_FOCUSED=1,
  // a mail session's VDX_INTERCOM=1.
  const focused = deps.env[FOCUSED_ENV_VAR] === '1';
  const intercom = !focused && deps.env[INTERCOM_ENV_VAR] === '1';
  const prepared = prepare(pathArg, deps, focused, intercom);
  if (typeof prepared === 'number') return prepared;
  const { projectRoot, profilePath, plan } = prepared;
  const vdxAi = `vdx ai${focused ? ' --focused' : intercom ? ' --intercom' : ''}`;

  const lines = [
    `${machineLine(plan.host)}; the agent in this project is started with \`vdx ai\`, and its flags come from the profile ` +
      `${profilePath} — agent.args for every project, agent.when[] for a class of projects. ` +
      `Hand the user \`vdx ai\`, not \`${plan.command} --<flag>\`; a flag a class of projects needs is a ` +
      `condition in the profile, not an instruction to type. A project's agent on another machine: ` +
      `\`vdx ai@<machine>\`. More: \`vdx ai --help\`.`,
  ];
  const procs = deps.processes();
  const own = findOwnAgent(procs, selfPid, plan.command);
  if (focused) {
    lines.push(
      `· this session is focused (\`vdx ai --focused\`): it works on what the user gave it — nothing should wake it, ` +
        `and it does not read its inbox unless the user asks` +
        (plan.skipped.length ? `; the profile's ${plan.skipped.join(', ')} is left out` : '') +
        '.',
    );
    if (own) lines.push(...focusedTopicLines(projectRoot, deps.tmux, procs, own.pid));
  }
  if (intercom) {
    // The conversation is known by this line as a mail session's (conversations.ts): keep its opening.
    lines.push(
      `${MAIL_LINE_PREFIX} (\`vdx ai --intercom\`): letters and wakes for the project come here, so the user's ` +
        `own session stays quiet, and nobody sits at this one. When nothing is left for it — right after a check ` +
        `of its inbox shows nothing to take — it ends itself: \`vdx ai --close\` (the pane closes ${CLOSE_DELAY_S} s ` +
        `later, so say what was done first). With questions to the user still unanswered: ` +
        `\`vdx ai --close --waiting <n>\` — the project's other tmux sessions here show the number; a plain ` +
        `\`--close\` clears it.`,
    );
  }
  if (!own) {
    lines.push(`· no ${plan.command} among the ancestors of this process — no session to compare with the profile.`);
    deps.out(lines.join('\n') + '\n');
    return EXIT_OK;
  }
  const missing = missingArgs(own.args, plan.args);
  const why = plan.matched.length ? ` (profile conditions met here: ${plan.matched.join(', ')})` : '';
  // A live session keeps the Claude Code and plugins it started with (vdx-ai, Sidetrack #24).
  const lag = (deps.lag ?? ((pid, root, command) => machineLag(deps, pid, root, command)))(
    own.pid,
    projectRoot,
    plan.command,
  );
  if (missing.length === 0 && !lag) {
    lines.push(`✓ this session carries the profile's flags${why}.`);
    deps.out(lines.join('\n') + '\n');
    return EXIT_OK;
  }
  const problems: string[] = [];
  if (missing.length > 0) problems.push(`✗ this session runs without ${missing.join(' ')}${why}.`);
  else lines.push(`✓ this session carries the profile's flags${why}.`);
  if (lag) problems.push(`✗ ${describeLag(lag)}.`);

  const root = shellQuote(projectRoot);
  const again = [
    missing.length > 0 ? " with the profile's flags" : '',
    lag ? `${missing.length > 0 ? ',' : ''} on the installed Claude Code and plugins` : '',
  ].join('');
  // Plugins alone: /reload-plugins loads them and the conversation goes on in the same process.
  const reload =
    missing.length === 0 && lag && !lag.claude
      ? '`/reload-plugins`: it loads the installed plugins and keeps the conversation (Claude Code stays as it is); or '
      : '';
  problems.push(
    `Hand the user the fix — ${reload}` +
      (deps.env['TMUX']
        ? `\`${vdxAi} --restart ${root}\`: it stops this session and starts it again${again}` +
          // A focused session and the mail session restart into a new conversation, and what lives
          // only in this one ends with it (ai-dev-plugins, restart-hint-wrap-first).
          (focused || intercom
            ? ", in a new conversation — before handing it over, run the project's wrap check (`/vdm:wrap` where vdm is installed): what lives only in this chat ends with it"
            : plan.resumeArgs.length
              ? `, resuming the conversation (${plan.resumeArgs.join(' ')})`
              : '') +
          `. Do not run it yourself: it ends this session.`
        : `this session runs outside tmux, so vdx cannot restart it: the user exits it and runs \`${vdxAi} ${root}\`.`),
  );
  lines.push(problems.join(' '));
  deps.out(lines.join('\n') + '\n');
  return EXIT_DRIFT;
}

/**
 * `vdx ai --close [--waiting <n>]`: the mail session ends itself — run inside it, by its
 * agent. Only the pane whose agent is this process's own ancestor and carries VDX_INTERCOM=1
 * is closed, a few seconds later: the command never ends the person's session. The project's
 * other tmux sessions here get `@vdx_waiting` = n, the questions to the person still
 * unanswered — the mail session's tab is about to go; without `--waiting`, none, and the
 * mark is cleared: the last mail session's word holds.
 */
export function runAiClose(pathArg: string, waiting: number, deps: AiDeps, selfPid: number = process.pid): number {
  const { log, tmux } = deps;
  const prepared = prepare(pathArg, deps, false, true);
  if (typeof prepared === 'number') return prepared;
  const { projectRoot, plan } = prepared;
  const procs = deps.processes();
  const own = findOwnAgent(procs, selfPid, plan.command);
  const mailOf = deps.agentMail ?? ((pid: number) => processMode(pid) === 'mail');
  if (!own || !mailOf(own.pid)) {
    log(
      `vdx ai --close: this is not a mail session (\`vdx ai --intercom\`)` +
        `${own ? '' : ` — no ${plan.command} among the ancestors of this process`}; nothing closed`,
    );
    return EXIT_USAGE;
  }
  const panes = tmux.panes();
  const pane = panes.find((p) => processTree(procs, p.panePid).some((x) => x.pid === own.pid));
  if (!pane) {
    log('vdx ai --close: this mail session runs outside tmux — nothing to close here; it ends when its agent exits');
    return EXIT_USAGE;
  }
  const others = [
    ...new Set(findAgentPanes(panes, procs, projectRoot, plan.command).map((a) => a.pane.session)),
  ].filter((s) => s !== pane.session);
  for (const s of others) {
    // `=name:` — a session option needs the session as a target, `=name` alone is not found.
    tmux.tryRun(
      waiting > 0
        ? ['set-option', '-t', `=${s}:`, WAITING_OPTION, String(waiting)]
        : ['set-option', '-u', '-t', `=${s}:`, WAITING_OPTION],
    );
  }
  if (waiting > 0)
    log(
      others.length
        ? `✓ ${waiting} waiting for the user — shown on ${others.join(', ')}`
        : `note: ${waiting} waiting for the user, and no other session of this project here to show it`,
    );
  if (tmux.tryRun(['run-shell', '-b', '-d', String(CLOSE_DELAY_S), '-C', `kill-pane -t ${pane.paneId}`]) === null) {
    log(`✗ ${pane.session} ${pane.paneId}: tmux did not take the close — the mail session keeps running`);
    return EXIT_LAUNCH_FAILED;
  }
  log(`✓ ${pane.session} ${pane.paneId}: the mail session closes in ${CLOSE_DELAY_S} s`);
  return EXIT_OK;
}

/** A focused session's topic for a start, and where it came from — as `--dry-run` and the start say. */
interface Topic {
  text: string | null;
  from: string;
}

const AGENT_TAKES_TOPIC = "the agent takes it from the user's first message";

/**
 * The topic of the focused session a start makes (focused-topic DL #3): the one named with
 * `--focused`; a restart keeps its session's; a conversation brings back its last; at a terminal
 * a question — Enter leaves it to the agent, which takes it from the first message (and knows the
 * active crystal, which vdx does not). Null — Ctrl-D at the question: nothing starts.
 */
function chooseTopic(
  opts: AiOptions,
  plan: LaunchPlan,
  deps: AiDeps,
  restarted: AgentPane | undefined,
  canAsk: boolean,
): Topic | null {
  if (opts.topic) return { text: opts.topic, from: 'from --focused' };
  const kept = restarted ? sessionTopic(deps.tmux, restarted.pane.session) : null;
  if (kept) return { text: kept, from: 'kept from its tmux session' };
  const back = opts.conversation
    ? conversationTopic({ env: deps.env, home: deps.home, projectRoot: plan.projectRoot, id: opts.conversation })
    : null;
  if (back) return { text: back, from: 'from the conversation' };
  if (!deps.interactive) return { text: null, from: AGENT_TAKES_TOPIC };
  if (!canAsk) return { text: null, from: `asked at the start; Enter — ${AGENT_TAKES_TOPIC}` };
  const answer = deps.ask(`Topic of this focused session [Enter: the agent takes it from your first message]: `);
  if (answer === null) return null;
  const typed = normalizeTopic(answer);
  return typed ? { text: typed, from: 'typed' } : { text: null, from: AGENT_TAKES_TOPIC };
}

/**
 * `vdx ai <path> --focused <topic>` run by the agent of a focused session of the project, about
 * itself: its tmux session gets the new topic, and nothing starts (focused-topic DL #3). In the
 * project's session that is not focused it is refused, with the command that starts a focused one
 * next to it: a topic is a focused session's. Null — not such a call: a start.
 */
function changeTopic(opts: AiOptions, plan: LaunchPlan, deps: AiDeps, selfPid: number): number | null {
  const topic = opts.topic;
  if (!topic || opts.fresh || opts.restart || opts.detach || opts.conversation) return null;
  const procs = deps.processes();
  const own = findOwnAgent(procs, selfPid, plan.command);
  if (!own) return null;
  const pane = paneOfAgent(deps.tmux, procs, own.pid);
  // An agent may start a focused session of another project: that is a start.
  if (pane && !isInside(realpathOr(pane.cwd), realpathOr(plan.projectRoot))) return null;
  const root = shellQuote(plan.projectRoot);
  if (deps.env[FOCUSED_ENV_VAR] !== '1') {
    deps.log("vdx ai --focused: this session is not focused, and a topic is a focused session's — nothing changed");
    deps.log(`  a focused session next to this one: vdx ai ${root} --focused ${shellQuote(topic)} --detach`);
    return EXIT_USAGE;
  }
  if (!pane) {
    deps.log(
      `vdx ai --focused: this focused session runs outside tmux, and its topic lives in the agent's tmux session ` +
        `(${TOPIC_OPTION}) — nothing changed`,
    );
    return EXIT_USAGE;
  }
  const before = sessionTopic(deps.tmux, pane.session);
  const was = before ? `, was «${before}»` : '';
  if (opts.dryRun) {
    deps.out(`vdx ai — ${pane.session}: the topic would be «${topic}»${was}\n`);
    return EXIT_OK;
  }
  if (!setSessionTopic(deps.tmux, pane.session, topic)) {
    deps.log(`✗ ${pane.session}: tmux did not take the topic — it stays ${before ? `«${before}»` : 'unset'}`);
    return EXIT_LAUNCH_FAILED;
  }
  deps.log(`✓ ${pane.session}: the topic is «${topic}»${was}`);
  return EXIT_OK;
}

/** `this session runs Claude Code 2.1.294 — 2.1.304 is installed; plugins updated since it loaded them: vdm 2.54.0`. */
function describeLag(lag: Lag): string {
  const names = lag.plugins.map((p) => `${p.name} ${p.version}`).join(', ');
  if (!lag.claude) return `plugins updated since this session loaded them: ${names} — it still runs the ones it loaded`;
  const claude = `this session runs Claude Code ${lag.claude.runs} — ${lag.claude.installed} is installed`;
  return lag.plugins.length > 0 ? `${claude}; plugins updated since it loaded them: ${names}` : claude;
}

export function runAi(opts: AiOptions, deps: AiDeps, selfPid: number = process.pid): number {
  const { log, tmux } = deps;

  if (opts.intercom && opts.focused) {
    log('vdx ai: --intercom and --focused are different sessions — the mail session, or one nothing wakes; pick one');
    return EXIT_USAGE;
  }
  if (opts.intercom && opts.conversation) {
    log('vdx ai: --intercom starts the mail session in a new conversation — it takes no --conversation');
    return EXIT_USAGE;
  }
  const prepared = prepare(opts.path, deps, opts.focused === true, opts.intercom === true);
  if (typeof prepared === 'number') return prepared;
  const { projectRoot, environment, profileDir } = prepared;
  let { plan } = prepared;
  // Run by a focused session's agent about itself: a new topic, nothing started. Read before the
  // marks below go: VDX_FOCUSED here is the agent's.
  const changed = changeTopic(opts, plan, deps, selfPid);
  if (changed !== null) return changed;
  // The agent started here runs on this machine: it does not inherit where the person sat,
  // and its mode is this start's flag, not the shell vdx runs in.
  delete deps.env[SEAT_ENV_VAR];
  delete deps.env[FOCUSED_ENV_VAR];
  delete deps.env[INTERCOM_ENV_VAR];
  // Under `vdx ai@<host>` the person is not here: this machine goes by its name.
  const atSeat = sameMachine(plan.seat, plan.host);
  const here = atSeat ? `here, on ${plan.host}` : `on ${plan.host}`;
  const vdxAiHere = atSeat ? 'vdx ai' : `vdx ai@${plan.host}`;
  if (opts.conversation && !isClaude(plan.command)) {
    log(`vdx ai: --conversation names a Claude Code conversation; the agent here is ${plan.command}`);
    return EXIT_USAGE;
  }
  // A start continues the last conversation unless asked for a new one; a focused session and
  // the mail session are new ones.
  const wantsNew = (opts.fresh || opts.focused === true || plan.intercom) && !opts.conversation;
  if (wantsNew) plan = { ...plan, resumeArgs: [] };

  let multiplexer = plan.multiplexer;
  if (multiplexer === 'tmux' && !tmux.available()) {
    log('vdx ai: tmux is not installed — starting the agent in this terminal');
    multiplexer = 'none';
  }
  if (opts.topic && multiplexer !== 'tmux') {
    log(
      `vdx ai: a topic lives in the agent's tmux session (${TOPIC_OPTION}), and this start has no tmux ` +
        `(session.multiplexer: tmux in the profile, and tmux installed) — nothing started; without a topic: vdx ai --focused ${shellQuote(projectRoot)}`,
    );
    return EXIT_USAGE;
  }

  const procs = multiplexer === 'tmux' ? deps.processes() : [];
  const agentsHere = multiplexer === 'tmux' ? findAgentPanes(tmux.panes(), procs, projectRoot, plan.command) : [];
  // The mail session and the person's sessions do not see each other: --intercom is about the
  // one mail session, every other start leaves it alone — nobody sits at it, and it ends itself.
  const mailOf = deps.agentMail ?? ((pid: number) => processMode(pid) === 'mail');
  const running = agentsHere.filter((a) => mailOf(a.proc.pid) === plan.intercom);
  const aside = agentsHere.filter((a) => !running.includes(a));
  const focusedOf = deps.agentFocused ?? processFocused;
  const conversationOf = (a: AgentPane) => liveConversationId(deps.env, deps.home, a.proc.pid);
  // Which running agent the start is about. A new conversation, or one no agent here is in, starts
  // next to them; --restart replaces one. An agent whose conversation vdx cannot read may be in the
  // one asked for: no second agent in it blindly.
  const inConversation = opts.conversation ? running.find((a) => conversationOf(a) === opts.conversation) : undefined;
  const unreadable = opts.conversation && !inConversation ? running.find((a) => conversationOf(a) === null) : undefined;
  // One mail session per project and machine: a running one is the one, never a second next to it.
  let alongside =
    !plan.intercom &&
    running.length > 0 &&
    !opts.restart &&
    !inConversation &&
    !unreadable &&
    (wantsNew || !!opts.conversation);
  let current = inConversation ?? unreadable;

  // A plain start of Claude Code: one list of what runs on every machine and what can be
  // continued, unless the choice is plain (vdx-ai-predictable).
  const wrapSkills = environment.session?.wrap_skills ?? [];
  const onBoard =
    opts.list === true ||
    (isClaude(plan.command) && !opts.conversation && !opts.restart && !plan.intercom && !wantsNew);
  let boardChoice: ConversationChoice | null = null;
  let boardNew = false;
  if (onBoard) {
    if (!isClaude(plan.command)) {
      log(`vdx ai: --list shows Claude Code's agents and conversations; the agent here is ${plan.command}`);
      return EXIT_USAGE;
    }
    const outcome = boardStart(
      plan,
      deps,
      running,
      procs,
      wrapSkills,
      { focused: focusedOf, mail: mailOf },
      opts.list ? 'print' : deps.interactive && !opts.dryRun ? 'ask' : 'auto',
    );
    switch (outcome.kind) {
      case 'listed':
        return EXIT_OK;
      case 'abort':
        for (const l of outcome.lines) log(l);
        return EXIT_LAUNCH_FAILED;
      case 'remote':
        for (const l of outcome.lines) log(l);
        return runAiRemote(
          { ...opts, path: projectRoot, conversation: outcome.conversation ?? undefined },
          outcome.host,
          deps,
          plan.seat,
        );
      case 'attach': {
        for (const l of outcome.lines) log(l);
        if (outcome.open) {
          const answer = deps.interactive
            ? deps.ask(`${outcome.agent.pane.session} is open in another terminal here — attach this one too? [y/N]: `)
            : null;
          if (!/^y(es)?$/i.test(answer?.trim() ?? '')) {
            log(`nothing done — ${outcome.agent.pane.session} is in your other terminal`);
            return EXIT_LAUNCH_FAILED;
          }
        }
        current = outcome.agent;
        break;
      }
      case 'continue':
        boardChoice = outcome.choice;
        break;
      case 'new':
        for (const l of outcome.lines) log(l);
        boardChoice = { args: [], lines: [] };
        boardNew = true;
        plan = outcome.focused ? { ...prepared.replan(true), resumeArgs: [] } : { ...plan, resumeArgs: [] };
        break;
    }
  }

  // An empty session of the project here — nothing typed in it since /clear — is the place for a
  // new conversation, not a reason for one more next to it (vdx-ai-predictable P9). Not one a
  // terminal at this seat shows, not one with a draft, and not a focused one for a plain start.
  let reused = false;
  if (
    isClaude(plan.command) &&
    !current &&
    !opts.restart &&
    !plan.intercom &&
    !opts.conversation &&
    (wantsNew || boardNew) &&
    running.length > 0
  ) {
    const free = agentFacts(running, plan, deps, procs, wrapSkills, { focused: focusedOf, mail: mailOf }).find(
      (f) => f.empty && f.draft === 0 && !openAtSeat(f, plan.seat) && (plan.focused || !f.focused),
    );
    const pane = free && running.find((a) => a.proc.pid === free.pid);
    if (pane) {
      current = pane;
      alongside = false;
      reused = true;
      log(`♻ ${pane.pane.session}: nothing typed in it since /clear — the new conversation goes there`);
    }
  }
  if (!onBoard && !current && !alongside && running.length > 0) {
    const picked = pickAgent(running, focusedOf, deps, !opts.dryRun);
    if (picked === null) {
      log('nothing done');
      return EXIT_LAUNCH_FAILED;
    }
    current = picked;
  }
  // A running agent keeps its mode: plain `vdx ai` takes a focused one as it is,
  // and the rules it leaves out are not missing from it.
  const runningFocused = current ? focusedOf(current.proc.pid) : false;
  if (current && !opts.restart && runningFocused && !plan.focused) {
    plan = { ...prepared.replan(true), resumeArgs: plan.resumeArgs };
  }

  // What a start continues. A restart keeps the conversation the agent is in.
  let choice: ConversationChoice | null = boardChoice;
  if (boardChoice) plan = { ...plan, resumeArgs: boardChoice.args };
  else if (!current || opts.restart) {
    // The mail session runs next to the person's agents on any machine by design: nothing to ask.
    if (plan.intercom) choice = { args: [], lines: [] };
    else if (opts.conversation) choice = { args: resumeId(opts.conversation), lines: [] };
    // A restart into a new conversation replaces the agent here, and a new one next to an agent here
    // is what was asked for: the other machines are not asked.
    else if ((current || alongside) && plan.resumeArgs.length === 0) choice = { args: [], lines: [] };
    else if (current && isClaude(plan.command)) {
      const live = liveConversationId(deps.env, deps.home, current.proc.pid);
      choice = live
        ? { args: resumeId(live), lines: [`the agent is in conversation ${live.slice(0, 8)} — resuming it`] }
        : chooseConversation(plan, deps, false);
    } else choice = chooseConversation(plan, deps, !opts.dryRun);
    plan = { ...plan, resumeArgs: choice.args };
  }

  const poolDirs = authorPoolDirs(environment, projectRoot, deps.home, profileDir);
  // Said before a start or an attach, never in the way: the agent runs, without those files.
  const denied =
    (deps.platform ?? process.platform) === 'darwin'
      ? unreadableFolders(multiplexer === 'tmux' ? tmux : null, deps.home)
      : [];
  const folders = denied.length
    ? foldersWarning(denied, multiplexer === 'tmux', environment.session?.folders_fix, deps.home)
    : [];
  if (opts.dryRun) {
    const topic = !plan.focused
      ? null
      : multiplexer === 'tmux'
        ? chooseTopic(opts, plan, deps, current, false)
        : { text: null, from: 'none: a topic lives in the tmux session, and this start has none' };
    deps.out(
      renderPlan(
        plan,
        multiplexer,
        running,
        focusedOf,
        freeSessionName(plan.sessionName, alongside ? running : []),
        aside,
        topic,
      ),
    );
    for (const l of choice?.lines ?? []) deps.out(`  conversation: ${l}\n`);
    for (const l of folders) deps.out(`  ${l}\n`);
    ensureAuthor(projectRoot, poolDirs, deps, true);
    ensureMemory(
      projectRoot,
      plan.command,
      personalHosts(environment.git?.personal_hosts),
      deps,
      true,
      agentsHere.length > 0,
    );
    return EXIT_OK;
  }
  for (const l of choice?.lines ?? []) log(l);
  for (const l of folders) log(l);
  if (choice?.abort) return EXIT_LAUNCH_FAILED;
  if (choice?.elsewhere && !current) {
    const answer = deps.interactive
      ? deps.ask(`Start a new conversation ${here}${atSeat ? ',' : ''} anyway? [y/N]: `)
      : null;
    if (!/^y(es)?$/i.test(answer?.trim() ?? '')) {
      log('nothing started');
      return EXIT_LAUNCH_FAILED;
    }
  }

  let askHere = choice?.askHere;
  if (choice?.remote) {
    const { host, id, reachable } = choice.remote;
    if (reachable) return runAiRemote({ ...opts, path: projectRoot, conversation: id }, host, deps, plan.seat);
    log(`✗ ${host} does not answer over ssh — its conversation ${id.slice(0, 8)} cannot be continued there`);
    askHere = { id, why: `If it still runs on ${host}, both machines will write to it` };
  }
  if (askHere) {
    const { id, why } = askHere;
    const answer = deps.interactive ? deps.ask(`Continue ${id.slice(0, 8)} ${here}? ${why}. [y/N]: `) : null;
    if (!/^y(es)?$/i.test(answer?.trim() ?? '')) {
      log(
        `nothing started. ${atSeat ? 'Here' : `On ${plan.host}`}: ${vdxAiHere} ${shellQuote(projectRoot)} --conversation ${id}` +
          ` · a new conversation: ${vdxAiHere} --new ${shellQuote(projectRoot)}`,
      );
      return EXIT_LAUNCH_FAILED;
    }
    plan = { ...plan, resumeArgs: resumeId(id) };
  }
  ensureAuthor(projectRoot, poolDirs, deps, false);
  ensureMemory(
    projectRoot,
    plan.command,
    personalHosts(environment.git?.personal_hosts),
    deps,
    false,
    agentsHere.length > 0,
  );

  if (multiplexer === 'none') {
    if (opts.restart) {
      log('vdx ai: --restart works on tmux sessions; without tmux there is nothing to restart');
      return EXIT_USAGE;
    }
    if (!deps.interactive) {
      log('vdx ai: no terminal here and no tmux — an interactive agent needs one of them');
      return EXIT_USAGE;
    }
    for (const c of plan.confirm) log(`note: the agent will ask "${c.screen}" — answer it with ${c.keys.join(' ')}`);
    const mark = modeEnvVar(plan);
    const env = mark ? { ...process.env, [mark]: '1' } : undefined;
    const startedAt = Date.now();
    let res = spawnSync(plan.command, launchArgs(plan, [...plan.args, ...plan.resumeArgs]), {
      cwd: projectRoot,
      stdio: 'inherit',
      env,
    });
    if (at(res.error, 'code') === 'ENOENT') {
      log(`vdx ai: \`${plan.command}\` not found on PATH`);
      return 127;
    }
    const failedAtOnce = res.status !== null && res.status !== 0 && Date.now() - startedAt < NOTHING_TO_RESUME_MS;
    if (plan.resumeArgs.length > 0 && failedAtOnce) {
      log(`↻ nothing to resume — starting without ${plan.resumeArgs.join(' ')}: ${agentLine(plan, plan.args)}`);
      res = spawnSync(plan.command, launchArgs(plan, plan.args), { cwd: projectRoot, stdio: 'inherit', env });
    }
    return res.status ?? 1;
  }

  if (alongside) {
    const others = running.map((r) => `${r.pane.session} ${r.pane.paneId}`).join(', ');
    log(
      `note: ${others} keep${running.length === 1 ? 's' : ''} running ${plan.command} — starting another one next to it, ` +
        `in ${opts.conversation ? `conversation ${opts.conversation.slice(0, 8)}` : 'a new conversation'}`,
    );
  }

  // A focused conversation in an empty session: its agent restarts focused, with the new topic.
  if (current && !opts.restart && !(reused && plan.focused)) {
    if (current === unreadable) {
      log(
        `note: ${current.pane.session} runs ${plan.command} in a conversation vdx cannot read — attaching to it; ` +
          `to switch it: vdx ai --restart ${shellQuote(projectRoot)} --conversation ${opts.conversation}`,
      );
    }
    const unfocused = plan.focused && !runningFocused;
    // A topic named for the focused agent attached to is its topic from now on.
    const { session } = current.pane;
    const attachTopic = () => {
      if (!opts.topic || !runningFocused) return;
      if (setSessionTopic(tmux, session, opts.topic)) log(`🎯 ${session}: the topic is «${opts.topic}»`);
      else log(`✗ ${session}: tmux did not take the topic`);
    };
    const missing = unfocused ? [] : missingArgs(current.proc.args, plan.args);
    if (!unfocused && missing.length === 0) {
      const mode = runningFocused ? ', focused' : plan.intercom ? ', the mail session' : '';
      log(`✓ ${current.pane.session}: already running with the profile${mode} — ${current.proc.args}`);
      attachTopic();
      return finish(true, current.pane.session, current.pane.paneId, opts, deps, runningFocused, plan.seat);
    }
    // Drift. In a terminal the person picks: the agent as it runs, or a restart
    // with the profile; without one nothing is touched, and the fix is named.
    const drift = `${current.pane.session}: ${plan.command} is running${unfocused ? ', not focused' : ` without ${missing.join(' ')}`}`;
    const modeFlag = plan.focused ? ' --focused' : plan.intercom ? ' --intercom' : '';
    const fix =
      `vdx ai --restart${modeFlag}${opts.fresh ? ' --new' : ''} ${shellQuote(projectRoot)}` +
      (opts.conversation ? ` --conversation ${opts.conversation}` : '');
    const effect = plan.resumeArgs.length
      ? 'stops the running agent, then resumes its conversation'
      : opts.fresh || plan.intercom
        ? 'stops the running agent and starts a new conversation'
        : 'stops the running agent; the conversation is not resumed — the profile has no resume_args';
    if (!deps.interactive) {
      log(`✗ ${drift}`);
      log(`  ${unfocused ? 'to focus it' : 'to apply the profile'}: ${fix} (${effect})`);
      return EXIT_DRIFT;
    }
    log(`⚠ ${drift}`);
    log(
      `  Enter  ${opts.detach ? 'leave it running' : 'attach to it'} as is${unfocused ? '' : ' — the flags wait for a restart'}`,
    );
    log(`  r      restart it ${unfocused ? 'focused' : 'with the profile'}: ${effect}`);
    log(`  q      leave it; later: ${fix}`);
    const answer = deps.ask(`${opts.detach ? 'Leave it as is' : 'Attach as is'}? [Enter/r/q]: `);
    if (answer === '') {
      log(`→ ${current.pane.session}: as is — ${current.proc.args}`);
      attachTopic();
      return finish(true, current.pane.session, current.pane.paneId, opts, deps, runningFocused, plan.seat);
    }
    if (answer?.toLowerCase() !== 'r') {
      log('nothing done');
      return EXIT_DRIFT;
    }
    // As --restart: the conversation the agent is in, not the folder's newest — another agent's, maybe.
    const live = isClaude(plan.command) && plan.resumeArgs.length > 0 ? conversationOf(current) : null;
    if (live) plan = { ...plan, resumeArgs: resumeId(live) };
  }

  // Nobody sits at a detached start, and Claude Code holds one in a folder it does not trust on
  // its trust window, unseen (intercom-session-mode Sidetrack #4). The answer is the person's.
  if (opts.detach && isClaude(plan.command) && claudeTrusts(projectRoot, deps.env, deps.home) === false) {
    log(`✗ Claude Code has not trusted ${projectRoot} yet: a detached agent would wait on its trust window, unseen`);
    log(`  start it once at a terminal and answer the window: ${vdxAiHere} ${shellQuote(projectRoot)}`);
    return EXIT_LAUNCH_FAILED;
  }

  // The topic goes into the tmux session before the agent starts: its session-start hook reads it.
  let topic: Topic | null = null;
  if (plan.focused) {
    topic = chooseTopic(opts, plan, deps, reused ? undefined : current, true);
    if (!topic) {
      log('no answer — nothing started');
      return EXIT_LAUNCH_FAILED;
    }
  }
  const topicSaid = () => {
    if (topic) log(topic.text ? `🎯 topic «${topic.text}» (${topic.from})` : `🎯 no topic yet — ${topic.from}`);
  };

  if (current) {
    const line = agentLine(plan, [...plan.args, ...plan.resumeArgs]);
    log(`↻ ${current.pane.session} ${current.pane.paneId}: restarting — ${line}`);
    setSessionTopic(tmux, current.pane.session, topic?.text ?? null);
    topicSaid();
    tmux.respawn(current.pane.paneId, projectRoot, tmuxShellCommand(line, deps.shell, !plan.intercom));
    return finish(
      settleResumed(plan, current.pane.paneId, deps),
      current.pane.session,
      current.pane.paneId,
      opts,
      deps,
      plan.focused,
      plan.seat,
    );
  }

  if (opts.restart) log(`note: no running ${plan.command} in this project — starting one`);
  if (plan.intercom && plan.intercomArgs.length === 0)
    log('note: the profile has no agent.intercom_args — the mail session starts idle and waits for a wake');
  const line = agentLine(plan, [...plan.args, ...plan.resumeArgs]);
  const cmd = tmuxShellCommand(line, deps.shell, !plan.intercom);
  const session = freeSessionName(plan.sessionName, running);
  const reuse = tmux.hasSession(session);
  if (reuse) setSessionTopic(tmux, session, topic?.text ?? null);
  const paneId = reuse ? tmux.newWindow(session, projectRoot, cmd) : tmux.newSession(session, projectRoot, cmd);
  if (!reuse && topic?.text) setSessionTopic(tmux, session, topic.text);
  log(`▶ ${session}${reuse ? ' (new window)' : ''}: ${line}`);
  topicSaid();
  return finish(settleResumed(plan, paneId, deps), session, paneId, opts, deps, plan.focused, plan.seat);
}
