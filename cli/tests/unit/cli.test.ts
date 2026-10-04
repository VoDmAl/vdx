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

describe('vdx ai --help and unknown options', () => {
  // A profile whose agent would start for real: without a terminal runAi refuses
  // with "no terminal", so a run that should not have happened shows up as that.
  const env = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-cli-'));
    const profile = path.join(dir, 'env.yaml');
    fs.writeFileSync(profile, 'schema_version: "0.1"\nagent:\n  command: claude\n');
    return { VDX_HOST: 'zz-self', VDX_ENVIRONMENT: profile };
  };

  it('prints the help and exits 0, for --help and -h, starting nothing', () => {
    for (const args of [['--help'], ['-h'], [CLI_ROOT, '--help'], ['--dry-run', '-h']]) {
      const r = vdxEnv(env(), 'ai', ...args);
      expect(r.status, args.join(' ')).toBe(0);
      expect(r.stdout).toContain('Usage: vdx ai[@host]');
      expect(r.stdout).toContain('agent.when[]');
      expect(r.stdout).not.toContain('vdx ai — ');
      expect(r.stderr).toBe('');
    }
  });

  it('answers --help here, for any @host — nothing reaches ssh', () => {
    const r = vdxEnv(env(), 'ai@zz-elsewhere', '--help');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: vdx ai[@host]');
    expect(r.stderr).toBe('');
  });

  it('refuses an unknown option before the plan, even with --dry-run', () => {
    // After a bare flag, parseArgs takes `-x` for that flag's value.
    for (const bad of ['--hlep', '-x', '--version']) {
      for (const args of [[bad, '--dry-run'], ['--dry-run', bad]]) {
        const r = vdxEnv(env(), 'ai', CLI_ROOT, ...args);
        expect(r.status, args.join(' ')).toBe(2);
        expect(r.stderr).toContain(`unknown option ${bad}`);
        expect(r.stderr).toContain('vdx ai --help');
        expect(r.stdout).toBe('');
      }
    }
  });

  it('refuses a second path instead of dropping it', () => {
    const r = vdxEnv(env(), 'ai', CLI_ROOT, os.tmpdir(), '--dry-run');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`unexpected argument ${os.tmpdir()}`);
    expect(r.stdout).toBe('');
  });

  it('still accepts --resume, a no-op since 0.13', () => {
    const r = vdxEnv(env(), 'ai', CLI_ROOT, '--resume', '--dry-run');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('vdx ai — ');
  });

  it('is named in the usage', () => {
    expect(vdx().stderr).toContain('vdx ai --help');
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
