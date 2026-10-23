import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureMemory, shellQuote, Tmux, type AiDeps } from '../../src/ai.ts';
import { checkClaudeMemory, resolveDoctorCtx, runDoctorStaged } from '../../src/doctor.ts';
import type { Answer, HostingIo } from '../../src/hosting.ts';
import {
  defaultMemoryDir,
  memoryApplies,
  describeMemory,
  fixMemory,
  fixProjectMemory,
  isPersonalProject,
  memoryNeedsFix,
  memoryReaders,
  memoryState,
  personalHosts,
  type MemoryCtx,
} from '../../src/memory.ts';

// Claude Code keeps a project's memory by the folder's path unless autoMemoryDirectory names
// another place (docs/tasks/claude-memory-in-project, DL #2–#6).
let dir: string;
let ctx: MemoryCtx;
let root: string;
const saved = { global: process.env['GIT_CONFIG_GLOBAL'], nosystem: process.env['GIT_CONFIG_NOSYSTEM'] };
const TODAY = '2026-10-22';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = (file: string) => fs.readFileSync(file, 'utf8');
const json = (file: string) => JSON.parse(read(file)) as Record<string, unknown>;
const project = (name: string, origin?: string) => {
  const d = path.join(dir, name);
  fs.mkdirSync(d);
  git(d, 'init', '-q');
  if (origin) git(d, 'remote', 'add', 'origin', origin);
  return fs.realpathSync(d);
};
const conversationsOf = (r: string) => path.dirname(defaultMemoryDir(r, ctx));

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-memory-')));
  fs.writeFileSync(path.join(dir, 'gitconfig'), '');
  process.env['GIT_CONFIG_GLOBAL'] = path.join(dir, 'gitconfig');
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  ctx = { env: { CLAUDE_CONFIG_DIR: path.join(dir, 'claude') }, home: path.join(dir, 'home') };
  root = project('app');
});
afterEach(() => {
  for (const [k, v] of [
    ['GIT_CONFIG_GLOBAL', saved.global],
    ['GIT_CONFIG_NOSYSTEM', saved.nosystem],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('memoryState', () => {
  it('nothing set: outside, with the notes of the old place counted', () => {
    const old = defaultMemoryDir(root, ctx);
    expect(old).toBe(path.join(dir, 'claude', 'projects', root.replace(/[^A-Za-z0-9]/g, '-'), 'memory'));
    expect(memoryState(root, ctx)).toEqual({ kind: 'outside', old, notes: 0 });
    write(path.join(old, 'MEMORY.md'), '- a\n');
    write(path.join(old, 'a.md'), 'a\n');
    expect(memoryState(root, ctx)).toEqual({ kind: 'outside', old, notes: 2 });
  });

  it('a relative path is no setting — Claude Code drops it (DL #2)', () => {
    write(path.join(root, '.claude', 'settings.json'), '{"autoMemoryDirectory": ".claude/memory"}');
    expect(memoryState(root, ctx).kind).toBe('outside');
  });

  it('set to .claude/memory/ of this project — inside; ~/ is the home directory', () => {
    write(
      path.join(root, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryDirectory: `${root}/.claude/memory/` }),
    );
    expect(memoryState(root, ctx)).toEqual({ kind: 'inside' });
    const home = project('home');
    const inHome = { ...ctx, home };
    const sub = path.join(home, 'p');
    fs.mkdirSync(sub);
    write(path.join(sub, '.claude', 'settings.local.json'), '{"autoMemoryDirectory": "~/p/.claude/memory/"}');
    expect(memoryState(sub, inHome)).toEqual({ kind: 'inside' });
  });

  it('local settings first, as Claude Code reads them', () => {
    write(path.join(root, '.claude', 'settings.json'), '{"autoMemoryDirectory": "/elsewhere/mem/"}');
    write(
      path.join(root, '.claude', 'settings.local.json'),
      JSON.stringify({ autoMemoryDirectory: `${root}/.claude/memory` }),
    );
    expect(memoryState(root, ctx)).toEqual({ kind: 'inside' });
  });

  it('inside, with notes left in the old place: counted, the differing and the only-there named', () => {
    write(
      path.join(root, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryDirectory: `${root}/.claude/memory/` }),
    );
    const old = defaultMemoryDir(root, ctx);
    for (const [n, t] of [
      ['same.md', 's'],
      ['differ.md', 'old'],
      ['gone.md', 'g'],
    ])
      write(path.join(old, n!), t!);
    write(path.join(root, '.claude', 'memory', 'same.md'), 's');
    write(path.join(root, '.claude', 'memory', 'differ.md'), 'new');
    const s = memoryState(root, ctx);
    expect(s).toEqual({ kind: 'leftovers', old, notes: 3, differ: 1, onlyOld: 1 });
    expect(describeMemory(s, ctx)).toMatch(
      /3 note\(s\) still in the old place.*\(1 differ, 1 only there\).*copies nothing back/,
    );
  });

  it('pointing into a folder that is gone: moved, with its conversations', () => {
    const from = path.join(dir, 'old-place');
    write(
      path.join(root, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryDirectory: `${from}/.claude/memory/` }),
    );
    expect(memoryState(root, ctx)).toMatchObject({ kind: 'moved', from, conversations: null, stray: null });
    const conversations = path.join(dir, 'claude', 'projects', from.replace(/[^A-Za-z0-9]/g, '-'));
    write(path.join(conversations, 'c1.jsonl'), '{}\n');
    expect(memoryState(root, ctx)).toMatchObject({ kind: 'moved', conversations });
  });

  it('pointing into a folder that holds only that memory — moved, the notes there stray', () => {
    const from = path.join(dir, 'old-place');
    write(path.join(from, '.claude', 'memory', 'late.md'), 'written after the move');
    write(
      path.join(root, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryDirectory: `${from}/.claude/memory/` }),
    );
    expect(memoryState(root, ctx)).toMatchObject({ kind: 'moved', stray: path.join(from, '.claude', 'memory') });
  });

  it('pointing into another project that exists — elsewhere; any other path — the owner’s own', () => {
    const other = project('other');
    write(path.join(other, 'README.md'), 'x');
    write(
      path.join(root, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryDirectory: `${other}/.claude/memory/` }),
    );
    expect(memoryState(root, ctx)).toMatchObject({ kind: 'elsewhere', from: other });
    write(path.join(root, '.claude', 'settings.json'), '{"autoMemoryDirectory": "/Volumes/Notes/agent/"}');
    const s = memoryState(root, ctx);
    expect(s.kind).toBe('custom');
    expect(memoryNeedsFix(s)).toBe(false);
  });
});

