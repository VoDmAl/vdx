import * as fs from 'node:fs';
import * as path from 'node:path';
import * as TOML from 'smol-toml';
import YAML from 'js-yaml';
import { at, dict, type Dict } from './narrow.ts';

export interface VdxManifest {
  schema_version?: string;
  /** Short name people use for the project (a session name, a sidebar); defaults to the repository name. */
  name?: string;
  baseline?: string;
  stack?: string;
  primary_language?: string;
  primary_subpackage?: string;
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

/**
 * Where the manifest lives in mise.toml. `[_.vdx]` — mise documents the `[_]` table as never
 * read, for other tools' data. `[vdx]` — where it lived before vdx 0.26; still read, but mise
 * 2026.10 warns about an unknown field on every run.
 */
export type ManifestPlace = '_.vdx' | 'vdx';

/** The manifest table of a parsed mise.toml and its place: `[_.vdx]`, else the older `[vdx]`. */
export function manifestTable(data: unknown): { table: Dict; place: ManifestPlace } | null {
  const table = dict(at(data, '_', 'vdx'));
  if (table) return { table, place: '_.vdx' };
  const older = dict(at(data, 'vdx'));
  return older ? { table: older, place: 'vdx' } : null;
}

/** The project's manifest and where in its mise.toml it was found. */
export function loadManifestAt(projectRoot: string): { manifest: VdxManifest; place: ManifestPlace } | null {
  const miseToml = path.join(projectRoot, 'mise.toml');
  if (!fs.existsSync(miseToml)) return null;
  try {
    const found = manifestTable(TOML.parse(fs.readFileSync(miseToml, 'utf8')));
    // The fields are the project's to write; readers check what they use.
    return found ? { manifest: found.table, place: found.place } : null;
  } catch {
    return null;
  }
}

export function loadManifest(projectRoot: string): VdxManifest | null {
  return loadManifestAt(projectRoot)?.manifest ?? null;
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
