import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import YAML from 'js-yaml';
import { evalPredicate } from './evaluator.ts';
import { autoDetectStack, readStructured, resolveConfigPath, type Ctx } from './facts.ts';
import { loadManifest } from './manifest.ts';
import { type Author, effectiveAuthor, isGitRepo, rankAuthors, scanPool, writeAuthor } from './author.ts';
import type { Predicate } from './rubric.ts';
import {
  type Conversation,
  describeConversation,
  describeLive,
  isMachineLabel,
  LIVE_SESSIONS_SCRIPT,
  type LiveSession,
  latestPerMachine,
  listConversations,
  liveConversationId,
  liveSessionsHere,
  machineLine,
  type MachineReport,
  machineOf,
  parseMachineReport,
  runsInProject,
} from './conversations.ts';

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
export interface ConfirmRule {
  screen: string;
  keys: string[];
}

export interface WhenRule {
  id: string;
  description?: string;
  if: Predicate;
  args?: string[];
  confirm?: ConfirmRule[];
}

export interface AgentProfile {
  command: string;
  args?: string[];
  resume_args?: string[];
  when?: WhenRule[];
}

export type Multiplexer = 'tmux' | 'none';

/** A place a project's short name may come from: a structured file and a dot path into it. */
export interface NameSource {
  /** `{repo}` is the repository name; `~` the home directory; relative to the profile's directory. */
  file: string;
  jsonpath: string;
}

export interface SessionProfile {
  multiplexer?: Multiplexer;
  name?: string;
  /** Tried after `[vdx] name` in the project's mise.toml; the first non-empty string wins. */
  project_names?: NameSource[];
  /** The machines a project's agent may run on, as ssh destinations; vdx asks the others what runs there. */
  machines?: string[];
}

export interface GitProfile {
  /** Directories whose repos are the neighbours an author is proposed from; default — the project's parent. */
  author_pool?: string[];
}

export interface Environment {
  schema_version?: string;
  metadata?: Record<string, unknown>;
  agent?: AgentProfile;
  session?: SessionProfile;
  git?: GitProfile;
}

export const ENVIRONMENT_ENV_VAR = 'VDX_ENVIRONMENT';
export const HOST_ENV_VAR = 'VDX_HOST';
export const USER_ENVIRONMENT_FILE = '.vdx-environment.yaml';
/** Tried in order when no profile names an agent. Started plain, with no flags. */
export const FALLBACK_AGENTS = ['claude', 'codex'] as const;
export const DEFAULT_SESSION_NAME = '{project}';

export function resolveEnvironmentPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string | null {
  const explicit = env[ENVIRONMENT_ENV_VAR];
  if (explicit) return path.resolve(explicit.replace(/^~(?=$|\/)/, home));
  const user = path.join(home, USER_ENVIRONMENT_FILE);
  return fs.existsSync(user) ? user : null;
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Parse and validate a profile. Throws with the offending key named. */
export function parseEnvironment(text: string, source: string): Environment {
  const data = YAML.load(text) as unknown;
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
    for (const key of ['args', 'resume_args'] as const) {
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
        if (!isMachineLabel(m)) fail(`session.machines[${i}]`, 'must be an ssh destination: letters, digits, . _ - and no leading -');
      });
    }
  }

  const gitDoc = envDoc.git;
  if (gitDoc !== undefined) {
    if (typeof gitDoc !== 'object' || gitDoc === null) fail('git', 'must be a mapping');
    if (gitDoc.author_pool !== undefined && !isStringList(gitDoc.author_pool)) {
      fail('git.author_pool', 'must be a list of directories');
    }
  }
  return envDoc;
}

