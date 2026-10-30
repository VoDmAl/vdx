import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cmuxToken, watchTopic } from '../../src/cmux.ts';
import { remoteAiArgs } from '../../src/ai.ts';

// The cmux topic watcher (focused-topic DL #6), run against fakes of cmux, tmux and ssh.
const SCRIPT = path.resolve(__dirname, '..', '..', 'bin', 'vdx-cmux-topic.cjs');

let dir: string;
let bin: string;
const file = (name: string) => path.join(dir, name);
const calls = () => (fs.existsSync(file('cmux.log')) ? fs.readFileSync(file('cmux.log'), 'utf8') : '');
const snapshot = (description?: string) =>
  fs.writeFileSync(
    file('snapshot.json'),
    JSON.stringify({ windows: [{ workspaces: [{ id: 'WS-1', customTitle: 'x', customDescription: description }] }] }),
  );
const args = (mode: string, extra: string[]) => [
  SCRIPT,
  mode,
  '--workspace',
  'WS-1',
  '--cli',
  path.join(bin, 'cmux'),
  '--state',
  file('state'),
  '--snapshot',
  file('snapshot.json'),
  ...extra,
];
const env = () => ({ PATH: `${bin}:${process.env['PATH']}`, FAKE: dir });
/** A parent for the watcher that is no child of this process: a killed child stays a zombie until Node reaps it. */
const orphan = () => {
  const pid = Number(execFileSync('sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).trim());
  return { pid, kill: () => spawnSync('kill', ['-9', String(pid)]) };
};
const waitFor = (check: () => boolean, ms = 8_000) => {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) spawnSync('sleep', ['0.1']);
  return check();
};

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-cmux-')));
  bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const tool = (name: string, body: string) =>
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  // cmux logs what it is told; tmux and ssh answer the topic from a file.
  tool('cmux', 'printf "%s|" "$@" >> "$FAKE/cmux.log"; echo >> "$FAKE/cmux.log"');
  tool('tmux', 'cat "$FAKE/topic" 2>/dev/null');
  tool('ssh', 'cat "$FAKE/sessions" 2>/dev/null');
  snapshot();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('vdx-cmux-topic.cjs', () => {
  it('watch: sets the topic, Markdown escaped; a new topic replaces it; when the parent ends, clears it', () => {
    fs.writeFileSync(file('topic'), 'release a_b *c* [d]\n');
    const parent = orphan();
    const watcher = spawn(
      process.execPath,
      args('watch', ['--session', 's', '--parent', String(parent.pid), '--every', '100']),
      {
        env: env(),
        stdio: 'ignore',
      },
    );
    try {
      expect(waitFor(() => calls().includes('set-description'))).toBe(true);
      expect(calls()).toContain(
        'workspace-action|--workspace|WS-1|--action|set-description|--description|release a\\_b \\*c\\* \\[d\\]|',
      );
      expect(fs.readFileSync(file('state'), 'utf8')).toBe('release a\\_b \\*c\\* \\[d\\]');
      snapshot('release a\\_b \\*c\\* \\[d\\]');
      fs.writeFileSync(file('topic'), 'docs\n');
      expect(waitFor(() => calls().includes('|docs|'))).toBe(true);
      snapshot('docs');
      parent.kill();
      expect(waitFor(() => calls().includes('clear-description'))).toBe(true);
      expect(waitFor(() => !fs.existsSync(file('state')))).toBe(true);
    } finally {
      parent.kill();
      watcher.kill('SIGKILL');
    }
  }, 20_000);

  it('a description set by hand is never touched — neither set over nor cleared', () => {
    snapshot('my own words');
    fs.writeFileSync(file('topic'), 'release\n');
    spawnSync(process.execPath, args('clear', ['--session', 's']), { env: env() });
    const parent = orphan();
    const watcher = spawn(
      process.execPath,
      args('watch', ['--session', 's', '--parent', String(parent.pid), '--every', '100']),
      {
        env: env(),
        stdio: 'ignore',
      },
    );
    try {
      spawnSync('sleep', ['0.6']);
      expect(calls()).toBe('');
    } finally {
      parent.kill();
      watcher.kill('SIGKILL');
    }
  }, 20_000);

  it('clear: only the description set here, and only while it is still in place', () => {
    fs.writeFileSync(file('state'), 'release');
    snapshot('changed by hand since');
    spawnSync(process.execPath, args('clear', ['--session', 's']), { env: env() });
    expect(calls()).toBe('');
    expect(fs.existsSync(file('state'))).toBe(false);
    fs.writeFileSync(file('state'), 'release');
    snapshot('release');
    spawnSync(process.execPath, args('clear', ['--session', 's']), { env: env() });
    expect(calls()).toBe('workspace-action|--workspace|WS-1|--action|clear-description|\n');
  });

  it('on another machine: the session marked with the token; none marked — it gives up', () => {
    fs.writeFileSync(file('sessions'), '|\nother|nope\ntok1|релиз «0.42»\n');
    const parent = orphan();
    const watcher = spawn(
      process.execPath,
      args('watch', ['--host', 'm3', '--token', 'tok1', '--parent', String(parent.pid), '--every', '100']),
      { env: env(), stdio: 'ignore' },
    );
    try {
      expect(waitFor(() => calls().includes('релиз «0.42»'))).toBe(true);
    } finally {
      parent.kill();
      watcher.kill('SIGKILL');
    }
    const lonely = spawnSync(
      process.execPath,
      args('watch', ['--host', 'm3', '--token', 'absent', '--parent', String(process.pid), '--every', '50']),
      { env: env(), timeout: 5_000 },
    );
    expect(lonely.status).toBe(0);
  }, 20_000);
});

describe('vdx ai in cmux', () => {
  it('outside cmux: no watch and no token', () => {
    expect(watchTopic({}, { session: 's', socket: null }, dir)).toBeNull();
    expect(cmuxToken({})).toBeNull();
    expect(cmuxToken({ CMUX_WORKSPACE_ID: 'WS-1' })).toMatch(/^[0-9a-f]{12}$/);
  });

  it('vdx ai@<host> hands the vdx there the token it marks the session with', () => {
    const base = {
      host: 'm3',
      from: 'lft',
      projectPath: '/h/p',
      home: '/h',
      version: '1.0.0',
      opts: { path: '.', restart: false, fresh: false, detach: false, dryRun: false, focused: true },
      tty: true,
    };
    expect(remoteAiArgs({ ...base, cmuxToken: 'abc123' })[2]).toContain('export VDX_AI_CMUX=abc123; ');
    expect(remoteAiArgs(base)[2]).not.toContain('VDX_AI_CMUX');
  });

  it('watchTopic runs the watcher with this workspace and stops it with a clear', () => {
    fs.writeFileSync(file('topic'), 'release\n');
    const home = path.join(dir, 'home');
    const snap = path.join(home, 'Library', 'Application Support', 'cmux', 'session-com.cmuxterm.app.json');
    fs.mkdirSync(path.dirname(snap), { recursive: true });
    fs.writeFileSync(snap, JSON.stringify({ workspaces: [{ id: 'WS-9' }] }));
    const watch = watchTopic(
      { ...env(), CMUX_WORKSPACE_ID: 'WS-9', CMUX_BUNDLED_CLI_PATH: path.join(bin, 'cmux') },
      { session: 's', socket: null },
      home,
    );
    expect(watch).not.toBeNull();
    expect(waitFor(() => calls().includes('--workspace|WS-9|--action|set-description|--description|release|'))).toBe(
      true,
    );
    watch!.stop();
    expect(calls()).toContain('--workspace|WS-9|--action|clear-description|');
    expect(execFileSync('ls', [path.join(home, '.cache', 'vdx', 'cmux')], { encoding: 'utf8' })).toBe('');
  }, 20_000);
});
