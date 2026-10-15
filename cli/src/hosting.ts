import { execFileSync } from 'node:child_process';
import { remoteParts } from './author.ts';
import type { Ctx } from './facts.ts';
import { at, errorMessage, list, str } from './narrow.ts';
import type { Unknown, Verdict } from './predicates.ts';

/** One answer of the GitHub API: its status and its body, parsed (null when not JSON). */
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
  /** GET of an api.github.com path. Throws when no answer came at all. */
  get: (apiPath: string, token: string | null) => Answer;
}

// A child node runs the request: the audit is synchronous and fetch is not
// (DL #6 of docs/tasks/hosting-extension). The token travels in its
// environment, not its arguments — those are visible in ps.
const GET = `
const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'vdx' };
if (process.env.VDX_GITHUB_TOKEN) headers.authorization = 'Bearer ' + process.env.VDX_GITHUB_TOKEN;
try {
  const r = await fetch(process.argv[1], { headers, signal: AbortSignal.timeout(8000) });
  process.stdout.write(JSON.stringify({ status: r.status, text: await r.text() }));
} catch (e) {
  process.stdout.write(JSON.stringify({ error: String(e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e) }));
}
`;

function get(apiPath: string, token: string | null): Answer {
  const env = { ...process.env };
  delete env.VDX_GITHUB_TOKEN;
  if (token) env.VDX_GITHUB_TOKEN = token;
  const out: unknown = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', GET, `https://api.github.com${apiPath}`], {
      encoding: 'utf8',
      env,
      timeout: 10_000,
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

function machineIo(root: string): HostingIo {
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
  if (at(classic, 'enforcement_level') === 'everyone' && checkCount(classic) > 0) return true;

  // Rulesets: a rule that requires checks, in a ruleset nobody bypasses.
  const rules = io.get(`/repos/${repo}/rules/branches/${ref}`, token);
  const refusedRules = refusal(rules, repo, token);
  if (refusedRules) return refusedRules;
  let hidden = false;
  for (const rule of list(rules.body)) {
    if (at(rule, 'type') !== 'required_status_checks') continue;
    if (list(at(rule, 'parameters', 'required_status_checks')).length === 0) continue;
    const id = at(rule, 'ruleset_id');
    const ruleset = typeof id === 'number' ? io.get(`/repos/${repo}/rulesets/${id}`, token) : null;
    const bypass = ruleset?.status === 200 ? at(ruleset.body, 'bypass_actors') : undefined;
    if (!Array.isArray(bypass)) hidden = true;
    else if (bypass.length === 0) return true;
  }
  if (hidden) {
    return {
      unknown: `a ruleset requires checks on ${branch}, but GitHub shows who bypasses it only to ${token ? 'a repository admin' : 'a token; gh auth login, or GH_TOKEN'}`,
    };
  }
  return false;
}

/**
 * Whether the default branch on the hosting of `origin` takes changes only after a check
 * required of everyone. GitHub only; what vdx cannot ask is unknown, with the reason.
 */
export function branchRequiresChecks(ctx: Ctx, io: HostingIo = machineIo(ctx.projectRoot)): Verdict {
  const key = 'hosting:branch-requires-checks';
  if (ctx.cache.has(key)) return ctx.cache.get(key) as Verdict;
  const verdict = ask(io);
  ctx.cache.set(key, verdict);
  return verdict;
}

function ask(io: HostingIo): Verdict {
  if (io.env.VDX_OFFLINE) return { unknown: 'VDX_OFFLINE is set — the hosting was not asked' };
  const url = io.git(['remote', 'get-url', 'origin']);
  if (!url) return { unknown: 'no origin remote — the hosting is not known' };
  const { host, path: repo } = remoteParts(url);
  // The host only: a URL can carry a token.
  if (host !== 'github.com')
    return { unknown: `origin is on ${host || 'a host vdx cannot tell'} — vdx reads GitHub only` };
  const token = io.env.GH_TOKEN || io.env.GITHUB_TOKEN || io.ghToken();
  try {
    return judge(io, repo, token);
  } catch (e) {
    return { unknown: `GitHub did not answer: ${errorMessage(e)}` };
  }
}
