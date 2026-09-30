import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI_ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(CLI_ROOT, 'bin', 'vdx.cjs');

function vdx(...args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

function vdxEnv(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
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

describe('vdx ai@host', () => {
  it('refuses a host that is not a host name — nothing reaches ssh', () => {
    for (const bad of ['-oProxyCommand=x', '', 'a b']) {
      const r = vdx(`ai@${bad}`, '--dry-run');
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('is not a host name');
    }
  });

  it("runs here when the host is this machine's own label", () => {
    const profile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-cli-')), 'env.yaml');
    fs.writeFileSync(profile, 'schema_version: "0.1"\nagent:\n  command: claude\n');
    const r = vdxEnv({ VDX_HOST: 'zz-self', VDX_ENVIRONMENT: profile }, 'ai@zz-self', CLI_ROOT, '--dry-run');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('vdx ai — ');
    expect(r.stderr).not.toContain('→ zz-self');
  });
});
