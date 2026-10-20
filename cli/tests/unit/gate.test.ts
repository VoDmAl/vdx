import { describe, expect, it } from 'vitest';
import { planGate, pushThroughGate, type GateDeps, type GateTarget } from '../../src/gate.ts';
import type { Answer, HostingIo } from '../../src/hosting.ts';

const SHA = 'a43b981f0c2e4d5b6a7980123456789abcdef012';
const BASE = '/repos/owner/repo';

// Shapes of GitHub's answers (branches and rules: hosting.test.ts; check runs of 1af1102, 2026-10-18).
const PROTECTED: Answer = {
  status: 200,
  body: {
    protected: true,
    protection: {
      enabled: true,
      required_status_checks: {
        enforcement_level: 'everyone',
        contexts: ['cli (node 22)', 'cli (node 24)'],
        checks: [{ context: 'cli (node 22)' }, { context: 'cli (node 24)' }],
      },
    },
  },
};
const UNPROTECTED: Answer = {
  status: 200,
  body: { protected: false, protection: { required_status_checks: { enforcement_level: 'off', contexts: [] } } },
};
const NO_RULES: Answer = { status: 200, body: [] };

const run = (id: number, name: string, status: string, conclusion: string | null = null) => ({
  id,
  name,
  status,
  conclusion,
  html_url: `https://github.com/owner/repo/actions/runs/1/job/${id}`,
});
const runs = (...r: ReturnType<typeof run>[]): Answer => ({
  status: 200,
  body: { total_count: r.length, check_runs: r },
});
const QUEUED = runs(run(1, 'cli (node 22)', 'queued'), run(2, 'cli (node 24)', 'queued'));
const RUNNING = runs(run(1, 'cli (node 22)', 'in_progress'), run(2, 'cli (node 24)', 'completed', 'success'));
const GREEN = runs(run(1, 'cli (node 22)', 'completed', 'success'), run(2, 'cli (node 24)', 'completed', 'success'));
const RED = runs(run(1, 'cli (node 22)', 'completed', 'failure'), run(2, 'cli (node 24)', 'completed', 'success'));
const NOT_THERE: Answer = { status: 422, body: { message: `No commit found for SHA: ${SHA}` } };

type Reply = Answer | Error;

interface Fake {
  io: HostingIo;
  asked: string[];
}

/** Answers by path; a list is answered in turn, its last answer from then on. */
function fake(opts: {
  git?: Record<string, string | null>;
  env?: NodeJS.ProcessEnv;
  answers?: Record<string, Reply | Reply[]>;
}): Fake {
  const asked: string[] = [];
  const git: Record<string, string | null> = {
    'symbolic-ref --quiet --short HEAD': 'main',
    'config --get branch.main.remote': 'origin',
    'config --get branch.main.merge': 'refs/heads/main',
    'remote get-url origin': 'git@github.com:owner/repo.git',
    'rev-list --count HEAD..@{u}': '0',
    'rev-parse HEAD': SHA,
    'rev-parse @{u}': '1564059aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ...opts.git,
  };
  const turns: Record<string, number> = {};
  return {
    asked,
    io: {
      env: opts.env ?? {},
      git: (args) => git[args.join(' ')] ?? null,
      ghToken: () => null,
      glabToken: () => null,
      get: (apiPath) => {
        asked.push(apiPath);
        const a = opts.answers?.[apiPath];
        const reply = Array.isArray(a) ? a[Math.min((turns[apiPath] = (turns[apiPath] ?? -1) + 1), a.length - 1)] : a;
        if (reply instanceof Error) throw reply;
        return reply ?? { status: 404, body: { message: 'Not Found' } };
      },
    },
  };
}

const protectedBranch = (more: Record<string, Reply | Reply[]> = {}) => ({
  [`${BASE}/branches/main`]: PROTECTED,
  [`${BASE}/rules/branches/main`]: NO_RULES,
  ...more,
});
const checksPath = `${BASE}/commits/${SHA}/check-runs?per_page=100`;

const TARGET: GateTarget = {
  remote: 'origin',
  branch: 'main',
  repo: 'owner/repo',
  token: null,
  checks: ['cli (node 22)', 'cli (node 24)'],
};

function deps(f: Fake): GateDeps & { pushes: string[][]; logs: string[] } {
  const pushes: string[][] = [];
  const logs: string[] = [];
  let clock = 0;
  return {
    pushes,
    logs,
    io: f.io,
    push: (args) => pushes.push(args),
    log: (l) => logs.push(l),
    sleep: (ms) => (clock += ms),
    now: () => clock,
    pollMs: 15_000,
    timeoutMs: 20 * 60_000,
  };
}

