import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadManifest, loadManifestAt } from '../../src/manifest.ts';

describe('the manifest in mise.toml: [_.vdx], else the older [vdx]', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const project = (miseToml: string | null) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-manifest-'));
    if (miseToml !== null) fs.writeFileSync(path.join(dir, 'mise.toml'), miseToml);
    return dir;
  };

  it('reads [_.vdx], the table mise leaves alone', () => {
    const root = project(
      '[tasks.test]\nrun = "true"\n\n[_.vdx]\nstack = "node"\n\n[_.vdx.shared_infra]\nprecheck = true\n',
    );
    expect(loadManifestAt(root)).toEqual({
      manifest: { stack: 'node', shared_infra: { precheck: true } },
      place: '_.vdx',
    });
  });

  it('still reads [vdx], where vdx before 0.26 wrote it', () => {
    const root = project('[vdx]\nstack = "php"\n');
    expect(loadManifestAt(root)).toEqual({ manifest: { stack: 'php' }, place: 'vdx' });
  });

  it('takes [_.vdx] when both are there', () => {
    const root = project('[vdx]\nstack = "php"\n\n[_.vdx]\nstack = "node"\n');
    expect(loadManifest(root)?.stack).toBe('node');
  });

  it('has none without either, without a mise.toml, or with one that does not parse', () => {
    expect(loadManifest(project('[tasks.test]\nrun = "true"\n\n[_]\nother = 1\n'))).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
    expect(loadManifest(project(null))).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
    expect(loadManifest(project('[vdx\n'))).toBeNull();
  });
});