// GitHub's answers as they came 2026-10-23 (claude-memory-in-project DL #12): the token's user,
// a repo's `private`, its collaborators; a repo that is not there — 404.
const ME: Answer = { status: 200, body: { login: 'owner' } };
const repoAnswer = (priv: boolean): Answer => ({ status: 200, body: { private: priv, owner: { type: 'User' } } });
const readers = (...logins: string[]): Answer => ({ status: 200, body: logins.map((login) => ({ login })) });
const NOT_FOUND: Answer = { status: 404, body: { message: 'Not Found' } };
function hostingIo(origin: string | null, answers: Record<string, Answer | Error> = {}, env: NodeJS.ProcessEnv = {}) {
  const asked: string[] = [];
  const io: HostingIo = {
    env,
    git: (args) => (args[0] === 'remote' ? origin : null),
    ghToken: () => 'gh-t',
    glabToken: () => null,
    gitCredential: () => null,
    get: (p) => {
      asked.push(p);
      const a = answers[p];
      if (a instanceof Error) throw a;
      return a ?? NOT_FOUND;
    },
  };
  return { io, asked };
}

describe('memoryReaders: only the owner reads where the commits go', () => {
  const home = personalHosts([
    { host: 'git.home.example', mirrors: ['github.com/me/{repo}', 'github.com/Friends/{repo}'] },
  ]);
  it('no origin: nothing leaves the machine; nothing asked', () => {
    const { io, asked } = hostingIo(null);
    expect(memoryReaders(io, home)).toEqual({ only: true });
    expect(asked).toEqual([]);
  });
  it("a personal host whose mirrors are absent, or private and the owner's alone", () => {
    const none = hostingIo('git@git.home.example:notes.git', { '/user': ME });
    expect(memoryReaders(none.io, home)).toEqual({ only: true });
    expect(none.asked).toEqual(['/user', '/repos/me/notes', '/repos/Friends/notes']);
    const priv = hostingIo('git@git.home.example:notes.git', {
      '/user': ME,
      '/repos/me/notes': repoAnswer(true),
      '/repos/me/notes/collaborators?per_page=100': readers('owner'),
    });
    expect(memoryReaders(priv.io, home)).toEqual({ only: true });
  });
  it('a public mirror — the ai-dev-plugins case', () => {
    const { io } = hostingIo('git@git.home.example:plugins.git', {
      '/user': ME,
      '/repos/me/plugins': repoAnswer(false),
    });
    expect(memoryReaders(io, home)).toEqual({ only: false, why: 'github.com/me/plugins is public' });
  });
  it('a private mirror somebody else reads', () => {
    const { io } = hostingIo('git@git.home.example:site.git', {
      '/user': ME,
      '/repos/Friends/site': repoAnswer(true),
      '/repos/Friends/site/collaborators?per_page=100': readers('owner', 'friend'),
    });
    expect(memoryReaders(io, home)).toEqual({
      only: false,
      why: 'github.com/Friends/site is read by 1 more besides owner',
    });
  });
  it("origin on GitHub: private and the owner's alone, or not; public — no", () => {
    const own = hostingIo('git@github.com:owner/diary.git', {
      '/user': ME,
      '/repos/owner/diary': repoAnswer(true),
      '/repos/owner/diary/collaborators?per_page=100': readers('owner'),
    });
    expect(memoryReaders(own.io, [])).toEqual({ only: true });
    const pub = hostingIo('git@github.com:owner/vdx.git', { '/user': ME, '/repos/owner/vdx': repoAnswer(false) });
    expect(memoryReaders(pub.io, [])).toEqual({ only: false, why: 'github.com/owner/vdx is public' });
    const gone = hostingIo('git@github.com:owner/gone.git', { '/user': ME });
    expect(memoryReaders(gone.io, [])).toEqual({ only: false, why: 'GitHub answered 404 for owner/gone' });
  });
  it('another host, no token, no answer, VDX_OFFLINE — not known, so not only', () => {
    expect(memoryReaders(hostingIo('ssh://git@git.work.example:7999/team/w.git').io, home)).toEqual({
      only: false,
      why: 'origin is on git.work.example — not a host the profile names as yours (git.personal_hosts)',
    });
    const noToken = hostingIo('git@github.com:owner/x.git');
    noToken.io.ghToken = () => null;
    expect(memoryReaders(noToken.io, []).only).toBe(false);
    const down = hostingIo('git@github.com:owner/x.git', { '/user': new Error('ETIMEDOUT') });
    expect(memoryReaders(down.io, [])).toEqual({ only: false, why: 'GitHub did not answer: ETIMEDOUT' });
    const off = hostingIo('git@github.com:owner/x.git', {}, { VDX_OFFLINE: '1' });
    expect(memoryReaders(off.io, []).only).toBe(false);
    expect(off.asked).toEqual([]);
  });
  it('isPersonalProject: the same answer, a plain host name in the profile too', () => {
    expect(isPersonalProject(root, [])).toBe(true);
    const work = project('work', 'ssh://git@git.work.example:7999/team/work.git');
    expect(isPersonalProject(work, personalHosts([]))).toBe(false);
    expect(isPersonalProject(work, personalHosts(['GIT.work.example']))).toBe(true);
  });
});

