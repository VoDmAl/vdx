import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit } from '../../src/audit.ts';
import type { Ctx } from '../../src/facts.ts';
import type { Predicate, Rubric } from '../../src/rubric.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, '..', 'fixtures');

function mkCtx(fixture: string, stack: string): Ctx {
  return {
    projectRoot: path.join(FIXTURES, fixture),
    stack,
    cache: new Map(),
  };
}

// Mini-рубрика c одной осью release-artifact-like. applies_when копирует
// форму canonical v0.3.1: Node lib OR PHP lib. Levels тривиальные — нас
// интересует только гейтинг, не сами уровни.
function mkRubric(): Rubric {
  return {
    schema_version: '0.2',
    metadata: { name: 'test', version: '0.0.0' },
    scoring: { formula: 'weighted_two_class', supporting_threshold: 0.8 },
    levels: {
      L0: { name: 'L0', description: '' },
      L1: { name: 'L1', description: '' },
      L2: { name: 'L2', description: '' },
      L3: { name: 'L3', description: '' },
      L4: { name: 'L4', description: '' },
    },
    axes: [
      {
        id: 'release-artifact',
        class: 'supporting',
        storage: 'level',
        default_target: 'L4',
        applies_to: ['node', 'php'],
        applies_when: {
          any_of: [
            {
              all_of: [
                { has_file: 'package.json' },
                {
                  not: {
                    config_value: { path: 'package.json', jsonpath: 'private', equals: true },
                  },
                },
                {
                  any_of: [
                    { config_value: { path: 'package.json', jsonpath: 'publishConfig', op: 'present' } },
                    { config_value: { path: 'package.json', jsonpath: 'bin', op: 'present' } },
                    { config_value: { path: 'package.json', jsonpath: 'main', op: 'present' } },
                    { config_value: { path: 'package.json', jsonpath: 'exports', op: 'present' } },
                    { config_value: { path: 'package.json', jsonpath: 'module', op: 'present' } },
                  ],
                },
              ],
            },
            {
              all_of: [
                { has_file: 'composer.json' },
                { config_value: { path: 'composer.json', jsonpath: 'name', op: 'present' } },
                {
                  not: {
                    config_value: { path: 'composer.json', jsonpath: 'type', op: 'equals', equals: 'project' },
                  },
                },
              ],
            },
          ],
        },
        levels: {
          L1: { requires: { has_file: 'package.json' } },
        },
      },
    ],
  };
}

function axisResult(stack: string, fixture: string) {
  const result = audit(mkRubric(), mkCtx(fixture, stack), [], 'test@v0.0.0', null);
  return result.per_axis.find((a) => a.axis_id === 'release-artifact')!;
}

describe('audit: applies_when on release-artifact', () => {
  it('Node lib with publishConfig + bin → evaluated (not excluded)', () => {
    const r = axisResult('node', 'node-publishable-lib');
    expect(r.drift_kind).not.toBe('excluded');
    expect(r.achieved).toBe('L1');
  });

  it('Node app with private:true → excluded', () => {
    const r = axisResult('node', 'node-with-vitest');
    expect(r.drift_kind).toBe('excluded');
    expect(r.achieved).toBe('L0');
  });

  it('PHP lib without type:project → evaluated (not excluded)', () => {
    const r = axisResult('php', 'php-with-phpstan');
    expect(r.drift_kind).not.toBe('excluded');
  });

  it('PHP app with type:project → excluded', () => {
    const r = axisResult('php', 'php-app-project');
    expect(r.drift_kind).toBe('excluded');
  });

  it('applies_to-gate fires before applies_when (unrelated stack stays excluded)', () => {
    const r = axisResult('go', 'node-publishable-lib');
    expect(r.drift_kind).toBe('excluded');
  });
});

// Мета-репо: корень без своего манифеста, код — в `cli/`. Половины дочитывают
// друг у друга недостающие файлы; задачи словаря — только свои.
describe('audit: a meta repo reads files across its halves', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function write(rel: string, text: string) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }

  function rubric(): Rubric {
    const axis = (id: string, requires: Predicate, appliesTo?: string[]) => ({
      id,
      class: 'supporting' as const,
      storage: 'level' as const,
      default_target: 'L1' as const,
      ...(appliesTo ? { applies_to: appliesTo } : {}),
      levels: { L1: { requires } },
    });
    return {
      ...mkRubric(),
      axes: [
        axis('engines', { config_value: { path: 'package.json', jsonpath: 'engines.node', op: 'present' } }),
        axis('root-task', { has_task: 'test' }),
        axis('dependabot', { has_file: '.github/dependabot.yml' }, ['node']),
        axis('audit-in-ci', { file_contains: { path: '.github/workflows/*.yml', pattern: 'npm audit' } }, ['node']),
      ],
    };
  }

  function levels(manifest: { primary_subpackage: string } | null = null) {
    const res = audit(rubric(), { projectRoot: dir, stack: 'meta', cache: new Map() }, [], 'test@v0.0.0', manifest);
    return Object.fromEntries(res.per_axis.map((a) => [a.axis_id, a.achieved]));
  }

  it('the root takes the manifest from the subpackage; the subpackage takes .github from the root', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-meta-'));
    write('cli/package.json', JSON.stringify({ name: 'x', engines: { node: '>=20' }, scripts: { test: 'vitest' } }));
    write('.github/dependabot.yml', 'version: 2\n');
    write('.github/workflows/ci.yml', 'jobs:\n  a:\n    steps:\n      - run: npm audit\n');
    expect(levels({ primary_subpackage: 'cli' })).toEqual({
      engines: 'L1',
      'root-task': 'L0',
      dependabot: 'L1',
      'audit-in-ci': 'L1',
    });
  });

  it('a root with its own manifest does not borrow from the subpackage', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-meta-'));
    write('package.json', JSON.stringify({ name: 'root' }));
    write('cli/package.json', JSON.stringify({ name: 'x', engines: { node: '>=20' } }));
    expect(levels({ primary_subpackage: 'cli' }).engines).toBe('L0');
  });

  it('the subpackage keeps its own file when both halves have one', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-meta-'));
    write('cli/package.json', JSON.stringify({ name: 'x' }));
    write('cli/.github/dependabot.yml', 'version: 2\n');
    write('.github/workflows/ci.yml', 'jobs: {}\n');
    write('cli/.github/workflows/ci.yml', 'run: npm audit\n');
    const l = levels({ primary_subpackage: 'cli' });
    expect(l.dependabot).toBe('L1');
    expect(l['audit-in-ci']).toBe('L1');
  });
});
