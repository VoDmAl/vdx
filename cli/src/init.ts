import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Ctx,
  fileExists,
  readJson,
  readText,
  listAllTasks,
  autoDetectStack,
  findSubPackages,
  type SubPackage,
} from './facts.ts';

export const STANDARD_VERBS = ['up', 'down', 'build', 'test', 'check', 'fix'] as const;
export type Verb = (typeof STANDARD_VERBS)[number];

export const DEFAULT_BASELINE = 'github.com/VoDmAl/vdx-rubric-vodmal@v0.3.1';

const VERB_ALIASES: Record<Verb, string[]> = {
  up: ['docker:up', 'docker-up', 'docker:up:detached', 'start', 'dev', 'serve'],
  down: ['docker:down', 'docker-down', 'stop'],
  build: [
    'docker:build',
    'build:prod',
    'build-prod',
    'build:dev',
    'build-dev',
    'build:assets',
    'compile',
    'dist',
  ],
  test: [
    'phpunit',
    'pest',
    'test:unit',
    'test-unit',
    'test:unit:phpunit',
    'tests',
    'unit',
    'jest',
    'vitest',
    'mocha',
    'ava',
    'spec',
    'coverage',
  ],
  check: [
    'lint',
    'check:before:commit',
    'check:before:push',
    'check:config',
    'check:code:static',
    'check:code:lint',
    'typecheck',
    'tsc',
    'eslint',
    'prettier:check',
    'format:check',
    'qa',
    'phpstan',
    'psalm',
  ],
  fix: [
    'fix:ecs',
    'fix:rector',
    'format',
    'lint:fix',
    'eslint:fix',
    'prettier',
    'prettier:write',
    'prettier:fix',
    'format:write',
    'cs-fix',
    'cs:fix',
  ],
};

const VERB_PREFIX_GROUPS: Record<Verb, string[]> = {
  up: [],
  down: [],
  build: ['build:', 'build-'],
  test: ['test:', 'test-'],
  check: ['check:', 'check-'],
  fix: ['fix:', 'fix-'],
};

// Suffix-based monorepo fallback: lets us pick up `server:test`, `api:lint`, etc.
// when no exact/alias/prefix-group match exists.
const VERB_SUFFIX_GROUPS: Record<Verb, string[]> = {
  up: [':up', '-up'],
  down: [':down', '-down'],
  build: [':build', '-build'],
  test: [':test', '-test'],
  check: [':check', '-check', ':lint', ':typecheck'],
  fix: [':fix', '-fix', ':format'],
};

export type MatchReason = 'exact' | 'alias' | 'prefix-group' | 'suffix-group' | 'not-found';

export interface VerbMapping {
  verb: Verb;
  nativeTask: string | null;
  runCommand: string | null;
  reason: MatchReason;
  /** Other candidate tasks that also matched but weren't chosen — useful for tuning. */
  alternatives: string[];
}

export interface VerbMatch {
  task: string | null;
  reason: MatchReason;
  alternatives: string[];
}

export interface InitPlan {
  projectRoot: string;
  stack: string;
  /** Was `stack` derived from autoDetectStack (false) or supplied via --stack (true). */
  stackOverridden: boolean;
  /** Non-null only when stack === 'meta' and resolved a single nested manifest. */
  primarySubpackage: string | null;
  pkgManager: 'composer' | 'npm' | 'pnpm' | 'yarn' | null;
  tools: Record<string, string>;
  mappings: VerbMapping[];
  miseTomlPath: string;
  miseTomlContent: string;
  agentsMdPath: string;
  agentsMdContent: string;
  baseline: string;
  /** Human-readable advisories for the user — printed to stderr by the CLI. */
  warnings: string[];
}

