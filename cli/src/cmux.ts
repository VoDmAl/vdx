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
    path.join(home, 'Library', 'Application Support', 'cmux', 'session-com.cmuxterm.app.json'),
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
