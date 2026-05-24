import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGISTRY } from '../../src/predicates.ts';
import type { Ctx } from '../../src/facts.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, '..', 'fixtures');

function mkCtx(fixture: string, stack = 'node'): Ctx {
  return {
    projectRoot: path.join(FIXTURES, fixture),
    stack,
    cache: new Map(),
  };
}

describe('has_file', () => {
  it('returns true for existing file', () => {
    expect(REGISTRY.has_file!({ path: 'package.json' }, mkCtx('node-with-vitest'))).toBe(true);
  });
  it('returns true for existing directory', () => {
    expect(REGISTRY.has_file!({ path: 'tests' }, mkCtx('node-with-vitest'))).toBe(true);
  });
  it('returns false for missing path', () => {
    expect(REGISTRY.has_file!({ path: 'nonexistent.json' }, mkCtx('node-with-vitest'))).toBe(false);
  });
  it('returns false in empty project', () => {
    expect(REGISTRY.has_file!({ path: 'package.json' }, mkCtx('empty'))).toBe(false);
  });
});

describe('has_task', () => {
  it('finds task from package.json scripts', () => {
    expect(REGISTRY.has_task!({ task: 'test' }, mkCtx('node-with-vitest'))).toBe(true);
  });
  it('returns false for missing task', () => {
    expect(REGISTRY.has_task!({ task: 'deploy' }, mkCtx('node-with-vitest'))).toBe(false);
  });
});

describe('has_task_matching', () => {
  it('matches by regex', () => {
    expect(REGISTRY.has_task_matching!({ pattern: '^test:' }, mkCtx('node-with-vitest'))).toBe(true);
  });
  it('returns false for no match', () => {
    expect(REGISTRY.has_task_matching!({ pattern: '^deploy:' }, mkCtx('node-with-vitest'))).toBe(false);
  });
  it('survives invalid regex', () => {
    expect(REGISTRY.has_task_matching!({ pattern: '[invalid(' }, mkCtx('node-with-vitest'))).toBe(false);
  });
});

describe('package_present', () => {
  it('npm devDependency', () => {
    expect(
      REGISTRY.package_present!({ name: 'vitest', ecosystem: 'npm' }, mkCtx('node-with-vitest')),
    ).toBe(true);
  });
  it('npm dependency', () => {
    expect(
      REGISTRY.package_present!({ name: 'lodash', ecosystem: 'npm' }, mkCtx('node-with-vitest')),
    ).toBe(true);
  });
  it('ecosystem any falls through to all', () => {
    expect(
      REGISTRY.package_present!({ name: 'vitest', ecosystem: 'any' }, mkCtx('node-with-vitest')),
    ).toBe(true);
  });
  it('composer dependency', () => {
    expect(
      REGISTRY.package_present!(
        { name: 'phpstan/phpstan', ecosystem: 'composer' },
        mkCtx('php-with-phpstan', 'php'),
      ),
    ).toBe(true);
  });
  it('missing package', () => {
    expect(
      REGISTRY.package_present!({ name: 'nonexistent', ecosystem: 'npm' }, mkCtx('node-with-vitest')),
    ).toBe(false);
  });
});

describe('file_contains', () => {
  it('matches pattern in file', () => {
    expect(
      REGISTRY.file_contains!({ path: 'package.json', pattern: '"vitest"' }, mkCtx('node-with-vitest')),
    ).toBe(true);
  });
  it('returns false when pattern absent', () => {
    expect(
      REGISTRY.file_contains!({ path: 'package.json', pattern: 'nonexistent-token' }, mkCtx('node-with-vitest')),
    ).toBe(false);
  });
  it('returns false for missing file', () => {
    expect(
      REGISTRY.file_contains!({ path: 'missing.json', pattern: 'x' }, mkCtx('node-with-vitest')),
    ).toBe(false);
  });
  it('accepts paths[] form', () => {
    expect(
      REGISTRY.file_contains!(
        { paths: ['missing.json', 'package.json'], pattern: '"vitest"' },
        mkCtx('node-with-vitest'),
      ),
    ).toBe(true);
  });
});

describe('tsc_flag', () => {
  it('strict: true matches when set', () => {
    expect(
      REGISTRY.tsc_flag!({ name: 'strict', equals: true }, mkCtx('node-with-vitest')),
    ).toBe(true);
  });
  it('default equals: true', () => {
    expect(REGISTRY.tsc_flag!({ name: 'strict' }, mkCtx('node-with-vitest'))).toBe(true);
  });
  it('false when flag absent', () => {
    expect(
      REGISTRY.tsc_flag!({ name: 'noUncheckedIndexedAccess', equals: true }, mkCtx('node-with-vitest')),
    ).toBe(false);
  });
  it('false when tsconfig missing', () => {
    expect(REGISTRY.tsc_flag!({ name: 'strict' }, mkCtx('empty'))).toBe(false);
  });
});

describe('phpstan_level_at_least', () => {
  it('reads max level', () => {
    expect(
      REGISTRY.phpstan_level_at_least!({ n: 9 }, mkCtx('php-with-phpstan', 'php')),
    ).toBe(true);
  });
  it('level threshold gate', () => {
    expect(
      REGISTRY.phpstan_level_at_least!({ n: 10 }, mkCtx('php-with-phpstan', 'php')),
    ).toBe(false);
  });
  it('returns false when phpstan config missing', () => {
    expect(REGISTRY.phpstan_level_at_least!({ n: 1 }, mkCtx('empty'))).toBe(false);
  });
});

describe('always_true / command_succeeds / config_value', () => {
  it('always_true', () => {
    expect(REGISTRY.always_true!({}, mkCtx('empty'))).toBe(true);
  });
  it('command_succeeds is a stub returning false', () => {
    expect(REGISTRY.command_succeeds!({}, mkCtx('empty'))).toBe(false);
  });
  it('config_value: present on existing path', () => {
    expect(
      REGISTRY.config_value!(
        { path: 'package.json', jsonpath: 'name' },
        mkCtx('node-with-vitest'),
      ),
    ).toBe(true);
  });
  it('config_value: equals match', () => {
    expect(
      REGISTRY.config_value!(
        { path: 'package.json', jsonpath: 'name', equals: 'fixture-node-with-vitest' },
        mkCtx('node-with-vitest'),
      ),
    ).toBe(true);
  });
  it('config_value: missing path returns false', () => {
    expect(
      REGISTRY.config_value!(
        { path: 'package.json', jsonpath: 'no.such.key' },
        mkCtx('node-with-vitest'),
      ),
    ).toBe(false);
  });
});
