import { describe, expect, it } from 'vitest';
import { branchRequiresChecks, type Answer, type HostingIo } from '../../src/hosting.ts';
import { isUnknown, type Verdict } from '../../src/predicates.ts';
import type { Ctx } from '../../src/facts.ts';

const ctx = (): Ctx => ({ projectRoot: '/nowhere', stack: 'node', cache: new Map() });

// Shapes of the answers GitHub gave on 2026-10-15 (docs/tasks/hosting-extension, DL #2 and #3).
const UNPROTECTED: Answer = {
  status: 200,
  body: {
    protected: false,
    protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } },
  },
};
const FOR_EVERYONE: Answer = {
  status: 200,
  body: {
    protected: true,
    protection: {
      enabled: true,
      required_status_checks: { enforcement_level: 'everyone', contexts: ['test'], checks: [{ context: 'test' }] },
    },
  },
};
const ADMINS_BYPASS: Answer = {
  status: 200,
  body: {
    protected: true,
    protection: {
      enabled: true,
      required_status_checks: { enforcement_level: 'non_admins', contexts: ['build'], checks: [{ context: 'build' }] },
    },
  },
};
const NO_RULES: Answer = { status: 200, body: [] };
const CHECKS_RULE: Answer = {
  status: 200,
  body: [
    { type: 'deletion', ruleset_id: 7 },
    { type: 'required_status_checks', ruleset_id: 9, parameters: { required_status_checks: [{ context: 'test' }] } },
  ],
};

interface Fake {
  io: HostingIo;
  asked: Array<{ path: string; token: string | null }>;
}

function fake(opts: {
  origin?: string | null;
  head?: string | null;
  env?: NodeJS.ProcessEnv;
  gh?: string | null;
  answers?: Record<string, Answer | Error>;
}): Fake {
  const asked: Fake['asked'] = [];
  const origin = opts.origin === undefined ? 'git@github.com:owner/repo.git' : opts.origin;
  const head = opts.head === undefined ? 'origin/main' : opts.head;
  return {
    asked,
    io: {
      env: opts.env ?? {},
      git: (args) => (args[0] === 'remote' ? origin : head),
      ghToken: () => opts.gh ?? null,
      get: (apiPath, token) => {
        asked.push({ path: apiPath, token });
        const a = opts.answers?.[apiPath];
        if (a instanceof Error) throw a;
        return a ?? { status: 404, body: { message: 'Not Found' } };
      },
    },
  };
}

const branch = (a: Answer, rules: Answer = NO_RULES, more: Record<string, Answer | Error> = {}) => ({
  '/repos/owner/repo/branches/main': a,
  '/repos/owner/repo/rules/branches/main': rules,
  ...more,
});

function reason(v: Verdict): string {
  expect(isUnknown(v)).toBe(true);
  return isUnknown(v) ? v.unknown : '';
}

describe('branch_requires_checks: what vdx does not ask', () => {
  it('VDX_OFFLINE: the hosting is not asked', () => {
    const f = fake({ env: { VDX_OFFLINE: '1' } });
    expect(reason(branchRequiresChecks(ctx(), f.io))).toMatch(/VDX_OFFLINE/);
    expect(f.asked).toEqual([]);
  });
  it('no origin remote', () => {
    expect(reason(branchRequiresChecks(ctx(), fake({ origin: null }).io))).toMatch(/no origin remote/);
  });
  it('origin on another hosting: named by its host, without what the URL carries', () => {
    const f = fake({ origin: 'https://ci:secret-token@gitlab.example.com/group/repo.git' });
    const why = reason(branchRequiresChecks(ctx(), f.io));
    expect(why).toMatch(/gitlab\.example\.com — vdx reads GitHub only/);
    expect(why).not.toMatch(/secret/);
    expect(f.asked).toEqual([]);
  });
});

describe('branch_requires_checks: classic protection', () => {
  it('a check required of everyone — met', () => {
    expect(branchRequiresChecks(ctx(), fake({ answers: branch(FOR_EVERYONE) }).io)).toBe(true);
  });
  it('admins bypass the checks — not met: the agent pushes as the owner, an admin (DL #3)', () => {
    expect(branchRequiresChecks(ctx(), fake({ answers: branch(ADMINS_BYPASS) }).io)).toBe(false);
  });
  it('an unprotected branch without rulesets — not met', () => {
    expect(branchRequiresChecks(ctx(), fake({ answers: branch(UNPROTECTED) }).io)).toBe(false);
  });
  it('everyone, but no check named — not met', () => {
    const none: Answer = {
      status: 200,
      body: { protection: { required_status_checks: { enforcement_level: 'everyone', contexts: [], checks: [] } } },
    };
    expect(branchRequiresChecks(ctx(), fake({ answers: branch(none) }).io)).toBe(false);
  });
});

