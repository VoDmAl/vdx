import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseEnvironment } from '../../src/ai.ts';
import { projectDirName } from '../../src/conversations.ts';
import { EXIT_FAILED, EXIT_MOVED, EXIT_REFUSED, EXIT_USAGE, runMove, type MoveDeps } from '../../src/move.ts';

// `vdx move`: two machines are two homes here — "m3" is reached by a fake ssh that runs
// the same script with its own HOME (claude-memory-in-project DL #17, #18).
let base: string;
let here: string;
let m3: string;
let logs: string[];
let restarts: { host: string | null; path: string; conversation: string; focused: boolean }[];
let sleepers: number[];
const saved = { global: process.env['GIT_CONFIG_GLOBAL'], nosystem: process.env['GIT_CONFIG_NOSYSTEM'] };
const CONVERSATION = '11111111-2222-4333-8444-555555555555';

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const json = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
const config = (home: string) => path.join(home, '.claude');
const projDir = (home: string) => path.join(home, 'AI Projects', 'proj');
const ga = (home: string) => path.join(home, 'AI Projects', 'GA', 'proj');
const caughtUp = (home: string, code: number) =>
  fs.writeFileSync(path.join(home, '.local', 'bin', 'caught-code'), String(code));

/** A machine's home: the project, Claude Code's config, a syncthing-caught-up answering 0. */
function machine(home: string): void {
  write(path.join(projDir(home), 'README.md'), 'proj\n');
  write(path.join(projDir(home), 'node_modules', 'x.js'), 'ignored by Syncthing\n');
  fs.mkdirSync(path.join(config(home), 'sessions'), { recursive: true });
  const bin = path.join(home, '.local', 'bin', 'syncthing-caught-up');
  write(bin, '#!/bin/sh\nexit "$(cat "$(dirname "$0")/caught-code")"\n');
  fs.chmodSync(bin, 0o755);
  caughtUp(home, 0);
}

/**
 * A live session of the project on a machine: a real process, as Claude Code's session file
 * names it. Not a child of this one — a child that ended stays a zombie until Node reaps it,
 * and `kill -0` would still find it.
 */
