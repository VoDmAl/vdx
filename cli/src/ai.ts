import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import YAML from 'js-yaml';
import { evalPredicate } from './evaluator.ts';
import { autoDetectStack, type Ctx } from './facts.ts';
import type { Predicate } from './rubric.ts';

/**
 * `vdx ai` — start the person's agent in a project, with the flags their
 * profile asks for. vdx runs nothing itself: it builds the agent's command line
 * and hands it to tmux, or runs it in this terminal when tmux is not wanted or
 * not installed.
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

export interface SessionProfile {
  multiplexer?: Multiplexer;
  name?: string;
}

export interface Environment {
  schema_version?: string;
  metadata?: Record<string, unknown>;
  agent?: AgentProfile;
  session?: SessionProfile;
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
}

export function planLaunch(input: {
  environment: Environment;
  profilePath: string | null;
  agent: AgentProfile;
  projectRoot: string;
  project: string;
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
  resume: boolean;
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
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
  };
}

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_DRIFT = 3;
export const EXIT_LAUNCH_FAILED = 4;

export function renderPlan(plan: LaunchPlan, multiplexer: Multiplexer, running: AgentPane[]): string {
  const lines = [
    `vdx ai — ${plan.projectRoot}`,
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
 * Settle a pane that was started with the resume args. An agent with nothing to
 * resume exits at once; start it once more without them rather than leave the
 * project without an agent.
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

export function runAi(opts: AiOptions, deps: AiDeps): number {
  const { log, tmux } = deps;

  const projectRoot = resolveProjectRoot(opts.path);
  if (!projectRoot) {
    log(`vdx ai: ${path.resolve(opts.path)} is not a directory`);
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

  let plan: LaunchPlan;
  try {
    plan = planLaunch({
      environment,
      profilePath,
      agent,
      projectRoot,
      project: projectIdentity(projectRoot),
      host: hostLabel(deps.env),
    });
  } catch (e: any) {
    log(`vdx ai: ${profilePath ?? 'profile'}: ${e?.message ?? e}`);
    return EXIT_USAGE;
  }

  let multiplexer = plan.multiplexer;
  if (multiplexer === 'tmux' && !tmux.available()) {
    log('vdx ai: tmux is not installed — starting the agent in this terminal');
    multiplexer = 'none';
  }

  const running =
    multiplexer === 'tmux'
      ? findAgentPanes(tmux.panes(), deps.processes(), projectRoot, plan.command)
      : [];

  if (opts.dryRun) {
    deps.out(renderPlan(plan, multiplexer, running));
    return EXIT_OK;
  }

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
    const args = [...plan.args, ...(opts.resume ? plan.resumeArgs : [])];
    const res = spawnSync(plan.command, args, { cwd: projectRoot, stdio: 'inherit' });
    if ((res.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      log(`vdx ai: \`${plan.command}\` not found on PATH`);
      return 127;
    }
    return res.status ?? 1;
  }

  const current = running[0];
  if (running.length > 1) {
    log(
      `note: ${running.length} panes run ${plan.command} in this project: ` +
        `${running.map((r) => `${r.pane.session} ${r.pane.paneId}`).join(', ')} — using the first`,
    );
  }

  if (current && !opts.restart) {
    const missing = missingArgs(current.proc.args, plan.args);
    if (missing.length > 0) {
      log(`✗ ${current.pane.session}: ${plan.command} is running without ${missing.join(' ')}`);
      log(
        `  to apply the profile: vdx ai --restart ${shellQuote(projectRoot)}` +
          (plan.resumeArgs.length
            ? ` (stops the running agent, then resumes the conversation with ${plan.resumeArgs.join(' ')})`
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

  if (opts.restart) log(`note: no running ${plan.command} in this project — starting a new one`);
  const line = commandLine(plan.command, [...plan.args, ...(opts.resume ? plan.resumeArgs : [])]);
  const cmd = tmuxShellCommand(line, deps.shell);
  const reuse = tmux.hasSession(plan.sessionName);
  const paneId = reuse
    ? tmux.newWindow(plan.sessionName, projectRoot, cmd)
    : tmux.newSession(plan.sessionName, projectRoot, cmd);
  log(`▶ ${plan.sessionName}${reuse ? ' (new window)' : ''}: ${line}`);
  const ok = opts.resume ? settleResumed(plan, paneId, deps) : settle(plan, paneId, deps) === 'ok';
  return finish(ok, plan.sessionName, paneId, opts, deps);
}
