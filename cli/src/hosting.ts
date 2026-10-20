import { execFileSync } from 'node:child_process';
import { remoteParts } from './author.ts';
import type { Ctx } from './facts.ts';
import { at, errorMessage, list, str } from './narrow.ts';
import type { Unknown, Verdict } from './predicates.ts';

/** One answer of a hosting's API: its status and its body, parsed (null when not JSON). */
export interface Answer {
  status: number;
  body: unknown;
}

/** What the check needs from outside — the machine's own below, recorded answers in the tests. */
export interface HostingIo {
  env: NodeJS.ProcessEnv;
  /** `git <args>` in the project, trimmed; null when git fails. */
  git: (args: string[]) => string | null;
  /** The token `gh` keeps; null without gh or a login. */
  ghToken: () => string | null;
  /** The token `glab` keeps for a GitLab host; null without glab or a login there. */
  glabToken: (host: string) => string | null;
  /** GET of an api.github.com path, or of a whole https:// URL. Throws when no answer came at all. */
  get: (apiPath: string, token: string | null) => Answer;
}

// A child node runs the request: the audit is synchronous and fetch is not
// (DL #6 of docs/tasks/hosting-extension). The token travels in its
// environment, not its arguments — those are visible in ps.
const GET = `
const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'vdx' };
if (process.env.VDX_HOSTING_TOKEN) headers.authorization = 'Bearer ' + process.env.VDX_HOSTING_TOKEN;
try {
  const r = await fetch(process.argv[1], { headers, signal: AbortSignal.timeout(15000) });
  process.stdout.write(JSON.stringify({ status: r.status, text: await r.text() }));
} catch (e) {
  process.stdout.write(JSON.stringify({ error: String(e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e) }));
}
`;

function get(apiPath: string, token: string | null): Answer {
  const env = { ...process.env };
  delete env.VDX_HOSTING_TOKEN;
  if (token) env.VDX_HOSTING_TOKEN = token;
  const url = apiPath.startsWith('https://') ? apiPath : `https://api.github.com${apiPath}`;
  const out: unknown = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', GET, url], {
      encoding: 'utf8',
      env,
      // node's own start counts too: at a load of ~7 on lft 10 s ran out (2026-10-20).
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  );
  const error = str(at(out, 'error'));
  if (error !== undefined) throw new Error(error);
  const status = at(out, 'status');
  if (typeof status !== 'number') throw new Error('no status in the answer');
  let body: unknown = null;
  try {
    body = JSON.parse(str(at(out, 'text')) ?? '');
  } catch {
    // not JSON: the status says enough
  }
  return { status, body };
}

export function machineIo(root: string): HostingIo {
  const run = (cmd: string, args: string[]): string | null => {
    try {
      return (
        execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim() ||
        null
      );
    } catch {
      return null;
    }
  };
  return {
    env: process.env,
    git: (args) => run('git', ['--no-optional-locks', '-C', root, ...args]),
    ghToken: () => run('gh', ['auth', 'token']),
    glabToken: (host) => run('glab', ['config', 'get', 'token', '--host', host]),
    get,
  };
}

/** A refusal of the API as the reason the answer is unknown; null for a 200. */
function refusal(a: Answer, repo: string, token: string | null): Unknown | null {
  if (a.status === 200) return null;
  const message = str(at(a.body, 'message')) ?? '';
  if ((a.status === 403 || a.status === 429) && message.startsWith('API rate limit exceeded')) {
    return {
      unknown: `GitHub's rate limit is spent${token ? '' : ' — 60 requests an hour without a token; gh auth login, or GH_TOKEN'}`,
    };
  }
  if (a.status === 404 && !token) {
    return { unknown: `GitHub does not show ${repo} without a token — private? gh auth login, or GH_TOKEN` };
  }
  return { unknown: `GitHub answered ${a.status} for ${repo}${message ? `: ${message}` : ''}` };
}

/** Checks a required-status-checks setting names: `checks`, else the older `contexts`. */
function checkCount(setting: unknown): number {
  return Math.max(list(at(setting, 'checks')).length, list(at(setting, 'contexts')).length);
}

