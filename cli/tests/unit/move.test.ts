import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseEnvironment, shellQuote } from '../../src/ai.ts';
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
const bin = (home: string) => path.join(home, '.local', 'bin');
const ID = (home: string) => (home === here ? 'HERE-ID' : 'M3-ID');
const NAS = { device: 'NAS-ID', name: 'vodmal-nas-nyc' };

/** What a machine's fake syncthing-caught-up answers: its Syncthing folders, and the codes. */
interface SyncConfig {
  folders: Record<string, { path: string; peers: { device: string; name: string }[] }>;
  /** For the old path (odd arguments) and the new one (even). */
  code: number;
  toCode?: number;
}
const syncConfig = (home: string): SyncConfig =>
  JSON.parse(fs.readFileSync(path.join(bin(home), 'sync.json'), 'utf8')) as SyncConfig;
const setSync = (home: string, change: (c: SyncConfig) => void) => {
  const c = syncConfig(home);
  change(c);
  fs.writeFileSync(path.join(bin(home), 'sync.json'), JSON.stringify(c));
};
const caughtUp = (home: string, code: number) => setSync(home, (c) => (c.code = code));
/** The machine's "AI Projects" folder in Syncthing — or another one, or none. */
const syncedFolder = (
  home: string,
  folder: string | null,
  peers = [{ device: ID(home === here ? m3 : here), name: 'peer' }, NAS],
) =>
  setSync(home, (c) => {
    c.folders = folder ? { [path.basename(folder)]: { path: folder, peers } } : {};
  });
const pausedLog = (home: string) =>
  fs.existsSync(path.join(bin(home), 'paused.log')) ? fs.readFileSync(path.join(bin(home), 'paused.log'), 'utf8') : '';

/** A fake tool in the machine's ~/.local/bin, ahead of the real one. */
function tool(home: string, name: string, script: string): void {
  write(path.join(bin(home), name), script);
  fs.chmodSync(path.join(bin(home), name), 0o755);
}

/**
 * A machine's home: the project, Claude Code's config, and fakes of what the stations run:
 * syncthing-caught-up --json (the project in Syncthing's "AI Projects", caught up), the
 * syncthing command (its device id, pausing folders), docker and lsof with nothing to say.
 */
