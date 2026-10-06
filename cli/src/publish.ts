import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AuditResult } from './audit.ts';
import { stackForDir, type Ctx } from './facts.ts';

export type BumpKind = 'patch' | 'minor' | 'major';

export interface PublishOptions {
  projectRoot: string;
  bump: BumpKind;
  dryRun: boolean;
  force: boolean;
  /** `git push --follow-tags` after the tag; `--no-push` turns it off. */
  push?: boolean;
}

export interface PreflightCheck {
  name: string;
  ok: boolean;
  message: string;
  /** A failed check a command at the terminal can fix — `npm login` for an expired session. */
  fix?: { cmd: string; args: string[] };
}

/** Where the release goes after the tag. */
export interface PushPlan {
  /** Asked for (not `--no-push`). */
  enabled: boolean;
  /** `origin/main`; null — the branch has none, nothing to push to. */
  upstream: string | null;
  /** Local commits not on the upstream yet — they go with the release. */
  ahead: number;
  /** Upstream commits not here: the push would be refused. */
  behind: number;
}

export interface PublishPlan {
  projectRoot: string;
  stack: string;
  packageName: string;
  currentVersion: string;
  newVersion: string;
  bump: BumpKind;
  packageJsonPath: string;
  /** package-lock.json beside package.json, when there is one: its version goes into the same commit. */
  lockPath?: string | null;
  push?: PushPlan;
  preflight: PreflightCheck[];
  preflightPassed: boolean;
  delegatedToMise: boolean;
}

export function bumpSemver(current: string, kind: BumpKind): string {
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`Cannot parse semver "${current}"`);
  let major = parseInt(m[1]!, 10);
  let minor = parseInt(m[2]!, 10);
  let patch = parseInt(m[3]!, 10);
  if (kind === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (kind === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

export function compareSemver(a: string, b: string): number {
  const norm = (s: string) =>
    s.replace(/^v/, '').split(/[.\-+]/).map((p) => parseInt(p, 10) || 0);
  const pa = norm(a);
  const pb = norm(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

function isGitWorkingTreeClean(projectRoot: string): { ok: boolean; detail: string } {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    if (out.trim() === '') return { ok: true, detail: 'OK' };
    const lines = out.trim().split('\n');
    const sample = lines.slice(0, 3).join(', ');
    return { ok: false, detail: `${lines.length} uncommitted file(s) — ${sample}` };
  } catch {
    return { ok: false, detail: 'not a git repo (or git not available)' };
  }
}

/** Runs npm with these args and returns stdout; throws with `stderr` on a non-zero exit. */
export type NpmRunner = (args: string[]) => string;

/** Runs git with these args in `cwd` and returns stdout; throws on a non-zero exit. */
export type GitRunner = (args: string[], cwd: string) => string;

const runGit: GitRunner = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * The branch's upstream and how far apart they are — from what git knows
 * since the last fetch; nothing is fetched.
 */
export function planPush(projectRoot: string, enabled: boolean, git: GitRunner = runGit): PushPlan {
  let upstream: string | null = null;
  try {
    upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], projectRoot).trim() || null;
  } catch {
    return { enabled, upstream: null, ahead: 0, behind: 0 };
  }
  const count = (range: string) => {
    try {
      return parseInt(git(['rev-list', '--count', range], projectRoot).trim(), 10) || 0;
    } catch {
      return 0;
    }
  };
  return { enabled, upstream, ahead: count('@{u}..HEAD'), behind: count('HEAD..@{u}') };
}

// A caller's `npm run -s` passes `npm_config_loglevel=silent` down, and npm then
// fails with an empty stderr — no E401 or E404 left to tell the cases apart.
const runNpm: NpmRunner = (args) =>
  execFileSync('npm', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, npm_config_loglevel: 'error' },
  });

function fetchPublishedVersion(packageName: string, npm: NpmRunner): string | null {
  try {
    const out = npm(['view', packageName, 'version']);
    return out.trim() || null;
  } catch (e: any) {
    const stderr = String(e?.stderr ?? e?.message ?? '');
    if (stderr.includes('E404') || stderr.includes('404 Not Found')) return null;
    throw new Error(`npm view failed: ${stderr.split('\n')[0] ?? stderr}`);
  }
}

/**
 * The registry `npm publish` sends this package to, when it is not npm's
 * default: `publishConfig.registry`, else the scope's registry from npm config.
 */