function judge(io: HostingIo, repo: string, token: string | null): Verdict {
  let branch = io.git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])?.replace(/^origin\//, '');
  if (!branch) {
    const r = io.get(`/repos/${repo}`, token);
    const refused = refusal(r, repo, token);
    if (refused) return refused;
    branch = str(at(r.body, 'default_branch'));
    if (!branch) return { unknown: `GitHub names no default branch for ${repo}` };
  }
  const ref = encodeURIComponent(branch);

  // Classic protection: the checks are required of everyone, admins too (DL #3).
  const b = io.get(`/repos/${repo}/branches/${ref}`, token);
  const refusedBranch = refusal(b, repo, token);
  if (refusedBranch) return refusedBranch;
  const classic = at(b.body, 'protection', 'required_status_checks');
  const level = at(classic, 'enforcement_level');
  const named = checkCount(classic) > 0;
  if (level === 'everyone' && named) return true;
  // Why not, for the report (DL #11): what classic protection lacks.
  const classicWhy =
    at(b.body, 'protected') !== true
      ? `${branch} is not protected`
      : level === 'non_admins' && named
        ? `${branch} requires checks of everyone but admins — and an agent pushes as its owner, an admin (DL #3)`
        : level === 'everyone'
          ? `${branch} is protected, but names no check it requires`
          : `${branch} is protected without required checks`;

  // Rulesets: a rule that requires checks, in a ruleset nobody bypasses.
  const rules = io.get(`/repos/${repo}/rules/branches/${ref}`, token);
  const refusedRules = refusal(rules, repo, token);
  if (refusedRules) return refusedRules;
  let hidden = false;
  let bypassers = 0;
  for (const rule of list(rules.body)) {
    if (at(rule, 'type') !== 'required_status_checks') continue;
    if (list(at(rule, 'parameters', 'required_status_checks')).length === 0) continue;
    const id = at(rule, 'ruleset_id');
    const ruleset = typeof id === 'number' ? io.get(`/repos/${repo}/rulesets/${id}`, token) : null;
    const bypass = ruleset?.status === 200 ? at(ruleset.body, 'bypass_actors') : undefined;
    if (!Array.isArray(bypass)) hidden = true;
    else if (bypass.length === 0) return true;
    else bypassers = Math.max(bypassers, bypass.length);
  }
  if (hidden) {
    return {
      unknown: `a ruleset requires checks on ${branch}, but GitHub shows who bypasses it only to ${token ? 'a repository admin' : 'a token; gh auth login, or GH_TOKEN'}`,
    };
  }
  return {
    no:
      bypassers > 0
        ? `${classicWhy}; a ruleset requires checks, but ${bypassers} actor(s) may bypass it`
        : `${classicWhy}, and no ruleset requires checks`,
  };
}

/**
 * Whether the default branch on the hosting of `origin` takes changes only after a check
 * required of everyone. GitHub and GitLab; what vdx cannot ask is unknown, with the reason.
 */
export function branchRequiresChecks(ctx: Ctx, io: HostingIo = machineIo(ctx.projectRoot)): Verdict {
  const key = 'hosting:branch-requires-checks';
  if (ctx.cache.has(key)) return ctx.cache.get(key) as Verdict;
  const verdict = ask(io);
  ctx.cache.set(key, verdict);
  return verdict;
}

function ask(io: HostingIo): Verdict {
  const gh = githubRepo(io, 'origin');
  if (!isUnknownRepo(gh)) {
    try {
      return judge(io, gh.repo, gh.token);
    } catch (e) {
      return { unknown: `GitHub did not answer: ${errorMessage(e)}` };
    }
  }
  if (io.env.VDX_OFFLINE) return gh;
  const url = io.git(['remote', 'get-url', 'origin']);
  if (!url) return gh;
  const { host, path: repo } = remoteParts(url);
  // GitLab: the host GITLAB_HOST names, one glab has a token for (gitlab.finam.ru, DL #12),
  // or one with gitlab in its name. A token goes only where it belongs: GITLAB_TOKEN to
  // GITLAB_HOST, as glab sends it; glab's to its own host. Any other host is asked without
  // one — an origin is the repository's to name, and may point anywhere.
  const tokenHost = (io.env.GITLAB_HOST || 'gitlab.com')
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
  const glab = io.glabToken(host);
  const token = (host.toLowerCase() === tokenHost ? io.env.GITLAB_TOKEN : undefined) || glab;
  if (host.toLowerCase() === tokenHost || glab || host.includes('gitlab')) {
    try {
      return judgeGitlab(io, host, repo, token);
    } catch (e) {
      return { unknown: `${host} did not answer: ${errorMessage(e)}` };
    }
  }
  return { unknown: `origin is on ${host || 'a host vdx cannot tell'} — vdx reads GitHub and GitLab` };
}

