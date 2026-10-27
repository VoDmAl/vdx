import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  type Environment,
  hostLabel,
  loadEnvironment,
  type MoveHook,
  remotePathWord,
  resolveEnvironmentPath,
  resolveProjectRoot,
  shellQuote,
} from './ai.ts';
import {
  claudeConfigDir,
  claudeTrusts,
  LIVE_SESSIONS_SCRIPT,
  type LiveSession,
  parseMachineReport,
  projectDirName,
  runsInProject,
} from './conversations.ts';
import {
  describeMemory,
  fixProjectMemory,
  memoryApplies,
  memoryState,
  moveConversations,
  personalHosts,
} from './memory.ts';
import { at, dict, errorMessage } from './narrow.ts';

/**
 * `vdx move <project>… <folder>` — moves projects into a folder on every machine of
 * the profile (`session.machines`) and takes along what Claude Code files by the
 * folder's path: the memory path, the conversations, the trust in the folder
 * (claude-memory-in-project DL #17, #18).
 *
 * Nothing changes until every check passed on every machine: the new place is free,
 * each machine answers, Syncthing has caught up with the folder, and no session of
 * the project is in a turn. An idle session is closed only after a yes and is
 * started again in the new place, in the same conversation. The `mv` runs on every
 * machine that has the folder — so what Syncthing does not carry (`node_modules`,
 * builds, a container's database) moves with it, and no old folder is left behind.
 * A machine whose `mv` fails puts the others back.
 */

export const EXIT_MOVED = 0;
export const EXIT_USAGE = 2;
export const EXIT_REFUSED = 3;
export const EXIT_FAILED = 4;

/** What a shell script printed and how it ended; null — the machine did not answer. */
type Ran = { status: number; stdout: string } | null;

export interface MoveDeps {
  env: NodeJS.ProcessEnv;
  home: string;
  /** A person at a terminal can answer. */
  interactive: boolean;
  log: (line: string) => void;
  ask: (prompt: string) => string | null;
  /** A shell script on this machine, with HOME set to `home`. */
  sh: (script: string) => Ran;
  /** ssh with this argv; null when ssh is not on PATH. */
  ssh: (args: string[]) => Ran;
  /** A `move.after` command on this machine; its output goes to the person. Returns the exit status. */
  hook: (command: string, env: Record<string, string>) => number;
  /** Start the agent again in its conversation, in the new place: here (host null) or on `host`. */
  restart: (input: { host: string | null; path: string; conversation: string; focused: boolean }) => number;
  sleep: (ms: number) => void;
  today: string;
  /** How long to wait for Syncthing to catch up with a folder; default a minute. */
  syncWaitMs?: number;
}

interface Machine {
  label: string;
  /** null — this machine. */
  host: string | null;
}

interface Planned {
  name: string;
  from: string;
  to: string;
}

interface Probe {
  home: string | null;
  sessions: LiveSession[];
  /** Projects whose folder this machine has. */
  old: Set<number>;
  /** Projects whose new place is taken on this machine. */
  dest: Set<number>;
  /** syncthing-caught-up per project: its exit status, or `none` — not installed. */
  caught: Map<number, number | 'none'>;
}

/** A session of a project to close before the move and start again after it. */
interface Found {
  machine: Machine;
  project: number;
  live: LiveSession;
  /** Read when it is closed: from its process's environment. */
  mode?: 'focused' | 'mail' | 'plain';
}

const SYNC_POLL_MS = 5_000;

function runOn(m: Machine, script: string, deps: MoveDeps): Ran {
  if (m.host === null) return deps.sh(script);
  return deps.ssh(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', m.host, `sh -c ${shellQuote(script)}`]);
}

/** `p` with its existing part resolved through links: the new folder may not be there yet. */
function realish(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    const up = path.dirname(abs);
    return up === abs ? abs : path.join(realish(up), path.basename(abs));
  }
}

