import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import * as TOML from 'smol-toml';

// The package as npm ships it: `npm pack`, installed into an empty prefix. What the
// unit tests cannot see — a file missing from `files`, a runtime dependency listed
// as a dev one, a launcher that only works inside the clone — breaks here.

const CLI_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(CLI_ROOT, 'tests', 'fixtures');
const PKG = JSON.parse(fs.readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};

let dir: string;
let installed: string;
let bin: (name: string) => string;

function run(name: string, ...args: string[]) {
  return spawnSync(bin(name), args, { encoding: 'utf8', cwd: dir });
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-e2e-'));
  // --ignore-scripts: `prepare` sets core.hooksPath, which is the clone's business, not the pack's.
  const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', dir, '--silent'], {
    cwd: CLI_ROOT,
    encoding: 'utf8',
  });
  expect(pack.status, pack.stderr).toBe(0);
  const tarball = path.join(dir, pack.stdout.trim().split('\n').pop()!);
  const prefix = path.join(dir, 'prefix');
  fs.mkdirSync(prefix);
  const install = spawnSync(
    'npm',
    ['install', '--prefix', prefix, tarball, '--prefer-offline', '--no-audit', '--no-fund', '--silent'],
    { encoding: 'utf8' },
  );
  expect(install.status, install.stderr).toBe(0);
  installed = path.join(prefix, 'node_modules', ...PKG.name.split('/'));
  bin = (name) => path.join(prefix, 'node_modules', '.bin', name);
}, 120_000);

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the packed CLI', () => {
  it('vdx --version is the version in package.json', () => {
    const r = run('vdx', '--version');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(`${PKG.version}\n`);
  });

  it('vdx audit reads the set shipped inside the package', () => {
    const r = run('vdx', 'audit', path.join(FIXTURES, 'node-with-vitest'), '--format=json');
    expect(r.status, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout) as { baseline: string; stack: string; per_axis: { axis_id: string }[] };
    expect(report.baseline).toBe(`file://${path.join(fs.realpathSync(installed), 'rubric', 'vdx-rubric.yaml')}`);
    expect(report.stack).toBe('node');
    expect(report.per_axis.map((a) => a.axis_id)).toContain('lifecycle-interface');
  });

  it('vdx init --dry-run prints a manifest in [_.vdx]', () => {
    const r = run('vdx', 'init', path.join(FIXTURES, 'node-with-vitest'), '--dry-run');
    expect(r.status, r.stderr).toBe(0);
    const toml = /```toml\n([\s\S]*?)\n```/.exec(r.stdout)?.[1] ?? '';
    const parsed = TOML.parse(toml) as { _?: { vdx?: { stack?: string } } };
    expect(parsed._?.vdx?.stack).toBe('node');
  });

  it('vdx-mcp answers over stdio and lists its tools', async () => {
    const child = spawn(bin('vdx-mcp'), [], { cwd: path.join(FIXTURES, 'node-with-vitest') });
    const send = (msg: object) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    const tools = new Promise<string[]>((resolve, reject) => {
      let buf = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const msg = JSON.parse(line) as { id?: number; result?: { tools?: { name: string }[] } };
          if (msg.id === 1) {
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
          }
          if (msg.id === 2) resolve((msg.result?.tools ?? []).map((t) => t.name));
        }
      });
      child.on('error', reject);
      child.on('exit', (code) => reject(new Error(`vdx-mcp exited with ${code}`)));
    });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } },
    });
    try {
      expect(await tools).toEqual(expect.arrayContaining(['list_capabilities', 'vdx_audit', 'vdx_test']));
    } finally {
      child.kill();
    }
  }, 30_000);
});
