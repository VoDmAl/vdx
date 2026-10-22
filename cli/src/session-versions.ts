import * as fs from 'node:fs';
import * as path from 'node:path';
import { claudeConfigDir, projectDirName } from './conversations.ts';
import { at, dict, list, str } from './narrow.ts';

/**
 * What a running Claude Code session lags behind: a live session keeps the
 * Claude Code and the plugins it started with, and takes new ones only when it
 * starts again or by `/reload-plugins` (docs/tasks/vdx-ai, Sidetrack #24).
 * Read from Claude Code's own files — its session file, `installed_plugins.json`,
 * the settings that enable a plugin, the transcript — which are its internals,
 * not an API.
 */
export interface Lag {
  /** Claude Code: the version the session runs and the one installed now; null when they agree. */
  claude: { runs: string; installed: string } | null;
  /** Enabled plugins updated after the session loaded its plugins: their name and the installed version. */
  plugins: Array<{ name: string; version: string }>;
}

export interface LagInput {
  env: NodeJS.ProcessEnv;
  home: string;
  /** The session's Claude Code process. */
  pid: number;
  projectRoot: string;
  /** `claude --version` of the Claude Code a new start would run; null when it does not answer. */
  installedClaude: () => string | null;
  /** Default `Date.now()`. */
  now?: number;
}

/**
 * How long what a session loaded may stand before newer counts as a lag. On
 * 2026-10-21 all 14 live sessions on lft were behind, an echelon release minutes
 * old among them; the harm is a session that runs old code for days (twelve, in
 * ai-dev-plugins' count). A day lets an update arrive without every session's
 * next compaction calling for a reload.
 */
const LAG_AFTER_MS = 24 * 60 * 60 * 1000;

/** What the session lags behind; null when nothing — or when its session file is not here to say. */
export function sessionLag(input: LagInput): Lag | null {
  const now = input.now ?? Date.now();
  const config = claudeConfigDir(input.env, input.home);
  const session = readJson(path.join(config, 'sessions', `${input.pid}.json`));
  const startedAt = at(session, 'startedAt');
  if (typeof startedAt !== 'number' || now - startedAt < LAG_AFTER_MS) return null;

  const runs = str(at(session, 'version'));
  const installed = versionOf(input.installedClaude());
  const claude = runs && installed && newer(installed, runs) ? { runs, installed } : null;

  let plugins = updatedPlugins(config, input.projectRoot).filter((p) => p.at > startedAt);
  if (plugins.length > 0) {
    // A /reload-plugins loaded what was installed then: the transcript keeps when (its "Reloaded: …" line).
    const sessionId = str(at(session, 'sessionId'));
    const reloaded = sessionId ? lastReload(config, input.projectRoot, sessionId) : null;
    if (reloaded !== null) plugins = now - reloaded < LAG_AFTER_MS ? [] : plugins.filter((p) => p.at > reloaded);
  }
  if (!claude && plugins.length === 0) return null;
  return { claude, plugins: plugins.map(({ name, version }) => ({ name, version })) };
}

/** Enabled plugins and when each was last updated (ms) — the user's and this project's. */
function updatedPlugins(config: string, projectRoot: string): Array<{ name: string; version: string; at: number }> {
  const records = dict(at(readJson(path.join(config, 'plugins', 'installed_plugins.json')), 'plugins')) ?? {};
  // The nearest settings that name a plugin decide: the project's local, the project's, the user's.
  const layers = [
    path.join(projectRoot, '.claude', 'settings.local.json'),
    path.join(projectRoot, '.claude', 'settings.json'),
    path.join(config, 'settings.json'),
  ].map((f) => dict(at(readJson(f), 'enabledPlugins')) ?? {});
  const out: Array<{ name: string; version: string; at: number }> = [];
  for (const [key, entries] of Object.entries(records)) {
    if (layers.map((l) => l[key]).find((v) => typeof v === 'boolean') !== true) continue;
    const entry = list(entries).find((e) => at(e, 'scope') === 'user' || at(e, 'projectPath') === projectRoot);
    const when = Date.parse(str(at(entry, 'lastUpdated')) ?? '');
    const version = str(at(entry, 'version'));
    if (Number.isNaN(when) || !version) continue;
    out.push({ name: key.split('@')[0] ?? key, version, at: when });
  }
  return out;
}

/** When the session last ran /reload-plugins (ms), from its transcript; null — never, or no transcript here. */
function lastReload(config: string, projectRoot: string, sessionId: string): number | null {
  const projects = path.join(config, 'projects');
  let file = path.join(projects, projectDirName(projectRoot), `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) {
    // The transcript sits under the directory the session started in, which may be another.
    const dir = safeReaddir(projects).find((d) => fs.existsSync(path.join(projects, d, `${sessionId}.jsonl`)));
    if (dir === undefined) return null;
    file = path.join(projects, dir, `${sessionId}.jsonl`);
  }
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let last: number | null = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"local_command"') || !line.includes('Reloaded:')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (at(entry, 'type') !== 'system' || at(entry, 'subtype') !== 'local_command') continue;
    if (!/<local-command-stdout>Reloaded:/.test(str(at(entry, 'content')) ?? '')) continue;
    const when = Date.parse(str(at(entry, 'timestamp')) ?? '');
    if (!Number.isNaN(when) && (last === null || when > last)) last = when;
  }
  return last;
}

/** `2.1.304 (Claude Code)` → `2.1.304`. */
function versionOf(text: string | null): string | null {
  return text?.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

/** Whether version `a` is newer than `b`, part by part. */
function newer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