function tilde(p: string, home: string): string {
  return p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/** The tmux pane of a session, from its session file (`name:@window.%pane`). */
function paneOf(live: LiveSession): string | null {
  return live.tmux?.match(/\.(%\d+)$/)?.[1] ?? null;
}

const FIND_CAUGHT_UP = 'c=$(command -v syncthing-caught-up 2>/dev/null) || c="$HOME/.local/bin/syncthing-caught-up"';

/**
 * One script for every machine: its live Claude Code sessions (LIVE_SESSIONS_SCRIPT), and
 * per project whether the folder is there, whether Syncthing has caught up with it,
 * whether the new place is taken. Paths go as words under that machine's home.
 */
function probeScript(moves: Planned[], home: string): string {
  const lines = moves.map((m, i) => {
    const o = remotePathWord(m.from, home);
    const d = remotePathWord(m.to, home);
    return (
      `if [ -d ${o} ]; then echo "old ${i}"; ` +
      `if [ -x "$c" ]; then "$c" --fast ${o} >/dev/null 2>&1; echo "caught ${i} $?"; else echo "caught ${i} none"; fi; fi; ` +
      `if [ -e ${d} ]; then echo "dest ${i}"; fi`
    );
  });
  return `(${LIVE_SESSIONS_SCRIPT}); ${FIND_CAUGHT_UP}; ${lines.join('; ')}; exit 0`;
}

function parseProbe(text: string): Probe {
  const report = parseMachineReport(text);
  const probe: Probe = { ...report, old: new Set(), dest: new Set(), caught: new Map() };
  for (const line of text.split('\n')) {
    const m = line.match(/^(old|dest|caught) (\d+)(?: (\S+))?$/);
    if (!m) continue;
    const i = Number(m[2]);
    if (m[1] === 'old') probe.old.add(i);
    else if (m[1] === 'dest') probe.dest.add(i);
    else probe.caught.set(i, m[3] === 'none' ? 'none' : Number(m[3]));
  }
  return probe;
}

/** syncthing-caught-up: 0 caught up, 1 changes on the way, 2 not in a Syncthing folder, 3 cannot tell. */
function caughtUpProblem(code: number | 'none' | undefined): string | null {
  if (code === undefined || code === 'none' || code === 0 || code === 2) return null;
  if (code === 1) return 'Syncthing still has changes of the folder on the way';
  if (code === 3) return 'Syncthing cannot tell whether it has caught up with the folder';
  return `syncthing-caught-up exited ${code}`;
}

/**
 * Ends a session: checks the pid is still the agent, prints its mode (from the
 * process's environment, as `vdx ai` reads it), sends SIGTERM, waits up to 10 s, closes
 * its tmux pane. Exit 3 — the pid is not the agent any more; 1 — it did not end.
 */
function endScript(live: LiveSession, agent: string): string {
  const pane = paneOf(live);
  return [
    `p=${live.pid}`,
    `ps -o args= -p $p 2>/dev/null | grep -q -- ${shellQuote(agent)} || exit 3`,
    `if [ -r /proc/$p/environ ]; then e=$(tr '\\0' ' ' < /proc/$p/environ); else e=$(ps -E -ww -o command= -p $p 2>/dev/null); fi`,
    'case " $e " in *" VDX_FOCUSED=1 "*) echo focused;; *" VDX_INTERCOM=1 "*) echo mail;; *) echo plain;; esac',
    'kill -TERM $p',
    'i=0; while kill -0 $p 2>/dev/null && [ $i -lt 40 ]; do sleep 0.25; i=$((i+1)); done',
    'kill -0 $p 2>/dev/null && exit 1',
    ...(pane ? [`tmux kill-pane -t ${shellQuote(pane)} 2>/dev/null`] : []),
    'exit 0',
  ].join('; ');
}

function mvScript(from: string, to: string, home: string): string {
  return `mkdir -p ${remotePathWord(path.dirname(to), home)} && mv ${remotePathWord(from, home)} ${remotePathWord(to, home)}`;
}

/** `.claude.json` of Claude Code: in CLAUDE_CONFIG_DIR, else the home directory. */
function claudeJson(env: NodeJS.ProcessEnv, home: string): string {
  const dir = env['CLAUDE_CONFIG_DIR']?.trim();
  return path.join(dir ? path.resolve(dir.replace(/^~(?=$|\/)/, home)) : home, '.claude.json');
}

/**
 * The old folder's record in Claude Code's `.claude.json`, trust and all, under the new
 * path: the person's own earlier answer, not one given for them (DL #18). Written through
 * a link (the file may live in a synced folder), by a rename next to it.
 */
function carryTrust(from: string, to: string, env: NodeJS.ProcessEnv, home: string): void {
  const file = fs.realpathSync(claudeJson(env, home));
  const data = dict(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!data) throw new Error(`${file} holds no JSON object`);
  const projects = dict(data['projects']) ?? {};
  projects[to.normalize('NFC')] = { ...(dict(projects[from.normalize('NFC')]) ?? {}), hasTrustDialogAccepted: true };
  data['projects'] = projects;
  const tmp = `${file}.vdx-move-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: fs.statSync(file).mode });
  fs.renameSync(tmp, file);
}

function settingsChanged(root: string): boolean {
  const run = (args: string[]) => spawnSync('git', ['-C', root, ...args], { stdio: 'ignore' }).status;
  return (
    run(['ls-files', '--error-unmatch', '.claude/settings.json']) === 0 &&
    run(['diff', '--quiet', '--', '.claude/settings.json']) === 1
  );
}

function describeSession(f: Found): string {
  const where = f.live.tmux ? f.live.tmux.replace(/:.*$/, '') : `pid ${f.live.pid}`;
  return `${where} on ${f.machine.label} (${f.live.status ?? 'no status'}, conversation ${f.live.conversation.slice(0, 8)})`;
}

export function runMove(input: { sources: string[]; folder: string; dryRun: boolean }, deps: MoveDeps): number {
  const { log, home } = deps;
  const expand = (p: string) => p.replace(/^~(?=$|\/)/, home);

  let environment: Environment = {};
  const profilePath = resolveEnvironmentPath(deps.env, home);
  if (profilePath) {
    try {
      environment = loadEnvironment(profilePath);
    } catch (e) {
      log(`vdx move: ${errorMessage(e)}`);
      return EXIT_USAGE;
    }
  }
  const agent = path.basename(environment.agent?.command ?? 'claude');

  const folder = realish(expand(input.folder));
  const config = realish(claudeConfigDir(deps.env, home));
  const homeReal = realish(home);
  const moves: Planned[] = [];
  const refusals: string[] = [];
  for (const src of input.sources) {
    const abs = realish(expand(src));
    const root = resolveProjectRoot(abs);
    if (!root) {
      refusals.push(`${src}: no such folder`);
      continue;
    }
    if (root !== abs) {
      refusals.push(`${src} lies inside the project ${tilde(root, home)} — name the project's own folder`);
      continue;
    }
    if (within(homeReal, root) || within(root, config)) {
      refusals.push(`${tilde(root, home)} is no project folder`);
      continue;
    }
    const to = path.join(folder, path.basename(root));
    if (to === root) refusals.push(`${tilde(root, home)} is in ${tilde(folder, home)} already`);
    else if (within(folder, root)) refusals.push(`${tilde(folder, home)} lies inside ${tilde(root, home)}`);
    else if (moves.some((m) => m.from === root || m.to === to))
      refusals.push(`${tilde(root, home)}: named twice, or another project has its name`);
    else moves.push({ name: path.basename(root), from: root, to });
  }
  if (refusals.length) {
    for (const r of refusals) log(`vdx move: ${r}`);
    log('nothing moved');
    return EXIT_USAGE;
  }

  const hereLabel = hostLabel(deps.env);
  const machines: Machine[] = [
    { label: hereLabel, host: null },
    ...(environment.session?.machines ?? [])
      .filter((m) => m.toLowerCase() !== hereLabel.toLowerCase())
      .map((m) => ({ label: m, host: m })),
  ];

  // The checks, on every machine, before anything changes.
  const probes = new Map<Machine, Probe>();
  const probe = (m: Machine): Probe | null => {
    const ran = runOn(m, probeScript(moves, home), deps);
    return ran && ran.status === 0 ? parseProbe(ran.stdout) : null;
  };
  for (const m of machines) {
    const p = probe(m);
    if (!p) {
      log(
        `vdx move: ${m.label} does not answer over ssh — its sessions and its copy of the folder cannot be checked; nothing moved`,
      );
      return EXIT_REFUSED;
    }
    probes.set(m, p);
  }
  // Changes on the way are waited for, a minute at most.
  const waitUntil = Date.now() + (deps.syncWaitMs ?? 60_000);
  for (const m of machines) {
    for (;;) {
      const pending = [...probes.get(m)!.caught.values()].includes(1);
      if (!pending || Date.now() >= waitUntil) break;
      log(`… Syncthing on ${m.label} has changes on the way — waiting`);
      deps.sleep(SYNC_POLL_MS);
      const again = probe(m);
      if (again) probes.set(m, again);
    }
  }

  const sessions: Found[] = [];
  for (const m of machines) {
    const p = probes.get(m)!;
    moves.forEach((mv, i) => {
      if (p.dest.has(i)) refusals.push(`${tilde(mv.to, home)} is taken on ${m.label}`);
      const sync = caughtUpProblem(p.caught.get(i));
      if (sync) refusals.push(`${mv.name} on ${m.label}: ${sync}`);
      for (const live of p.sessions)
        if (runsInProject(live, p.home, mv.from, home)) sessions.push({ machine: m, project: i, live });
    });
  }
  const busy = sessions.filter((s) => s.live.status !== 'idle');
  for (const s of busy) refusals.push(`a session of ${moves[s.project]!.name} is not idle: ${describeSession(s)}`);
  const noSync = machines.filter((m) => [...probes.get(m)!.caught.values()].includes('none'));

  log(`vdx move — ${moves.length} project(s) → ${tilde(folder, home)}/`);
  moves.forEach((mv, i) => {
    log(`  ${mv.name}: ${tilde(mv.from, home)} → ${tilde(mv.to, home)}`);
    const on = machines.filter((m) => probes.get(m)!.old.has(i)).map((m) => m.label);
    log(`    folder on: ${on.join(', ')}`);
    for (const s of sessions.filter((x) => x.project === i)) log(`    session: ${describeSession(s)}`);
  });
  for (const m of noSync) log(`  note: no syncthing-caught-up on ${m.label} — Syncthing not checked there`);
  const hooks = (environment.move?.after ?? []).filter((h) => !h.when_exists || fs.existsSync(expand(h.when_exists)));
  if (hooks.length) log(`  then: ${hooks.map((h) => h.name).join(', ')} (move.after)`);

  if (refusals.length) {
    for (const r of refusals) log(`✗ ${r}`);
    log('nothing moved');
    return EXIT_REFUSED;
  }
  if (input.dryRun) {
    log('dry run: nothing moved');
    return EXIT_MOVED;
  }

  if (sessions.length) {
    if (!deps.interactive) {
      log(`✗ ${sessions.length} idle session(s) of the project(s) run — close them, or run vdx move in a terminal`);
      log('nothing moved');
      return EXIT_REFUSED;
    }
    const answer = deps.ask(
      `Close ${sessions.length} idle session(s) and start them again in the new place, same conversation? [Y/n] `,
    );
    if (answer === null || /^n(o)?$/i.test(answer.trim())) {
      log('nothing moved');
      return EXIT_REFUSED;
    }
  }

  // Trust is read before the folder goes: Claude Code finds it by the path.
  const trusted = moves.map((mv) => claudeTrusts(mv.from, deps.env, home) === true);

  const closed: Found[] = [];
  const startAgain = (place: (f: Found) => string) => {
    for (const f of closed) {
      if (f.mode === 'mail') {
        log(`  ${describeSession(f)}: the mail session — the next letter starts it`);
        continue;
      }
      const status = deps.restart({
        host: f.machine.host,
        path: place(f),
        conversation: f.live.conversation,
        focused: f.mode === 'focused',
      });
      log(`${status === 0 ? '✓' : '✗'} started again: ${describeSession(f)}${status === 0 ? '' : ` — exit ${status}`}`);
    }
  };
  for (const f of sessions) {
    const ran = runOn(f.machine, endScript(f.live, agent), deps);
    if (!ran || ran.status !== 0) {
      log(`✗ could not close ${describeSession(f)}${ran ? ` (exit ${ran.status})` : ' — no answer'}`);
      startAgain((x) => moves[x.project]!.from);
      log('nothing moved');
      return EXIT_FAILED;
    }
    const mode = ran.stdout.trim().split('\n').pop();
    f.mode = mode === 'focused' || mode === 'mail' ? mode : 'plain';
    closed.push(f);
    log(`✓ closed ${describeSession(f)}`);
  }

  const done = new Set<number>();
  for (const [i, mv] of moves.entries()) {
    const on = machines.filter((m) => probes.get(m)!.old.has(i));
    const movedOn: Machine[] = [];
    for (const m of on) {
      const ran = runOn(m, mvScript(mv.from, mv.to, home), deps);
      if (ran && ran.status === 0) {
        movedOn.push(m);
        continue;
      }
      log(`✗ ${mv.name}: mv on ${m.label} failed${ran ? ` (exit ${ran.status})` : ' — no answer'}`);
      for (const back of movedOn) {
        const undo = runOn(back, `mv ${remotePathWord(mv.to, home)} ${remotePathWord(mv.from, home)}`, deps);
        log(
          undo && undo.status === 0
            ? `  put back on ${back.label}`
            : `  ✗ could not put it back on ${back.label}: ${tilde(mv.to, home)} → ${tilde(mv.from, home)} by hand`,
        );
      }
      startAgain((x) => (done.has(x.project) ? moves[x.project]!.to : moves[x.project]!.from));
      return EXIT_FAILED;
    }
    done.add(i);
    log(`✓ ${mv.name}: ${tilde(mv.from, home)} → ${tilde(mv.to, home)} on ${movedOn.map((m) => m.label).join(', ')}`);

    // What Claude Code files by the path. The conversations first: without a memory path
    // set, `vdx doctor --fix` would not take them along.
    const projects = path.join(claudeConfigDir(deps.env, home), 'projects');
    const oldDir = path.join(projects, projectDirName(mv.from));
    try {
      if (fs.existsSync(oldDir))
        log(`  ${moveConversations(oldDir, path.join(projects, projectDirName(mv.to)), deps.today)}`);
      if (trusted[i] && claudeTrusts(mv.to, deps.env, home) === false) {
        carryTrust(mv.from, mv.to, deps.env, home);
        log(
          claudeTrusts(mv.to, deps.env, home)
            ? '  Claude Code trusts the new folder, as it did the old one'
            : '  ✗ the trust record did not stay in .claude.json — a running Claude Code wrote over it; the first start here asks',
        );
      }
      const ctx = { env: deps.env, home };
      if (memoryApplies(mv.to, ctx)) {
        const state = memoryState(mv.to, ctx);
        if (state.kind === 'moved') {
          const fixed = fixProjectMemory(mv.to, state, ctx, {
            ask: () => null,
            log,
            today: deps.today,
            personalHosts: personalHosts(environment.git?.personal_hosts),
          });
          for (const line of fixed) if (!line.startsWith('sessions of this project')) log(`  ${line}`);
        }
        log(`  memory: ${describeMemory(memoryState(mv.to, ctx), ctx)}`);
        if (settingsChanged(mv.to)) log('  commit .claude/settings.json with the project: the memory path in it moved');
      }
    } catch (e) {
      log(`  ✗ ${errorMessage(e)} — vdx doctor --fix ${shellQuote(mv.to)}`);
    }
    for (const h of hooks) runHook(h, mv, deps);
  }

  startAgain((x) => moves[x.project]!.to);
  return EXIT_MOVED;
}

