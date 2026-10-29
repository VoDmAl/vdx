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
  describeAge,
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
import { at, dict, errorMessage, list, str } from './narrow.ts';

/**
 * `vdx move <project>… <folder>` — moves projects into a folder on every machine of
 * the profile (`session.machines`) and takes along what Claude Code files by the
 * folder's path: the memory path, the conversations, the trust in the folder
 * (claude-memory-in-project DL #17, #18).
 *
 * Any move works (DL #20): within a Syncthing folder, from one into another, out of
 * Syncthing, into it, or beside it. Each machine says where the old and the new path lie
 * in Syncthing (syncthing-caught-up --json), and the plan names the case and what the
 * folder's peers outside the profile will see.
 *
 * Nothing changes until every check passed on every machine: the new place is free,
 * each machine answers, Syncthing has caught up with the folder, no session of the
 * project is in a turn, no container mounts it. An idle session is closed only after a
 * yes and is started again in the new place, in the same conversation. The Syncthing
 * folders of both paths are paused on every machine while the `mv` runs on each — else
 * one machine gets the other's deletion of the old path before its own `mv` — and
 * resumed whatever happens (DL #19). A machine whose `mv` fails puts the others back.
 *
 * Copies: the machines of a synced folder hold one copy, each moves it, so what
 * Syncthing does not carry (`node_modules`, builds, a container's database) moves along;
 * a folder on a network disk or in a cloud folder is one copy everywhere, moved once;
 * any other folder is a machine's own copy. Copies whose new places Syncthing would merge
 * cannot all go: the person picks one, the others stay where they are (DL #22).
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

/** syncthing-caught-up's answer for one path on one machine. */
interface SyncAt {
  /** The Syncthing folder (its id) the path lies in; null — none. */
  folder: string | null;
  /** 0 caught up, 1 changes on the way, 2 not in a Syncthing folder, 3 cannot tell. */
  code: number;
}

interface Peer {
  device: string;
  name: string;
}

interface Probe {
  home: string | null;
  sessions: LiveSession[];
  /** Projects whose folder this machine has. */
  old: Set<number>;
  /** Projects whose new place is taken on this machine. */
  dest: Set<number>;
  /** syncthing-caught-up answered: per project, where its old and new path lie in Syncthing. */
  caughtUp: boolean;
  sync: Map<number, { from: SyncAt; to: SyncAt }>;
  /** Folder id → its peers, as syncthing-caught-up names them. */
  peers: Map<string, Peer[]>;
  /** This machine's Syncthing device id (`syncthing cli`); null — no syncthing command here. */
  myId: string | null;
  /** Projects whose folder is on a network disk: the same folder on every machine that sees it. */
  shared: Set<number>;
  /** Projects whose new place is on another volume: `mv` copies, then deletes. */
  otherVolume: Set<number>;
  /** The git state of this machine's copy, for choosing between copies. */
  git: Map<number, { head: string | null; dirty: number; committed: number | null }>;
  /** Running containers and the host paths they mount; null — no docker here. */
  containers: { name: string; sources: string[] }[] | null;
  /** Processes whose working directory lies in a project's folder (lsof), with their parent. */
  cwds: { project: number; pid: number; ppid: number; command: string }[];
}

/** A session of a project to close before the move and start again after it. */
interface Found {
  machine: Machine;
  project: number;
  live: LiveSession;
  /** Read when it is closed: from its process's environment. */
  mode?: 'focused' | 'mail' | 'plain';
}

/** One copy of a project's folder, and where its `mv` runs. */
interface Copy {
  kind: 'synced' | 'shared' | 'own';
  /** The machines whose old folder this copy is: their sessions close, their folder goes. */
  machines: Machine[];
  /** Every machine of a synced copy; one of a shared one. */
  mvOn: Machine[];
}

