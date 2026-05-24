import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LIFECYCLE_VERBS,
  resolveLifecycleVerb,
  renderResolveError,
} from '../../src/run.ts';

describe('LIFECYCLE_VERBS', () => {
  it('exposes the canonical six verbs', () => {
    expect([...LIFECYCLE_VERBS]).toEqual(['up', 'down', 'build', 'test', 'check', 'fix']);
  });
});

describe('resolveLifecycleVerb', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-run-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns no-mise-toml when mise.toml is missing', () => {
    const res = resolveLifecycleVerb(tmp, 'test');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no-mise-toml');
  });

  it('returns parse-error on invalid TOML', () => {
    fs.writeFileSync(path.join(tmp, 'mise.toml'), 'this = is = not = toml\n');
    const res = resolveLifecycleVerb(tmp, 'test');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('parse-error');
      expect(res.detail).toBeTruthy();
    }
  });

  it('returns no-task when mise.toml has no [tasks] section', () => {
    fs.writeFileSync(path.join(tmp, 'mise.toml'), '[tools]\nnode = "20"\n');
    const res = resolveLifecycleVerb(tmp, 'test');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no-task');
  });

  it('returns no-task when requested verb is not in [tasks]', () => {
    fs.writeFileSync(
      path.join(tmp, 'mise.toml'),
      '[tasks.build]\nrun = "echo build"\n',
    );
    const res = resolveLifecycleVerb(tmp, 'test');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no-task');
  });

  it('returns ok with miseTomlPath when verb is defined', () => {
    const miseTomlPath = path.join(tmp, 'mise.toml');
    fs.writeFileSync(miseTomlPath, '[tasks.test]\nrun = "echo test"\n');
    const res = resolveLifecycleVerb(tmp, 'test');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.miseTomlPath).toBe(miseTomlPath);
  });

  it('resolves inline [tasks] table with multiple verbs', () => {
    fs.writeFileSync(
      path.join(tmp, 'mise.toml'),
      [
        '[tasks.build]',
        'run = "npm run build"',
        '',
        '[tasks.test]',
        'run = "npm test"',
        '',
        '[tasks.check]',
        'run = "tsc --noEmit"',
      ].join('\n'),
    );
    for (const v of ['build', 'test', 'check'] as const) {
      const res = resolveLifecycleVerb(tmp, v);
      expect(res.ok, `${v} should resolve`).toBe(true);
    }
    expect(resolveLifecycleVerb(tmp, 'fix').ok).toBe(false);
  });
});

describe('renderResolveError', () => {
  it('formats no-mise-toml with init hint', () => {
    const msg = renderResolveError(
      { ok: false, reason: 'no-mise-toml' },
      '/proj',
      'test',
    );
    expect(msg).toMatch(/no mise\.toml in \/proj/);
    expect(msg).toMatch(/vdx init/);
  });

  it('formats no-task with --force hint', () => {
    const msg = renderResolveError(
      { ok: false, reason: 'no-task' },
      '/proj',
      'build',
    );
    expect(msg).toMatch(/\[tasks\.build\]/);
    expect(msg).toMatch(/--force/);
  });

  it('formats parse-error with the underlying detail', () => {
    const msg = renderResolveError(
      { ok: false, reason: 'parse-error', detail: 'unexpected token at 1:5' },
      '/proj',
      'test',
    );
    expect(msg).toMatch(/failed to parse mise\.toml/);
    expect(msg).toMatch(/unexpected token at 1:5/);
  });
});
