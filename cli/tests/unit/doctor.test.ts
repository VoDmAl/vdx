import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDoctor, looksLikeProject } from '../../src/doctor.ts';
import {
  reportDoctorMarkdown,
  reportDoctorJson,
  reportDoctorAnsi,
} from '../../src/report.ts';

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