describe('runDoctorStaged: the pre-commit guard', () => {
  it('a commit without memory: no word, nothing asked', () => {
    const { io, asked } = hostingIo('git@github.com:owner/vdx.git');
    io.git = (args) => (args[0] === 'diff' ? '' : 'git@github.com:owner/vdx.git');
    expect(runDoctorStaged(root, io, {})).toBeNull();
    expect(asked).toEqual([]);
  });
  it('memory staged where somebody else reads: refused, with the reason and what to do', () => {
    const { io } = hostingIo('git@github.com:owner/vdx.git', { '/user': ME, '/repos/owner/vdx': repoAnswer(false) });
    io.git = (args) =>
      args[0] === 'diff' ? '.claude/memory/a.md\n.claude/memory/MEMORY.md' : 'git@github.com:owner/vdx.git';
    expect(runDoctorStaged(root, io, {})).toBe(
      'vdx doctor: Claude memory stays out of this commit (2 file(s)) — github.com/owner/vdx is public.\n' +
        '  commit the rest: git restore --staged .claude/memory, and commit again\n' +
        '  keep it out of git here: echo /.claude/memory/ >> "$(git rev-parse --git-path info/exclude)"',
    );
  });
  it('memory staged where only the owner reads: the commit goes', () => {
    const { io } = hostingIo(null);
    io.git = (args) => (args[0] === 'diff' ? '.claude/memory/a.md' : null);
    expect(runDoctorStaged(root, io, {})).toBeNull();
  });
});

