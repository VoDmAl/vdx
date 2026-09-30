import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkGitAuthor, runDoctor, resolveDoctorCtx, looksLikeProject } from '../../src/doctor.ts';
import {
  reportDoctorMarkdown,
  reportDoctorJson,
  reportDoctorAnsi,
} from '../../src/report.ts';

// The machine's own profile would make the author check scan the owner's repos.
const savedProfile = process.env['VDX_ENVIRONMENT'];
beforeAll(() => {
  process.env['VDX_ENVIRONMENT'] = path.join(os.tmpdir(), 'vdx-doctor-test-no-profile.yaml');
});
afterAll(() => {
  if (savedProfile === undefined) delete process.env['VDX_ENVIRONMENT'];
  else process.env['VDX_ENVIRONMENT'] = savedProfile;
});

describe('runDoctor', () => {
  it('returns a report with checks array and counters that sum correctly', () => {
    const r = runDoctor();
    expect(Array.isArray(r.checks)).toBe(true);
    expect(r.checks.length).toBeGreaterThanOrEqual(5);
    expect(r.ok + r.warning + r.missing).toBe(r.checks.length);
  });

  it('every check has stable shape (id, label, status, message)', () => {
    const r = runDoctor();
    for (const c of r.checks) {
      expect(typeof c.id).toBe('string');
      expect(typeof c.label).toBe('string');
      expect(['ok', 'warning', 'missing']).toContain(c.status);
      expect(typeof c.message).toBe('string');
    }
  });

  it('node check always runs and has a result (we are inside node)', () => {
    const r = runDoctor();
    const node = r.checks.find((c) => c.id === 'node');
    expect(node).toBeDefined();
    expect(node!.status).toBe('ok');
  });

  it('vdx-version is the first check', () => {
    const r = runDoctor();
    expect(r.checks[0]!.id).toBe('vdx-version');
  });

  it('priority order: vdx-version, vdx, claude-code, claude-plugin appear before env checks', () => {
    const r = runDoctor();
    const ids = r.checks.map((c) => c.id);
    const idxVersion = ids.indexOf('vdx-version');
    const idxVdx = ids.indexOf('vdx');
    const idxClaude = ids.indexOf('claude-code');
    const idxPlugin = ids.indexOf('claude-plugin');
    const idxNode = ids.indexOf('node');
    expect(idxVersion).toBeLessThan(idxVdx);
    expect(idxVdx).toBeLessThan(idxClaude);
    expect(idxClaude).toBeLessThan(idxPlugin);
    expect(idxPlugin).toBeLessThan(idxNode);
  });

  it('legacy duplicate rows (vdx-on-path, vdx-in-shell) are gone', () => {
    const r = runDoctor();
    const ids = r.checks.map((c) => c.id);
    expect(ids).not.toContain('vdx-on-path');
    expect(ids).not.toContain('vdx-in-shell');
  });
});

describe('resolveDoctorCtx', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-doctor-ctx-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('projectRoot is null outside a project', () => {
    expect(resolveDoctorCtx(tmp).projectRoot).toBeNull();
  });

  it('projectRoot is the cwd when it looks like a project', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
    expect(resolveDoctorCtx(tmp).projectRoot).toBe(tmp);
  });

  it('defaults to process.cwd() — we run inside the cli package', () => {
    expect(resolveDoctorCtx().projectRoot).toBe(process.cwd());
  });
});