export function loadEnvironment(file: string): Environment {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e: any) {
    throw new Error(`cannot read profile ${file}: ${e?.code ?? e?.message ?? e}`);
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

export interface LaunchPlan {
  projectRoot: string;
  project: string;
  /** Where `project` came from: mise.toml, a profile source, or the repository name. */
  projectSource: string;
  host: string;
  profilePath: string | null;
  command: string;
  /** agent.args plus the args of every matched `when` rule — what a running agent must carry. */
  args: string[];
  resumeArgs: string[];
  matched: string[];
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
}): LaunchPlan {
  const { environment, agent, projectRoot } = input;
  const ctx: Ctx = { projectRoot, stack: autoDetectStack(projectRoot), cache: new Map() };
  const args = [...(agent.args ?? [])];
  const matched: string[] = [];
  const confirm: ConfirmRule[] = [];
  for (const rule of agent.when ?? []) {
    if (!evalPredicate(rule.if, ctx)) continue;
    matched.push(rule.id);
    args.push(...(rule.args ?? []));
    confirm.push(...(rule.confirm ?? []));
  }
  return {
    projectRoot,
    project: input.project,
    projectSource: input.projectSource ?? 'repository name',
    host: input.host,
    profilePath: input.profilePath,
    command: agent.command,
    args,
    resumeArgs: [...(agent.resume_args ?? [])],
    matched,
    confirm,
    multiplexer: environment.session?.multiplexer ?? 'none',
    sessionName: renderSessionName(environment.session?.name ?? DEFAULT_SESSION_NAME, {
      project: input.project,
      host: input.host,
    }),
    machines: (environment.session?.machines ?? []).filter((m) => m.toLowerCase() !== input.host.toLowerCase()),
  };
}