describe('fixMemory', () => {
  it('outside, personal: notes in, the path into settings.json with its other keys, the old place set aside', () => {
    const old = defaultMemoryDir(root, ctx);
    write(path.join(old, 'MEMORY.md'), '- [a](a.md)\n');
    write(path.join(old, 'a.md'), 'a\n');
    write(path.join(root, '.claude', 'settings.json'), '{"permissions": {"allow": ["Bash(ls)"]}}');
    const done = fixMemory(root, memoryState(root, ctx), ctx, { personal: true, underGit: false, today: TODAY });
    expect(read(path.join(root, '.claude', 'memory', 'a.md'))).toBe('a\n');
    expect(json(path.join(root, '.claude', 'settings.json'))).toEqual({
      permissions: { allow: ['Bash(ls)'] },
      autoMemoryDirectory: `${root}/.claude/memory/`,
    });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(`${old}.moved-${TODAY}`)).toBe(true);
    expect(done).toContain('2 note(s) → .claude/memory/');
    expect(done).toContain('commit .claude/memory/ and .claude/settings.json with the project');
    expect(memoryState(root, ctx)).toEqual({ kind: 'inside' });
  });

  it('outside, not personal: the path into settings.local.json, the memory out of git by the clone’s exclude', () => {
    const work = project('work', 'git@gitlab.work.example:team/work.git');
    write(path.join(defaultMemoryDir(work, ctx), 'n.md'), 'n');
    const done = fixMemory(work, memoryState(work, ctx), ctx, { personal: false, underGit: false, today: TODAY });
    expect(fs.existsSync(path.join(work, '.claude', 'settings.json'))).toBe(false);
    expect(json(path.join(work, '.claude', 'settings.local.json'))['autoMemoryDirectory']).toBe(
      `${work}/.claude/memory/`,
    );
    expect(read(path.join(work, '.git', 'info', 'exclude'))).toMatch(/^\/\.claude\/memory\/$/m);
    expect(git(work, 'status', '--porcelain', '--untracked-files=all', '--', '.claude/memory')).toBe('');
    expect(done).toContain('.claude/memory/ → .git/info/exclude');
    // A second exclude line is not added.
    write(path.join(defaultMemoryDir(work, ctx), 'm.md'), 'm');
    fixMemory(work, memoryState(work, ctx), ctx, { personal: false, underGit: false, today: TODAY });
    expect(read(path.join(work, '.git', 'info', 'exclude')).match(/\.claude\/memory/g)).toHaveLength(1);
  });

  it('a name .claude/memory/ already has stays as it is there — nothing overwritten', () => {
    write(path.join(defaultMemoryDir(root, ctx), 'a.md'), 'old');
    write(path.join(defaultMemoryDir(root, ctx), 'b.md'), 'b');
    write(path.join(root, '.claude', 'memory', 'a.md'), 'new');
    const done = fixMemory(root, memoryState(root, ctx), ctx, { personal: true, underGit: false, today: TODAY });
    expect(read(path.join(root, '.claude', 'memory', 'a.md'))).toBe('new');
    expect(read(path.join(root, '.claude', 'memory', 'b.md'))).toBe('b');
    expect(done).toContain('kept .claude/memory/ as it is for a.md — the old copy differs');
    expect(read(path.join(`${defaultMemoryDir(root, ctx)}.moved-${TODAY}`, 'a.md'))).toBe('old');
  });

  it('leftovers: the old place set aside, nothing copied back', () => {
    write(
      path.join(root, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryDirectory: `${root}/.claude/memory/` }),
    );
    write(path.join(defaultMemoryDir(root, ctx), 'gone.md'), 'g');
    fs.mkdirSync(path.join(root, '.claude', 'memory'));
    fixMemory(root, memoryState(root, ctx), ctx, { personal: true, underGit: false, today: TODAY });
    expect(fs.existsSync(path.join(root, '.claude', 'memory', 'gone.md'))).toBe(false);
    expect(memoryState(root, ctx)).toEqual({ kind: 'inside' });
    // A second set-aside of the same day takes the next free name.
    write(path.join(defaultMemoryDir(root, ctx), 'again.md'), 'x');
    fixMemory(root, memoryState(root, ctx), ctx, { personal: true, underGit: false, today: TODAY });
    expect(fs.existsSync(`${defaultMemoryDir(root, ctx)}.moved-${TODAY}-2`)).toBe(true);
  });

  it('moved: the path rewritten in its own file, the conversations brought to the new path', () => {
    const from = path.join(dir, 'old-place');
    write(
      path.join(root, '.claude', 'settings.local.json'),
      JSON.stringify({ autoMemoryDirectory: `${from}/.claude/memory/` }),
    );
    const conversations = path.join(dir, 'claude', 'projects', from.replace(/[^A-Za-z0-9]/g, '-'));
    write(path.join(conversations, 'c1.jsonl'), '{}\n');
    const done = fixMemory(root, memoryState(root, ctx), ctx, { personal: true, underGit: false, today: TODAY });
    expect(json(path.join(root, '.claude', 'settings.local.json'))['autoMemoryDirectory']).toBe(
      `${root}/.claude/memory/`,
    );
    expect(fs.existsSync(path.join(root, '.claude', 'settings.json'))).toBe(false);
    expect(read(path.join(conversationsOf(root), 'c1.jsonl'))).toBe('{}\n');
    expect(fs.existsSync(conversations)).toBe(false);
    expect(done.join('\n')).toMatch(/conversations .* → /);
  });

  it('moved, and the new path already has conversations: those stay, the rest is brought, nothing lost', () => {
    const from = path.join(dir, 'old-place');
    write(
      path.join(root, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryDirectory: `${from}/.claude/memory/` }),
    );
    const conversations = path.join(dir, 'claude', 'projects', from.replace(/[^A-Za-z0-9]/g, '-'));
    write(path.join(conversations, 'c1.jsonl'), 'old\n');
    write(path.join(conversations, 'same.jsonl'), 'old\n');
    write(path.join(conversationsOf(root), 'same.jsonl'), 'new\n');
    fixMemory(root, memoryState(root, ctx), ctx, { personal: true, underGit: false, today: TODAY });
    expect(read(path.join(conversationsOf(root), 'c1.jsonl'))).toBe('old\n');
    expect(read(path.join(conversationsOf(root), 'same.jsonl'))).toBe('new\n');
    expect(read(path.join(`${conversations}.moved-${TODAY}`, 'same.jsonl'))).toBe('old\n');
  });

  it('moved, with notes a session wrote at the old path after the move: they join .claude/memory/', () => {
    const from = path.join(dir, 'old-place');
    write(path.join(from, '.claude', 'memory', 'late.md'), 'late');
    write(
      path.join(root, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryDirectory: `${from}/.claude/memory/` }),
    );
    const done = fixMemory(root, memoryState(root, ctx), ctx, { personal: true, underGit: false, today: TODAY });
    expect(read(path.join(root, '.claude', 'memory', 'late.md'))).toBe('late');
    expect(done.join('\n')).toMatch(/1 note\(s\) written at the old path after the move.*remove it/);
  });

  it('a settings file that is not JSON: nothing written, the reason named', () => {
    write(path.join(root, '.claude', 'settings.json'), '{ not json');
    expect(() =>
      fixMemory(root, memoryState(root, ctx), ctx, { personal: true, underGit: false, today: TODAY }),
    ).toThrow(/is not a JSON object — nothing written/);
    expect(read(path.join(root, '.claude', 'settings.json'))).toBe('{ not json');
  });
});