function session(home: string, status: string): number {
  const pid = Number(execFileSync('sh', ['-c', 'sleep 60 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).trim());
  sleepers.push(pid);
  write(
    path.join(config(home), 'sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId: CONVERSATION, status, cwd: projDir(home) }),
  );
  return pid;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function deps(over: Partial<MoveDeps> = {}): MoveDeps {
  const run = (home: string, script: string) => {
    const res = spawnSync('sh', ['-c', script], {
      // The fake syncthing-caught-up comes first, as ~/.local/bin does on the stations.
      env: {
        PATH: `${path.join(home, '.local', 'bin')}:${process.env['PATH']}`,
        HOME: home,
        CLAUDE_CONFIG_DIR: config(home),
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { status: res.status ?? 1, stdout: res.stdout ?? '' };
  };
  return {
    env: {
      VDX_ENVIRONMENT: path.join(base, 'env.yaml'),
      VDX_HOST: 'here',
      CLAUDE_CONFIG_DIR: config(here),
      PATH: process.env['PATH'],
    },
    home: here,
    interactive: true,
    log: (l) => logs.push(l),
    ask: () => '',
    sh: (script) => run(here, script),
    // ssh -o … -o … <host> "sh -c '<script>'"
    ssh: (args) => (args[4] === 'm3' ? run(m3, args[5]!) : { status: 255, stdout: '' }),
    hook: (command, env) =>
      spawnSync('sh', ['-c', command], { env: { ...process.env, ...env }, stdio: 'ignore' }).status ?? 1,
    restart: (input) => {
      restarts.push(input);
      return 0;
    },
    sleep: () => {},
    today: '2026-10-27',
    ...over,
  };
}

const move = (over: Partial<MoveDeps> = {}, dryRun = false) =>
  runMove({ sources: [projDir(here)], folder: path.join(here, 'AI Projects', 'GA'), dryRun }, deps(over));

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-move-')));
  fs.writeFileSync(path.join(base, 'gitconfig'), '');
  process.env['GIT_CONFIG_GLOBAL'] = path.join(base, 'gitconfig');
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  here = path.join(base, 'here');
  m3 = path.join(base, 'm3');
  logs = [];
  restarts = [];
  sleepers = [];
  machine(here);
  machine(m3);
  // Here the project is a personal git repo with its memory path in the tracked settings.json.
  const root = projDir(here);
  write(path.join(root, '.claude', 'settings.json'), JSON.stringify({ autoMemoryDirectory: `${root}/.claude/memory` }));
  write(path.join(root, '.claude', 'memory', 'MEMORY.md'), '- a note\n');
  git(root, 'init', '-q');
  git(root, 'add', '.claude/settings.json', 'README.md');
  git(root, 'commit', '-q', '-m', 'init');
  write(path.join(config(here), 'projects', projectDirName(root), `${CONVERSATION}.jsonl`), '{}\n');
  write(
    path.join(config(here), '.claude.json'),
    JSON.stringify({ projects: { [root]: { hasTrustDialogAccepted: true, allowedTools: ['Bash(ls)'] } } }),
  );
  write(
    path.join(base, 'env.yaml'),
    [
      'agent:',
      '  command: sleep',
      'session:',
      '  machines: [here, m3]',
      'move:',
      '  after:',
      '    - name: recorder',
      `      command: 'echo "$VDX_MOVE_FROM|$VDX_MOVE_TO" > ${path.join(base, 'hook.txt')}'`,
      '',
    ].join('\n'),
  );
});

afterEach(() => {
  for (const pid of sleepers) if (alive(pid)) process.kill(pid, 'SIGKILL');
  for (const [k, v] of [
    ['GIT_CONFIG_GLOBAL', saved.global],
    ['GIT_CONFIG_NOSYSTEM', saved.nosystem],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(base, { recursive: true, force: true });
});

describe('vdx move', () => {
  it('--dry-run names what moves, where the folder is and the sessions found — and moves nothing', () => {
    session(here, 'idle');
    expect(move({}, true)).toBe(EXIT_MOVED);
    const out = logs.join('\n');
    expect(out).toContain('proj: ~/AI Projects/proj → ~/AI Projects/GA/proj');
    expect(out).toContain('folder on: here, m3');
    expect(out).toMatch(/session: pid \d+ on here \(idle, conversation 11111111\)/);
    expect(out).toContain('then: recorder (move.after)');
    expect(fs.existsSync(projDir(here))).toBe(true);
    expect(fs.existsSync(projDir(m3))).toBe(true);
  });

  it('moves the folder on both machines and takes along conversations, trust, memory path; runs move.after', () => {
    const from = projDir(here);
    const to = ga(here);
    expect(move()).toBe(EXIT_MOVED);
    for (const home of [here, m3]) {
      expect(fs.existsSync(projDir(home))).toBe(false);
      // What Syncthing would not carry moved with the folder on each machine.
      expect(fs.existsSync(path.join(ga(home), 'node_modules', 'x.js'))).toBe(true);
    }
    expect(fs.existsSync(path.join(config(here), 'projects', projectDirName(to), `${CONVERSATION}.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(config(here), 'projects', projectDirName(from)))).toBe(false);
    const projects = json(path.join(config(here), '.claude.json'))['projects'] as Record<string, unknown>;
    expect(projects[to]).toEqual({ hasTrustDialogAccepted: true, allowedTools: ['Bash(ls)'] });
    expect(json(path.join(to, '.claude', 'settings.json'))['autoMemoryDirectory']).toBe(`${to}/.claude/memory/`);
    expect(fs.readFileSync(path.join(base, 'hook.txt'), 'utf8').trim()).toBe(`${from}|${to}`);
    const out = logs.join('\n');
    expect(out).toContain('✓ proj: ~/AI Projects/proj → ~/AI Projects/GA/proj on here, m3');
    expect(out).toContain('Claude Code trusts the new folder, as it did the old one');
    expect(out).toContain('commit .claude/settings.json with the project');
    expect(out).toContain('✓ recorder (move.after)');
  });

  it('an idle session is closed after the yes and started again in the new place, same conversation', () => {
    const pid = session(m3, 'idle');
    expect(move()).toBe(EXIT_MOVED);
    expect(alive(pid)).toBe(false);
    expect(restarts).toEqual([{ host: 'm3', path: ga(here), conversation: CONVERSATION, focused: false }]);
  });

  it('a session in a turn, or waiting for an answer, refuses the move: nothing closed, nothing moved', () => {
    const busy = session(here, 'busy');
    const waiting = session(m3, 'waiting');
    expect(move()).toBe(EXIT_REFUSED);
    expect(logs.join('\n')).toMatch(/not idle: pid \d+ on here \(busy/);
    expect(logs.join('\n')).toMatch(/not idle: pid \d+ on m3 \(waiting/);
    expect(alive(busy) && alive(waiting)).toBe(true);
    expect(fs.existsSync(projDir(here)) && fs.existsSync(projDir(m3))).toBe(true);
  });

  it('an idle session without a terminal, or a no, refuses the move', () => {
    session(here, 'idle');
    expect(move({ interactive: false })).toBe(EXIT_REFUSED);
    expect(logs.join('\n')).toContain('run vdx move in a terminal');
    expect(move({ ask: () => 'n' })).toBe(EXIT_REFUSED);
    expect(fs.existsSync(projDir(here))).toBe(true);
  });

  it('the new place taken on another machine refuses the move', () => {
    write(path.join(ga(m3), 'x'), 'x');
    expect(move()).toBe(EXIT_REFUSED);
    expect(logs.join('\n')).toContain('~/AI Projects/GA/proj is taken on m3');
    expect(fs.existsSync(projDir(here))).toBe(true);
  });

  it('another machine that does not answer refuses the move', () => {
    expect(move({ ssh: () => ({ status: 255, stdout: '' }) })).toBe(EXIT_REFUSED);
    expect(logs.join('\n')).toContain('m3 does not answer over ssh');
    expect(fs.existsSync(projDir(here))).toBe(true);
  });

  it('Syncthing: changes on the way are waited for', () => {
    caughtUp(m3, 1);
    expect(move({ sleep: () => caughtUp(m3, 0) })).toBe(EXIT_MOVED);
    expect(logs.join('\n')).toContain('Syncthing on m3 has changes on the way — waiting');
  });

  it('Syncthing: "cannot tell" refuses the move; a folder outside Syncthing (2) does not', () => {
    caughtUp(m3, 3);
    expect(move()).toBe(EXIT_REFUSED);
    expect(logs.join('\n')).toContain('proj on m3: Syncthing cannot tell');
    caughtUp(m3, 2);
    expect(move()).toBe(EXIT_MOVED);
  });

  it('a failed mv on another machine puts this one back and starts the sessions in the old place', () => {
    // A file where m3's new folder should be: its mkdir -p fails.
    write(path.join(m3, 'AI Projects', 'GA'), 'not a folder');
    session(here, 'idle');
    expect(move()).toBe(EXIT_FAILED);
    expect(fs.existsSync(projDir(here))).toBe(true);
    expect(fs.existsSync(ga(here))).toBe(false);
    expect(logs.join('\n')).toContain('put back on here');
    expect(restarts).toEqual([{ host: null, path: projDir(here), conversation: CONVERSATION, focused: false }]);
  });

  it('a folder inside the project, or one already there, is a usage error', () => {
    expect(
      runMove({ sources: [path.join(projDir(here), '.claude')], folder: path.join(here, 'x'), dryRun: false }, deps()),
    ).toBe(EXIT_USAGE);
    expect(logs.join('\n')).toContain("name the project's own folder");
    expect(runMove({ sources: [projDir(here)], folder: path.join(here, 'AI Projects'), dryRun: false }, deps())).toBe(
      EXIT_USAGE,
    );
  });
});

describe('move.after in the profile', () => {
  it('takes a list of named commands; a command is required', () => {
    expect(parseEnvironment('move:\n  after:\n    - name: e\n      command: x\n', 'p').move?.after).toHaveLength(1);
    expect(() => parseEnvironment('move:\n  after:\n    - name: e\n', 'p')).toThrow('move.after[0].command');
    expect(() => parseEnvironment('move: [x]\n', 'p')).toThrow('move must be a mapping');
  });
});
