import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The topic of a focused session as the description of the cmux workspace it is shown in
 * (focused-topic DL #6). cmux lets only processes it started reach its socket, and of vdx that
 * is `vdx ai` holding `tmux attach` — locally, or `ssh -t` for `vdx ai@<host>`. While it holds
 * it, `bin/vdx-cmux-topic.cjs` watches the session's topic next to it; when it lets go, the
 * description goes, unless the person set one by hand.
 */

/** Set for the `vdx ai` that `vdx ai@<host>` starts there: it marks the session it attaches to. */
export const CMUX_TOKEN_ENV_VAR = 'VDX_AI_CMUX';
/** The tmux session option that mark goes into: the local watcher finds the session by it. */
export const CMUX_TOKEN_OPTION = '@vdx_cmux';

// Started by its path, so knip.json lists it as not unused.
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'vdx-cmux-topic.cjs');

/** Where the topic is read: a tmux session here, or the session on <host> marked with a token. */
export type TopicSource = { session: string; socket: string | null } | { host: string; token: string };

export interface CmuxWatch {
  stop: () => void;
}

/** The workspace and its command, when this process runs in cmux; null otherwise. */
function cmuxHere(env: NodeJS.ProcessEnv): { workspace: string; cli: string } | null {
  const workspace = env['CMUX_WORKSPACE_ID']?.trim();
  if (!workspace) return null;
  const bundled = env['CMUX_BUNDLED_CLI_PATH']?.trim();
  return { workspace, cli: bundled && fs.existsSync(bundled) ? bundled : 'cmux' };
}

/** A fresh mark for the session `vdx ai@<host>` attaches to; null when this runs outside cmux. */
export function cmuxToken(env: NodeJS.ProcessEnv): string | null {
  return cmuxHere(env) ? randomBytes(6).toString('hex') : null;
}

/** cmux's snapshot of its windows: the topic watcher reads the workspace's description from it. */
function cmuxSnapshotPath(home: string): string {
  return path.join(home, 'Library', 'Application Support', 'cmux', 'session-com.cmuxterm.app.json');
}

/** What cmux types into a tab it brings back itself (cmux 0.65): `cmux restore --surface`. */
const CMUX_LINE = 'cmux restore';

/**
 * cmux, started again, types `cmux restore --surface` into each tab it holds a trusted resume binding for —
 * a `tmux attach` it noticed — and no setting stops that for tmux (its docs: «cmux only auto-runs resume
 * bindings it marks trusted, such as live process-detected tmux bindings»). `vdx ai --tab` takes the tab back
 * itself, so the line must not reach the agent the tab attaches to: lft 2026-11-19, it stood in the input of
 * 4 agents of 7 (restore-after-any-crash DL #8). Reads what arrives — `read` gives what is there, '' when
 * nothing — until cmux's line has come and the terminal is quiet for `quietMs`, or `maxMs` passed.
 */
export function takeTypedLine(
  read: () => string,
  clock: { now: () => number; sleep: (ms: number) => void },
  maxMs = 5_000,
  quietMs = 300,
): string {
  const start = clock.now();
  let taken = '';
  let last = start;
  for (;;) {
    const got = read();
    const t = clock.now();
    if (got) {
      taken += got;
      last = t;
    }
    if (taken.includes(CMUX_LINE) && t - last >= quietMs) return taken;
    if (t - start >= maxMs) return taken;
    clock.sleep(50);
  }
}

/**
 * `takeTypedLine` on this process's terminal: its input read as it comes, unechoed, then the terminal as it
 * was. Null — no terminal here. `waitedMs` — how long it took, for the tab's log.
 */
export function takeCmuxLine(maxMs = 5_000): { taken: string; waitedMs: number } | null {
  let fd: number;
  try {
    fd = fs.openSync('/dev/tty', fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch {
    return null;
  }
  const stty = (args: string[]) => spawnSync('stty', args, { stdio: [fd, 'pipe', 'ignore'], encoding: 'utf8' });
  const saved = stty(['-g']).stdout?.trim();
  const start = Date.now();
  try {
    stty(['-icanon', '-echo', 'min', '0', 'time', '0']);
    const buf = Buffer.alloc(1024);
    const taken = takeTypedLine(
      () => {
        try {
          const n = fs.readSync(fd, buf, 0, buf.length, null);
          return n > 0 ? buf.toString('utf8', 0, n) : '';
        } catch {
          return ''; // EAGAIN: nothing typed yet
        }
      },
      { now: Date.now, sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) },
      maxMs,
    );
    return { taken, waitedMs: Date.now() - start };
  } finally {
    if (saved) stty([saved]);
    fs.closeSync(fd);
  }
}

function args(mode: 'watch' | 'clear', ws: { workspace: string; cli: string }, source: TopicSource, home: string) {
  const dir = path.join(home, '.cache', 'vdx', 'cmux');
  fs.mkdirSync(dir, { recursive: true });
  return [
    SCRIPT,
    mode,
    '--workspace',
    ws.workspace,
    '--cli',
    ws.cli,
    '--state',
    path.join(dir, ws.workspace.replace(/[^A-Za-z0-9_-]/g, '_')),
    '--snapshot',
    cmuxSnapshotPath(home),
    ...('host' in source
      ? ['--host', source.host, '--token', source.token]
      : ['--session', source.session, ...(source.socket ? ['--socket', source.socket] : [])]),
    '--parent',
    String(process.pid),
  ];
}

/**
 * Start watching the topic for the workspace this process runs in; null outside cmux. `stop`
 * ends the watch and clears the description, if it is still the one set here.
 */
export function watchTopic(env: NodeJS.ProcessEnv, source: TopicSource, home: string = os.homedir()): CmuxWatch | null {
  const ws = cmuxHere(env);
  if (!ws) return null;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, args('watch', ws, source, home), { stdio: 'ignore', env });
  } catch {
    return null;
  }
  child.unref();
  return {
    stop: () => {
      child.kill('SIGKILL');
      spawnSync(process.execPath, args('clear', ws, source, home), { stdio: 'ignore', env, timeout: 15_000 });
    },
  };
}