function runHook(h: MoveHook, mv: Planned, deps: MoveDeps): void {
  const status = deps.hook(h.command, { VDX_MOVE_FROM: mv.from, VDX_MOVE_TO: mv.to });
  deps.log(`${status === 0 ? '✓' : '✗'} ${h.name} (move.after)${status === 0 ? '' : ` — exit ${status}`}`);
}

export function defaultMoveDeps(base: {
  env: NodeJS.ProcessEnv;
  home: string;
  interactive: boolean;
  log: (line: string) => void;
  ask: (prompt: string) => string | null;
  sleep: (ms: number) => void;
  restart: MoveDeps['restart'];
}): MoveDeps {
  const shell = (script: string, extra: Record<string, string> = {}, capture = true) => {
    const res = spawnSync('sh', ['-c', script], {
      env: { ...base.env, HOME: base.home, ...extra },
      encoding: 'utf8',
      stdio: capture ? ['ignore', 'pipe', 'ignore'] : ['ignore', 2, 2],
    });
    return { status: res.status ?? 1, stdout: res.stdout ?? '' };
  };
  return {
    ...base,
    sh: (script) => shell(script),
    ssh: (args) => {
      const res = spawnSync('ssh', args, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
      if (at(res.error, 'code') === 'ENOENT') return null;
      return { status: res.status ?? 255, stdout: res.stdout ?? '' };
    },
    hook: (command, env) => shell(command, env, false).status,
    today: new Date().toLocaleDateString('sv-SE'),
  };
}
