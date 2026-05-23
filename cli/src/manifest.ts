import * as fs from 'node:fs';
import * as path from 'node:path';
import * as TOML from 'smol-toml';
import YAML from 'js-yaml';

export interface VdxManifest {
  schema_version?: string;
  baseline?: string;
  stack?: string;
  primary_language?: string;
  verbs?: string[];
  shared_infra?: {
    provider?: string;
    precheck?: boolean;
    healthcheck_url?: string;
  };
  success_path?: Record<string, unknown>;
  audit?: Record<string, unknown>;
}

export interface Override {
  axis: string;
  target?: string;
  suppress?: boolean;
  reason: string;
  until?: string;
}

export function loadManifest(projectRoot: string): VdxManifest | null {
  const miseToml = path.join(projectRoot, 'mise.toml');
  if (!fs.existsSync(miseToml)) return null;
  try {
    const text = fs.readFileSync(miseToml, 'utf8');
    const data = TOML.parse(text) as { vdx?: VdxManifest };
    return data?.vdx ?? null;
  } catch {
    return null;
  }
}

export function loadOverrides(projectRoot: string): Override[] {
  const file = path.join(projectRoot, '.vdx-overrides.yml');
  if (!fs.existsSync(file)) return [];
  try {
    const text = fs.readFileSync(file, 'utf8');
    const data = YAML.load(text) as { overrides?: Override[] };
    return data?.overrides ?? [];
  } catch {
    return [];
  }
}
