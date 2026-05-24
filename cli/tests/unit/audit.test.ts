import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit } from '../../src/audit.ts';
import type { Ctx } from '../../src/facts.ts';
import type { Rubric } from '../../src/rubric.ts';

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