/** What happens to one project: which copies move, which folders pause, who sees what. */
interface ProjectPlan {
  copies: Copy[];
  /** The copies' new places would be merged by Syncthing: one goes, the person picks. */
  pick: boolean;
  chosen: Copy[];
  /** Folders that pause, per machine. */
  pause: Map<Machine, Set<string>>;
  /** Machines whose copy of the new place Syncthing fills. */
  receivers: Machine[];
  /** Peers of the folders outside the profile, and what they get. */
  outside: { name: string; gets: 'deletion' | 'download' | 'own blocks' }[];
}

const SYNC_POLL_MS = 5_000;
/** Paths under the home directory whose content a cloud service keeps the same on every machine. */
const CLOUD_DIRS = ['Dropbox', 'Library/CloudStorage', 'Library/Mobile Documents'];
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'tcsh']);
const VERDICT_CODE: Record<string, number> = { 'caught-up': 0, ignored: 0, incoming: 1, outside: 2, unknown: 3 };

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

/** A path under this home as it is on a machine with home `there`; any other path as is. */
function onMachine(p: string, home: string, there: string | null): string {
  const rel = path.relative(home, p);
  return there && !rel.startsWith('..') && !path.isAbsolute(rel) ? path.join(there, rel) : p;
}

/** The tmux pane of a session, from its session file (`name:@window.%pane`). */
function paneOf(live: LiveSession): string | null {
  return live.tmux?.match(/\.(%\d+)$/)?.[1] ?? null;
}

const FIND_CAUGHT_UP = 'c=$(command -v syncthing-caught-up 2>/dev/null) || c="$HOME/.local/bin/syncthing-caught-up"';

/**
 * One script for every machine: its live Claude Code sessions (LIVE_SESSIONS_SCRIPT), its
 * Syncthing device id, and per project whether the folder is there and the new place taken;
 * syncthing-caught-up --json on both paths of every project (folder, verdict, peers); whether
 * the folder is on a network disk (df: `//host/…`, `host:/…`) and the new place on another
 * volume; the copy's git state; running containers' mounts; processes working in the folder.
 * Paths go as words under that machine's home.
 */
function probeScript(moves: Planned[], home: string): string {
  const lines = [
    `(${LIVE_SESSIONS_SCRIPT})`,
    FIND_CAUGHT_UP,
    'dev() { if [ "$(uname)" = Darwin ]; then stat -f %d "$1"; else stat -c %d "$1"; fi 2>/dev/null; }',
    'if command -v syncthing >/dev/null 2>&1; then',
    `  id=$(syncthing cli show system 2>/dev/null | sed -n 's/.*"myID": *"\\([^"]*\\)".*/\\1/p' | head -n 1)`,
    '  echo "myid ${id:-none}"',
    'else echo "myid none"; fi',
  ];
  moves.forEach((m, i) => {
    lines.push(
      `o${i}=${remotePathWord(m.from, home)}; d${i}=${remotePathWord(m.to, home)}`,
      `if [ -d "$o${i}" ]; then`,
      `  echo "old ${i}"`,
      `  f=$(df -P "$o${i}" 2>/dev/null | awk 'NR==2{print $1}'); case "$f" in //*|*:*) echo "shared ${i}";; esac`,
      `  q=$d${i}; q=\${q%/*}; while [ -n "$q" ] && [ ! -e "$q" ]; do q=\${q%/*}; done`,
      `  [ "$(dev "$o${i}")" = "$(dev "\${q:-/}")" ] || echo "volume ${i}"`,
      `  if [ -e "$o${i}/.git" ]; then`,
      `    echo "git ${i} $(git -C "$o${i}" rev-parse --short HEAD 2>/dev/null || echo -) $(git -C "$o${i}" status --porcelain 2>/dev/null | wc -l | tr -d ' ') $(git -C "$o${i}" log -1 --format=%ct 2>/dev/null || echo -)"`,
      '  fi',
      'fi',
      `if [ -e "$d${i}" ]; then echo "dest ${i}"; fi`,
    );
  });
  // Not --fast: with files needed anywhere in the Syncthing folder it cannot tell whether
  // they lie in this one, and a busy folder always needs some (exit 3, 2026-10-27).
  const words = moves.map((_, i) => `"$o${i}" "$d${i}"`).join(' ');
  lines.push(
    `if [ -x "$c" ]; then printf 'caught '; "$c" --json ${words} 2>/dev/null | tr -d '\\n'; echo; else echo "caught none"; fi`,
    'if command -v docker >/dev/null 2>&1; then',
    '  echo docker',
    `  docker ps -q 2>/dev/null | while read -r k; do printf 'mounts '; docker inspect --format '{{.Name}}{{range .Mounts}}{{"\\t"}}{{.Source}}{{end}}' "$k" 2>/dev/null || echo; done`,
    'fi',
    // The probe's parent — vdx itself here, sshd there — is no process of the project.
    'if command -v lsof >/dev/null 2>&1; then',
    '  self=$PPID',
    '  lsof -R -d cwd -FpRcn 2>/dev/null | while IFS= read -r l; do case "$l" in',
    '    p*) p=${l#p};; R*) r=${l#R};; c*) cm=${l#c};;',
    '    n*) n=${l#n}; [ "$p" = "$self" ] && continue',
    ...moves.map((_, i) => `      case "$n" in "$o${i}"|"$o${i}"/*) echo "cwd ${i} $p $r $cm";; esac`),
    '      ;;',
    '  esac; done',
    'fi',
    'exit 0',
  );
  return lines.join('\n');
}