function machine(home: string): void {
  write(path.join(projDir(home), 'README.md'), 'proj\n');
  write(path.join(projDir(home), 'node_modules', 'x.js'), 'ignored by Syncthing\n');
  fs.mkdirSync(path.join(config(home), 'sessions'), { recursive: true });
  tool(
    home,
    'syncthing-caught-up',
    `#!${process.execPath}
const fs = require('fs'), path = require('path');
const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'sync.json'), 'utf8'));
const verdict = ['caught-up', 'incoming', 'outside', 'unknown'];
const paths = process.argv.slice(2).filter((a) => a !== '--json').map((p, k) => {
  const f = Object.entries(c.folders).find(([, v]) => p === v.path || p.startsWith(v.path + '/'));
  if (!f) return { path: p, verdict: 'outside' };
  return { path: p, verdict: verdict[k % 2 === 0 ? c.code : (c.toCode ?? 0)], folder: f[0] };
});
const folders = {};
for (const p of paths) if (p.folder) folders[p.folder] = { label: p.folder, peers: c.folders[p.folder].peers };
process.stdout.write(JSON.stringify({ paths, folders }));
`,
  );
  write(path.join(bin(home), 'myid'), `${ID(home)}\n`);
  tool(
    home,
    'syncthing',
    [
      '#!/bin/sh',
      'd=$(dirname "$0")',
      '[ -f "$d/syncthing-fails" ] && exit 1',
      'case "$1 $2 $3" in',
      `  "cli show system") printf '{\\n  "myID": "%s"\\n}\\n' "$(cat "$d/myid")";;`,
      '  "cli config folders") case "$5 $6" in',
      '    "paused set") echo "$4 $7" >> "$d/paused.log"; echo "$7" > "$d/paused-$4";;',
      '    "paused get") cat "$d/paused-$4" 2>/dev/null || echo false;;',
      '  esac;;',
      'esac',
      '',
    ].join('\n'),
  );
  tool(
    home,
    'docker',
    '#!/bin/sh\n[ "$1" = ps ] && cat "$(dirname "$0")/containers" 2>/dev/null | cut -f1\n[ "$1" = inspect ] && grep "^$4" "$(dirname "$0")/containers" | cut -f2-\nexit 0\n',
  );
  tool(home, 'lsof', '#!/bin/sh\ncat "$(dirname "$0")/lsof.txt" 2>/dev/null\nexit 0\n');
  fs.writeFileSync(path.join(bin(home), 'sync.json'), JSON.stringify({ folders: {}, code: 0 } satisfies SyncConfig));
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
  syncedFolder(here, path.join(here, 'AI Projects'));
  syncedFolder(m3, path.join(m3, 'AI Projects'));
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
    expect(out).toContain('Syncthing: within AI Projects');
    expect(out).toContain('paused while it moves: AI Projects on here; AI Projects on m3');
    expect(out).toContain('vodmal-nas-nyc (outside the profile) — rebuilds it from the blocks it has');
    expect(fs.existsSync(projDir(here))).toBe(true);
    expect(fs.existsSync(projDir(m3))).toBe(true);
    expect(pausedLog(here) + pausedLog(m3)).toBe('');
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
    // The folder paused on both machines for both mv, and resumed (DL #19).
    for (const home of [here, m3]) expect(pausedLog(home)).toBe('AI Projects true\nAI Projects false\n');
    expect(out.indexOf('⏸ AI Projects paused on m3')).toBeLessThan(out.indexOf('✓ proj:'));
    expect(out.indexOf('▶ AI Projects resumed on m3')).toBeGreaterThan(out.indexOf('✓ proj:'));
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

  it('Syncthing: "cannot tell" refuses the move', () => {
    caughtUp(m3, 3);
    expect(move()).toBe(EXIT_REFUSED);
    expect(logs.join('\n')).toContain('proj on m3: Syncthing cannot tell');
  });

  it('outside Syncthing on both machines: each moves its own copy, nothing pauses', () => {
    syncedFolder(here, null);
    syncedFolder(m3, null);
    expect(move()).toBe(EXIT_MOVED);
    const out = logs.join('\n');
    expect(out).toContain('Syncthing: not in Syncthing');
    expect(out).toContain('✓ proj: ~/AI Projects/proj → ~/AI Projects/GA/proj on here, m3');
    expect(out).toContain(`on m3: its copy's memory path — vdx doctor --fix ${shellQuote(ga(m3))}`);
    expect(pausedLog(here) + pausedLog(m3)).toBe('');
  });

  it('into Syncthing with a copy on each machine: one goes, picked at the terminal; the other stays', () => {
    // Only the new folder is synced: the old copies are each machine's own.
    syncedFolder(here, path.join(here, 'AI Projects', 'GA'));
    syncedFolder(m3, path.join(m3, 'AI Projects', 'GA'));
    git(projDir(m3), 'init', '-q');
    expect(move({ interactive: false })).toBe(EXIT_REFUSED);
    expect(logs.join('\n')).toContain('which copy goes is asked in a terminal');
    logs = [];
    const asked: string[] = [];
    expect(move({ ask: (q) => (asked.push(q), q.startsWith('Which copy') ? '2' : '') })).toBe(EXIT_MOVED);
    expect(asked[0]).toBe('Which copy of proj goes? [1]: ');
    const out = logs.join('\n');
    expect(out).toMatch(/1\) here — its own, commit [0-9a-f]+, \d+ uncommitted, last commit .*← where you are/);
    expect(out).toContain('2) m3 — its own, no commit, ');
    expect(out).toContain('Syncthing: into GA');
    // m3's copy went; here keeps its own and gets the project through Syncthing.
    expect(fs.existsSync(ga(m3)) && !fs.existsSync(projDir(m3))).toBe(true);
    expect(fs.existsSync(projDir(here)) && !fs.existsSync(ga(here))).toBe(true);
    expect(out).toContain(
      `here keeps its own copy in ${projDir(here)}; once the project has come there through Syncthing, remove it`,
    );
    expect(pausedLog(m3)).toBe('GA true\nGA false\n');
  });

  it('out of Syncthing: a peer outside the profile would lose the project — a yes first', () => {
    const outside = path.join(here, 'Outside');
    const run = (over: Partial<MoveDeps> = {}) =>
      runMove({ sources: [projDir(here)], folder: outside, dryRun: false }, deps(over));
    expect(run()).toBe(EXIT_REFUSED);
    expect(logs.join('\n')).toContain('Syncthing: out of AI Projects');
    expect(logs.join('\n')).toContain('vodmal-nas-nyc (outside the profile) — Syncthing deletes the project there');
    expect(fs.existsSync(projDir(here))).toBe(true);
    expect(run({ interactive: false })).toBe(EXIT_REFUSED);
    logs = [];
    expect(run({ ask: (q) => (q.includes('deletes the project') ? 'y' : '') })).toBe(EXIT_MOVED);
    for (const home of [here, m3]) {
      expect(fs.existsSync(path.join(home, 'Outside', 'proj', 'node_modules', 'x.js'))).toBe(true);
      expect(pausedLog(home)).toBe('AI Projects true\nAI Projects false\n');
    }
  });

  it('a folder on a network disk is one copy: moved once, from the machine you are at', () => {
    syncedFolder(here, null);
    syncedFolder(m3, null);
    for (const home of [here, m3])
      tool(
        home,
        'df',
        '#!/bin/sh\necho "Filesystem 512-blocks Used Available Capacity Mounted on"\necho "//vdm@nas/share 1 1 1 1% /Volumes/share"\n',
      );
    expect(move()).toBe(EXIT_MOVED);
    expect(logs.join('\n')).toContain('✓ proj: ~/AI Projects/proj → ~/AI Projects/GA/proj on here\n');
    expect(fs.existsSync(projDir(m3))).toBe(true);
  });

  it('a container that mounts the project refuses the move; a process working in it is named', () => {
    write(path.join(bin(m3), 'containers'), `c1\t/db\t${path.join(projDir(m3), 'data')}\n`);
    write(
      path.join(bin(here), 'lsof.txt'),
      `p4242\nR1\ncnode\nfcwd\nn${projDir(here)}/web\np4243\nR1\nc-zsh\nfcwd\nn${projDir(here)}\np4244\nR1\nczsh\nfcwd\nn${projDir(here)}\n`,
    );
    expect(move()).toBe(EXIT_REFUSED);
    const out = logs.join('\n');
    expect(out).toContain(`container db on m3 mounts ${path.join(projDir(m3), 'data')} — stop it first`);
    expect(out).toContain('working in it on here: node 4242, zsh ×2 — they go on in the new place');
  });

  it('a folder that cannot be paused, or no syncthing command, moves nothing', () => {
    fs.writeFileSync(path.join(bin(m3), 'syncthing-fails'), '');
    expect(move()).toBe(EXIT_REFUSED);
    expect(logs.join('\n')).toContain(
      'proj on m3: no syncthing command there — AI Projects cannot be paused while it moves',
    );
    fs.rmSync(path.join(bin(m3), 'syncthing-fails'));
    // It answers its id, but the pause does not take: what was paused is resumed.
    tool(
      m3,
      'syncthing',
      `#!/bin/sh\ncase "$1 $2 $3" in "cli show system") printf '"myID": "M3-ID"\n';; *) exit 1;; esac\n`,
    );
    logs = [];
    expect(move()).toBe(EXIT_FAILED);
    expect(logs.join('\n')).toContain('✗ could not pause AI Projects on m3');
    expect(pausedLog(here)).toBe('AI Projects true\nAI Projects false\n');
    expect(fs.existsSync(projDir(here)) && fs.existsSync(projDir(m3))).toBe(true);
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
    for (const home of [here, m3]) expect(pausedLog(home)).toBe('AI Projects true\nAI Projects false\n');
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
