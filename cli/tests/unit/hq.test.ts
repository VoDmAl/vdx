import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { projectHq } from '../../src/hq.ts';

// www.t23b.org `hq-session-on-hands-project` (2026-11-20): `vdx ai --hq` in a hand started an HQ session that took
// its HQ's sheet. vdx asks the access layer the intercom directory names (hq-session-mode DL #10).
describe('whose HQ a project is: the intercom directory, then its access layer', () => {
  let base: string;
  let store: string;
  let env: NodeJS.ProcessEnv;
  let layer: string;
  let hands: string;
  let hqRoot: string;

  // An entry as intercom writes it — the fields of a real one (m3, `_registry/echelon.json`, 2026-11-20).
  const entry = (identity: string, paths: string[], extra: Record<string, unknown> = {}) => ({
    identity,
    registered: '2026-09-24T17:51:55Z',
    remote: `git@git.example:${identity}.git`,
    remotes: [`git@git.example:${identity}.git`],
    aliases: [],
    names: [identity],
    description: `${identity} for the test`,
    paths,
    updated: '2026-10-05T01:23:30Z',
    ...extra,
  });
  const register = (file: string, e: object) =>
    fs.writeFileSync(path.join(store, '_registry', file), JSON.stringify(e, null, 2) + '\n');
  /** The access layer's command: `hq <root>` answers by the folder's name, as `echelon hq` does by mcp.yaml. */
  const answer = (script: string) =>
    fs.writeFileSync(path.join(layer, 'bin', 'echelon'), `#!/bin/sh\n[ "$1" = hq ] || exit 9\n${script}\n`, {
      mode: 0o755,
    });

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-hq-')));
    store = path.join(base, 'store');
    fs.mkdirSync(path.join(store, '_registry'), { recursive: true });
    env = { VDM_INTERCOM_ROOT: store, PATH: process.env['PATH'] };
    layer = path.join(base, 'echelon');
    hands = path.join(base, 'www.t23b.org');
    hqRoot = path.join(base, 't23b-program');
    for (const d of [path.join(layer, 'bin'), hands, hqRoot]) fs.mkdirSync(d, { recursive: true });
    // The directory lists the harness's own copy first, and a path of the other machine: neither is a checkout here.
    register(
      'echelon.json',
      entry('echelon', [path.join(base, '.claude/plugins/marketplaces/echelon'), '/nowhere/echelon', layer], {
        names: ['echelon', 'эшелон'],
        roles: ['access-layer'],
      }),
    );
    register('t23b-program.json', entry('t23b-program', ['/nowhere/t23b-program', hqRoot]));
    register('www.t23b.org.json', entry('www.t23b.org', [hands]));
    fs.mkdirSync(path.join(base, '.claude/plugins/marketplaces/echelon/bin'), { recursive: true });
    fs.writeFileSync(path.join(base, '.claude/plugins/marketplaces/echelon/bin/echelon'), '#!/bin/sh\necho wrong\n', {
      mode: 0o755,
    });
    answer('case "$2" in */www.t23b.org) echo t23b-program;; esac');
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('a hand: the HQ its access layer names, and that one’s checkout on this machine', () => {
    expect(projectHq(hands, env, base)).toEqual({ kind: 'hand', hq: 't23b-program', root: hqRoot });
    // Its own HQ, or none: echelon answers empty.
    expect(projectHq(hqRoot, env, base)).toEqual({ kind: 'own' });
  });

  it('the HQ is found by any name the directory knows it by, folded as intercom folds names', () => {
    answer('echo "T23B_Program"');
    expect(projectHq(hands, env, base)).toEqual({ kind: 'hand', hq: 'T23B_Program', root: hqRoot });
    answer('echo троп');
    register('t23b-program.json', entry('t23b-program', [hqRoot], { names: ['t23b-program', 'троп'] }));
    expect(projectHq(hands, env, base)).toEqual({ kind: 'hand', hq: 'троп', root: hqRoot });
  });

  it('an HQ with no checkout here, or none in the directory: named, with no root', () => {
    register('t23b-program.json', entry('t23b-program', ['/nowhere/t23b-program']));
    expect(projectHq(hands, env, base)).toEqual({ kind: 'hand', hq: 't23b-program', root: null });
    answer('echo space-hq');
    expect(projectHq(hands, env, base)).toEqual({ kind: 'hand', hq: 'space-hq', root: null });
  });

  it('an answer that names the project itself: its own HQ', () => {
    answer('echo www.t23b.org');
    expect(projectHq(hands, env, base)).toEqual({ kind: 'own' });
  });

  it('a broken config or no answer: unknown, with the reason — the start goes on', () => {
    answer('echo "mcp.yaml: projects.x: bad" >&2; exit 1');
    expect(projectHq(hands, env, base)).toEqual({
      kind: 'unknown',
      note: 'echelon hq could not say whose HQ this project is (mcp.yaml: projects.x: bad) — started as it is',
    });
    answer('sleep 5');
    const slow = projectHq(hands, env, base, 300);
    expect(slow.kind).toBe('unknown');
    expect(slow.kind === 'unknown' && slow.note).toContain('(no answer in 0 s)');
  });

  it('nobody to ask: no store, no holder of the role, two holders, no command — its own HQ, nothing said', () => {
    expect(projectHq(hands, { ...env, VDM_INTERCOM_ROOT: path.join(base, 'none') }, base)).toEqual({ kind: 'own' });
    register('echelon.json', entry('echelon', [layer]));
    expect(projectHq(hands, env, base)).toEqual({ kind: 'own' });
    register('echelon.json', entry('echelon', [layer], { roles: ['access-layer'] }));
    register('other.json', entry('other', [hqRoot], { roles: ['access-layer'] }));
    expect(projectHq(hands, env, base)).toEqual({ kind: 'own' });
    fs.rmSync(path.join(store, '_registry', 'other.json'));
    fs.chmodSync(path.join(layer, 'bin', 'echelon'), 0o644);
    expect(projectHq(hands, env, base)).toEqual({ kind: 'own' });
  });

  it('a Syncthing copy of an entry is not an entry: it makes no second holder', () => {
    register('other.sync-conflict-20261121-010203-ABCDEFG.json', entry('other', [hqRoot], { roles: ['access-layer'] }));
    expect(projectHq(hands, env, base)).toEqual({ kind: 'hand', hq: 't23b-program', root: hqRoot });
  });

  it('the store as intercom finds it: intercom.root in ~/.claude/vdm-plugins.json, a leading ~ the home', () => {
    const moved = path.join(base, 'elsewhere');
    fs.renameSync(store, moved);
    fs.mkdirSync(path.join(base, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(base, '.claude', 'vdm-plugins.json'),
      JSON.stringify({ intercom: { root: '~/elsewhere' } }),
    );
    const noVar = { PATH: process.env['PATH'] };
    expect(projectHq(hands, noVar, base)).toEqual({ kind: 'hand', hq: 't23b-program', root: hqRoot });
    // Without both: ~/.claude/vdm/intercom.
    fs.rmSync(path.join(base, '.claude', 'vdm-plugins.json'));
    fs.mkdirSync(path.join(base, '.claude', 'vdm'), { recursive: true });
    fs.renameSync(moved, path.join(base, '.claude', 'vdm', 'intercom'));
    expect(projectHq(hands, noVar, base)).toEqual({ kind: 'hand', hq: 't23b-program', root: hqRoot });
  });
});
