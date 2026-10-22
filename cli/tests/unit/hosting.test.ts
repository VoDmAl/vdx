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
  asked: Array<{ path: string; token: string | null; scheme?: 'Bearer' | 'Basic' }>;
}

function fake(opts: {
  origin?: string | null;
  head?: string | null;
  env?: NodeJS.ProcessEnv;
  gh?: string | null;
  glab?: string | null;
  /** Logins git keeps, by host. */
  logins?: Record<string, { username: string; password: string }>;
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
      glabToken: () => opts.glab ?? null,
      gitCredential: (host) => opts.logins?.[host] ?? null,
      get: (apiPath, token, scheme) => {
        asked.push({ path: apiPath, token, ...(scheme ? { scheme } : {}) });
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
    const f = fake({ origin: 'https://ci:secret-token@git.example.com/scm/group/repo.git' });
    const why = reason(branchRequiresChecks(ctx(), f.io));
    expect(why).toMatch(/git\.example\.com — vdx reads GitHub, GitLab and Bitbucket Server/);
    expect(why).not.toMatch(/secret/);
    expect(f.asked).toEqual([]);
  });
});

describe('branch_requires_checks: classic protection', () => {
  it('a check required of everyone — met', () => {
    expect(branchRequiresChecks(ctx(), fake({ answers: branch(FOR_EVERYONE) }).io)).toBe(true);
  });
  it('admins bypass the checks — not met: the agent pushes as the owner, an admin (DL #3)', () => {
    expect(branchRequiresChecks(ctx(), fake({ answers: branch(ADMINS_BYPASS) }).io)).toEqual({
      no: 'main requires checks of everyone but admins — and an agent pushes as its owner, an admin (DL #3), and no ruleset requires checks',
    });
  });
  it('an unprotected branch without rulesets — not met', () => {
    expect(branchRequiresChecks(ctx(), fake({ answers: branch(UNPROTECTED) }).io)).toEqual({
      no: 'main is not protected, and no ruleset requires checks',
    });
  });
  it('everyone, but no check named — not met', () => {
    const none: Answer = {
      status: 200,
      body: {
        protected: true,
        protection: { required_status_checks: { enforcement_level: 'everyone', contexts: [], checks: [] } },
      },
    };
    expect(branchRequiresChecks(ctx(), fake({ answers: branch(none) }).io)).toEqual({
      no: 'main is protected, but names no check it requires, and no ruleset requires checks',
    });
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
    expect(branchRequiresChecks(ctx(), f.io)).toEqual({
      no: 'main is not protected; a ruleset requires checks, but 1 actor(s) may bypass it',
    });
  });
  it('a ruleset without checks counts for nothing', () => {
    const deletion: Answer = { status: 200, body: [{ type: 'deletion', ruleset_id: 7 }] };
    expect(branchRequiresChecks(ctx(), fake({ answers: branch(UNPROTECTED, deletion) }).io)).toEqual({
      no: 'main is not protected, and no ruleset requires checks',
    });
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

describe('branch_requires_checks: GitLab (DL #12)', () => {
  // Shapes of gitlab.finam.ru's answers (GitLab 18.11 EE), 2026-10-20: limeflow,
  // ga-developer-portal, showcase.
  const ORIGIN = 'ssh://git@gitlab.finam.ru:2222/space/limeflow.git';
  const BASE = 'https://gitlab.finam.ru/api/v4/projects/space%2Flimeflow';
  const project = (pipeline: boolean): Answer => ({
    status: 200,
    body: { default_branch: 'main', only_allow_merge_if_pipeline_succeeds: pipeline, merge_method: 'ff' },
  });
  const pushers = (...levels: Array<[number, string]>): Answer => ({
    status: 200,
    body: {
      name: 'main',
      push_access_levels: levels.map(([access_level, access_level_description]) => ({
        access_level,
        access_level_description,
        user_id: null,
        group_id: null,
        deploy_key_id: null,
      })),
      allow_force_push: false,
    },
  });
  const gl = (answers: Record<string, Answer | Error>, glab: string | null = 'glpat-x') =>
    fake({ origin: ORIGIN, glab, answers });

  it('nobody pushes straight to main, and a merge request needs a passing pipeline — met', () => {
    const f = gl({ [BASE]: project(true), [`${BASE}/protected_branches/main`]: pushers([0, 'No one']) });
    expect(branchRequiresChecks(ctx(), f.io)).toBe(true);
    expect(f.asked[0]).toEqual({ path: BASE, token: 'glpat-x' });
  });
  it('Maintainers push straight to main — not met, though merges need a pipeline (limeflow)', () => {
    const f = gl({ [BASE]: project(true), [`${BASE}/protected_branches/main`]: pushers([40, 'Maintainers']) });
    expect(branchRequiresChecks(ctx(), f.io)).toEqual({
      no: 'main takes direct pushes from Maintainers — a push skips the pipeline',
    });
  });
  it('no pipeline needed and admins push too — both named (showcase)', () => {
    const f = gl({
      [BASE]: project(false),
      [`${BASE}/protected_branches/main`]: pushers([60, 'Instance admins'], [40, 'Maintainers']),
    });
    expect(branchRequiresChecks(ctx(), f.io)).toEqual({
      no: 'main takes direct pushes from Instance admins, Maintainers — a push skips the pipeline; merge requests into main do not need a passing pipeline',
    });
  });
  it('an unprotected branch — not met', () => {
    const f = gl({
      [BASE]: project(true),
      [`${BASE}/protected_branches/main`]: { status: 404, body: { message: '404 Not found' } },
    });
    expect(branchRequiresChecks(ctx(), f.io)).toEqual({ no: 'main is not protected' });
  });
  it('a private project without a token — unknown, and how to log in', () => {
    const f = gl({ [BASE]: { status: 404, body: { message: '404 Project Not Found' } } }, null);
    expect(reason(branchRequiresChecks(ctx(), f.io))).toBe(
      'gitlab.finam.ru does not show space/limeflow without a token — private? glab auth login --hostname gitlab.finam.ru, or GITLAB_TOKEN',
    );
  });
  it('GITLAB_TOKEN goes to GITLAB_HOST only — never to a host an origin names', () => {
    const answers = {
      'https://code.example.org/api/v4/projects/team%2Fapp': project(true),
      'https://code.example.org/api/v4/projects/team%2Fapp/protected_branches/main': pushers([0, 'No one']),
    };
    const elsewhere = fake({ origin: 'git@code.example.org:team/app.git', env: { GITLAB_TOKEN: 'env-t' }, answers });
    expect(reason(branchRequiresChecks(ctx(), elsewhere.io))).toMatch(
      /code\.example\.org — vdx reads GitHub, GitLab and Bitbucket Server/,
    );
    expect(elsewhere.asked).toEqual([]);
    const named = fake({
      origin: 'git@gitlab.evil.example:team/app.git',
      env: { GITLAB_TOKEN: 'env-t' },
      answers: { 'https://gitlab.evil.example/api/v4/projects/team%2Fapp': project(true) },
    });
    branchRequiresChecks(ctx(), named.io);
    expect(named.asked[0]).toEqual({ path: 'https://gitlab.evil.example/api/v4/projects/team%2Fapp', token: null });
    const own = fake({
      origin: 'git@code.example.org:team/app.git',
      env: { GITLAB_TOKEN: 'env-t', GITLAB_HOST: 'https://code.example.org' },
      answers,
    });
    expect(branchRequiresChecks(ctx(), own.io)).toBe(true);
    expect(own.asked[0]!.token).toBe('env-t');
  });
  it('GITLAB_TOKEN before glab on its host; a host without gitlab in its name counts when glab knows it', () => {
    const env = fake({
      origin: 'git@code.example.org:team/app.git',
      env: { GITLAB_TOKEN: 'env-t', GITLAB_HOST: 'code.example.org' },
      glab: 'glab-t',
      answers: {
        'https://code.example.org/api/v4/projects/team%2Fapp': project(true),
        'https://code.example.org/api/v4/projects/team%2Fapp/protected_branches/main': pushers([0, 'No one']),
      },
    });
    expect(branchRequiresChecks(ctx(), env.io)).toBe(true);
    expect(env.asked[0]!.token).toBe('env-t');
    const unknownHost = fake({ origin: 'git@code.example.org:team/app.git' });
    expect(reason(branchRequiresChecks(ctx(), unknownHost.io))).toMatch(
      /code\.example\.org — vdx reads GitHub, GitLab and Bitbucket Server/,
    );
  });
  it('no answer from the host', () => {
    const f = gl({ [BASE]: new Error('ETIMEDOUT') });
    expect(reason(branchRequiresChecks(ctx(), f.io))).toBe('gitlab.finam.ru did not answer: ETIMEDOUT');
  });
});

describe('branch_requires_checks: Bitbucket Server (DL #16, #17)', () => {
  // Shapes of git.finam.ru's answers (Bitbucket 5.16.1), 2026-10-20: kratos, global-auth,
  // tx-auth-widget.
  const ORIGIN = 'ssh://git@git.finam.ru:7999/wt/kratos.git';
  const ABOUT = 'https://git.finam.ru/rest/api/1.0/application-properties';
  const API = 'https://git.finam.ru/rest/api/1.0/projects/wt/repos/kratos';
  const HOOKS = `${API}/settings/hooks?type=PRE_PULL_REQUEST_MERGE&limit=100`;
  const RESTRICTIONS =
    'https://git.finam.ru/rest/branch-permissions/2.0/projects/wt/repos/kratos/restrictions?limit=100';
  const LOGIN = { 'git.finam.ru': { username: 'owner', password: 'secret' } };
  const BASIC = Buffer.from('owner:secret').toString('base64');
  const BITBUCKET: Answer = {
    status: 200,
    body: { version: '5.16.1', buildNumber: '5016001', displayName: 'Bitbucket' },
  };
  const DENIED: Answer = {
    status: 401,
    body: {
      errors: [
        {
          context: null,
          message: 'You are not permitted to access this resource',
          exceptionName: 'com.atlassian.bitbucket.AuthorisationException',
        },
      ],
    },
  };
  const hooks = (builds: boolean): Answer => ({
    status: 200,
    body: {
      size: 2,
      isLastPage: true,
      values: [
        {
          details: { key: 'com.atlassian.bitbucket.server.bitbucket-bundled-hooks:requiredApproversMergeHook' },
          enabled: true,
          configured: true,
        },
        {
          details: {
            key: 'com.atlassian.bitbucket.server.bitbucket-build:requiredBuildsMergeCheck',
            name: 'Minimum successful builds',
          },
          enabled: builds,
          configured: builds,
          scope: { type: builds ? 'REPOSITORY' : 'PROJECT' },
        },
      ],
    },
  });
  const restriction = (type: string, users: string[] = [], matcher = 'BRANCH') => ({
    id: 530,
    type,
    matcher: { id: 'refs/heads/master', displayId: 'master', type: { id: matcher, name: matcher }, active: true },
    users: users.map((name) => ({ name, slug: name, displayName: name })),
    groups: [],
    accessKeys: [],
    scope: { type: 'REPOSITORY', resourceId: 4218 },
  });
  const restrictions = (...values: unknown[]): Answer => ({
    status: 200,
    body: { size: values.length, limit: 100, isLastPage: true, values, start: 0 },
  });
  const bb = (answers: Record<string, Answer | Error>, more: Parameters<typeof fake>[0] = {}) =>
    fake({
      origin: ORIGIN,
      head: 'origin/master',
      logins: LOGIN,
      answers: { [ABOUT]: BITBUCKET, ...answers },
      ...more,
    });

  it('nothing reaches master but a pull request, and a pull request needs a build — met', () => {
    const f = bb({ [HOOKS]: hooks(true), [RESTRICTIONS]: restrictions(restriction('pull-request-only')) });
    expect(branchRequiresChecks(ctx(), f.io)).toBe(true);
    expect(f.asked).toEqual([
      { path: ABOUT, token: null },
      { path: HOOKS, token: BASIC, scheme: 'Basic' },
      { path: RESTRICTIONS, token: BASIC, scheme: 'Basic' },
    ]);
  });
  it('master is not restricted and needs no build — not met, both named (kratos)', () => {
    const f = bb({ [HOOKS]: hooks(false), [RESTRICTIONS]: restrictions() });
    expect(branchRequiresChecks(ctx(), f.io)).toEqual({
      no: 'master is not restricted — whoever may write pushes to it; pull requests into master need no successful build',
    });
  });
  it('read-only with exempt users — they push past the build: not met (global-auth)', () => {
    const f = bb({
      [HOOKS]: hooks(true),
      [RESTRICTIONS]: restrictions(restriction('read-only', ['wt-deploy', 'dpzhuravlev'])),
    });
    expect(branchRequiresChecks(ctx(), f.io)).toEqual({
      no: 'master takes changes without a pull request from wt-deploy, dpzhuravlev — they skip the build',
    });
  });
  it('a restriction without exemptions guards the branch even beside one with them', () => {
    const f = bb({
      [HOOKS]: hooks(true),
      [RESTRICTIONS]: restrictions(restriction('read-only', ['wt-deploy']), restriction('pull-request-only')),
    });
    expect(branchRequiresChecks(ctx(), f.io)).toBe(true);
  });
  it('not a repository admin, and no build needed — not met without the restrictions (tx-auth-widget)', () => {
    const f = bb({ [HOOKS]: hooks(false), [RESTRICTIONS]: DENIED });
    expect(branchRequiresChecks(ctx(), f.io)).toEqual({ no: 'pull requests into master need no successful build' });
  });
  it('not a repository admin, and a build needed — unknown: who may change master', () => {
    const f = bb({ [HOOKS]: hooks(true), [RESTRICTIONS]: DENIED });
    expect(reason(branchRequiresChecks(ctx(), f.io))).toBe(
      'git.finam.ru shows who may change master of wt/kratos only to a repository admin',
    );
  });
  it('a restriction by pattern may cover master — unknown, not a guess', () => {
    const f = bb({
      [HOOKS]: hooks(true),
      [RESTRICTIONS]: restrictions(restriction('pull-request-only', [], 'PATTERN')),
    });
    expect(reason(branchRequiresChecks(ctx(), f.io))).toMatch(/by pattern or branching model .* may cover master/);
  });
  it('no login git keeps — unknown, and how vdx tells Bitbucket; nothing asked', () => {
    const f = bb({}, { logins: {} });
    expect(reason(branchRequiresChecks(ctx(), f.io))).toBe(
      'origin is on git.finam.ru — vdx reads GitHub, GitLab and Bitbucket Server, the last once git keeps a login for it or BITBUCKET_HOST names it',
    );
    expect(f.asked).toEqual([]);
  });
  it('BITBUCKET_HOST names it, but no login — unknown, and how to log in once', () => {
    const f = bb({ [HOOKS]: DENIED }, { logins: {}, env: { BITBUCKET_HOST: 'git.finam.ru' } });
    expect(reason(branchRequiresChecks(ctx(), f.io))).toBe(
      'git.finam.ru shows wt/kratos only after a login — once: git ls-remote https://git.finam.ru/scm/wt/kratos.git, a token as the password; or BITBUCKET_TOKEN with BITBUCKET_HOST',
    );
  });
  it('the login taken, without access to the repository — unknown, and no second question', () => {
    const f = bb({ [HOOKS]: DENIED, [RESTRICTIONS]: DENIED });
    expect(reason(branchRequiresChecks(ctx(), f.io))).toBe(
      'git.finam.ru refused wt/kratos to the login git keeps — it has no access to the repository',
    );
    expect(f.asked.map((a) => a.path)).toEqual([ABOUT, HOOKS]);
  });
  it('the login refused — unknown, how to erase it and log in again; no second try (Sidetrack #11)', () => {
    // A login git.finam.ru refuses, 2026-10-22: a user it does not know, Basic.
    const REFUSED: Answer = {
      status: 401,
      body: {
        errors: [
          {
            context: null,
            message: 'Authentication failed. Please check your credentials and try again.',
            exceptionName: 'com.atlassian.bitbucket.auth.IncorrectPasswordAuthenticationException',
          },
        ],
      },
    };
    const f = bb({ [HOOKS]: REFUSED, [RESTRICTIONS]: REFUSED });
    expect(reason(branchRequiresChecks(ctx(), f.io))).toBe(
      "git.finam.ru refused the login git keeps for it, and every audit sends it again — each refusal brings the account nearer a CAPTCHA; erase it: printf 'protocol=https\\nhost=git.finam.ru\\n\\n' | git credential reject — and log in once more: git ls-remote https://git.finam.ru/scm/wt/kratos.git, a token as the password",
    );
    expect(f.asked.map((a) => a.path)).toEqual([ABOUT, HOOKS]);
    const env = bb(
      { [HOOKS]: REFUSED },
      { logins: {}, env: { BITBUCKET_TOKEN: 'env-t', BITBUCKET_HOST: 'git.finam.ru' } },
    );
    expect(reason(branchRequiresChecks(ctx(), env.io))).toBe(
      'git.finam.ru refused BITBUCKET_TOKEN: Authentication failed. Please check your credentials and try again.',
    );
  });
  it('BITBUCKET_TOKEN without access — or one the host does not know, which it takes for no login', () => {
    const f = bb(
      { [HOOKS]: DENIED },
      { logins: {}, env: { BITBUCKET_TOKEN: 'env-t', BITBUCKET_HOST: 'git.finam.ru' } },
    );
    expect(reason(branchRequiresChecks(ctx(), f.io))).toBe(
      'git.finam.ru refused wt/kratos to BITBUCKET_TOKEN — no access, or a token it does not know: it takes one for no login',
    );
  });
  it('a host with a login that is not Bitbucket gets no login', () => {
    const f = fake({
      origin: 'https://git.example.com/team/app.git',
      logins: { 'git.example.com': LOGIN['git.finam.ru'] },
    });
    expect(reason(branchRequiresChecks(ctx(), f.io))).toMatch(
      /git\.example\.com — vdx reads GitHub, GitLab and Bitbucket Server/,
    );
    expect(f.asked).toEqual([{ path: 'https://git.example.com/rest/api/1.0/application-properties', token: null }]);
  });
  it('BITBUCKET_TOKEN goes to BITBUCKET_HOST only, before the login git keeps', () => {
    const answers = { [HOOKS]: hooks(true), [RESTRICTIONS]: restrictions(restriction('pull-request-only')) };
    const own = bb(answers, { env: { BITBUCKET_TOKEN: 'env-t', BITBUCKET_HOST: 'https://git.finam.ru' } });
    expect(branchRequiresChecks(ctx(), own.io)).toBe(true);
    expect(own.asked[1]).toEqual({ path: HOOKS, token: 'env-t', scheme: 'Bearer' });
    const other = bb(answers, {
      env: { BITBUCKET_TOKEN: 'env-t', BITBUCKET_HOST: 'bitbucket.example.org' },
      logins: {},
    });
    branchRequiresChecks(ctx(), other.io);
    expect(other.asked.every((a) => a.token === null)).toBe(true);
  });
  it('an https origin: /scm/ is not the project; the branch from the server when the clone does not know it', () => {
    const f = bb(
      {
        [`${API}/branches/default`]: {
          status: 200,
          body: { id: 'refs/heads/master', displayId: 'master', isDefault: true },
        },
        [HOOKS]: hooks(true),
        [RESTRICTIONS]: restrictions(restriction('pull-request-only')),
      },
      { origin: 'https://git.finam.ru/scm/wt/kratos.git', head: null },
    );
    expect(branchRequiresChecks(ctx(), f.io)).toBe(true);
    expect(f.asked[1]!.path).toBe(`${API}/branches/default`);
  });
  it('no answer from the host', () => {
    const f = bb({ [ABOUT]: new Error('ECONNREFUSED') });
    expect(reason(branchRequiresChecks(ctx(), f.io))).toBe('git.finam.ru did not answer: ECONNREFUSED');
  });
});