describe('planGate: which way the push goes', () => {
  it('a branch that requires checks: through them, with GitHub’s names for them', () => {
    expect(planGate(fake({ answers: protectedBranch() }).io)).toEqual({ kind: 'gate', target: TARGET });
  });
  it('the checks of a ruleset count too, each name once', () => {
    const rules: Answer = {
      status: 200,
      body: [
        {
          type: 'required_status_checks',
          ruleset_id: 9,
          parameters: { required_status_checks: [{ context: 'cli (node 24)' }, { context: 'lint' }] },
        },
      ],
    };
    const plan = planGate(fake({ answers: protectedBranch({ [`${BASE}/rules/branches/main`]: rules }) }).io);
    expect(plan.kind === 'gate' && plan.target.checks).toEqual(['cli (node 22)', 'cli (node 24)', 'lint']);
  });
  it('a branch that requires nothing: a plain git push', () => {
    const f = fake({ answers: { [`${BASE}/branches/main`]: UNPROTECTED, [`${BASE}/rules/branches/main`]: NO_RULES } });
    expect(planGate(f.io)).toEqual({ kind: 'plain', why: 'origin/main requires no checks' });
  });
  it('a remote not on GitHub, or VDX_OFFLINE: a plain git push, and why', () => {
    const gitolite = fake({ git: { 'remote get-url origin': 'vdm@git.vorobyev.name:telegram.vorobyev.name' } });
    expect(planGate(gitolite.io)).toEqual({
      kind: 'plain',
      why: 'origin is on git.vorobyev.name — vdx reads GitHub only',
    });
    expect(gitolite.asked).toEqual([]);
    expect(planGate(fake({ env: { VDX_OFFLINE: '1' } }).io)).toMatchObject({ kind: 'plain', why: /VDX_OFFLINE/ });
  });
  it('GitHub does not answer: a plain git push — the branch itself refuses what it would not take', () => {
    const limit: Answer = { status: 403, body: { message: 'API rate limit exceeded for 192.0.2.1.' } };
    expect(planGate(fake({ answers: { [`${BASE}/branches/main`]: limit } }).io)).toMatchObject({
      kind: 'plain',
      why: /rate limit is spent/,
    });
    const offline = fake({ answers: { [`${BASE}/branches/main`]: new Error('ENOTFOUND') } });
    expect(planGate(offline.io)).toEqual({ kind: 'plain', why: 'GitHub did not answer: ENOTFOUND' });
  });
  it('no branch, no upstream, or behind it: nowhere to push', () => {
    expect(planGate(fake({ git: { 'symbolic-ref --quiet --short HEAD': null } }).io)).toMatchObject({
      kind: 'refuse',
      message: /not on a branch/,
    });
    expect(planGate(fake({ git: { 'config --get branch.main.remote': null } }).io)).toEqual({
      kind: 'refuse',
      message: 'main has no upstream — git push -u <remote> main',
    });
    const behind = fake({ git: { 'rev-list --count HEAD..@{u}': '2' }, answers: protectedBranch() });
    expect(planGate(behind.io)).toMatchObject({ kind: 'refuse', message: /origin\/main has 2 commit\(s\)/ });
  });
});