describe('fixProjectMemory: the question outside a personal project', () => {
  const run = (r: string, answers: (string | null)[]) => {
    const logs: string[] = [];
    const done = fixProjectMemory(r, memoryState(r, ctx), ctx, {
      ask: () => (answers.length ? answers.shift()! : null),
      log: (l) => logs.push(l),
      today: TODAY,
      personalHosts: personalHosts(['git.home.example']),
    });
    return { done, logs };
  };
  it('Enter keeps the memory out of git; y keeps it under git', () => {
    const a = project('a', 'git@github.com:someone/a.git');
    expect(run(a, ['']).done).toContain('.claude/memory/ → .git/info/exclude');
    const b = project('b', 'git@github.com:someone/b.git');
    const yes = run(b, ['y']);
    expect(yes.done).not.toContain('.claude/memory/ → .git/info/exclude');
    expect(yes.done).toContain('autoMemoryDirectory → .claude/settings.local.json');
  });
  it('a personal project is not asked', () => {
    const p = project('p', 'git@git.home.example:p.git');
    const { done, logs } = run(p, []);
    expect(logs).toEqual([]);
    expect(done).toContain('autoMemoryDirectory → .claude/settings.json');
  });
});

describe('ensureMemory: vdx ai at the start', () => {
  const logs: string[] = [];
  const deps = (answers: (string | null)[], interactive = true): AiDeps => ({
    env: ctx.env,
    home: ctx.home,
    tmux: new Tmux(`vdx-test-unused-${process.pid}`),
    interactive,
    shell: '/bin/sh',
    log: (l) => logs.push(l),
    out: (t) => logs.push(t),
    onPath: () => false,
    processes: () => [],
    sleep: () => {},
    confirmTimeoutMs: 1000,
    ask: () => (answers.length ? answers.shift()! : null),
  });
  beforeEach(() => {
    logs.length = 0;
    write(path.join(defaultMemoryDir(root, ctx), 'a.md'), 'a');
  });

  it('Enter moves the memory in', () => {
    ensureMemory(root, 'claude', [], deps(['']), false, false);
    expect(logs[0]).toMatch(/⚠ app: Claude memory outside the project: 1 note\(s\)/);
    expect(logs).toContain('✓ 1 note(s) → .claude/memory/');
    expect(memoryState(root, ctx)).toEqual({ kind: 'inside' });
  });
  it('n leaves it and names the command; so does a start without a terminal', () => {
    ensureMemory(root, 'claude', [], deps(['n']), false, false);
    expect(logs.at(-1)).toBe(`  skipped — later: vdx doctor --fix ${shellQuote(root)}`);
    logs.length = 0;
    ensureMemory(root, 'claude', [], deps([], false), false, false);
    expect(logs.at(-1)).toBe(`  put it there: vdx doctor --fix ${shellQuote(root)}`);
    expect(memoryState(root, ctx).kind).toBe('outside');
  });
  it('an agent of the project running: only said — that session keeps the old place', () => {
    ensureMemory(root, 'claude', [], deps(['']), false, true);
    expect(logs.at(-1)).toBe(`  once the running agent of the project ends: vdx doctor --fix ${shellQuote(root)}`);
    expect(memoryState(root, ctx).kind).toBe('outside');
  });
  it('--dry-run shows where it is; another agent is not asked about Claude Code', () => {
    ensureMemory(root, 'claude', [], deps([]), true, false);
    expect(logs).toEqual([expect.stringMatching(/^ {2}memory: {3}outside the project: 1 note\(s\)/)]);
    logs.length = 0;
    ensureMemory(root, 'codex', [], deps(['']), false, false);
    expect(logs).toEqual([]);
  });
});

