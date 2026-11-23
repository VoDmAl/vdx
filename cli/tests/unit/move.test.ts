import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseEnvironment, shellQuote } from '../../src/ai.ts';
import { projectDirName } from '../../src/conversations.ts';
import {
  EXIT_FAILED,
  EXIT_MOVED,
  EXIT_REFUSED,
  EXIT_USAGE,
  runMove,
  type MoveDeps,
  zoxideScript,
} from '../../src/move.ts';
import { deskLinkNotes, runShelve, runTake } from '../../src/shelf.ts';

// `vdx move`: two machines are two homes here — "m3" is reached by a fake ssh that runs
// the same script with its own HOME (claude-memory-in-project DL #17, #18).
let base: string;
let here: string;
let m3: string;
let logs: string[];
let restarts: { host: string | null; path: string; conversation: string; focused: boolean; hq: boolean }[];
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
    ssh: (args) => (args.at(-2) === 'm3' ? run(m3, args.at(-1)!) : { status: 255, stdout: '' }),
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
    expect(restarts).toEqual([{ host: 'm3', path: ga(here), conversation: CONVERSATION, focused: false, hq: false }]);
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
    expect(restarts).toEqual([
      { host: null, path: projDir(here), conversation: CONVERSATION, focused: false, hq: false },
    ]);
    for (const home of [here, m3]) expect(pausedLog(home)).toBe('AI Projects true\nAI Projects false\n');
  });

  // git keeps a worktree's links as absolute paths, both ways (limeflow and its seven, 2026-11-14).
  describe('a repository with a worktree', () => {
    const wt = (home: string) => path.join(home, 'AI Projects', 'proj-wt');
    const head = (dir: string) => git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').toString().trim();
    beforeEach(() => {
      git(projDir(m3), 'init', '-q');
      git(projDir(m3), 'add', 'README.md');
      git(projDir(m3), 'commit', '-q', '-m', 'init');
      for (const h of [here, m3]) git(projDir(h), 'worktree', 'add', '-q', '-b', 'side', wt(h));
    });

    it('both moved: the plan names the link, and git worktree repair keeps it on both machines', () => {
      const run = (dryRun: boolean) =>
        runMove({ sources: [projDir(here), wt(here)], folder: path.join(here, 'AI Projects', 'GA'), dryRun }, deps());
      expect(run(true)).toBe(EXIT_MOVED);
      expect(logs.join('\n')).toContain(
        'worktrees: proj-wt — git keeps them by absolute paths; after the mv: git worktree repair',
      );
      expect(logs.join('\n')).toContain('a worktree of ~/AI Projects/proj — its link is repaired after the mv');
      logs = [];
      expect(run(false)).toBe(EXIT_MOVED);
      expect(logs.join('\n')).toContain('✓ worktrees of proj: links repaired on here, m3');
      for (const h of [here, m3]) {
        const moved = path.join(h, 'AI Projects', 'GA', 'proj-wt');
        expect(head(moved)).toBe('side');
        expect(git(ga(h), 'worktree', 'list', '--porcelain').toString()).toContain(`worktree ${moved}\n`);
      }
    });

    it('the main moved alone: the worktree where it was finds it again', () => {
      expect(move()).toBe(EXIT_MOVED);
      expect(logs.join('\n')).toContain('✓ worktrees of proj: links repaired on here, m3');
      for (const h of [here, m3]) {
        expect(head(wt(h))).toBe('side');
        expect(git(ga(h), 'worktree', 'list', '--porcelain').toString()).toContain(`worktree ${wt(h)}\n`);
      }
    });
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

// vdx take / vdx shelve (claude-memory-in-project DL #26–#28): each machine's desk and shelf under its own
// ~/Working, three Syncthing folders on each; the project's origin is on example.com.
describe('vdx take and vdx shelve', () => {
  const desk = (home: string) => path.join(home, 'Working', 'desk');
  const shelf = (home: string) => path.join(home, 'Working', 'repos');
  const onShelf = (home: string) => path.join(shelf(home), 'example.com', 'grp', 'proj');
  const ORIGIN = 'git@example.com:grp/proj.git';
  const take = (input: { sources?: string[]; group?: string } = {}, over: Partial<MoveDeps> = {}, dryRun = false) =>
    runTake({ sources: [projDir(here)], group: 'GA', dryRun, ...input }, deps(over));
  const shelve = (sources: string[], dryRun = false) => runShelve({ sources, dryRun }, deps());
  /** A clone of the project's server on both shelves, its origin the project's. */
  const secondClone = () => {
    const server = path.join(base, 'server.git');
    execFileSync('git', ['clone', '-q', '--bare', projDir(here), server]);
    execFileSync('git', ['clone', '-q', server, onShelf(here)]);
    git(onShelf(here), 'remote', 'set-url', 'origin', ORIGIN);
    fs.cpSync(onShelf(here), onShelf(m3), { recursive: true });
  };

  beforeEach(() => {
    for (const home of [here, m3]) {
      fs.mkdirSync(shelf(home), { recursive: true });
      fs.mkdirSync(desk(home), { recursive: true });
      setSync(home, (c) => {
        const peer = [{ device: ID(home === here ? m3 : here), name: 'peer' }];
        c.folders = {
          'AI Projects': { path: path.join(home, 'AI Projects'), peers: peer },
          desk: { path: desk(home), peers: peer },
          repos: { path: shelf(home), peers: peer },
        };
      });
    }
    git(projDir(here), 'remote', 'add', 'origin', ORIGIN);
    const env = path.join(base, 'env.yaml');
    fs.writeFileSync(
      env,
      fs.readFileSync(env, 'utf8').replace('move:\n', 'move:\n  desk: ~/Working/desk\n  shelf: ~/Working/repos\n'),
    );
  });

  it('take: onto the desk group on every machine, the same relative link on every shelf, the shelf paused too', () => {
    expect(take()).toBe(EXIT_MOVED);
    for (const home of [here, m3]) {
      expect(fs.existsSync(projDir(home))).toBe(false);
      expect(fs.existsSync(path.join(desk(home), 'GA', 'proj', 'README.md'))).toBe(true);
      expect(fs.readlinkSync(onShelf(home))).toBe('../../../desk/GA/proj');
      expect(fs.existsSync(path.join(onShelf(home), 'README.md'))).toBe(true);
      expect(pausedLog(home)).toContain('repos true');
      expect(pausedLog(home)).toContain('repos false');
    }
    const out = logs.join('\n');
    expect(out).toContain('vdx take — 1 project(s) → ~/Working/desk/GA/');
    expect(out).toContain('shelf: link ~/Working/repos/example.com/grp/proj → ../../../desk/GA/proj, on here, m3');
    expect(out).toContain('✓ proj: link ~/Working/repos/example.com/grp/proj → ../../../desk/GA/proj on here, m3');
  });

  it('take --dry-run: the plan with the link, nothing made', () => {
    expect(take({}, {}, true)).toBe(EXIT_MOVED);
    expect(logs.join('\n')).toContain('dry run: nothing moved');
    for (const home of [here, m3]) {
      expect(fs.existsSync(projDir(home))).toBe(true);
      expect(fs.existsSync(onShelf(home))).toBe(false);
    }
  });

  it('take: a second clone with nothing of its own gives its place to the link on every machine', () => {
    secondClone();
    expect(take()).toBe(EXIT_MOVED);
    for (const home of [here, m3]) {
      expect(fs.lstatSync(onShelf(home)).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(onShelf(home), 'README.md'))).toBe(true);
    }
    expect(logs.join('\n')).toContain('second clone ~/Working/repos/example.com/grp/proj: nothing of its own');
  });

  it('take: a second clone with its own work is left as it is, and no link is made', () => {
    secondClone();
    write(path.join(onShelf(here), 'draft.txt'), 'mine\n');
    expect(take()).toBe(EXIT_MOVED);
    for (const home of [here, m3]) {
      expect(fs.lstatSync(onShelf(home)).isDirectory()).toBe(true);
      expect(fs.existsSync(path.join(desk(home), 'GA', 'proj'))).toBe(true);
    }
    expect(fs.existsSync(path.join(onShelf(here), 'draft.txt'))).toBe(true);
    expect(logs.join('\n')).toContain('1 uncommitted — its own, left as it is; no link made');
  });

  it("take from the shelf: the link takes the project's own place there", () => {
    for (const home of [here, m3]) {
      fs.mkdirSync(path.dirname(onShelf(home)), { recursive: true });
      fs.renameSync(projDir(home), onShelf(home));
    }
    expect(take({ sources: [onShelf(here)], group: undefined })).toBe(EXIT_MOVED);
    for (const home of [here, m3]) {
      expect(fs.readlinkSync(onShelf(home))).toBe('../../../desk/proj');
      expect(fs.existsSync(path.join(desk(home), 'proj', 'README.md'))).toBe(true);
    }
  });

  it('take of a project in its place: the missing link only, on the machine that lacks it; then nothing to do', () => {
    expect(take()).toBe(EXIT_MOVED);
    fs.unlinkSync(onShelf(m3));
    logs = [];
    expect(take({ sources: [path.join(desk(here), 'GA', 'proj')] })).toBe(EXIT_MOVED);
    expect(fs.readlinkSync(onShelf(m3))).toBe('../../../desk/GA/proj');
    expect(logs.join('\n')).toContain('— stays where it is');
    logs = [];
    expect(take({ sources: [path.join(desk(here), 'GA', 'proj')] })).toBe(EXIT_MOVED);
    expect(logs.join('\n')).toContain('nothing to do: every project is in its place');
  });

  it('take into another group: the project moves on the desk and its link follows', () => {
    expect(take()).toBe(EXIT_MOVED);
    expect(take({ sources: [path.join(desk(here), 'GA', 'proj')], group: 'SPACE' })).toBe(EXIT_MOVED);
    for (const home of [here, m3]) expect(fs.readlinkSync(onShelf(home))).toBe('../../../desk/SPACE/proj');
  });

  it('take: a project without origin goes onto the desk only; --in must name a group inside the desk', () => {
    git(projDir(here), 'remote', 'remove', 'origin');
    expect(take()).toBe(EXIT_MOVED);
    expect(logs.join('\n')).toContain('no origin — it lives on the desk only');
    expect(fs.existsSync(path.join(shelf(here), 'example.com'))).toBe(false);
    expect(take({ group: '../x' })).toBe(EXIT_USAGE);
  });

  it('shelve: in place of its link on every machine; the link goes first', () => {
    withServer();
    expect(take()).toBe(EXIT_MOVED);
    expect(shelve([path.join(desk(here), 'GA', 'proj')])).toBe(EXIT_MOVED);
    for (const home of [here, m3]) {
      expect(fs.lstatSync(onShelf(home)).isDirectory()).toBe(true);
      expect(fs.existsSync(path.join(onShelf(home), 'README.md'))).toBe(true);
      expect(fs.existsSync(path.join(desk(home), 'GA', 'proj'))).toBe(false);
    }
    expect(logs.join('\n')).toContain(
      'shelf: the link ~/Working/repos/example.com/grp/proj → ../../../desk/GA/proj goes',
    );
  });

  it('shelve without a link: at <host>/<path> of its origin; refused without origin, or where a clone stands', () => {
    withServer();
    expect(shelve([projDir(here)])).toBe(EXIT_MOVED);
    for (const home of [here, m3]) expect(fs.existsSync(path.join(onShelf(home), 'README.md'))).toBe(true);
    expect(shelve([onShelf(here)])).toBe(EXIT_USAGE);
    expect(logs.join('\n')).toContain('is on the shelf already');
  });

  it('shelve refuses a project without origin, and a place a clone of it holds', () => {
    git(projDir(here), 'remote', 'remove', 'origin');
    expect(shelve([projDir(here)])).toBe(EXIT_USAGE);
    expect(logs.join('\n')).toContain('no origin — the shelf keeps clones by their remote');
    git(projDir(here), 'remote', 'add', 'origin', ORIGIN);
    secondClone();
    logs = [];
    expect(shelve([projDir(here)])).toBe(EXIT_USAGE);
    expect(logs.join('\n')).toContain('on the shelf is taken by a clone of it');
    expect(fs.existsSync(projDir(here))).toBe(true);
  });

  /** The project's origin a real server: its branches are on origin, the upstream set; the URL stays example.com. */
  const withServer = (): string => {
    const root = projDir(here);
    const server = path.join(base, 'server.git');
    execFileSync('git', ['clone', '-q', '--bare', root, server]);
    git(root, 'remote', 'set-url', 'origin', server);
    git(root, 'fetch', '-q', 'origin');
    const branch = git(root, 'symbolic-ref', '--short', 'HEAD').toString().trim();
    git(root, 'branch', '-q', `--set-upstream-to=origin/${branch}`);
    git(root, 'remote', 'set-url', 'origin', ORIGIN);
    return branch;
  };
  const sh = (cwd: string, script: string) => execFileSync('sh', ['-c', script], { cwd, encoding: 'utf8' }).trim();

  it('shelve keeps its own beside the clone, which goes onto the server branch; take brings all of it back', () => {
    const branch = withServer();
    const root = projDir(here);
    write(path.join(root, '.gitignore'), '.env\nnode_modules/\n');
    git(root, 'add', '.gitignore');
    git(root, 'commit', '-q', '-m', 'own commit');
    write(path.join(root, '.env'), 'SECRET=1\n');
    write(path.join(root, 'README.md'), 'changed\n');
    expect(shelve([root])).toBe(EXIT_MOVED);
    const clone = onShelf(here);
    const set = `${clone}.own/2026-10-27 shelve`;
    expect(sh(clone, 'git status --porcelain')).toBe('');
    expect(sh(clone, 'git rev-parse HEAD')).toBe(sh(clone, `git rev-parse origin/${branch}`));
    expect(fs.existsSync(path.join(clone, '.env'))).toBe(false);
    expect(fs.readFileSync(path.join(set, 'files', '.env'), 'utf8')).toBe('SECRET=1\n');
    expect(sh(clone, `git bundle verify -q '${set}/work.bundle' && echo ok`)).toBe('ok');
    expect(fs.existsSync(path.join(set, 'README'))).toBe(true);
    const out = logs.join('\n');
    expect(out).toContain('⚠ its own: 1 commit(s) on no remote branch it knows');
    expect(out).toMatch(
      /⚠ its own — 1 commit\(s\) on .*, \d+ uncommitted, .*\.env.* — kept beside it in proj\.own\/2026-10-27 shelve\//,
    );
    expect(out).toContain(`the clone is on origin/${branch}, as the server has it`);

    logs = [];
    expect(take({ sources: [clone], group: undefined })).toBe(EXIT_MOVED);
    const back = path.join(desk(here), 'proj');
    expect(fs.readFileSync(path.join(back, '.env'), 'utf8')).toBe('SECRET=1\n');
    expect(fs.readFileSync(path.join(back, 'README.md'), 'utf8')).toBe('changed\n');
    expect(sh(back, 'git log -1 --format=%s')).toBe('own commit');
    expect(sh(back, 'git symbolic-ref --short HEAD')).toBe(branch);
    expect(fs.existsSync(path.join(back, 'node_modules', 'x.js'))).toBe(true);
    expect(sh(back, 'git stash list')).toBe('');
    expect(fs.existsSync(`${clone}.own`)).toBe(false);
    expect(logs.join('\n')).toContain('✓ 2026-10-27 shelve: its own is back in the project');
  });

  it('a branch named with shell syntax goes beside the clone and comes back as a name, run by nobody', () => {
    withServer();
    const root = projDir(here);
    const name = 'own$(touch${IFS}pwned)';
    git(root, 'checkout', '-q', '-b', name);
    write(path.join(root, 'f.txt'), 'f\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'on a strange branch');
    expect(shelve([root])).toBe(EXIT_MOVED);
    expect(take({ sources: [onShelf(here)], group: undefined })).toBe(EXIT_MOVED);
    const back = path.join(desk(here), 'proj');
    expect(sh(back, 'git symbolic-ref --short HEAD')).toBe(name);
    for (const dir of [base, here, back, onShelf(here), '/'])
      expect(fs.existsSync(path.join(dir, 'pwned'))).toBe(false);
  });

  it('take: a set whose state.json names a file outside the project leaves it, and the set stays', () => {
    withServer();
    const root = projDir(here);
    write(path.join(root, '.gitignore'), '.env\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'ignore');
    write(path.join(root, '.env'), 'SECRET=1\n');
    expect(shelve([root])).toBe(EXIT_MOVED);
    const set = `${onShelf(here)}.own/2026-10-27 shelve`;
    const state = json(path.join(set, 'state.json'));
    write(path.join(set, 'files', '..', '..', 'escape.txt'), 'x\n');
    fs.writeFileSync(
      path.join(set, 'state.json'),
      JSON.stringify({ ...state, files: [...(state['files'] as string[]), '../../escape.txt'] }),
    );
    expect(take({ sources: [onShelf(here)], group: undefined })).toBe(EXIT_FAILED);
    expect(fs.existsSync(path.join(desk(here), 'proj', '..', '..', 'escape.txt'))).toBe(false);
    expect(fs.existsSync(path.join(desk(here), 'proj', '.env'))).toBe(true);
    expect(fs.existsSync(set)).toBe(true);
    expect(logs.join('\n')).toContain('../../escape.txt (not a path inside the project)');
  });

  it('shelve of a project with nothing of its own: no set beside it', () => {
    withServer();
    const root = projDir(here);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'all of it');
    git(root, 'push', '-q', path.join(base, 'server.git'), 'HEAD');
    git(root, 'fetch', '-q', path.join(base, 'server.git'), '+refs/heads/*:refs/remotes/origin/*');
    expect(shelve([root])).toBe(EXIT_MOVED);
    expect(fs.existsSync(`${onShelf(here)}.own`)).toBe(false);
    expect(logs.join('\n')).toContain('nothing of its own');
  });

  it('shelve without a server branch: its own stays inside the clone, untouched, and is named', () => {
    write(path.join(projDir(here), 'draft.txt'), 'mine\n');
    expect(shelve([projDir(here)])).toBe(EXIT_MOVED);
    expect(fs.existsSync(path.join(onShelf(here), 'draft.txt'))).toBe(true);
    expect(fs.existsSync(`${onShelf(here)}.own`)).toBe(false);
    expect(logs.join('\n')).toContain('⚠ its own stays inside the clone: no server branch to put it on');
  });

  it('take: a second clone with ignored files only — they go beside it, the link takes its place', () => {
    secondClone();
    write(path.join(onShelf(here), '.gitignore'), '.env\n');
    git(onShelf(here), 'add', '.gitignore');
    git(onShelf(here), 'commit', '-q', '-m', 'ignore');
    git(onShelf(here), 'push', '-q', path.join(base, 'server.git'), 'HEAD');
    git(onShelf(here), 'fetch', '-q', path.join(base, 'server.git'), '+refs/heads/*:refs/remotes/origin/*');
    write(path.join(onShelf(here), '.env'), 'CLONE=1\n');
    fs.rmSync(onShelf(m3), { recursive: true });
    fs.cpSync(onShelf(here), onShelf(m3), { recursive: true });
    expect(take()).toBe(EXIT_MOVED);
    const kept = `${onShelf(here)}.own/2026-10-27 second clone`;
    expect(fs.readFileSync(path.join(kept, 'files', '.env'), 'utf8')).toBe('CLONE=1\n');
    for (const home of [here, m3]) expect(fs.lstatSync(onShelf(home)).isSymbolicLink()).toBe(true);
    expect(logs.join('\n')).toContain(
      'files git ignores, which Syncthing carries, go beside it into proj.own/2026-10-27 second clone/: .env',
    );
  });

  it('vdx move of a desk project names its link on the shelf, which would lead to the old place', () => {
    expect(take()).toBe(EXIT_MOVED);
    const from = path.join(desk(here), 'GA', 'proj');
    const d = deps();
    logs = [];
    expect(
      runMove(
        {
          sources: [from],
          folder: path.join(desk(here), 'SPACE'),
          dryRun: true,
          notesFor: (root, environment) => deskLinkNotes(root, environment, d),
        },
        d,
      ),
    ).toBe(EXIT_MOVED);
    expect(logs.join('\n')).toContain(
      "shelf: the link ~/Working/repos/example.com/grp/proj leads here and would lead to the old place — vdx take '~/Working/desk/GA/proj' --in <group> moves it with the link",
    );
  });

  it('the profile takes move.desk and move.shelf as paths', () => {
    expect(parseEnvironment('move:\n  desk: /d\n  shelf: /s\n', 'p').move?.desk).toBe('/d');
    expect(() => parseEnvironment('move:\n  desk: [x]\n', 'p')).toThrow('move.desk must be a path');
  });
});

describe('move.after in the profile', () => {
  it('takes a list of named commands; a command is required', () => {
    expect(parseEnvironment('move:\n  after:\n    - name: e\n      command: x\n', 'p').move?.after).toHaveLength(1);
    expect(() => parseEnvironment('move:\n  after:\n    - name: e\n', 'p')).toThrow('move.after[0].command');
    expect(() => parseEnvironment('move: [x]\n', 'p')).toThrow('move must be a mapping');
  });
});

// nas-info `vdx-move-zoxide-paths` (2026-11-19), the owner: «vdx move не помешает научить ещё и в "z" находить и
// менять пути». A fake zoxide keeps its list in a file and logs what it is asked.
describe("zoxide's paths follow the move", () => {
  let dir: string;
  beforeEach(() => (dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-zoxide-')))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = (script: string, withZoxide = true) => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, 'zoxide'),
      '#!/bin/sh\ncase "$1" in\n  query) cat "$ZO_LIST";;\n  add|remove) echo "$*" >> "$ZO_LOG";;\nesac\n',
      { mode: 0o755 },
    );
    const res = spawnSync('sh', ['-c', script], {
      encoding: 'utf8',
      env: {
        PATH: withZoxide ? `${bin}:/usr/bin:/bin` : '/usr/bin:/bin',
        HOME: dir,
        ZO_LIST: path.join(dir, 'list'),
        ZO_LOG: path.join(dir, 'log'),
      },
    });
    const log = fs.existsSync(path.join(dir, 'log')) ? fs.readFileSync(path.join(dir, 'log'), 'utf8') : '';
    return { out: res.stdout.trim(), log };
  };

  it('moves the old place and its subfolders with their scores; drops one gone; leaves others alone', () => {
    const from = path.join(dir, 'AI Projects', 'proj');
    const to = path.join(dir, 'repos', 'proj');
    fs.mkdirSync(path.join(to, 'cli', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'list'),
      [
        `2529.2 ${from}`,
        `  40.0 ${from}/cli/src`,
        `   4.0 ${from}/gone`,
        `   8.0 ${from}-other`,
        `  12.5 ${path.join(dir, 'elsewhere')}`,
      ].join('\n') + '\n',
    );
    const r = run(zoxideScript(from, to, dir));
    expect(r.out).toBe('2 1');
    expect(r.log.split('\n').filter(Boolean)).toEqual([
      `add --score 2529.2 -- ${to}`,
      `remove -- ${from}`,
      `add --score 40.0 -- ${to}/cli/src`,
      `remove -- ${from}/cli/src`,
      `remove -- ${from}/gone`,
    ]);
  });

  it('skips a machine without zoxide, without the new place, or that keeps its copy in the old place', () => {
    const from = path.join(dir, 'old');
    const to = path.join(dir, 'new');
    expect(run(zoxideScript(from, to, dir), false).out).toBe('skip no zoxide');
    expect(run(zoxideScript(from, to, dir)).out).toBe('skip not here');
    fs.mkdirSync(to);
    fs.mkdirSync(from);
    expect(run(zoxideScript(from, to, dir)).out).toBe('skip the old place stays');
    expect(run(zoxideScript(from, to, dir)).log).toBe('');
  });
});