function detectNodePackageManager(projectRoot: string): 'pnpm' | 'yarn' | 'npm' {
  if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function renderRunCommand(task: string, stack: string, projectRoot: string): string {
  if (stack === 'php') return `composer ${task}`;
  if (stack === 'node') {
    const pm = detectNodePackageManager(projectRoot);
    if (pm === 'yarn') return `yarn ${task}`;
    return `${pm} run ${task}`;
  }
  return task;
}

function renderRunCommandInSubpackage(
  task: string,
  subStack: string,
  subAbs: string,
  subRel: string,
): string {
  return `cd ${subRel} && ${renderRunCommand(task, subStack, subAbs)}`;
}

function pickPrefixGroup(prefixes: string[], tasks: Set<string>, verb: Verb): string | null {
  if (prefixes.length === 0) return null;
  // Prefer entries that look like a canonical "prod/dist/release" first, then any.
  const canonHints = ['prod', 'production', 'release', 'dist', 'all'];
  const candidates: string[] = [];
  for (const t of tasks) {
    for (const pfx of prefixes) {
      if (t.startsWith(pfx) && t !== verb) {
        candidates.push(t);
        break;
      }
    }
  }
  if (candidates.length === 0) return null;
  for (const hint of canonHints) {
    const hit = candidates.find((c) => c.toLowerCase().includes(hint));
    if (hit) return hit;
  }
  candidates.sort((a, b) => a.length - b.length);
  return candidates[0] ?? null;
}

function collectPrefixCandidates(prefixes: string[], tasks: Set<string>, verb: Verb): string[] {
  if (prefixes.length === 0) return [];
  const candidates: string[] = [];
  for (const t of tasks) {
    if (t === verb) continue;
    for (const pfx of prefixes) {
      if (t.startsWith(pfx)) {
        candidates.push(t);
        break;
      }
    }
  }
  return candidates;
}

function collectSuffixCandidates(suffixes: string[], tasks: Set<string>, verb: Verb): string[] {
  if (suffixes.length === 0) return [];
  const candidates: string[] = [];
  for (const t of tasks) {
    if (t === verb) continue;
    for (const sfx of suffixes) {
      if (t.endsWith(sfx)) {
        candidates.push(t);
        break;
      }
    }
  }
  return candidates;
}

export function selectVerbTask(verb: Verb, tasks: Set<string>): VerbMatch {
  // 1) exact match wins; siblings (aliases / prefix-group) reported as alternatives.
  if (tasks.has(verb)) {
    const alts = new Set<string>();
    for (const a of VERB_ALIASES[verb]) if (tasks.has(a)) alts.add(a);
    for (const c of collectPrefixCandidates(VERB_PREFIX_GROUPS[verb], tasks, verb)) alts.add(c);
    return { task: verb, reason: 'exact', alternatives: [...alts].sort() };
  }

  // 2) alias hit (curated common alternates per stack).
  const aliasHits = VERB_ALIASES[verb].filter((a) => tasks.has(a));
  if (aliasHits.length > 0) {
    const [chosen, ...rest] = aliasHits;
    return { task: chosen!, reason: 'alias', alternatives: rest.slice().sort() };
  }

  // 3) prefix-group with canonical hint (prod/release/all preferred, then shortest).
  const prefixCandidates = collectPrefixCandidates(VERB_PREFIX_GROUPS[verb], tasks, verb);
  if (prefixCandidates.length > 0) {
    const chosen = pickPrefixGroup(VERB_PREFIX_GROUPS[verb], tasks, verb)!;
    const alts = prefixCandidates.filter((c) => c !== chosen).sort();
    return { task: chosen, reason: 'prefix-group', alternatives: alts };
  }

  // 4) suffix-group (monorepo fallback: `server:test` -> verb 'test').
  const suffixCandidates = collectSuffixCandidates(VERB_SUFFIX_GROUPS[verb], tasks, verb);
  if (suffixCandidates.length > 0) {
    suffixCandidates.sort((a, b) => a.length - b.length);
    const [chosen, ...rest] = suffixCandidates;
    return { task: chosen!, reason: 'suffix-group', alternatives: rest.slice().sort() };
  }

  return { task: null, reason: 'not-found', alternatives: [] };
}

/** Kept for back-compat with potential external callers; prefer `selectVerbTask`. */
export function mapVerb(verb: Verb, tasks: Set<string>): string | null {
  return selectVerbTask(verb, tasks).task;
}

function collectTools(ctx: Ctx): Record<string, string> {
  const tools: Record<string, string> = {};
  const composer = readJson(ctx, 'composer.json');
  if (composer?.require?.php && typeof composer.require.php === 'string') {
    tools.php = stripVersionConstraint(composer.require.php);
  }
  const pkg = readJson(ctx, 'package.json');
  if (pkg?.engines?.node && typeof pkg.engines.node === 'string') {
    tools.node = stripVersionConstraint(pkg.engines.node);
  }
  return tools;
}

function stripVersionConstraint(raw: string): string {
  const m = raw.match(/(\d+(?:\.\d+){0,2})/);
  if (m && m[1]) return m[1];
  return raw.trim();
}

const VERB_DESCRIPTIONS: Record<Verb, string> = {
  up: 'Start the project locally',
  down: 'Stop the project',
  build: 'Build assets / artifacts',
  test: 'Run tests',
  check: 'Quality checks (read-only)',
  fix: 'Auto-fixes',
};

function quoteToml(s: string): string {
  // mise tasks accept basic strings; only escape backslash and double quote.
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export function renderMiseToml(
  tools: Record<string, string>,
  mappings: VerbMapping[],
  stack: string,
  baseline: string,
  primarySubpackage: string | null = null,
): string {
  const out: string[] = [];
  out.push('# Generated by vdx init. The [vdx] block is metadata for vdx audit.');
  out.push('# Lifecycle verbs follow the vdx contract: up/down/build/test/check/fix.');
  out.push('');

  if (stack === 'unknown' || stack === 'monorepo') {
    out.push(
      '# TODO(vdx): stack auto-detection вернул "' +
        stack +
        '". Замени на php/node/go/python/meta',
    );
    out.push('#   и заполни [tasks.*] блоки руками, либо перегенери: vdx init --stack <id>.');
    out.push('');
  }

  if (Object.keys(tools).length > 0) {
    out.push('[tools]');
    for (const [k, v] of Object.entries(tools)) {
      out.push(`${k} = ${quoteToml(v)}`);
    }
    out.push('');
  }

  for (const m of mappings) {
    if (!m.runCommand) continue;
    if (m.reason !== 'exact' || m.alternatives.length > 0) {
      const altPart = m.alternatives.length > 0 ? `; alt: ${m.alternatives.join(', ')}` : '';
      out.push(`# vdx: matched "${m.nativeTask}" via ${m.reason}${altPart}`);
    }
    out.push(`[tasks.${m.verb}]`);
    out.push(`description = ${quoteToml(VERB_DESCRIPTIONS[m.verb])}`);
    out.push(`run = ${quoteToml(m.runCommand)}`);
    out.push('');
  }

  out.push('[vdx]');
  out.push('schema_version = "0.2"');
  out.push(`baseline = ${quoteToml(baseline)}`);
  out.push(`stack = ${quoteToml(stack)}`);
  if (primarySubpackage) {
    out.push(`primary_subpackage = ${quoteToml(primarySubpackage)}`);
  }
  const verbsList = mappings
    .filter((m) => m.runCommand)
    .map((m) => quoteToml(m.verb))
    .join(', ');
  out.push(`verbs = [${verbsList}]`);
  out.push('');

  return out.join('\n');
}

const AGENTS_MARKER_OPEN = '<!-- vdx:commands -->';
const AGENTS_MARKER_CLOSE = '<!-- /vdx:commands -->';

export function renderAgentsCommandsSection(
  mappings: VerbMapping[],
  baseline: string,
): string {
  const lines: string[] = [];
  lines.push(AGENTS_MARKER_OPEN);
  lines.push('## Commands');
  lines.push('');
  lines.push(
    `This project follows the vdx lifecycle interface (baseline: ${baseline}).`,
  );
  lines.push('');
  lines.push('| Verb | What it does | Native command |');
  lines.push('|------|--------------|----------------|');
  for (const m of mappings) {
    if (!m.runCommand) {
      lines.push(`| \`mise run ${m.verb}\` | ${VERB_DESCRIPTIONS[m.verb]} | _(not mapped)_ |`);
    } else {
      lines.push(
        `| \`mise run ${m.verb}\` | ${VERB_DESCRIPTIONS[m.verb]} | \`${m.runCommand}\` |`,
      );
    }
  }
  lines.push(AGENTS_MARKER_CLOSE);
  return lines.join('\n');
}

export function buildAgentsMd(existing: string | null, section: string): string {
  if (existing === null) {
    return `# AGENTS\n\nProject agent guide.\n\n${section}\n`;
  }
  const openIdx = existing.indexOf(AGENTS_MARKER_OPEN);
  const closeIdx = existing.indexOf(AGENTS_MARKER_CLOSE);
  if (openIdx !== -1 && closeIdx !== -1 && closeIdx > openIdx) {
    const before = existing.slice(0, openIdx);
    const after = existing.slice(closeIdx + AGENTS_MARKER_CLOSE.length);
    return before + section + after;
  }
  // No markers — append.
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  return existing + sep + section + '\n';
}

export function planInit(
  projectRoot: string,
  opts: { baseline?: string; stack?: string } = {},
): InitPlan {
  const detectedStack = autoDetectStack(projectRoot);
  const stackOverridden = opts.stack !== undefined && opts.stack !== detectedStack;
  const stack = opts.stack ?? detectedStack;
  const warnings: string[] = [];

  // For meta-stack — try to resolve a single nested subpackage and scan it for tasks.
  let primarySubpackage: string | null = null;
  let scanRoot = projectRoot;
  let scanStack = stack;

  if (stack === 'meta') {
    const subs: SubPackage[] = findSubPackages(projectRoot);
    if (subs.length === 1) {
      primarySubpackage = subs[0]!.relPath;
      scanRoot = path.join(projectRoot, primarySubpackage);
      scanStack = subs[0]!.stack;
    } else if (subs.length === 0) {
      warnings.push(
        'stack="meta", но nested manifest не найден. mise.toml будет иметь пустой verbs[]; ' +
          'заполни [tasks.*] руками.',
      );
    } else {
      const list = subs.map((s) => `${s.relPath}(${s.stack})`).join(', ');
      warnings.push(
        `stack="meta", найдено несколько subpackages: ${list}. ` +
          'primary_subpackage не выбран; укажи его руками в [vdx] блоке.',
      );
    }
  } else if (!stackOverridden && (detectedStack === 'unknown' || detectedStack === 'monorepo')) {
    if (detectedStack === 'unknown') {
      warnings.push(
        'autoDetectStack вернул "unknown" — в корне нет manifest и нет subpackages. ' +
          'Передай --stack <id> (php|node|go|python|meta) либо отредактируй mise.toml вручную.',
      );
    } else {
      const subs = findSubPackages(projectRoot);
      const list = subs.map((s) => `${s.relPath}(${s.stack})`).join(', ');
      warnings.push(
        `autoDetectStack вернул "monorepo": ${list}. ` +
          'Передай --stack <id> чтобы выбрать конкретный стек, либо --stack meta + укажи primary_subpackage.',
      );
    }
  }

  const scanCtx: Ctx = { projectRoot: scanRoot, stack: scanStack, cache: new Map() };
  const tasks = listAllTasks(scanCtx);

  const mappings: VerbMapping[] = STANDARD_VERBS.map((verb) => {
    const sel = selectVerbTask(verb, tasks);
    let runCommand: string | null = null;
    if (sel.task) {
      runCommand =
        primarySubpackage !== null
          ? renderRunCommandInSubpackage(sel.task, scanStack, scanRoot, primarySubpackage)
          : renderRunCommand(sel.task, stack, projectRoot);
    }
    return {
      verb,
      nativeTask: sel.task,
      runCommand,
      reason: sel.reason,
      alternatives: sel.alternatives,
    };
  });

  // tools читаем из root независимо: для PHP/Node корневой manifest часто
  // содержит engines/require php; для meta-проектов вынос tool-версий в
  // root mise.toml — общая практика.
  const rootCtx: Ctx = { projectRoot, stack, cache: new Map() };
  const tools = collectTools(rootCtx);
  const baseline = opts.baseline ?? DEFAULT_BASELINE;
  const miseTomlContent = renderMiseToml(tools, mappings, stack, baseline, primarySubpackage);

  const agentsMdPath = path.join(projectRoot, 'AGENTS.md');
  const existingAgents = fileExists(rootCtx, 'AGENTS.md') ? readText(rootCtx, 'AGENTS.md') : null;
  const section = renderAgentsCommandsSection(mappings, baseline);
  const agentsMdContent = buildAgentsMd(existingAgents, section);

  let pkgManager: InitPlan['pkgManager'] = null;
  const pmStack = primarySubpackage ? scanStack : stack;
  const pmRoot = primarySubpackage ? scanRoot : projectRoot;
  if (pmStack === 'php') pkgManager = 'composer';
  else if (pmStack === 'node') pkgManager = detectNodePackageManager(pmRoot);

  return {
    projectRoot,
    stack,
    stackOverridden,
    primarySubpackage,
    pkgManager,
    tools,
    mappings,
    miseTomlPath: path.join(projectRoot, 'mise.toml'),
    miseTomlContent,
    agentsMdPath,
    agentsMdContent,
    baseline,
    warnings,
  };
}

export function writeInit(plan: InitPlan, opts: { force: boolean }): void {
  if (fs.existsSync(plan.miseTomlPath) && !opts.force) {
    throw new Error(
      `mise.toml уже существует: ${plan.miseTomlPath}. Используй --force для перезаписи.`,
    );
  }
  fs.writeFileSync(plan.miseTomlPath, plan.miseTomlContent, 'utf8');
  fs.writeFileSync(plan.agentsMdPath, plan.agentsMdContent, 'utf8');
}

export function renderPlanSummary(plan: InitPlan): string {
  const lines: string[] = [];
  lines.push(`# vdx init plan`);
  lines.push('');
  lines.push(
    `- **Project**: ${plan.projectRoot}`,
  );
  lines.push(
    `- **Stack**: ${plan.stack}${plan.stackOverridden ? ' (via --stack)' : ''}`,
  );
  if (plan.primarySubpackage) {
    lines.push(`- **Primary subpackage**: ${plan.primarySubpackage}`);
  }
  if (plan.pkgManager) lines.push(`- **Package manager**: ${plan.pkgManager}`);
  lines.push(`- **Baseline**: ${plan.baseline}`);
  if (plan.warnings.length > 0) {
    lines.push('');
    lines.push('## ⚠ Warnings');
    lines.push('');
    for (const w of plan.warnings) lines.push(`- ${w}`);
  }
  if (Object.keys(plan.tools).length > 0) {
    const toolStr = Object.entries(plan.tools)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    lines.push(`- **Tools**: ${toolStr}`);
  }
  lines.push('');
  lines.push('## Verb mappings');
  lines.push('');
  lines.push('| Verb | Native task | Reason | Generated `run` |');
  lines.push('|------|-------------|--------|-----------------|');
  for (const m of plan.mappings) {
    if (m.runCommand) {
      lines.push(
        `| \`${m.verb}\` | \`${m.nativeTask}\` | ${m.reason} | \`${m.runCommand}\` |`,
      );
    } else {
      lines.push(`| \`${m.verb}\` | _(not found)_ | not-found | _(skipped)_ |`);
    }
  }
  lines.push('');
  const withAlts = plan.mappings.filter((m) => m.alternatives.length > 0);
  if (withAlts.length > 0) {
    lines.push('### Alternatives considered');
    lines.push('');
    for (const m of withAlts) {
      const alts = m.alternatives.map((a) => `\`${a}\``).join(', ');
      lines.push(
        `- \`${m.verb}\` chose \`${m.nativeTask}\` (${m.reason}); also matched: ${alts}`,
      );
    }
    lines.push('');
  }
  const unmatched = plan.mappings.filter((m) => !m.runCommand).map((m) => m.verb);
  if (unmatched.length > 0) {
    lines.push(`> Not mapped: ${unmatched.join(', ')}. Добавь тиски в \`mise.toml\` вручную.`);
    lines.push('');
  }
  lines.push('## Generated mise.toml');
  lines.push('');
  lines.push('```toml');
  lines.push(plan.miseTomlContent);
  lines.push('```');
  return lines.join('\n') + '\n';
}