describe('runDoctor with explicit ctx', () => {
  it('accepts a ctx and still produces a well-formed report', () => {
    const r = runDoctor({ projectRoot: null });
    expect(r.ok + r.warning + r.missing).toBe(r.checks.length);
  });

  it('machine-level checks are unaffected by projectRoot', () => {
    const projectScoped = new Set(['git-hooks', 'git-author']);
    const machine = (ids: string[]) => ids.filter((id) => !projectScoped.has(id));
    const withRoot = runDoctor({ projectRoot: process.cwd() });
    const without = runDoctor({ projectRoot: null });
    expect(machine(withRoot.checks.map((c) => c.id))).toEqual(machine(without.checks.map((c) => c.id)));
    expect(without.checks.map((c) => c.id)).not.toContain('git-author');
  }, 30_000);

  it('names the commit author of a repo, or the likely one with a command', () => {
    const saved = { g: process.env['GIT_CONFIG_GLOBAL'], s: process.env['GIT_CONFIG_NOSYSTEM'], e: process.env['VDX_ENVIRONMENT'] };
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-doctor-author-')));
    fs.writeFileSync(path.join(dir, 'gitconfig'), '');
    process.env['GIT_CONFIG_GLOBAL'] = path.join(dir, 'gitconfig');
    process.env['GIT_CONFIG_NOSYSTEM'] = '1';
    process.env['VDX_ENVIRONMENT'] = path.join(dir, 'no-profile.yaml');
    try {
      const repo = (name: string, email?: string) => {
        const d = path.join(dir, name);
        fs.mkdirSync(d);
        execFileSync('git', ['-C', d, 'init', '-q']);
        execFileSync('git', ['-C', d, 'remote', 'add', 'origin', `git@gitlab.work:team/${name}.git`]);
        if (email) execFileSync('git', ['-C', d, 'config', '--local', 'user.email', email]);
        return d;
      };
      const has = repo('svc-a', 'me@work.example');
      const none = repo('svc-b');
      const row = (root: string) => checkGitAuthor({ projectRoot: root });
      expect(row(has)).toMatchObject({ status: 'ok', message: 'me@work.example (local)' });
      expect(row(none)).toMatchObject({ status: 'warning' });
      expect(row(none)!.message).toContain('likely me@work.example');
      expect(row(none)!.remedy).toContain('config --local user.email me@work.example');
    } finally {
      for (const [k, v] of [['GIT_CONFIG_GLOBAL', saved.g], ['GIT_CONFIG_NOSYSTEM', saved.s], ['VDX_ENVIRONMENT', saved.e]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('looksLikeProject', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-doctor-test-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('returns false for an empty directory (like $HOME without markers)', () => {
    expect(looksLikeProject(tmp)).toBe(false);
  });

  it('returns true when package.json is present', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
    expect(looksLikeProject(tmp)).toBe(true);
  });

  it('returns true when .git directory is present', () => {
    fs.mkdirSync(path.join(tmp, '.git'));
    expect(looksLikeProject(tmp)).toBe(true);
  });

  it('returns true for composer.json / pyproject.toml / Makefile / mise.toml / Cargo.toml / go.mod', () => {
    for (const marker of [
      'composer.json',
      'pyproject.toml',
      'Makefile',
      'mise.toml',
      'Cargo.toml',
      'go.mod',
    ]) {
      const sub = fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-doctor-marker-'));
      fs.writeFileSync(path.join(sub, marker), '');
      expect(looksLikeProject(sub), `marker: ${marker}`).toBe(true);
      fs.rmSync(sub, { recursive: true, force: true });
    }
  });
});

describe('reportDoctor formatters', () => {
  it('markdown contains header + table + counter row', () => {
    const r = runDoctor();
    const out = reportDoctorMarkdown(r);
    expect(out).toContain('# vdx doctor report');
    expect(out).toContain('| Check | Status | Detail | Remedy |');
    expect(out).toContain('**OK**:');
  });

  it('json parses with checks array', () => {
    const r = runDoctor();
    const parsed = JSON.parse(reportDoctorJson(r));
    expect(parsed.checks.length).toBe(r.checks.length);
  });

  it('ansi contains escape codes under FORCE_COLOR', () => {
    const prev = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = '1';
    try {
      const out = reportDoctorAnsi(runDoctor());
      expect(out).toMatch(/\x1b\[/);
    } finally {
      if (prev === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = prev;
    }
  });
});

describe('checkGitHooks (via runDoctor)', () => {
  let tmp: string;
  const row = (root: string) =>
    runDoctor({ projectRoot: root }).checks.find((c) => c.id === 'git-hooks');

  const git = (root: string, ...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-hooks-')));
    execFileSync('git', ['init', '-q', tmp], { stdio: 'ignore' });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const writeHook = (dir: string, name: string, body: string) => {
    fs.mkdirSync(path.join(tmp, dir), { recursive: true });
    const f = path.join(tmp, dir, name);
    fs.writeFileSync(f, body);
    fs.chmodSync(f, 0o755);
  };

  it('omits the row when the repo declares no hooks', () => {
    expect(row(tmp)).toBeUndefined();
  });

  it('omits the row outside a project', () => {
    expect(runDoctor({ projectRoot: null }).checks.find((c) => c.id === 'git-hooks')).toBeUndefined();
  });

  it('RED: hook files present but core.hooksPath unset — hooks never run', () => {
    writeHook('.githooks', 'pre-commit', '#!/bin/bash\nexit 0\n');
    const r = row(tmp);
    expect(r?.status).toBe('warning');
    expect(r?.message).toContain('core.hooksPath is unset');
  });

  it('RED: core.hooksPath points at a directory that does not exist', () => {
    git(tmp, 'config', 'core.hooksPath', '.githooks');
    const r = row(tmp);
    expect(r?.status).toBe('missing');
  });

  it('RED: hooksPath set but nothing executable in it', () => {
    fs.mkdirSync(path.join(tmp, '.githooks'));
    fs.writeFileSync(path.join(tmp, '.githooks', 'pre-commit'), '#!/bin/bash\n');
    fs.chmodSync(path.join(tmp, '.githooks', 'pre-commit'), 0o644);
    git(tmp, 'config', 'core.hooksPath', '.githooks');
    expect(row(tmp)?.status).toBe('warning');
  });

  it('RED: hook gated on an unset variable is a no-op that looks installed', () => {
    // The documented vdm activation snippet, verbatim in shape.
    writeHook(
      '.githooks',
      'pre-commit',
      '#!/bin/bash\n[ -n "${VDX_TEST_GATE:-}" ] && [ -x "$VDX_TEST_GATE" ] && { "$VDX_TEST_GATE" || exit 1; }\n',
    );
    git(tmp, 'config', 'core.hooksPath', '.githooks');
    delete process.env.VDX_TEST_GATE;
    const r = row(tmp);
    expect(r?.status).toBe('warning');
    expect(r?.message).toContain('VDX_TEST_GATE');
  });

  it('GREEN: same hook goes ok once the variable resolves', () => {
    writeHook(
      '.githooks',
      'pre-commit',
      '#!/bin/bash\n[ -n "${VDX_TEST_GATE:-}" ] && [ -x "$VDX_TEST_GATE" ] && { "$VDX_TEST_GATE" || exit 1; }\n',
    );
    git(tmp, 'config', 'core.hooksPath', '.githooks');
    process.env.VDX_TEST_GATE = '/bin/true';
    try {
      const r = row(tmp);
      expect(r?.status).toBe('ok');
      expect(r?.message).toContain('active via .githooks');
    } finally {
      delete process.env.VDX_TEST_GATE;
    }
  });

  it('does not flag a hook that merely mentions a variable outside a test', () => {
    writeHook('.githooks', 'pre-commit', '#!/bin/bash\necho "run $HOME/x"\nexit 0\n');
    git(tmp, 'config', 'core.hooksPath', '.githooks');
    expect(row(tmp)?.status).toBe('ok');
  });
});