export function shellQuote(s: string): string {
  if (s !== '' && /^[A-Za-z0-9_\/.:@%+=,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function commandLine(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(' ');
}

/**
 * The pane runs the agent inside the user's login shell, so the agent sees what
 * `.zshrc` sets up exactly as when it is typed by hand; the tmux server's own
 * environment does not have it. When the agent exits, the pane keeps a shell.
 */
export function tmuxShellCommand(line: string, shell: string | null): string {
  if (!shell) return line;
  const sh = shellQuote(shell);
  return `exec ${sh} -lic ${shellQuote(`${line}; exec ${sh} -l`)}`;
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

export const PANE_FORMAT = '#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_path}';

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

export function isInside(child: string, parent: string): boolean {
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
    const slug = url.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop();
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
 * `{project}`: `[vdx] name` in the project's mise.toml, else the first profile
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
  const own = loadManifest(input.projectRoot)?.name;
  if (typeof own === 'string' && own.trim()) return { name: own.trim(), source: 'mise.toml [vdx] name' };
  for (const src of input.sources) {
    const file = path.resolve(
      input.profileDir,
      src.file.replace(/^~(?=$|\/)/, input.home).replace(/\{repo\}/g, input.repo),
    );
    // Readers take paths relative to a project root; from "/" an absolute path stays itself.
    const value = resolveConfigPath(readStructured({ projectRoot: '/', stack: '', cache: new Map() }, file), src.jsonpath);
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

  attach(session: string, insideTmux: boolean): number {
    const args = insideTmux
      ? ['switch-client', '-t', `=${session}`]
      : ['attach-session', '-t', `=${session}`];
    return spawnSync('tmux', this.argv(args), { stdio: 'inherit' }).status ?? 1;
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
}

export function runSsh(args: string[], capture: boolean): { status: number; stdout: string } | null {
  const res = spawnSync('ssh', args, { stdio: capture ? ['ignore', 'pipe', 'ignore'] : 'inherit', encoding: 'utf8' });
  if ((res.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
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
    } catch (e: any) {
      if (e?.code === 'EAGAIN') {
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
export const NOTHING_TO_RESUME_MS = 30_000;

export function renderPlan(plan: LaunchPlan, multiplexer: Multiplexer, running: AgentPane[]): string {
  const lines = [
    `vdx ai — ${plan.projectRoot}`,
    `  name:     ${plan.project} (${plan.projectSource})`,
    `  profile:  ${plan.profilePath ?? `none — built-in default (${FALLBACK_AGENTS.join(' or ')}, no flags, no tmux)`}`,
    `  agent:    ${commandLine(plan.command, plan.args)}`,
    `  resume:   ${plan.resumeArgs.length ? plan.resumeArgs.join(' ') : '—'}`,
    `  matched:  ${plan.matched.length ? plan.matched.join(', ') : '—'}`,
  ];
  for (const c of plan.confirm) lines.push(`  confirm:  "${c.screen}" → ${c.keys.join(' ')}`);
  lines.push(
    multiplexer === 'tmux'
      ? `  session:  tmux; a new session is named "${plan.sessionName}"`
      : '  session:  this terminal (no tmux)',
  );
  if (multiplexer === 'tmux') {
    if (running.length === 0) lines.push('  running:  —');
    for (const r of running) {
      const missing = missingArgs(r.proc.args, plan.args);
      lines.push(
        `  running:  ${r.pane.session} ${r.pane.paneId} — ${
          missing.length ? `missing ${missing.join(' ')}` : 'matches the profile'
        }`,
      );
    }
  }
  return lines.join('\n') + '\n';
}

function lastLines(screen: string | null, n: number): string {
  const lines = (screen ?? '').split('\n').filter((l) => l.trim() !== '');
  return lines.slice(-n).map((l) => `    | ${l}`).join('\n');
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
  const line = commandLine(plan.command, plan.args);
  deps.log(`↻ nothing to resume — starting without ${plan.resumeArgs.join(' ')}: ${line}`);
  deps.tmux.respawn(paneId, plan.projectRoot, tmuxShellCommand(line, deps.shell));
  return settle(plan, paneId, deps) === 'ok';
}

function finish(ok: boolean, session: string, paneId: string, opts: AiOptions, deps: AiDeps): number {
  if (deps.interactive && !opts.detach) {
    if (!ok) deps.log('attaching so you can see the pane');
    deps.tmux.focus(paneId);
    return deps.tmux.attach(session, Boolean(deps.env['TMUX']));
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
 */
export function remoteAiArgs(input: {
  host: string;
  projectPath: string;
  home: string;
  version: string;
  opts: AiOptions;
  tty: boolean;
}): string[] {
  const { host, opts, version } = input;
  const flags = [
    opts.fresh && '--new',
    opts.restart && '--restart',
    opts.detach && '--detach',
    opts.dryRun && '--dry-run',
    opts.conversation && `--conversation ${shellQuote(opts.conversation)}`,
  ].filter((f): f is string => Boolean(f));
  const v = shellQuote(version);
  const script =
    `v=$(vdx --version 2>/dev/null) || v='older than 0.13.1'; ` +
    `[ "$v" = ${v} ] || echo "note: vdx on ${host} is $v, here "${v} >&2; ` +
    `exec vdx ai ${[remotePathWord(input.projectPath, input.home), ...flags].join(' ')}`;
  return [input.tty ? '-t' : '-T', host, script];
}

/** Where neighbour repos live: the profile's `git.author_pool`, else the project's parent directory. */
export function authorPoolDirs(environment: Environment, projectRoot: string, home: string, profileDir: string): string[] {
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
      a === '' ? top[0] : /^\d+$/.test(a) ? top[Number(a) - 1] : a.includes('@') ? { name: top[0]!.name, email: a } : undefined;
    if (pick) {
      if (writeAuthor(projectRoot, pick)) deps.log(`✓ ${pick.name} <${pick.email}> → .git/config`);
      else deps.log(`✗ could not write .git/config — ${command(pick)}`);
      return;
    }
    deps.log(`  1–${top.length}, an address, or s`);
  }
}

export function runAiRemote(opts: AiOptions, host: string, deps: AiDeps, version: string = deps.version ?? ''): number {
  const projectPath = resolveProjectRoot(opts.path) ?? path.resolve(opts.path);
  const tty = deps.interactive && !opts.detach && !opts.dryRun;
  const args = remoteAiArgs({ host, projectPath, home: deps.home, version, opts, tty });
  deps.log(`→ ${host}: vdx ai ${shellQuote(projectPath)}${opts.conversation ? ` --conversation ${opts.conversation}` : ''}`);
  const res = (deps.ssh ?? runSsh)(args, false);
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
 * The Claude Code sessions alive on `host` right now; null when it does not
 * answer over ssh (BatchMode: a password prompt counts as no answer).
 */
export function askMachine(host: string, deps: AiDeps): MachineReport | null {
  const res = (deps.ssh ?? runSsh)(
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host, `sh -c ${shellQuote(LIVE_SESSIONS_SCRIPT)}`],
    true,
  );
  return res && res.status === 0 ? parseMachineReport(res.stdout) : null;
}

/** What a start continues: resume args here, or a conversation on another machine. */
export interface ConversationChoice {
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

export function isClaude(command: string): boolean {
  return path.basename(command) === 'claude';
}

const resumeId = (id: string) => ['--resume', id];

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
export function chooseConversation(plan: LaunchPlan, deps: AiDeps, canAsk: boolean): ConversationChoice {
  if (!isClaude(plan.command)) return { args: plan.resumeArgs, lines: [] };
  const host = plan.host;
  const same = (a: string | null, b: string | null) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
  const all = plan.resumeArgs.length === 0 ? [] : listConversations({ env: deps.env, home: deps.home, projectRoot: plan.projectRoot });
  const root = shellQuote(plan.projectRoot);

  // Who runs what right now: this machine from its session files, the others over ssh.
  const reach = new Map<string, MachineReport | null>();
  for (const m of [...plan.machines, ...all.map((c) => c.machine)]) {
    if (m && !same(m, host) && ![...reach.keys()].some((k) => same(k, m))) reach.set(m, askMachine(m, deps));
  }
  const silent = [...reach].filter(([, r]) => r === null).map(([m]) => `note: ${m} does not answer over ssh — what runs there is not known`);
  const elsewhere = [...reach].flatMap(([m, r]) =>
    (r?.sessions ?? []).filter((l) => runsInProject(l, r!.home, plan.projectRoot, deps.home)).map((l) => ({ m, l })),
  );
  const fresh = (lines: string[]): ConversationChoice => {
    if (elsewhere.length === 0) return { args: [], lines };
    const agents = elsewhere.map(({ m, l }) => `an agent of this project is ${describeLive(m, l, false)} — there: vdx ai@${m} ${root}`);
    return { args: [], elsewhere: [...new Set(elsewhere.map(({ m }) => m))], lines: [...lines, ...agents] };
  };
  if (plan.resumeArgs.length === 0) return fresh(silent);
  if (all.length === 0) return fresh(['no conversation of this project yet — starting a new one', ...silent]);

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
  const running = (c: Conversation) => (live.get(c.id) ?? []).map((l) => describeLive(l.machine, l.session, l.here));

  const take = (c: Conversation): ConversationChoice => {
    const m = machine(c);
    const here = runsHere(c);
    if (here) {
      return {
        args: [],
        askHere: { id: c.id, why: `It runs here right now (${here.session.tmux ?? `pid ${here.session.pid}`}); two sessions would write to it` },
        lines: [`chosen: ${show(c)}`],
      };
    }
    if (isOurs(c)) return { args: resumeId(c.id), lines: [`continuing ${show(c)}`] };
    if (m) return { args: [], remote: { host: m, id: c.id, reachable: reach.get(m) != null }, lines: [`continuing on ${m}: ${show(c)}`] };
    return {
      args: [],
      askHere: { id: c.id, why: 'Its machine is unknown (never typed in here); if it runs there, both machines will write to it' },
      lines: [`chosen: ${show(c)}`],
    };
  };
  if (found.every(idleHere)) {
    const chosen = take(found[0]!);
    return { ...chosen, lines: [...chosen.lines, ...silent] };
  }

  const firstIdle = found.find(idleHere);
  if (canAsk && deps.interactive) {
    deps.log('conversations of this project:');
    found.forEach((c, i) => {
      const marks = [i === 0 && 'newest', c === firstIdle && 'this machine', !machine(c) && 'machine unknown', ...running(c)];
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
      return m
        ? `note: ${m} has ${which} — continue it there: vdx ai@${m} ${root} --conversation ${c.id}`
        : `note: ${which} is of an unknown machine (never typed in here) — on its machine: vdx ai@<machine> ${root} --conversation ${c.id}`;
    });
  notes.push(...silent);
  if (firstIdle) {
    const chosen = take(firstIdle);
    return { ...chosen, lines: [...chosen.lines, ...notes] };
  }
  return fresh(['no idle conversation of this machine — starting a new one', ...notes]);
}

interface Prepared {
  projectRoot: string;
  environment: Environment;
  profilePath: string | null;
  profileDir: string;
  plan: LaunchPlan;
}

/** The project, the profile and the launch plan for `pathArg`; an exit code when there is none. */
function prepare(pathArg: string, deps: AiDeps): Prepared | number {
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
    } catch (e: any) {
      log(`vdx ai: ${e?.message ?? e}`);
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

  let plan: LaunchPlan;
  try {
    plan = planLaunch({
      environment,
      profilePath,
      agent,
      projectRoot,
      project: named.name,
      projectSource: named.source,
      host: hostLabel(deps.env),
    });
  } catch (e: any) {
    log(`vdx ai: ${profilePath ?? 'profile'}: ${e?.message ?? e}`);
    return EXIT_USAGE;
  }
  return { projectRoot, environment, profilePath, profileDir, plan };
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
 * `vdx ai --check`: what an agent should know about how it is launched here,
 * and whether the session it runs in carries the profile's flags. Prints
 * nothing without a profile — on such a machine `vdx ai` decides nothing.
 */
export function runAiCheck(pathArg: string, deps: AiDeps, selfPid: number = process.pid): number {
  if (!resolveEnvironmentPath(deps.env, deps.home)) return EXIT_OK;
  const prepared = prepare(pathArg, deps);
  if (typeof prepared === 'number') return prepared;
  const { projectRoot, profilePath, plan } = prepared;

  const lines = [
    `${machineLine(plan.host)}; the agent in this project is started with \`vdx ai\`, and its flags come from the profile ` +
      `${profilePath} — agent.args for every project, agent.when[] for a class of projects. ` +
      `Hand the user \`vdx ai\`, not \`${plan.command} --<flag>\`; a flag a class of projects needs is a ` +
      `condition in the profile, not an instruction to type. A project's agent on another machine: ` +
      `\`vdx ai@<machine>\`. More: \`vdx ai --help\`.`,
  ];
  const own = findOwnAgent(deps.processes(), selfPid, plan.command);
  if (!own) {
    lines.push(`· no ${plan.command} among the ancestors of this process — no session to compare with the profile.`);
    deps.out(lines.join('\n') + '\n');
    return EXIT_OK;
  }
  const missing = missingArgs(own.args, plan.args);
  const why = plan.matched.length ? ` (profile conditions met here: ${plan.matched.join(', ')})` : '';
  if (missing.length === 0) {
    lines.push(`✓ this session carries the profile's flags${why}.`);
    deps.out(lines.join('\n') + '\n');
    return EXIT_OK;
  }
  const root = shellQuote(projectRoot);
  lines.push(
    `✗ this session runs without ${missing.join(' ')}${why}. Hand the user the fix — ` +
      (deps.env['TMUX']
        ? `\`vdx ai --restart ${root}\`: it stops this session and starts it again with the profile's flags` +
          (plan.resumeArgs.length ? `, resuming the conversation (${plan.resumeArgs.join(' ')})` : '') +
          `. Do not run it yourself: it ends this session.`
        : `this session runs outside tmux, so vdx cannot restart it: the user exits it and runs \`vdx ai ${root}\`.`),
  );
  deps.out(lines.join('\n') + '\n');
  return EXIT_DRIFT;
}

export function runAi(opts: AiOptions, deps: AiDeps): number {
  const { log, tmux } = deps;

  const prepared = prepare(opts.path, deps);
  if (typeof prepared === 'number') return prepared;
  const { projectRoot, environment, profileDir } = prepared;
  let { plan } = prepared;
  if (opts.conversation && !isClaude(plan.command)) {
    log(`vdx ai: --conversation names a Claude Code conversation; the agent here is ${plan.command}`);
    return EXIT_USAGE;
  }
  // A start continues the last conversation unless asked for a new one.
  if (opts.fresh) plan = { ...plan, resumeArgs: [] };

  let multiplexer = plan.multiplexer;
  if (multiplexer === 'tmux' && !tmux.available()) {
    log('vdx ai: tmux is not installed — starting the agent in this terminal');
    multiplexer = 'none';
  }

  const running =
    multiplexer === 'tmux'
      ? findAgentPanes(tmux.panes(), deps.processes(), projectRoot, plan.command)
      : [];
  const current = running[0];

  // What a start continues. A restart keeps the conversation the agent is in.
  let choice: ConversationChoice | null = null;
  if (!current || opts.restart) {
    if (opts.conversation) choice = { args: resumeId(opts.conversation), lines: [] };
    // A restart into a new conversation replaces the agent here: no second agent, nothing to ask.
    else if (current && plan.resumeArgs.length === 0) choice = { args: [], lines: [] };
    else if (current && isClaude(plan.command)) {
      const live = liveConversationId(deps.env, deps.home, current.proc.pid);
      choice = live
        ? { args: resumeId(live), lines: [`the agent is in conversation ${live.slice(0, 8)} — resuming it`] }
        : chooseConversation(plan, deps, false);
    } else choice = chooseConversation(plan, deps, !opts.dryRun);
    plan = { ...plan, resumeArgs: choice.args };
  }

  const poolDirs = authorPoolDirs(environment, projectRoot, deps.home, profileDir);
  if (opts.dryRun) {
    deps.out(renderPlan(plan, multiplexer, running));
    for (const l of choice?.lines ?? []) deps.out(`  conversation: ${l}\n`);
    ensureAuthor(projectRoot, poolDirs, deps, true);
    return EXIT_OK;
  }
  for (const l of choice?.lines ?? []) log(l);
  if (choice?.abort) return EXIT_LAUNCH_FAILED;
  if (choice?.elsewhere && !current) {
    const answer = deps.interactive ? deps.ask(`Start a new conversation here, on ${plan.host}, anyway? [y/N]: `) : null;
    if (!/^y(es)?$/i.test(answer?.trim() ?? '')) {
      log('nothing started');
      return EXIT_LAUNCH_FAILED;
    }
  }

  let askHere = choice?.askHere;
  if (choice?.remote) {
    const { host, id, reachable } = choice.remote;
    if (reachable) return runAiRemote({ ...opts, path: projectRoot, conversation: id }, host, deps);
    log(`✗ ${host} does not answer over ssh — its conversation ${id.slice(0, 8)} cannot be continued there`);
    askHere = { id, why: `If it still runs on ${host}, both machines will write to it` };
  }
  if (askHere) {
    const { id, why } = askHere;
    const answer = deps.interactive ? deps.ask(`Continue ${id.slice(0, 8)} here, on ${plan.host}? ${why}. [y/N]: `) : null;
    if (!/^y(es)?$/i.test(answer?.trim() ?? '')) {
      log(
        `nothing started. Here: vdx ai ${shellQuote(projectRoot)} --conversation ${id}` +
          ` · a new conversation: vdx ai --new ${shellQuote(projectRoot)}`,
      );
      return EXIT_LAUNCH_FAILED;
    }
    plan = { ...plan, resumeArgs: resumeId(id) };
  }
  ensureAuthor(projectRoot, poolDirs, deps, false);

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
    const startedAt = Date.now();
    let res = spawnSync(plan.command, [...plan.args, ...plan.resumeArgs], { cwd: projectRoot, stdio: 'inherit' });
    if ((res.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      log(`vdx ai: \`${plan.command}\` not found on PATH`);
      return 127;
    }
    const failedAtOnce = res.status !== null && res.status !== 0 && Date.now() - startedAt < NOTHING_TO_RESUME_MS;
    if (plan.resumeArgs.length > 0 && failedAtOnce) {
      log(`↻ nothing to resume — starting without ${plan.resumeArgs.join(' ')}: ${commandLine(plan.command, plan.args)}`);
      res = spawnSync(plan.command, plan.args, { cwd: projectRoot, stdio: 'inherit' });
    }
    return res.status ?? 1;
  }

  if (running.length > 1) {
    log(
      `note: ${running.length} panes run ${plan.command} in this project: ` +
        `${running.map((r) => `${r.pane.session} ${r.pane.paneId}`).join(', ')} — using the first`,
    );
  }

  if (current && !opts.restart) {
    if (opts.fresh) log(`note: ${current.pane.session} already runs ${plan.command} — --new replaces it only with --restart`);
    if (opts.conversation) {
      const live = liveConversationId(deps.env, deps.home, current.proc.pid);
      if (live !== opts.conversation) {
        log(
          `note: ${current.pane.session} is in ${live ? `conversation ${live.slice(0, 8)}` : 'another conversation'} — ` +
            `to switch it: vdx ai --restart ${shellQuote(projectRoot)} --conversation ${opts.conversation}`,
        );
      }
    }
    const missing = missingArgs(current.proc.args, plan.args);
    if (missing.length > 0) {
      log(`✗ ${current.pane.session}: ${plan.command} is running without ${missing.join(' ')}`);
      log(
        `  to apply the profile: vdx ai --restart${opts.fresh ? ' --new' : ''} ${shellQuote(projectRoot)}` +
          (plan.resumeArgs.length
            ? ` (stops the running agent, then resumes its conversation)`
            : opts.fresh
              ? ' (stops the running agent and starts a new conversation)'
              : ' (stops the running agent; the conversation is not resumed — the profile has no resume_args)'),
      );
      return EXIT_DRIFT;
    }
    log(`✓ ${current.pane.session}: already running with the profile — ${current.proc.args}`);
    return finish(true, current.pane.session, current.pane.paneId, opts, deps);
  }

  if (current) {
    const line = commandLine(plan.command, [...plan.args, ...plan.resumeArgs]);
    log(`↻ ${current.pane.session} ${current.pane.paneId}: restarting — ${line}`);
    tmux.respawn(current.pane.paneId, projectRoot, tmuxShellCommand(line, deps.shell));
    return finish(settleResumed(plan, current.pane.paneId, deps), current.pane.session, current.pane.paneId, opts, deps);
  }

  if (opts.restart) log(`note: no running ${plan.command} in this project — starting one`);
  const line = commandLine(plan.command, [...plan.args, ...plan.resumeArgs]);
  const cmd = tmuxShellCommand(line, deps.shell);
  const reuse = tmux.hasSession(plan.sessionName);
  const paneId = reuse
    ? tmux.newWindow(plan.sessionName, projectRoot, cmd)
    : tmux.newSession(plan.sessionName, projectRoot, cmd);
  log(`▶ ${plan.sessionName}${reuse ? ' (new window)' : ''}: ${line}`);
  return finish(settleResumed(plan, paneId, deps), plan.sessionName, paneId, opts, deps);
}