describe('pushThroughGate', () => {
  it('the gate branch, the wait, then the same commit to the branch with its tags', () => {
    const f = fake({ answers: { [checksPath]: [QUEUED, RUNNING, GREEN] } });
    const d = deps(f);
    pushThroughGate(TARGET, d);
    expect(d.pushes).toEqual([
      ['push', '--force', 'origin', `${SHA}:refs/heads/vdx-gate/main`],
      ['push', '--follow-tags', 'origin', `${SHA}:refs/heads/main`],
    ]);
    // Not asked before the push — the commit is not on GitHub yet; then every 15 s.
    expect(f.asked.filter((p) => p === checksPath)).toHaveLength(3);
    expect(d.logs.join('\n')).toContain(`https://github.com/owner/repo/commit/${SHA}/checks`);
    expect(d.logs.join('\n')).toMatch(/✓ cli \(node 22\), cli \(node 24\) passed \(45 s\)/);
    expect(d.logs.at(-1)).toBe('✓ origin/main is at a43b981');
  });
  it('a commit GitHub does not show yet, seconds after the push, is waited for — the first live push stopped there', () => {
    const f = fake({ answers: { [checksPath]: [NOT_THERE, NOT_THERE, RUNNING, GREEN] } });
    const d = deps(f);
    pushThroughGate(TARGET, d);
    expect(d.pushes.map((p) => p[3])).toEqual([`${SHA}:refs/heads/vdx-gate/main`, `${SHA}:refs/heads/main`]);
    expect(d.logs.join('\n')).toMatch(/passed \(60 s\)/); // asked at 15, 30, 45 and 60 s
  });
  it('a second vdx push of a commit whose checks passed on the gate branch: to the branch at once', () => {
    const onGate = { 'rev-parse --verify --quiet refs/remotes/origin/vdx-gate/main': SHA };
    const d = deps(fake({ git: onGate, answers: { [checksPath]: GREEN } }));
    pushThroughGate(TARGET, d);
    expect(d.pushes).toEqual([['push', '--follow-tags', 'origin', `${SHA}:refs/heads/main`]]);
    // Still running there: pushed to the gate branch again (a no-op for git) and waited for.
    const running = deps(fake({ git: onGate, answers: { [checksPath]: [RUNNING, GREEN] } }));
    pushThroughGate(TARGET, running);
    expect(running.pushes.map((p) => p[3])).toEqual([`${SHA}:refs/heads/vdx-gate/main`, `${SHA}:refs/heads/main`]);
  });
  it('a failed check: the branch is left as it was, and the check is named with its link', () => {
    const d = deps(fake({ answers: { [checksPath]: [NOT_THERE, RED] } }));
    expect(() => pushThroughGate(TARGET, d)).toThrow(
      'cli (node 22) — failure (https://github.com/owner/repo/actions/runs/1/job/1): main did not take a43b981',
    );
    expect(d.pushes).toHaveLength(1); // the gate branch only
  });
  it('checks that do not finish in time: the branch is left, and how to go on', () => {
    const d = deps(fake({ answers: { [checksPath]: [NOT_THERE, RUNNING] } }));
    expect(() => pushThroughGate(TARGET, { ...d, timeoutMs: 60_000 })).toThrow(
      /cli \(node 22\): in progress, cli \(node 24\): success after 1 min — main did not take a43b981; once they pass: vdx push/,
    );
    expect(d.pushes).toHaveLength(1);
  });
  it('no answer at all mid-wait (a timeout) is asked again — the 0.32.0 release push stopped on one', () => {
    const d = deps(fake({ answers: { [checksPath]: [RUNNING, new Error('spawnSync node ETIMEDOUT'), GREEN] } }));
    pushThroughGate(TARGET, d);
    expect(d.pushes.at(-1)).toEqual(['push', '--follow-tags', 'origin', `${SHA}:refs/heads/main`]);
    expect(d.logs.join('\n')).toContain('GitHub did not answer: spawnSync node ETIMEDOUT; asking again');
  });
  it('no answer for the whole wait: stopped, with the last reason', () => {
    const d = deps(fake({ answers: { [checksPath]: new Error('ENOTFOUND') } }));
    expect(() => pushThroughGate(TARGET, { ...d, timeoutMs: 60_000 })).toThrow(
      /GitHub did not answer: ENOTFOUND after 1 min — main did not take a43b981/,
    );
  });
  it('GitHub stops answering mid-wait: the reason, and how to go on', () => {
    const limit: Answer = { status: 403, body: { message: 'API rate limit exceeded for 192.0.2.1.' } };
    const d = deps(fake({ answers: { [checksPath]: [NOT_THERE, limit] } }));
    expect(() => pushThroughGate(TARGET, d)).toThrow(
      /rate limit is spent .* main did not take a43b981; once they pass: vdx push/,
    );
  });
  it('the newest run of a check counts: a re-run that passed', () => {
    const rerun = runs(
      run(1, 'cli (node 22)', 'completed', 'failure'),
      run(3, 'cli (node 22)', 'completed', 'success'),
      run(2, 'cli (node 24)', 'completed', 'success'),
    );
    const d = deps(fake({ answers: { [checksPath]: rerun } }));
    pushThroughGate(TARGET, d);
    expect(d.pushes.at(-1)).toEqual(['push', '--follow-tags', 'origin', `${SHA}:refs/heads/main`]);
  });
  it('a check an outside CI reports as a commit status', () => {
    const status: Answer = {
      status: 200,
      body: { state: 'success', statuses: [{ context: 'ci/jenkins', state: 'success', target_url: 'https://ci' }] },
    };
    const d = deps(fake({ answers: { [checksPath]: runs(), [`${BASE}/commits/${SHA}/status`]: status } }));
    pushThroughGate({ ...TARGET, checks: ['ci/jenkins'] }, d);
    expect(d.pushes.at(-1)).toEqual(['push', '--follow-tags', 'origin', `${SHA}:refs/heads/main`]);
  });
  it('the upstream at HEAD already: nothing to push', () => {
    const d = deps(fake({ git: { 'rev-parse @{u}': SHA } }));
    pushThroughGate(TARGET, d);
    expect(d.pushes).toEqual([]);
    expect(d.logs).toEqual(['✓ origin/main is at a43b981 already — nothing to push']);
  });
});