function parseCaught(text: string, probe: Probe, count: number): void {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return;
  }
  const paths = list(at(data, 'paths'));
  const syncAt = (p: unknown): SyncAt => ({
    folder: str(at(p, 'folder')) ?? null,
    code: VERDICT_CODE[str(at(p, 'verdict')) ?? ''] ?? 3,
  });
  for (let i = 0; i < count; i++) probe.sync.set(i, { from: syncAt(paths[2 * i]), to: syncAt(paths[2 * i + 1]) });
  for (const [id, f] of Object.entries(dict(at(data, 'folders')) ?? {})) {
    const peers = list(at(f, 'peers')).flatMap((p) => {
      const device = str(at(p, 'device'));
      return device ? [{ device, name: str(at(p, 'name')) ?? device.slice(0, 7) }] : [];
    });
    probe.peers.set(id, peers);
  }
  probe.caughtUp = true;
}

function parseProbe(text: string, count: number): Probe {
  const report = parseMachineReport(text);
  const probe: Probe = {
    ...report,
    old: new Set(),
    dest: new Set(),
    caughtUp: false,
    sync: new Map(),
    peers: new Map(),
    myId: null,
    shared: new Set(),
    otherVolume: new Set(),
    git: new Map(),
    containers: null,
    cwds: [],
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('caught ')) {
      if (line !== 'caught none') parseCaught(line.slice('caught '.length), probe, count);
      continue;
    }
    if (line === 'docker') {
      probe.containers = [];
      continue;
    }
    if (line.startsWith('mounts ')) {
      const [name, ...sources] = line.slice('mounts '.length).split('\t');
      if (name) probe.containers?.push({ name: name.replace(/^\//, ''), sources: sources.filter(Boolean) });
      continue;
    }
    const id = line.match(/^myid (\S+)$/);
    if (id) {
      probe.myId = id[1] === 'none' ? null : id[1]!;
      continue;
    }
    const cwd = line.match(/^cwd (\d+) (\d+) (\d+) (.*)$/);
    if (cwd) {
      probe.cwds.push({ project: Number(cwd[1]), pid: Number(cwd[2]), ppid: Number(cwd[3]), command: cwd[4]! });
      continue;
    }
    const g = line.match(/^git (\d+) (\S+) (\d+) (\S+)$/);
    if (g) {
      probe.git.set(Number(g[1]), {
        head: g[2] === '-' ? null : g[2]!,
        dirty: Number(g[3]),
        committed: g[4] === '-' ? null : Number(g[4]),
      });
      continue;
    }
    const m = line.match(/^(old|dest|shared|volume) (\d+)$/);
    if (!m) continue;
    const i = Number(m[2]);
    ({ old: probe.old, dest: probe.dest, shared: probe.shared, volume: probe.otherVolume })[
      m[1] as 'old' | 'dest' | 'shared' | 'volume'
    ].add(i);
  }
  return probe;
}

function caughtUpProblem(code: number | undefined): string | null {
  if (code === undefined || code === 0 || code === 2) return null;
  if (code === 1) return 'Syncthing still has changes of the folder on the way';
  if (code === 3) return 'Syncthing cannot tell whether it has caught up with the folder';
  return `syncthing-caught-up answered ${code}`;
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
  const here: Machine = { label: hereLabel, host: null };
  const machines: Machine[] = [
    here,
    ...(environment.session?.machines ?? [])
      .filter((m) => m.toLowerCase() !== hereLabel.toLowerCase())
      .map((m) => ({ label: m, host: m })),
  ];

  // The checks, on every machine, before anything changes.
  const probes = new Map<Machine, Probe>();
  const probe = (m: Machine): Probe | null => {
    const ran = runOn(m, probeScript(moves, home), deps);
    return ran && ran.status === 0 ? parseProbe(ran.stdout, moves.length) : null;
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
  const sync = (m: Machine, i: number) => probes.get(m)!.sync.get(i);
  // Changes on the way are waited for, a minute at most.
  const waitUntil = Date.now() + (deps.syncWaitMs ?? 60_000);
  for (const m of machines) {
    for (;;) {
      const pending = moves.some((_, i) => {
        const s = sync(m, i);
        return (probes.get(m)!.old.has(i) && s?.from.code === 1) || s?.to.code === 1;
      });
      if (!pending || Date.now() >= waitUntil) break;
      log(`… Syncthing on ${m.label} has changes on the way — waiting`);
      deps.sleep(SYNC_POLL_MS);
      const again = probe(m);
      if (again) probes.set(m, again);
    }
  }

  const plans = moves.map((mv, i) => planProject(mv, i, machines, here, probes, home));
  // Which copy goes is asked first: the checks below are about the machines it touches.
  for (const [i, plan] of plans.entries()) {
    if (!plan.pick || input.dryRun) continue;
    log(`${moves[i]!.name}: Syncthing would merge the new places of its copies, so one goes and the others stay:`);
    plan.copies.forEach((c, k) => log(`  ${k + 1}) ${describeCopy(c, i, probes, here)}`));
    if (!deps.interactive) {
      log('✗ which copy goes is asked in a terminal');
      log('nothing moved');
      return EXIT_REFUSED;
    }
    let picked: Copy | undefined;
    for (let tries = 0; tries < 2 && !picked; tries++) {
      const a = deps.ask(`Which copy of ${moves[i]!.name} goes? [1]: `);
      if (a === null) break;
      picked = a.trim() === '' ? plan.copies[0] : /^\d+$/.test(a.trim()) ? plan.copies[Number(a) - 1] : undefined;
    }
    if (!picked) {
      log('nothing moved');
      return EXIT_REFUSED;
    }
    Object.assign(plan, planChosen(i, [picked], machines, probes));
  }
  const affected = (i: number) => new Set(plans[i]!.chosen.flatMap((c) => c.machines));
  const mvOn = (i: number) => plans[i]!.chosen.flatMap((c) => c.mvOn);

  const sessions: Found[] = [];
  const lines: string[][] = moves.map(() => []);
  moves.forEach((mv, i) => {
    const plan = plans[i]!;
    const at = affected(i);
    const movers = mvOn(i);
    for (const m of [...new Set([...movers, ...plan.receivers])])
      if (probes.get(m)!.dest.has(i)) refusals.push(`${tilde(mv.to, home)} is taken on ${m.label}`);
    for (const m of movers) {
      const p = caughtUpProblem(sync(m, i)?.from.code);
      if (p) refusals.push(`${mv.name} on ${m.label}: ${p}`);
    }
    for (const m of [...new Set([...movers, ...plan.receivers])]) {
      const code = sync(m, i)?.to.code;
      if (code === 1) refusals.push(`${mv.name} on ${m.label}: Syncthing has something on the way to the new place`);
      if (code === 3) refusals.push(`${mv.name} on ${m.label}: Syncthing cannot tell about the new place`);
    }
    for (const [m, folders] of plan.pause)
      if (!probes.get(m)!.myId)
        refusals.push(
          `${mv.name} on ${m.label}: no syncthing command there — ${[...folders].join(', ')} cannot be paused while it moves`,
        );
    for (const m of at) {
      const p = probes.get(m)!;
      const ours = p.sessions.filter((live) => runsInProject(live, p.home, mv.from, home));
      for (const live of ours) sessions.push({ machine: m, project: i, live });
      const old = onMachine(mv.from, home, p.home);
      for (const c of p.containers ?? [])
        for (const src of c.sources)
          if (within(src, old)) refusals.push(`container ${c.name} on ${m.label} mounts ${src} — stop it first`);
      if (p.containers === null && (p.old.has(i) || at.has(m)))
        lines[i]!.push(`note: no docker on ${m.label} — containers not checked there`);
      // The agent's own processes go with it: its pane's shell, its MCP servers below it.
      const agentPids = new Set(ours.map((l) => l.pid));
      const parentOf = new Map(p.cwds.map((c) => [c.pid, c.ppid]));
      const ofAgent = (pid: number): boolean => {
        for (let x: number | undefined = pid, hops = 0; x !== undefined && hops < 32; hops++) {
          if (agentPids.has(x)) return true;
          x = parentOf.get(x);
        }
        return false;
      };
      const agentParents = new Set(p.cwds.filter((c) => agentPids.has(c.pid)).map((c) => c.ppid));
      const named: string[] = [];
      const shells = new Map<string, number>();
      for (const c of p.cwds.filter((x) => x.project === i && !ofAgent(x.pid) && !agentParents.has(x.pid))) {
        const shell = c.command.replace(/^-/, '');
        if (SHELLS.has(shell)) shells.set(shell, (shells.get(shell) ?? 0) + 1);
        else if (p.otherVolume.has(i) && movers.includes(m))
          refusals.push(
            `${c.command} (pid ${c.pid}) on ${m.label} works in ${mv.name}, and mv to another volume takes the files from under it — stop it first`,
          );
        else named.push(`${c.command} ${c.pid}`);
      }
      named.push(...[...shells].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)));
      if (named.length)
        lines[i]!.push(`working in it on ${m.label}: ${named.join(', ')} — they go on in the new place`);
    }
    for (const m of movers)
      if (probes.get(m)!.otherVolume.has(i))
        lines[i]!.push(`another volume on ${m.label}: mv copies, then deletes — slow, and not undone halfway`);
  });
  const busy = sessions.filter((s) => s.live.status !== 'idle');
  for (const s of busy) refusals.push(`a session of ${moves[s.project]!.name} is not idle: ${describeSession(s)}`);
  const noSync = machines.filter((m) => !probes.get(m)!.caughtUp);

  log(`vdx move — ${moves.length} project(s) → ${tilde(folder, home)}/`);
  moves.forEach((mv, i) => {
    const plan = plans[i]!;
    log(`  ${mv.name}: ${tilde(mv.from, home)} → ${tilde(mv.to, home)}`);
    const on = machines.filter((m) => probes.get(m)!.old.has(i)).map((m) => m.label);
    log(`    folder on: ${on.length ? on.join(', ') : '—'}`);
    log(`    Syncthing: ${describeSyncthing(plan, i, probes)}`);
    if (plan.pause.size)
      log(
        `    paused while it moves: ${[...plan.pause].map(([m, f]) => `${[...f].join(', ')} on ${m.label}`).join('; ')}`,
      );
    for (const o of plan.outside)
      log(
        `    ${o.name} (outside the profile) — ${
          o.gets === 'deletion'
            ? 'Syncthing deletes the project there'
            : o.gets === 'download'
              ? 'downloads it'
              : 'rebuilds it from the blocks it has'
        }`,
      );
    if (plan.pick) {
      log('    copies — Syncthing would merge their new places, so one goes and the others stay:');
      plan.copies.forEach((c, k) =>
        log(`      ${k + 1}) ${describeCopy(c, i, probes, here)}${plan.chosen.includes(c) ? '   ← goes' : ''}`),
      );
    }
    for (const r of plan.receivers.filter((m) => !plan.chosen.some((c) => c.machines.includes(m))))
      log(`    ${r.label} gets it through Syncthing — without what Syncthing ignores (node_modules and the like)`);
    for (const l of lines[i]!) log(`    ${l}`);
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
    if (plans.some((p) => p.pick)) log('dry run: which copy goes is asked at the move; Enter takes 1');
    log('dry run: nothing moved');
    return EXIT_MOVED;
  }

  // Questions, before anything changes: a deletion on a peer, the sessions.
  const deletions = [
    ...new Set(plans.flatMap((p) => p.outside.filter((o) => o.gets === 'deletion').map((o) => o.name))),
  ];
  if (deletions.length) {
    if (!deps.interactive) {
      log(`✗ Syncthing would delete the project(s) on ${deletions.join(', ')} — asked in a terminal`);
      log('nothing moved');
      return EXIT_REFUSED;
    }
    const a = deps.ask(
      `Syncthing deletes the project(s) on ${deletions.join(', ')} (outside the profile). Go on? [y/N] `,
    );
    if (!/^y(es)?$/i.test(a?.trim() ?? '')) {
      log('nothing moved');
      return EXIT_REFUSED;
    }
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

  // Pause every folder involved on every machine that has it; resume whatever happens.
  const toPause = new Map<Machine, Set<string>>();
  for (const plan of plans) for (const [m, f] of plan.pause) toPause.set(m, new Set([...(toPause.get(m) ?? []), ...f]));
  const paused: [Machine, string][] = [];
  const resume = () => {
    for (const [m, f] of paused.splice(0)) {
      const ran = runOn(m, `syncthing cli config folders ${shellQuote(f)} paused set false`, deps);
      log(
        ran && ran.status === 0
          ? `▶ ${f} resumed on ${m.label}`
          : `✗ ${f} stays paused on ${m.label} — resume it: syncthing cli config folders ${shellQuote(f)} paused set false`,
      );
    }
  };
  const interrupted = () => {
    resume();
    process.exit(130);
  };
  process.on('SIGINT', interrupted);
  try {
    for (const [m, folders] of toPause)
      for (const f of folders) {
        const q = shellQuote(f);
        const ran = runOn(
          m,
          `syncthing cli config folders ${q} paused set true && [ "$(syncthing cli config folders ${q} paused get)" = true ]`,
          deps,
        );
        if (!ran || ran.status !== 0) {
          log(`✗ could not pause ${f} on ${m.label}${ran ? ` (exit ${ran.status})` : ' — no answer'}`);
          resume();
          startAgain((x) => moves[x.project]!.from);
          log('nothing moved');
          return EXIT_FAILED;
        }
        paused.push([m, f]);
        log(`⏸ ${f} paused on ${m.label}`);
      }

    const done = new Set<number>();
    for (const [i, mv] of moves.entries()) {
      const movedOn: Machine[] = [];
      for (const m of mvOn(i)) {
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
        resume();
        startAgain((x) => (done.has(x.project) ? moves[x.project]!.to : moves[x.project]!.from));
        return EXIT_FAILED;
      }
      done.add(i);
      log(`✓ ${mv.name}: ${tilde(mv.from, home)} → ${tilde(mv.to, home)} on ${movedOn.map((m) => m.label).join(', ')}`);
    }
  } finally {
    resume();
    process.off('SIGINT', interrupted);
  }

  for (const [i, mv] of moves.entries()) {
    const plan = plans[i]!;
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
      if (fs.existsSync(mv.to) && memoryApplies(mv.to, ctx)) {
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
    // A copy Syncthing does not keep together with this machine's has a memory path of its own.
    const hereFolder = sync(here, i)?.to.folder ?? null;
    for (const m of mvOn(i).filter((x) => x !== here)) {
      const f = sync(m, i)?.to.folder ?? null;
      if (!f || f !== hereFolder)
        log(
          `  on ${m.label}: its copy's memory path — vdx doctor --fix ${shellQuote(onMachine(mv.to, home, probes.get(m)!.home))}`,
        );
    }
    for (const c of plan.copies.filter((x) => !plan.chosen.includes(x)))
      for (const m of c.machines) {
        const old = onMachine(mv.from, home, probes.get(m)!.home);
        log(
          plan.receivers.includes(m)
            ? `  ${m.label} keeps its own copy in ${old}; once the project has come there through Syncthing, remove it: rm -rf ${shellQuote(old)}`
            : `  ${m.label} keeps its own copy in ${old}`,
        );
      }
    for (const h of hooks) runHook(h, mv, deps);
  }

  startAgain((x) => moves[x.project]!.to);
  return EXIT_MOVED;
}

/**
 * The copies of a project's folder: one per Syncthing folder its machines share it in, one
 * for a folder on a network disk or in a cloud folder, one per machine for any other.
 */
function copiesOf(
  mv: Planned,
  i: number,
  machines: Machine[],
  here: Machine,
  probes: Map<Machine, Probe>,
  home: string,
): Copy[] {
  const has = machines.filter((m) => probes.get(m)!.old.has(i));
  const folderOf = (m: Machine) => probes.get(m)!.sync.get(i)?.from.folder ?? null;
  const copies: Copy[] = [];
  const byFolder = new Map<string, Machine[]>();
  for (const m of has) {
    const f = folderOf(m);
    if (f) byFolder.set(f, [...(byFolder.get(f) ?? []), m]);
  }
  for (const ms of byFolder.values()) copies.push({ kind: 'synced', machines: ms, mvOn: ms });
  const rel = path.relative(home, mv.from);
  const cloud = CLOUD_DIRS.some((d) => within(rel, d));
  const rest = has.filter((m) => !folderOf(m));
  const shared = rest.filter((m) => cloud || probes.get(m)!.shared.has(i));
  if (shared.length)
    copies.push({ kind: 'shared', machines: shared, mvOn: [shared.includes(here) ? here : shared[0]!] });
  for (const m of rest.filter((x) => !shared.includes(x))) copies.push({ kind: 'own', machines: [m], mvOn: [m] });
  // The copy of the machine the person sits at comes first: Enter takes it.
  return copies.sort((a, b) => Number(b.machines.includes(here)) - Number(a.machines.includes(here)));
}

function planProject(
  mv: Planned,
  i: number,
  machines: Machine[],
  here: Machine,
  probes: Map<Machine, Probe>,
  home: string,
): ProjectPlan {
  const copies = copiesOf(mv, i, machines, here, probes, home);
  const newFolder = (m: Machine) => probes.get(m)!.sync.get(i)?.to.folder ?? null;
  // Two copies clash when Syncthing would carry one's new place onto the other's.
  const clash = copies.some((a, k) =>
    copies
      .slice(k + 1)
      .some((b) => a.mvOn.some((x) => b.mvOn.some((y) => !!newFolder(x) && newFolder(x) === newFolder(y)))),
  );
  return {
    copies,
    pick: clash,
    ...planChosen(i, clash ? copies.slice(0, 1) : copies, machines, probes),
  };
}

/** Pauses, receivers and peers outside the profile for the copies that move. */
function planChosen(
  i: number,
  chosen: Copy[],
  machines: Machine[],
  probes: Map<Machine, Probe>,
): Pick<ProjectPlan, 'chosen' | 'pause' | 'receivers' | 'outside'> {
  const at = (m: Machine) => probes.get(m)!.sync.get(i);
  const movers = chosen.flatMap((c) => c.mvOn);
  const oldFolders = new Set(movers.map((m) => at(m)?.from.folder).filter((f): f is string => !!f));
  const newFolders = new Set(movers.map((m) => at(m)?.to.folder).filter((f): f is string => !!f));
  const touched = new Set([...oldFolders, ...newFolders]);
  const pause = new Map<Machine, Set<string>>();
  for (const m of machines) {
    const folders = [at(m)?.from.folder, at(m)?.to.folder].filter((f): f is string => !!f && touched.has(f));
    if (folders.length) pause.set(m, new Set(folders));
  }
  const receivers = machines.filter((m) => {
    const f = at(m)?.to.folder;
    return !!f && newFolders.has(f) && !movers.includes(m);
  });
  const ids = new Set(machines.map((m) => probes.get(m)!.myId).filter((x): x is string => !!x));
  const peersOf = (folders: Set<string>) => {
    const out = new Map<string, string>();
    for (const m of machines)
      for (const f of folders)
        for (const p of probes.get(m)!.peers.get(f) ?? []) if (!ids.has(p.device)) out.set(p.device, p.name);
    return out;
  };
  const before = peersOf(oldFolders);
  const after = peersOf(newFolders);
  const outside: ProjectPlan['outside'] = [];
  for (const [d, name] of new Map([...before, ...after]))
    outside.push({
      name,
      gets: before.has(d) && after.has(d) ? 'own blocks' : before.has(d) ? 'deletion' : 'download',
    });
  return { chosen, pause, receivers, outside };
}

/** `within AI Projects`, `from A to B`, `out of A`, `into B`, `not in Syncthing`. */
function describeSyncthing(plan: ProjectPlan, i: number, probes: Map<Machine, Probe>): string {
  const movers = plan.chosen.flatMap((c) => c.mvOn);
  const pick = (k: 'from' | 'to') =>
    [...new Set(movers.map((m) => probes.get(m)!.sync.get(i)?.[k].folder).filter((f): f is string => !!f))].join(', ');
  const from = pick('from');
  const to = pick('to');
  if (!from && !to) return movers.every((m) => probes.get(m)!.caughtUp) ? 'not in Syncthing' : 'not known here';
  if (from && !to) return `out of ${from}`;
  if (!from && to) return `into ${to}`;
  return from === to ? `within ${from}` : `from ${from} to ${to}`;
}

function describeCopy(c: Copy, i: number, probes: Map<Machine, Probe>, here: Machine): string {
  const who = c.machines.map((m) => m.label).join(', ');
  const kind =
    c.kind === 'synced' ? 'synced between them' : c.kind === 'shared' ? 'one folder on a network disk' : 'its own';
  const g = probes.get(c.mvOn[0]!)!.git.get(i);
  const state = g
    ? `, ${g.head ? `commit ${g.head}` : 'no commit'}, ${g.dirty} uncommitted${
        g.committed ? `, last commit ${describeAge(new Date(g.committed * 1000))}` : ''
      }`
    : '';
  return `${who} — ${kind}${state}${c.machines.includes(here) ? '   ← where you are' : ''}`;
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
    // From /: a probe started in the project would find its own processes working there.
    const res = spawnSync('sh', ['-c', script], {
      cwd: '/',
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
