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
}

export interface PreflightCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface PublishPlan {
  stack: string;
  packageName: string;
  currentVersion: string;
  newVersion: string;
  bump: BumpKind;
  packageJsonPath: string;
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

function fetchPublishedVersion(packageName: string): string | null {
  try {
    const out = execFileSync('npm', ['view', packageName, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.trim() || null;
  } catch (e: any) {
    const stderr = String(e?.stderr ?? e?.message ?? '');
    if (stderr.includes('E404') || stderr.includes('404 Not Found')) return null;
    throw new Error(`npm view failed: ${stderr.split('\n')[0] ?? stderr}`);
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
): PublishPlan {
  if (checkMiseOverride(opts.projectRoot)) {
    return {
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

  let published: string | null = null;
  let registryError: string | null = null;
  try {
    published = fetchPublishedVersion(packageName);
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

  const preflightPassed = preflight.every((c) => c.ok);

  return {
    stack: ctx.stack,
    packageName,
    currentVersion,
    newVersion,
    bump: opts.bump,
    packageJsonPath: pkgJsonPath,
    preflight,
    preflightPassed,
    delegatedToMise: false,
  };
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
  if (plan.preflightPassed) {
    lines.push('## Pipeline (would execute on `vdx publish`)');
    lines.push('');
    lines.push(`1. Set \`version\` in package.json → \`${plan.newVersion}\``);
    lines.push(`2. \`npm publish\` (cwd = directory containing package.json)`);
    lines.push(`3. \`git add package.json && git commit -m "release: v${plan.newVersion}"\``);
    lines.push(`4. \`git tag -a v${plan.newVersion} -m "v${plan.newVersion}"\``);
    lines.push(`5. (NOT pushed — your call: \`git push --follow-tags\`)`);
  } else {
    lines.push('> Pre-flight failed. Use `--force` to bypass at your own risk.');
  }
  return lines.join('\n') + '\n';
}
