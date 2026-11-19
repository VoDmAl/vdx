import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { awaitReach, reach } from '../../src/reach.ts';

// nas-info `projects-link-mount-race` (2026-11-17): on lft `~/.claude/projects` is a link to
// `/Volumes/Working/claude-projects`, an encrypted volume unlocked at login. A volumes root of the test's own
// stands for `/Volumes`.
describe('a path that leads nowhere until a volume is mounted', () => {
  let dir: string;
  let volumes: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-reach-')));
    volumes = path.join(dir, 'Volumes');
    fs.mkdirSync(volumes);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mount = () => fs.mkdirSync(path.join(volumes, 'Working', 'claude-projects'), { recursive: true });

  it('a link to a volume not mounted waits; mounted, it is there; a link to a deleted place is missing', () => {
    const link = path.join(dir, 'projects');
    fs.symlinkSync(path.join(volumes, 'Working', 'claude-projects'), link);
    expect(reach(link, volumes)).toEqual({
      kind: 'unreachable',
      why: `${link} → ${path.join(volumes, 'Working', 'claude-projects')}: ${path.join(volumes, 'Working')} is not mounted`,
    });
    // A project on the volume, reached through no link.
    expect(reach(path.join(volumes, 'Working', 'ObsidianVault'), volumes).kind).toBe('unreachable');
    mount();
    expect(reach(link, volumes)).toEqual({ kind: 'ok' });
    // Mounted, a folder not on it is gone, not awaited.
    expect(reach(path.join(volumes, 'Working', 'ObsidianVault'), volumes)).toEqual({ kind: 'missing' });

    const gone = path.join(dir, 'gone-link');
    fs.symlinkSync(path.join(dir, 'deleted', 'x'), gone);
    expect(reach(gone, volumes)).toEqual({ kind: 'missing' });
    expect(reach(path.join(dir, 'never'), volumes)).toEqual({ kind: 'missing' });
  });

  it('waits while it leads nowhere, and says so once; never mounted, what is still stuck', () => {
    const link = path.join(dir, 'projects');
    fs.symlinkSync(path.join(volumes, 'Working', 'claude-projects'), link);
    const told: string[][] = [];
    let slept = 0;
    const stuck = awaitReach(
      [link, path.join(dir, 'never')],
      60_000,
      () => {
        if (++slept === 3) mount();
      },
      (s) => told.push(s.map((x) => x.path)),
      volumes,
    );
    expect(stuck).toEqual([]);
    expect(slept).toBe(3);
    expect(told).toEqual([[link]]);

    fs.rmSync(path.join(volumes, 'Working'), { recursive: true });
    slept = 0;
    const still = awaitReach(
      [link],
      10_000,
      () => void slept++,
      () => {},
      volumes,
    );
    expect(still.map((x) => x.path)).toEqual([link]);
    expect(slept).toBe(5);
    // Nothing to wait for: no word, no sleep.
    mount();
    slept = 0;
    expect(
      awaitReach(
        [link],
        10_000,
        () => void slept++,
        () => told.push(['again']),
        volumes,
      ),
    ).toEqual([]);
    expect(slept).toBe(0);
    expect(told).toHaveLength(1);
  });
});
