import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionLag } from '../../src/session-versions.ts';

// Shapes of Claude Code's own files on lft, 2026-10-21: sessions/<pid>.json,
// plugins/installed_plugins.json (version 2), settings.json enabledPlugins, and the
// transcript line /reload-plugins leaves (vdx-ai, Sidetrack #24).
const SID = '04a89426-701e-42c5-8367-e63f5a75734d';
const STARTED = Date.parse('2026-10-20T23:14:34Z');

let config: string;
let root: string;

function write(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
}

function session(version = '2.1.304'): void {
  write(path.join(config, 'sessions', '96057.json'), { pid: 96057, sessionId: SID, startedAt: STARTED, version });
}

function plugin(key: string, version: string, lastUpdated: string, extra: Record<string, unknown> = {}) {
  return [{ scope: 'user', installPath: `/cache/${key}/${version}`, version, lastUpdated, ...extra }];
}

function installed(plugins: Record<string, unknown>): void {
  write(path.join(config, 'plugins', 'installed_plugins.json'), { version: 2, plugins });
}

function enabled(file: string, map: Record<string, boolean>): void {
  write(file, { enabledPlugins: map });
}

function reloadAt(when: string, dir = root.replace(/[^A-Za-z0-9]/g, '-')): void {
  const lines = [
    { type: 'user', message: { role: 'user', content: '<command-name>/reload-plugins</command-name>' } },
    {
      type: 'system',
      subtype: 'local_command',
      content: '<local-command-stdout>Reloaded: 18 plugins · 66 skills · 21 agents · 47 hooks</local-command-stdout>',
      timestamp: when,
    },
  ];
  write(path.join(config, 'projects', dir, `${SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

const DAY = 24 * 60 * 60 * 1000;

const lag = (claude: string | null = '2.1.304 (Claude Code)', now = STARTED + 2 * DAY) =>
  sessionLag({
    env: { CLAUDE_CONFIG_DIR: config },
    home: '/nowhere',
    pid: 96057,
    projectRoot: root,
    installedClaude: () => claude,
    now,
  });

beforeEach(() => {
  config = fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-lag-config-'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-lag-root-'));
});
afterEach(() => {
  fs.rmSync(config, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

describe('sessionLag: Claude Code', () => {
  it('no session file — nothing to say', () => {
    expect(lag()).toBeNull();
  });
  it('the session runs an older Claude Code than the installed one', () => {
    session('2.1.294');
    expect(lag()).toEqual({ claude: { runs: '2.1.294', installed: '2.1.304' }, plugins: [] });
  });
  it('the same or a newer one, or no answer from claude — not behind', () => {
    session('2.1.304');
    expect(lag()).toBeNull();
    session('2.1.310');
    expect(lag()).toBeNull();
    session('2.1.294');
    expect(lag(null)).toBeNull();
  });
  it('a session younger than a day is not called behind yet — an update may be minutes old', () => {
    session('2.1.294');
    expect(lag(undefined, STARTED + DAY - 60_000)).toBeNull();
    expect(lag(undefined, STARTED + DAY)?.claude).toEqual({ runs: '2.1.294', installed: '2.1.304' });
  });
});

describe('sessionLag: plugins', () => {
  beforeEach(() => session());

  it('an enabled plugin updated after the session started — named with its installed version', () => {
    installed({
      'vdm@market': plugin('vdm', '2.54.0', '2026-10-20T23:18:54.305Z'),
      'echelon@echelon': plugin('echelon', '0.6.0', '2026-10-21T19:23:15.786Z'),
      'vdx@market': plugin('vdx', '0.9.3', '2026-10-15T19:45:11.283Z'),
    });
    enabled(path.join(config, 'settings.json'), { 'vdm@market': true, 'echelon@echelon': true, 'vdx@market': true });
    expect(lag()).toEqual({
      claude: null,
      plugins: [
        { name: 'vdm', version: '2.54.0' },
        { name: 'echelon', version: '0.6.0' },
      ],
    });
  });
  it('a disabled or never enabled plugin counts for nothing', () => {
    installed({
      'off@m': plugin('off', '1.0.0', '2026-10-21T10:00:00Z'),
      'unnamed@m': plugin('unnamed', '1.0.0', '2026-10-21T10:00:00Z'),
    });
    enabled(path.join(config, 'settings.json'), { 'off@m': false });
    expect(lag()).toBeNull();
  });
  it("the project's settings decide over the user's — the nearest that names it", () => {
    installed({
      'proj@m': plugin('proj', '1.0.0', '2026-10-21T10:00:00Z'),
      'muted@m': plugin('muted', '1.0.0', '2026-10-21T10:00:00Z'),
    });
    enabled(path.join(config, 'settings.json'), { 'muted@m': true });
    enabled(path.join(root, '.claude', 'settings.json'), { 'proj@m': true });
    enabled(path.join(root, '.claude', 'settings.local.json'), { 'muted@m': false });
    expect(lag()?.plugins).toEqual([{ name: 'proj', version: '1.0.0' }]);
  });
  it("another project's installation is not this session's", () => {
    installed({
      'p@m': [{ scope: 'project', projectPath: '/elsewhere', version: '1.0.0', lastUpdated: '2026-10-21T10:00:00Z' }],
    });
    enabled(path.join(config, 'settings.json'), { 'p@m': true });
    expect(lag()).toBeNull();
  });
  it('/reload-plugins after the update loaded it; one before the update did not', () => {
    installed({ 'vdm@market': plugin('vdm', '2.54.0', '2026-10-20T23:18:54.305Z') });
    enabled(path.join(config, 'settings.json'), { 'vdm@market': true });
    reloadAt('2026-10-21T01:00:00.000Z');
    expect(lag()).toBeNull();
    reloadAt('2026-10-20T23:16:00.000Z');
    expect(lag()?.plugins).toEqual([{ name: 'vdm', version: '2.54.0' }]);
  });
  it('a /reload-plugins less than a day ago: quiet, though a plugin came out after it', () => {
    installed({ 'echelon@echelon': plugin('echelon', '0.6.2', '2026-10-22T20:00:00.000Z') });
    enabled(path.join(config, 'settings.json'), { 'echelon@echelon': true });
    reloadAt('2026-10-22T12:00:00.000Z');
    expect(lag()).toBeNull();
    expect(lag(undefined, Date.parse('2026-10-23T12:00:00.000Z'))?.plugins).toEqual([
      { name: 'echelon', version: '0.6.2' },
    ]);
  });
  it('the transcript is found under another project directory too', () => {
    installed({ 'vdm@market': plugin('vdm', '2.54.0', '2026-10-20T23:18:54.305Z') });
    enabled(path.join(config, 'settings.json'), { 'vdm@market': true });
    reloadAt('2026-10-21T01:00:00.000Z', '-Users-someone-else');
    expect(lag()).toBeNull();
  });
  it('a "Reloaded:" quoted by the conversation is not a reload', () => {
    installed({ 'vdm@market': plugin('vdm', '2.54.0', '2026-10-20T23:18:54.305Z') });
    enabled(path.join(config, 'settings.json'), { 'vdm@market': true });
    const quoted = {
      type: 'user',
      message: { role: 'user', content: 'it leaves "local_command" with <local-command-stdout>Reloaded: …' },
      timestamp: '2026-10-21T01:00:00.000Z',
    };
    write(
      path.join(config, 'projects', root.replace(/[^A-Za-z0-9]/g, '-'), `${SID}.jsonl`),
      JSON.stringify(quoted) + '\n',
    );
    expect(lag()?.plugins).toEqual([{ name: 'vdm', version: '2.54.0' }]);
  });
});
