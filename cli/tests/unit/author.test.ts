import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { effectiveAuthor, rankAuthors, remoteParts, scanPool, writeAuthor } from '../../src/author.ts';

// Git here must not see the machine's own config: no global author, no system file.
const saved = { global: process.env['GIT_CONFIG_GLOBAL'], nosystem: process.env['GIT_CONFIG_NOSYSTEM'] };
let emptyGlobal: string;
beforeAll(() => {
  emptyGlobal = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-gitcfg-')), 'config');
  fs.writeFileSync(emptyGlobal, '');
  process.env['GIT_CONFIG_GLOBAL'] = emptyGlobal;
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
});
afterAll(() => {
  for (const [k, v] of [['GIT_CONFIG_GLOBAL', saved.global], ['GIT_CONFIG_NOSYSTEM', saved.nosystem]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(path.dirname(emptyGlobal), { recursive: true, force: true });
});

function makeRepo(dir: string, o: { email?: string; name?: string; remote?: string; commitsBy?: string[] } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  git('init', '-q');
  if (o.remote) git('remote', 'add', 'origin', o.remote);
  for (const [i, email] of (o.commitsBy ?? []).entries()) {
    execFileSync('git', ['-C', dir, 'commit', '-q', '--allow-empty', '-m', `c${i}`], {
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_NAME: 'X', GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: 'X', GIT_COMMITTER_EMAIL: email },
    });
  }
  if (o.email) git('config', '--local', 'user.email', o.email);
  if (o.name) git('config', '--local', 'user.name', o.name);
  return dir;
}

describe('remoteParts', () => {
  it('reads host and group from scp-like, ssh and https remotes', () => {
    expect(remoteParts('git@github.com:VoDmAl/vdx.git')).toMatchObject({ host: 'github.com', group: 'VoDmAl' });
    expect(remoteParts('ssh://git@gitlab.finam.ru:2222/AITECH/mcp/mcp-app-email.git')).toMatchObject({
      host: 'gitlab.finam.ru',
      group: 'AITECH/mcp',
    });
    expect(remoteParts('https://github.com/plaid/quickstart')).toMatchObject({ host: 'github.com', group: 'plaid' });
    expect(remoteParts('git@git.vorobyev.name:echelon.git')).toMatchObject({ host: 'git.vorobyev.name', group: '' });
  });
});

describe('proposing an author', () => {
  let pool: string;
  beforeEach(() => {
    pool = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-pool-')));
    makeRepo(path.join(pool, 'svc-a'), { email: 'me@work.example', name: 'Me', remote: 'git@gitlab.work:team/svc-a.git' });
    makeRepo(path.join(pool, 'svc-b'), { email: 'me@work.example', name: 'Me', remote: 'git@gitlab.work:team/svc-b.git' });
    makeRepo(path.join(pool, 'site'), { email: 'me@home.example', name: 'Me Home', remote: 'git@github.com:me/site.git' });
    makeRepo(path.join(pool, 'lime-dash'), { email: 'me@lime.example', name: 'Me' });
    fs.mkdirSync(path.join(pool, 'not-a-repo'));
  });
  afterEach(() => fs.rmSync(pool, { recursive: true, force: true }));

  it('finds the repos one level down, once each, and skips plain directories', () => {
    const found = scanPool([pool, pool]).map((p) => path.basename(p.dir)).sort();
    expect(found).toEqual(['lime-dash', 'site', 'svc-a', 'svc-b']);
  });

  it('puts the address of the same remote group first, with the reason', () => {
    const t = makeRepo(path.join(pool, 'svc-c'), { remote: 'git@gitlab.work:team/svc-c.git' });
    const [first] = rankAuthors(t, scanPool([pool]));
    expect(first).toMatchObject({ email: 'me@work.example', name: 'Me' });
    expect(first!.why.join(' ')).toContain('same group gitlab.work/team: 2');
  });

  it('uses a similar name when there is no remote', () => {
    const t = makeRepo(path.join(pool, 'lime-report'));
    const [first] = rankAuthors(t, scanPool([pool]));
    expect(first).toMatchObject({ email: 'me@lime.example' });
    expect(first!.why.join(' ')).toContain('similar: lime-dash');
  });

  it("counts history only for the pool's addresses — a colleague is never proposed", () => {
    const t = makeRepo(path.join(pool, 'fork'), {
      remote: 'git@github.com:someone/fork.git',
      commitsBy: ['colleague@work.example', 'colleague@work.example', 'me@home.example'],
    });
    const ranked = rankAuthors(t, scanPool([pool]));
    expect(ranked[0]).toMatchObject({ email: 'me@home.example', name: 'Me Home' });
    expect(ranked[0]!.why).toContain('history 1');
    expect(ranked.map((c) => c.email)).not.toContain('colleague@work.example');
  });

  it('proposes nothing when no neighbour has an author', () => {
    const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-empty-')));
    const t = makeRepo(path.join(empty, 'x'));
    expect(rankAuthors(t, scanPool([empty]))).toEqual([]);
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it('writes the author into the repo and git then knows it', () => {
    const t = makeRepo(path.join(pool, 'new'));
    expect(effectiveAuthor(t)).toBeNull();
    expect(writeAuthor(t, { name: 'Me', email: 'me@work.example' })).toBe(true);
    expect(effectiveAuthor(t)).toEqual({ email: 'me@work.example', scope: 'local' });
  });
});