export function publishRegistry(
  pkg: { name?: string; publishConfig?: { registry?: string } },
  npm: NpmRunner,
): string | null {
  if (pkg.publishConfig?.registry) return pkg.publishConfig.registry;
  const scope = pkg.name?.match(/^(@[^/]+)\//)?.[1];
  if (!scope) return null;
  try {
    const value = npm(['config', 'get', `${scope}:registry`]).trim();
    return value && value !== 'undefined' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Logged in where the package goes? Without it `npm publish` fails only after
 * the bump and the pack, and with E404 on a scoped package, not E401 — an
 * expired npm session reads as a missing package.
 */
export function checkNpmAuth(registry: string | null, npm: NpmRunner): PreflightCheck {
  const where = registry ?? 'npm';
  const loginArgs = registry ? ['login', '--registry', registry] : ['login'];
  const login = `npm ${loginArgs.join(' ')}`;
  const fix = { cmd: 'npm', args: loginArgs };
  try {
    const who = npm(registry ? ['whoami', '--registry', registry] : ['whoami']).trim();
    if (who) return { name: 'npm-auth', ok: true, message: `OK (logged in to ${where} as ${who})` };
    return { name: 'npm-auth', ok: false, message: `npm whoami answered nothing for ${where}. Run: ${login}`, fix };
  } catch (e: any) {
    const stderr = String(e?.stderr ?? e?.message ?? '');
    if (/E401|ENEEDAUTH/.test(stderr)) {
      return {
        name: 'npm-auth',
        ok: false,
        message: `not logged in to ${where} (the npm session may have expired). Run: ${login}`,
        fix,
      };
    }
    return {
      name: 'npm-auth',
      ok: false,
      message: `npm whoami failed for ${where}: ${stderr.split('\n').find((l) => l.trim()) ?? stderr}`,
    };
  }
}

function checkMiseOverride(projectRoot: string): boolean {
  const miseToml = path.join(projectRoot, 'mise.toml');
  if (!fs.existsSync(miseToml)) return false;
  try {
    const text = fs.readFileSync(miseToml, 'utf8');
    // Lightweight check — a [tasks.publish] section header is unambiguous
    // enough for the delegation gate; no need for full TOML parsing here.
    return /^\[tasks\.publish\b/m.test(text);
  } catch {
    return false;
  }
}

function resolvePackageJsonPath(projectRoot: string, audit: AuditResult): string {
  const subpkg = audit.primary_subpackage;
  const root = subpkg ? path.join(projectRoot, subpkg) : projectRoot;
  return path.join(root, 'package.json');
}

export function planPublish(
  opts: PublishOptions,
  audit: AuditResult,
  ctx: Ctx,
  npm: NpmRunner = runNpm,
  git: GitRunner = runGit,
): PublishPlan {
  if (checkMiseOverride(opts.projectRoot)) {
    return {
      projectRoot: opts.projectRoot,
      stack: ctx.stack,
      packageName: '(delegated)',
      currentVersion: '',
      newVersion: '',
      bump: opts.bump,
      packageJsonPath: '',
      preflight: [
        {
          name: 'mise-override',
          ok: true,
          message: '[tasks.publish] present in mise.toml — delegating to mise',
        },
      ],
      preflightPassed: true,
      delegatedToMise: true,
    };
  }

  // Resolve effective stack: prefer subpackage stack if primary_subpackage is set
  // (meta-projects publishing a nested lib, e.g. vdx itself with primary_subpackage=cli).
  const subpkg = audit.primary_subpackage;
  const effectiveStack = subpkg
    ? stackForDir(path.join(opts.projectRoot, subpkg))
    : ctx.stack;

  if (effectiveStack !== 'node') {
    throw new Error(
      `vdx publish: only "node" stack is supported in the MVP (Шаг X). ` +
        `Effective stack: "${effectiveStack}" (root: "${ctx.stack}"${
          subpkg ? `, subpackage: "${subpkg}"` : ''
        }). PHP/Python come in Шаг X.2.`,
    );
  }

  const pkgJsonPath = resolvePackageJsonPath(opts.projectRoot, audit);
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(`vdx publish: package.json not found at ${pkgJsonPath}`);
  }

  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const packageName: string = pkg.name ?? '(unnamed)';
  const currentVersion: string = pkg.version ?? '0.0.0';
  const newVersion = bumpSemver(currentVersion, opts.bump);

  const preflight: PreflightCheck[] = [];

  const tree = isGitWorkingTreeClean(opts.projectRoot);
  preflight.push({
    name: 'working-tree-clean',
    ok: tree.ok,
    message: tree.detail,
  });

  const raAxis = audit.per_axis.find((a) => a.axis_id === 'release-artifact');
  const isExcluded = raAxis?.drift_kind === 'excluded';
  preflight.push({
    name: 'lib-intent (applies_when)',
    ok: !!raAxis && !isExcluded,
    message: !raAxis
      ? 'release-artifact axis missing from rubric'
      : isExcluded
        ? 'release-artifact axis excluded — this looks like an app, not a library. ' +
          'Use [tasks.publish] in mise.toml if you really need vdx publish here.'
        : 'OK (axis applies → lib-intent)',
  });

  const raLevel = raAxis?.achieved ?? 'L0';
  const raLevelInt = parseInt(raLevel.slice(1), 10) || 0;
  preflight.push({
    name: 'release-artifact >= L3',
    ok: raLevelInt >= 3,
    message:
      raLevelInt >= 3
        ? `OK (release-artifact ${raLevel})`
        : `release-artifact at ${raLevel}, need >= L3. Add files[], main/exports, license in package.json.`,
  });

  preflight.push(checkNpmAuth(publishRegistry(pkg, npm), npm));

  let published: string | null = null;
  let registryError: string | null = null;
  try {
    published = fetchPublishedVersion(packageName, npm);
  } catch (e: any) {
    registryError = e?.message ?? String(e);
  }
  if (registryError) {
    preflight.push({
      name: 'registry-collision',
      ok: false,
      message: `could not query npm registry: ${registryError}`,
    });
  } else if (published === null) {
    preflight.push({
      name: 'registry-collision',
      ok: true,
      message: `first publish (no prior version on registry)`,
    });
  } else {
    const cmp = compareSemver(newVersion, published);
    preflight.push({
      name: 'registry-collision',
      ok: cmp > 0,
      message:
        cmp > 0
          ? `OK (registry @ ${published}, new ${newVersion})`
          : `registry @ ${published} ≥ new ${newVersion}; pick a higher bump`,
    });
  }

  const push = planPush(opts.projectRoot, opts.push ?? true, git);
  if (push.enabled && push.upstream && push.behind > 0) {
    preflight.push({
      name: 'push-target',
      ok: false,
      message:
        `${push.upstream} has ${push.behind} commit(s) this branch lacks — the push after npm publish ` +
        `would be refused. Pull first (or --no-push)`,
    });
  } else if (push.enabled) {
    preflight.push({
      name: 'push-target',
      ok: true,
      message: push.upstream
        ? `OK (${push.upstream}${push.ahead ? `, ${push.ahead} local commit(s) go with the release` : ''})`
        : 'no upstream for this branch — the release commit and tag stay local',
    });
  }

  const lockPath = path.join(path.dirname(pkgJsonPath), 'package-lock.json');
  const preflightPassed = preflight.every((c) => c.ok);

  return {
    projectRoot: opts.projectRoot,
    stack: ctx.stack,
    packageName,
    currentVersion,
    newVersion,
    bump: opts.bump,
    packageJsonPath: pkgJsonPath,
    lockPath: fs.existsSync(lockPath) ? lockPath : null,
    push,
    preflight,
    preflightPassed,
    delegatedToMise: false,
  };
}

/** Every failed check has a command that fixes it — run at a terminal, then plan again. */
export function preflightFixable(plan: PublishPlan): boolean {
  const failed = plan.preflight.filter((c) => !c.ok);
  return failed.length > 0 && failed.every((c) => c.fix);
}

/** Runs a command on this terminal (stdio inherited); throws on a non-zero exit. */
export type CommandRunner = (cmd: string, args: string[], cwd: string) => void;

export interface PublishDeps {
  run: CommandRunner;
  npm: NpmRunner;
  log: (line: string) => void;
  sleep: (ms: number) => void;
  /** How long to wait for the registry to show the new version. */
  registryWaitMs: number;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function defaultPublishDeps(): PublishDeps {
  return {
    run: (cmd, args, cwd) => {
      execFileSync(cmd, args, { cwd, stdio: 'inherit' });
    },
    npm: runNpm,
    log: (line) => process.stderr.write(line + '\n'),
    sleep: sleepSync,
    registryWaitMs: 180_000,
  };
}

/** Set `version` in package-lock.json — the root and its own entry under `packages`. */
export function bumpLockText(text: string, version: string): string {
  const lock = JSON.parse(text);
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  return JSON.stringify(lock, null, 2) + '\n';
}

/**
 * npm answers `202 Accepted` and the version shows up a minute or two later;
 * until then `npm view` and `npx` still see the previous one. Waiting here
 * turns "is it out?" into an answer. A version that does not show up in time
 * is not a failure: npm took it.
 */
export function waitForRegistry(name: string, version: string, deps: PublishDeps): boolean {
  const started = Date.now();
  const deadline = started + deps.registryWaitMs;
  deps.log(`→ waiting for the registry to show ${name}@${version}...`);
  for (;;) {
    try {
      if (deps.npm(['view', `${name}@${version}`, 'version', '--prefer-online']).trim() === version) {
        deps.log(`✓ ${name}@${version} is on the registry (${Math.round((Date.now() - started) / 1000)} s after publish)`);
        return true;
      }
    } catch {
      /* E404 until it is processed */
    }
    if (Date.now() >= deadline) break;
    deps.sleep(10_000);
  }
  deps.log(
    `! ${name}@${version} not visible on the registry after ${Math.round(deps.registryWaitMs / 60_000)} min — ` +
      `npm accepted it; check later: npm view ${name}@${version} version`,
  );
  return false;
}

/**
 * Execute the publish pipeline. Order is transactional:
 *   1. bump package.json and package-lock.json in place (reversible by file restore).
 *   2. `npm publish` (irreversible — first because npm errors are easier
 *      to recover from than a published-but-uncommitted state).
 *   3. git add + commit + tag (reversible by reset/tag delete, but only
 *      a problem if step 2 succeeded — uncommitted bump after success
 *      is recoverable manually).
 *   4. `git push --follow-tags` to the branch's upstream, unless `--no-push`
 *      or there is none. The pre-flight refused a branch behind its upstream.
 *   5. Wait until the registry shows the version.
 *
 * On npm publish failure → restore the original files.
 * Git failures after a successful npm publish leave the user in a
 * partially-released state; they fix it manually (commit/tag/push what's
 * needed) — we don't try to unpublish.
 */
export function executePublish(plan: PublishPlan, deps: PublishDeps = defaultPublishDeps()): void {
  if (plan.delegatedToMise) {
    deps.log('→ delegating to `mise run publish`...');
    deps.run('mise', ['run', 'publish'], plan.projectRoot);
    return;
  }

  // 1. Bump package.json (and the lock) in place, keeping the original text for revert.
  const originals = new Map<string, string>();
  const rewrite = (file: string, next: (text: string) => string) => {
    const text = fs.readFileSync(file, 'utf8');
    originals.set(file, text);
    fs.writeFileSync(file, next(text), 'utf8');
  };
  rewrite(plan.packageJsonPath, (text) => {
    const pkg = JSON.parse(text);
    pkg.version = plan.newVersion;
    return JSON.stringify(pkg, null, 2) + '\n';
  });
  if (plan.lockPath) rewrite(plan.lockPath, (text) => bumpLockText(text, plan.newVersion));
  const bumped = [...originals.keys()];
  deps.log(
    `✓ bumped ${bumped.map((f) => path.relative(plan.projectRoot, f)).join(' and ')}: ${plan.currentVersion} → ${plan.newVersion}`,
  );

  // 2. npm publish (interactive — OTP prompt may appear)
  deps.log('→ running `npm publish` (OTP prompt may appear)...');
  try {
    deps.run('npm', ['publish'], path.dirname(plan.packageJsonPath));
  } catch (e: any) {
    for (const [file, text] of originals) fs.writeFileSync(file, text, 'utf8');
    deps.log(`✗ npm publish failed (exit ${e?.status ?? '?'}); reverted ${bumped.map((f) => path.basename(f)).join(' and ')}`);
    throw new Error('npm publish failed');
  }
  deps.log(`✓ published ${plan.packageName}@${plan.newVersion}`);

  // 3. git add + commit + tag (at project root)
  deps.run('git', ['add', '--', ...bumped], plan.projectRoot);
  deps.run('git', ['commit', '-m', `release: v${plan.newVersion}`, '--', ...bumped], plan.projectRoot);
  deps.run('git', ['tag', '-a', `v${plan.newVersion}`, '-m', `v${plan.newVersion}`], plan.projectRoot);
  deps.log(`✓ committed + tagged v${plan.newVersion}`);

  // 4. push
  const push = plan.push;
  if (push?.enabled && push.upstream) {
    deps.log(`→ git push --follow-tags (${push.upstream})...`);
    try {
      deps.run('git', ['push', '--follow-tags'], plan.projectRoot);
    } catch {
      deps.log(`✗ git push failed — ${plan.packageName}@${plan.newVersion} is published and tagged here; push it: git push --follow-tags`);
      throw new Error('git push failed');
    }
    deps.log(`✓ pushed to ${push.upstream} with tag v${plan.newVersion}`);
  } else {
    deps.log(
      push?.enabled === false
        ? '! not pushed (--no-push): git push --follow-tags'
        : '! not pushed — the branch has no upstream: git push --follow-tags -u <remote> <branch>',
    );
  }

  // 5. registry
  waitForRegistry(plan.packageName, plan.newVersion, deps);
}

export function renderPublishPlan(plan: PublishPlan): string {
  const lines: string[] = [];
  lines.push('# vdx publish plan');
  lines.push('');
  if (plan.delegatedToMise) {
    lines.push('- **Mode**: delegated to `[tasks.publish]` from mise.toml');
    lines.push('');
    lines.push('## Pre-flight checks');
    lines.push('');
    lines.push('| Check | Status | Message |');
    lines.push('|-------|:------:|---------|');
    for (const c of plan.preflight) {
      lines.push(`| ${c.name} | ${c.ok ? 'OK' : 'FAIL'} | ${c.message} |`);
    }
    lines.push('');
    lines.push('> vdx will exec `mise run publish` — no vdx-native pipeline involved.');
    return lines.join('\n') + '\n';
  }

  lines.push(`- **Package**: ${plan.packageName}`);
  lines.push(`- **Stack**: ${plan.stack}`);
  lines.push(`- **Bump**: ${plan.bump}`);
  lines.push(`- **Version**: ${plan.currentVersion} → ${plan.newVersion}`);
  lines.push(`- **package.json**: ${plan.packageJsonPath}`);
  lines.push('');
  lines.push('## Pre-flight checks');
  lines.push('');
  lines.push('| Check | Status | Message |');
  lines.push('|-------|:------:|---------|');
  for (const c of plan.preflight) {
    lines.push(`| ${c.name} | ${c.ok ? 'OK' : 'FAIL'} | ${c.message} |`);
  }
  lines.push('');
  const fixable = !plan.preflightPassed && preflightFixable(plan);
  if (plan.preflightPassed || fixable) {
    const files = plan.lockPath ? 'package.json and package-lock.json' : 'package.json';
    const push = plan.push;
    lines.push('## Pipeline (would execute on `vdx publish`)');
    lines.push('');
    if (fixable) {
      const fixes = plan.preflight.filter((c) => !c.ok && c.fix).map((c) => `\`${c.fix!.cmd} ${c.fix!.args.join(' ')}\``);
      lines.push(`0. ${fixes.join(', ')} — at a terminal, then the pre-flight again`);
    }
    lines.push(`1. Set \`version\` in ${files} → \`${plan.newVersion}\``);
    lines.push(`2. \`npm publish\` (cwd = directory containing package.json)`);
    lines.push(`3. \`git commit -m "release: v${plan.newVersion}"\` (${files})`);
    lines.push(`4. \`git tag -a v${plan.newVersion} -m "v${plan.newVersion}"\``);
    lines.push(
      !push?.enabled
        ? '5. Not pushed (`--no-push`): `git push --follow-tags` is yours'
        : push.upstream
          ? `5. \`git push --follow-tags\` → ${push.upstream}${push.ahead ? ` (with ${push.ahead} local commit(s) not pushed yet)` : ''}`
          : '5. Not pushed: the branch has no upstream',
    );
    lines.push(`6. Wait until the registry shows ${plan.newVersion} (up to 3 min)`);
  } else {
    lines.push('> Pre-flight failed. Use `--force` to bypass at your own risk.');
  }
  return lines.join('\n') + '\n';
}