describe('checkClaudeMemory: the doctor line', () => {
  it('outside: a warning, the fix, and that the running session keeps the old place', () => {
    write(path.join(defaultMemoryDir(root, ctx), 'a.md'), 'a');
    const c = checkClaudeMemory({ projectRoot: root }, {}, ctx)!;
    expect(c).toMatchObject({ id: 'claude-memory', status: 'warning', remedy: `vdx doctor --fix ${shellQuote(root)}` });
    expect(c.sessionNote).toMatch(/keeps the old place until it restarts/);
  });
  it('leftovers: the fix, but no restart note — the session writes inside already', () => {
    write(
      path.join(root, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryDirectory: `${root}/.claude/memory/` }),
    );
    write(path.join(defaultMemoryDir(root, ctx), 'a.md'), 'a');
    const c = checkClaudeMemory({ projectRoot: root }, {}, ctx)!;
    expect(c.status).toBe('warning');
    expect(c.sessionNote).toBeUndefined();
  });
  it('inside: ok; another agent in the profile, or no project: no line', () => {
    write(
      path.join(root, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryDirectory: `${root}/.claude/memory/` }),
    );
    expect(checkClaudeMemory({ projectRoot: root }, {}, ctx)).toMatchObject({
      status: 'ok',
      message: 'in .claude/memory/',
    });
    expect(checkClaudeMemory({ projectRoot: root }, { agent: { command: 'codex' } }, ctx)).toBeNull();
    expect(checkClaudeMemory({ projectRoot: null }, {}, ctx)).toBeNull();
  });
  it('from a subdirectory: the checkout’s top, where the agent starts', () => {
    fs.mkdirSync(path.join(root, 'src'));
    write(path.join(defaultMemoryDir(root, ctx), 'a.md'), 'a');
    expect(checkClaudeMemory({ projectRoot: path.join(root, 'src') }, {}, ctx)!.remedy).toBe(
      `vdx doctor --fix ${shellQuote(root)}`,
    );
  });
});

