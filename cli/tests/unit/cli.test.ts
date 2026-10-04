import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

});

describe('every command: --help, unknown options, stray arguments', () => {
  const COMMANDS = ['audit', 'init', 'publish', 'doctor', 'ai', 'up', 'down', 'build', 'test', 'check', 'fix'];
  // A project init would write mise.toml for and a verb would run in: if an
  // argument is misread, the command shows up as a file or as a mise run.
  let dir: string;
  const inDir = (...args: string[]) =>
    spawnSync(process.execPath, [BIN, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, VDX_ENVIRONMENT: path.join(dir, 'none.yaml') },
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-cli-cmd-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"p","scripts":{"test":"echo hi"}}\n');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('vdx --help, -h and help print the usage to stdout and exit 0', () => {
    for (const flag of ['--help', '-h', 'help']) {
      const r = inDir(flag);
      expect(r.status, flag).toBe(0);
      expect(r.stdout).toContain('vdx <command> --help');
      expect(r.stderr).toBe('');
    }
  });

  it('names an unknown command', () => {
    const r = inDir('tset');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown command "tset"');
  });

  it('<command> --help prints its usage and runs nothing', () => {
    for (const cmd of COMMANDS) {
      for (const flag of ['--help', '-h']) {
        const r = inDir(cmd, flag);
        expect(r.status, `${cmd} ${flag}`).toBe(0);
        expect(r.stdout.startsWith(`Usage: vdx ${cmd}`), `${cmd} ${flag}`).toBe(true);
        expect(r.stderr, `${cmd} ${flag}`).toBe('');
      }
    }
    expect(fs.existsSync(path.join(dir, 'mise.toml'))).toBe(false);
  });

  it('<command> refuses an unknown option with exit 2 and runs nothing', () => {
    for (const cmd of COMMANDS) {
      const r = inDir(cmd, '--hlep');
      expect(r.status, cmd).toBe(2);
      expect(r.stderr, cmd).toContain(`vdx ${cmd}: unknown option --hlep`);
      expect(r.stderr, cmd).toContain(`vdx ${cmd} --help`);
      expect(r.stdout, cmd).toBe('');
    }
    expect(fs.existsSync(path.join(dir, 'mise.toml'))).toBe(false);
  });

  it('refuses a stray argument and a value flag without its value', () => {
    for (const [args, message] of [
      [['doctor', 'extra'], 'unexpected argument extra'],
      [['down', 'extra'], 'unexpected argument extra'],
      [['init', '.', 'extra'], 'unexpected argument extra'],
      [['audit', '--stack'], '--stack needs a value'],
      [['init', '--baseline', '--dry-run'], '--baseline needs a value'],
    ] as const) {
      const r = inDir(...args);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr).toContain(message);
    }
    expect(fs.existsSync(path.join(dir, 'mise.toml'))).toBe(false);
  });

  it('gives back the path after a flag that takes no value', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-cli-other-'));
    fs.writeFileSync(path.join(other, 'package.json'), '{"name":"other"}\n');
    const r = inDir('init', '--force', other);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(other, 'mise.toml'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'mise.toml'))).toBe(false);
    fs.rmSync(other, { recursive: true, force: true });
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