/** A refusal of a GitLab API as the reason the answer is unknown; null for a 200. */
function gitlabRefusal(a: Answer, host: string, repo: string, token: string | null): Unknown | null {
  if (a.status === 200) return null;
  const message = str(at(a.body, 'message')) ?? str(at(a.body, 'error')) ?? '';
  if (a.status === 429) return { unknown: `${host}'s rate limit is spent` };
  if ((a.status === 401 || a.status === 404) && !token) {
    return {
      unknown: `${host} does not show ${repo} without a token — private? glab auth login --hostname ${host}, or GITLAB_TOKEN`,
    };
  }
  return { unknown: `${host} answered ${a.status} for ${repo}${message ? `: ${message}` : ''}` };
}

/**
 * GitLab: the default branch takes changes only after a pipeline when nobody may push to
 * it directly — a push skips the pipeline — and a merge request needs one that passed
 * (`only_allow_merge_if_pipeline_succeeds`). The agent pushes as the owner (DL #3).
 */
function judgeGitlab(io: HostingIo, host: string, repo: string, token: string | null): Verdict {
  const base = `https://${host}/api/v4/projects/${encodeURIComponent(repo)}`;
  const p = io.get(base, token);
  const refused = gitlabRefusal(p, host, repo, token);
  if (refused) return refused;
  const branch =
    io.git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])?.replace(/^origin\//, '') ||
    str(at(p.body, 'default_branch'));
  if (!branch) return { unknown: `${host} names no default branch for ${repo}` };
  const pipeline = at(p.body, 'only_allow_merge_if_pipeline_succeeds') === true;

  const pb = io.get(`${base}/protected_branches/${encodeURIComponent(branch)}`, token);
  const isProtected = pb.status === 200;
  if (!isProtected && pb.status !== 404) {
    const refusedBranch = gitlabRefusal(pb, host, repo, token);
    if (refusedBranch) return refusedBranch;
  }
  // Who may push straight to the branch: a role above "No one" (0), a user, a group, a deploy key.
  const pushers = list(at(pb.body, 'push_access_levels'))
    .filter(
      (l) =>
        at(l, 'access_level') !== 0 ||
        at(l, 'user_id') != null ||
        at(l, 'group_id') != null ||
        at(l, 'deploy_key_id') != null,
    )
    .map((l) => str(at(l, 'access_level_description')) ?? 'someone');
  if (isProtected && pushers.length === 0 && pipeline) return true;

  const why: string[] = [];
  if (!isProtected) why.push(`${branch} is not protected`);
  else if (pushers.length > 0)
    why.push(`${branch} takes direct pushes from ${pushers.join(', ')} — a push skips the pipeline`);
  if (!pipeline) why.push(`merge requests into ${branch} do not need a passing pipeline`);
  return { no: why.join('; ') };
}

/** A remote's repository on GitHub and the token to ask with; unknown, with the reason, when vdx cannot ask. */
export function githubRepo(io: HostingIo, remote: string): { repo: string; token: string | null } | Unknown {
  if (io.env.VDX_OFFLINE) return { unknown: 'VDX_OFFLINE is set — the hosting was not asked' };
  const url = io.git(['remote', 'get-url', remote]);
  if (!url) return { unknown: `no ${remote} remote — the hosting is not known` };
  const { host, path: repo } = remoteParts(url);
  // The host only: a URL can carry a token.
  if (host !== 'github.com')
    return { unknown: `${remote} is on ${host || 'a host vdx cannot tell'} — vdx reads GitHub only` };
  return { repo, token: githubToken(io)?.token ?? null };
}

/** The token vdx asks GitHub with and where it comes from — `GH_TOKEN`, `GITHUB_TOKEN`, then gh, as gh itself picks. */
export function githubToken(io: HostingIo): { token: string; source: 'GH_TOKEN' | 'GITHUB_TOKEN' | 'gh' } | null {
  if (io.env.GH_TOKEN) return { token: io.env.GH_TOKEN, source: 'GH_TOKEN' };
  if (io.env.GITHUB_TOKEN) return { token: io.env.GITHUB_TOKEN, source: 'GITHUB_TOKEN' };
  const gh = io.ghToken();
  return gh ? { token: gh, source: 'gh' } : null;
}