describe('memoryApplies: the home directory is no project', () => {
  it("home, above it, or inside Claude Code's config: not a folder whose memory vdx moves", () => {
    fs.mkdirSync(ctx.home, { recursive: true });
    expect(memoryApplies(ctx.home, ctx)).toBe(false);
    expect(memoryApplies(dir, ctx)).toBe(false); // above home
    expect(memoryApplies(path.join(dir, 'claude'), ctx)).toBe(false);
    expect(memoryApplies(root, ctx)).toBe(true);
    const sub = path.join(ctx.home, 'notes');
    fs.mkdirSync(sub);
    expect(memoryApplies(sub, ctx)).toBe(true);
  });
  it("doctor says nothing there, and a fix refuses — it would write the user's own settings", () => {
    fs.mkdirSync(ctx.home, { recursive: true });
    expect(checkClaudeMemory({ projectRoot: ctx.home }, {}, ctx)).toBeNull();
    expect(() =>
      fixMemory(ctx.home, memoryState(ctx.home, ctx), ctx, { personal: true, underGit: false, today: TODAY }),
    ).toThrow(/no project folder/);
    expect(fs.existsSync(path.join(ctx.home, '.claude', 'settings.json'))).toBe(false);
  });
});

describe('resolveDoctorCtx: a named folder is the project', () => {
  it('a folder of notes, without a marker file: the project when named, not as the working directory', () => {
    const notes = path.join(dir, 'notes');
    fs.mkdirSync(notes);
    expect(resolveDoctorCtx(notes, true).projectRoot).toBe(notes);
    expect(resolveDoctorCtx(notes).projectRoot).toBeNull();
    expect(resolveDoctorCtx(path.join(dir, 'nowhere'), true).projectRoot).toBeNull();
  });
});