describe('branch_requires_checks: rulesets', () => {
  it('without a token GitHub hides who bypasses — unknown, and the remedy named', () => {
    const f = fake({ answers: branch(UNPROTECTED, CHECKS_RULE) });
    expect(reason(branchRequiresChecks(ctx(), f.io))).toMatch(/who bypasses it .*gh auth login, or GH_TOKEN/);
  });
  it('nobody bypasses — met', () => {
    const f = fake({
      env: { GH_TOKEN: 't' },
      answers: branch(UNPROTECTED, CHECKS_RULE, {
        '/repos/owner/repo/rulesets/9': { status: 200, body: { bypass_actors: [] } },
      }),
    });
    expect(branchRequiresChecks(ctx(), f.io)).toBe(true);
  });
  it('somebody bypasses — not met', () => {
    const f = fake({
      env: { GH_TOKEN: 't' },
      answers: branch(UNPROTECTED, CHECKS_RULE, {
        '/repos/owner/repo/rulesets/9': {
          status: 200,
          body: { bypass_actors: [{ actor_type: 'RepositoryRole', bypass_mode: 'always' }] },
        },
      }),
    });
    expect(branchRequiresChecks(ctx(), f.io)).toBe(false);
  });
  it('a ruleset without checks counts for nothing', () => {
    const deletion: Answer = { status: 200, body: [{ type: 'deletion', ruleset_id: 7 }] };
    expect(branchRequiresChecks(ctx(), fake({ answers: branch(UNPROTECTED, deletion) }).io)).toBe(false);
  });
});

describe('branch_requires_checks: refusals and the branch', () => {
  it('404 without a token: private, and how to log in', () => {
    expect(reason(branchRequiresChecks(ctx(), fake({}).io))).toMatch(
      /does not show owner\/repo without a token — private\? gh auth login, or GH_TOKEN/,
    );
  });
  it('404 with a token: the status and the message', () => {
    expect(reason(branchRequiresChecks(ctx(), fake({ env: { GH_TOKEN: 't' } }).io))).toMatch(
      /GitHub answered 404 for owner\/repo: Not Found/,
    );
  });
  it('the rate limit, without the address GitHub puts in its message', () => {
    const limit: Answer = { status: 403, body: { message: 'API rate limit exceeded for 192.0.2.1. (But here…)' } };
    const why = reason(branchRequiresChecks(ctx(), fake({ answers: branch(limit) }).io));
    expect(why).toMatch(/rate limit is spent — 60 requests an hour without a token/);
    expect(why).not.toMatch(/192\.0\.2\.1/);
  });
  it('no answer at all', () => {
    const f = fake({ answers: { '/repos/owner/repo/branches/main': new Error('ENOTFOUND') } });
    expect(reason(branchRequiresChecks(ctx(), f.io))).toBe('GitHub did not answer: ENOTFOUND');
  });
  it('the branch from origin/HEAD, else the default branch GitHub names', () => {
    const known = fake({ head: 'origin/trunk', answers: {} });
    branchRequiresChecks(ctx(), known.io);
    expect(known.asked[0]!.path).toBe('/repos/owner/repo/branches/trunk');

    const asked = fake({
      head: null,
      answers: {
        '/repos/owner/repo': { status: 200, body: { default_branch: 'master' } },
        '/repos/owner/repo/branches/master': FOR_EVERYONE,
      },
    });
    expect(branchRequiresChecks(ctx(), asked.io)).toBe(true);
    expect(asked.asked.map((a) => a.path)).toEqual(['/repos/owner/repo', '/repos/owner/repo/branches/master']);
  });
  it('the token: GH_TOKEN, then GITHUB_TOKEN, then gh', () => {
    const first = (f: Fake) => (branchRequiresChecks(ctx(), f.io), f.asked[0]!.token);
    expect(first(fake({ env: { GH_TOKEN: 'a', GITHUB_TOKEN: 'b' }, gh: 'c' }))).toBe('a');
    expect(first(fake({ env: { GITHUB_TOKEN: 'b' }, gh: 'c' }))).toBe('b');
    expect(first(fake({ gh: 'c' }))).toBe('c');
    expect(first(fake({}))).toBeNull();
  });
  it('asked once per audit', () => {
    const f = fake({ answers: branch(UNPROTECTED) });
    const c = ctx();
    branchRequiresChecks(c, f.io);
    branchRequiresChecks(c, f.io);
    expect(f.asked).toHaveLength(2); // the branch and its rules, once
  });
});
