import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI_ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(CLI_ROOT, 'bin', 'vdx.cjs');

function vdx(...args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

describe('vdx --version', () => {
  it('prints the package version to stdout and exits 0', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf8'));
    const r = vdx('--version');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${pkg.version}\n`);
    expect(r.stderr).toBe('');
  });

  it('is listed in the usage', () => {
    const r = vdx();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('vdx --version');
  });
});