function isUnknownRepo(v: { repo: string } | Unknown): v is Unknown {
  return 'unknown' in v;
}

/**
 * The checks a branch requires before it takes a commit — of classic protection and of
 * rulesets together, whoever they bind: what GitHub will ask of the commit.
 */
export function requiredChecks(io: HostingIo, repo: string, branch: string, token: string | null): string[] | Unknown {
  const ref = encodeURIComponent(branch);
  const names = new Set<string>();
  const b = io.get(`/repos/${repo}/branches/${ref}`, token);
  const refusedBranch = refusal(b, repo, token);
  if (refusedBranch) return refusedBranch;
  const classic = at(b.body, 'protection', 'required_status_checks');
  if (at(classic, 'enforcement_level') !== 'off') {
    for (const c of list(at(classic, 'checks'))) add(names, at(c, 'context'));
    for (const c of list(at(classic, 'contexts'))) add(names, c);
  }
  const rules = io.get(`/repos/${repo}/rules/branches/${ref}`, token);
  const refusedRules = refusal(rules, repo, token);
  if (refusedRules) return refusedRules;
  for (const rule of list(rules.body)) {
    if (at(rule, 'type') !== 'required_status_checks') continue;
    for (const c of list(at(rule, 'parameters', 'required_status_checks'))) add(names, at(c, 'context'));
  }
  return [...names];
}

function add(names: Set<string>, name: unknown): void {
  const n = str(name);
  if (n) names.add(n);
}

/** Where one required check of a commit stands. */
export interface CheckState {
  name: string;
  state: 'pending' | 'passed' | 'failed';
  /** GitHub's word for it: `in_progress`, `success`, `failure`, `not started`. */
  detail: string;
  url?: string;
}

/**
 * The named checks of a commit: its check runs (GitHub Actions), else its commit
 * statuses (an outside CI). A check that has not reported yet is pending.
 */
export function commitChecks(
  io: HostingIo,
  repo: string,
  sha: string,
  names: string[],
  token: string | null,
): CheckState[] | Unknown {
  const runs = io.get(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`, token);
  // Seconds after a push GitHub may not show the commit yet: 422 «No commit found
  // for SHA» for 106da5f, 15 s after its push to a new branch (2026-10-18).
  if (runs.status === 422 && /^No commit found/.test(str(at(runs.body, 'message')) ?? '')) {
    return names.map((name) => ({ name, state: 'pending', detail: 'not on GitHub yet' }));
  }
  const refusedRuns = refusal(runs, repo, token);
  if (refusedRuns) return refusedRuns;
  // A re-run is a new check run under the same name: the newest one counts.
  const latest = new Map<string, unknown>();
  for (const run of list(at(runs.body, 'check_runs'))) {
    const name = str(at(run, 'name'));
    const id = at(run, 'id');
    if (!name || typeof id !== 'number') continue;
    const seen = at(latest.get(name), 'id');
    if (typeof seen !== 'number' || id > seen) latest.set(name, run);
  }
  let statuses: Map<string, unknown> | null = null;
  const states: CheckState[] = [];
  for (const name of names) {
    const run = latest.get(name);
    if (run !== undefined) {
      const status = str(at(run, 'status')) ?? 'queued';
      const conclusion = str(at(run, 'conclusion')) ?? '';
      const url = str(at(run, 'html_url'));
      const state =
        status !== 'completed'
          ? 'pending'
          : ['success', 'neutral', 'skipped'].includes(conclusion)
            ? 'passed'
            : 'failed';
      states.push({ name, state, detail: status === 'completed' ? conclusion : status, ...(url ? { url } : {}) });
      continue;
    }
    if (statuses === null) {
      const combined = io.get(`/repos/${repo}/commits/${sha}/status`, token);
      const refused = refusal(combined, repo, token);
      if (refused) return refused;
      statuses = new Map();
      for (const s of list(at(combined.body, 'statuses'))) {
        const context = str(at(s, 'context'));
        if (context && !statuses.has(context)) statuses.set(context, s);
      }
    }
    const status = statuses.get(name);
    const word = str(at(status, 'state'));
    const url = str(at(status, 'target_url'));
    states.push({
      name,
      state: word === 'success' ? 'passed' : word === 'failure' || word === 'error' ? 'failed' : 'pending',
      detail: word ?? 'not started',
      ...(url ? { url } : {}),
    });
  }
  return states;
}
