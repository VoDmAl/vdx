/**
 * `vdx push`: a commit reaches a branch that requires checks only once they pass
 * (DL #8–#10 of docs/tasks/hosting-extension). It goes to a gate branch of its own,
 * CI checks it there, and the branch takes the same commit — the same SHA, a linear
 * history. A branch that requires nothing, a remote not on GitHub, a hosting that
 * does not answer: a plain `git push`, as before.
 */
import { execFileSync } from 'node:child_process';
import { commitChecks, githubRepo, machineIo, requiredChecks, type CheckState, type HostingIo } from './hosting.ts';
import { errorMessage } from './narrow.ts';
import type { Unknown } from './predicates.ts';

/** The branch CI checks a commit on before `<branch>` takes it: `vdx-gate/main`. */
export const GATE_PREFIX = 'vdx-gate/';
/** Set for the pushes `vdx push` makes: a pre-push hook that runs what CI runs may step aside. */
const GATE_ENV = 'VDX_GATE_PUSH';

/** Where a push goes, and through what. */
export interface GateTarget {
  remote: string;
  branch: string;
  repo: string;
  token: string | null;
  /** What the branch requires — GitHub's names. */
  checks: string[];
}

export type GatePlan =
  | { kind: 'gate'; target: GateTarget }
  /** Nothing to wait for: `git push` as it is. */
  | { kind: 'plain'; why: string }
  | { kind: 'refuse'; message: string };

function isUnknown(v: object): v is Unknown {
  return 'unknown' in v;
}

/** The current branch, its upstream and what the upstream requires — nothing is fetched. */
export function planGate(io: HostingIo): GatePlan {
  const local = io.git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!local) return { kind: 'refuse', message: 'HEAD is not on a branch — nothing to push it to' };
  const remote = io.git(['config', '--get', `branch.${local}.remote`]);
  const merge = io.git(['config', '--get', `branch.${local}.merge`]);
  if (!remote || !merge?.startsWith('refs/heads/')) {
    return { kind: 'refuse', message: `${local} has no upstream — git push -u <remote> ${local}` };
  }
  const branch = merge.slice('refs/heads/'.length);
  const gh = githubRepo(io, remote);
  if (isUnknown(gh)) return { kind: 'plain', why: gh.unknown };
  let checks: string[] | Unknown;
  try {
    checks = requiredChecks(io, gh.repo, branch, gh.token);
  } catch (e) {
    return { kind: 'plain', why: `GitHub did not answer: ${errorMessage(e)}` };
  }
  if (isUnknown(checks)) return { kind: 'plain', why: checks.unknown };
  if (checks.length === 0) return { kind: 'plain', why: `${remote}/${branch} requires no checks` };
  const behind = parseInt(io.git(['rev-list', '--count', 'HEAD..@{u}']) ?? '0', 10) || 0;
  if (behind > 0) {
    return {
      kind: 'refuse',
      message: `${remote}/${branch} has ${behind} commit(s) this branch lacks — pull first; CI would check a commit ${branch} cannot take`,
    };
  }
  return { kind: 'gate', target: { remote, branch, repo: gh.repo, token: gh.token, checks } };
}

/** What a gated push does outside — the machine's own below, a fake in the tests. */
export interface GateDeps {
  io: HostingIo;
  /** `git <args>` with `VDX_GATE_PUSH=1`, its output on this terminal; throws on a non-zero exit. */
  push: (args: string[]) => void;
  log: (line: string) => void;
  /** Rewrites one status line in place (a terminal); without it the wait logs a line now and then. */
  progress?: (text: string) => void;
  sleep: (ms: number) => void;
  now: () => number;
  /** How often GitHub is asked: its limit is 60 an hour without a token. */
  pollMs: number;
  timeoutMs: number;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function defaultGateDeps(root: string): GateDeps {
  return {
    io: machineIo(root),
    push: (args) => {
      execFileSync('git', ['-C', root, ...args], { stdio: 'inherit', env: { ...process.env, [GATE_ENV]: '1' } });
    },
    log: (line) => process.stderr.write(line + '\n'),
    progress: process.stderr.isTTY ? (text) => process.stderr.write(`\r${text}\x1b[K`) : undefined,
    sleep: sleepSync,
    now: Date.now,
    pollMs: 15_000,
    timeoutMs: 20 * 60_000,
  };
}

const passed = (states: CheckState[]) => states.every((s) => s.state === 'passed');
const brief = (states: CheckState[]) => states.map((s) => `${s.name}: ${s.detail.replace(/_/g, ' ')}`).join(', ');

/**
 * HEAD to the target branch through its checks: the gate branch, the wait, then the
 * branch itself, with the annotated tags on the way (`--follow-tags` — a release's
 * tag). Throws when the branch did not take the commit; the reason names what next.
 */
export function pushThroughGate(t: GateTarget, d: GateDeps): void {
  const sha = d.io.git(['rev-parse', 'HEAD']);
  if (!sha) throw new Error('git rev-parse HEAD failed');
  const short = sha.slice(0, 7);
  const where = `${t.remote}/${t.branch}`;
  if (d.io.git(['rev-parse', '@{u}']) === sha) {
    d.log(`✓ ${where} is at ${short} already — nothing to push`);
    return;
  }
  const names = t.checks.join(', ');
  const link = `https://github.com/${t.repo}/commit/${sha}/checks`;
  const again = `once they pass: vdx push (${link})`;
  // No answer at all — a timeout, the network — is not a refusal: the wait asks again
  // (0.32.0's release push stopped on one ETIMEDOUT at a load of ~7, 2026-10-20).
  let silent: string | null = null;
  const ask = (): CheckState[] | Unknown | null => {
    try {
      silent = null;
      return commitChecks(d.io, t.repo, sha, t.checks, t.token);
    } catch (e) {
      silent = `GitHub did not answer: ${errorMessage(e)}`;
      return null;
    }
  };
  const toBranch = () => {
    d.log(`→ git push --follow-tags ${t.remote} ${short}:${t.branch}`);
    d.push(['push', '--follow-tags', t.remote, `${sha}:refs/heads/${t.branch}`]);
    d.log(`✓ ${where} is at ${short}`);
  };

  const gate = GATE_PREFIX + t.branch;
  // On the gate branch already (a second vdx push) and checked: the branch takes it now.
  // A commit not pushed yet is not asked about — GitHub would only answer 422.
  if (d.io.git(['rev-parse', '--verify', '--quiet', `refs/remotes/${t.remote}/${gate}`]) === sha) {
    const before = ask();
    if (before !== null && !isUnknown(before) && passed(before)) {
      d.log(`✓ ${short} has passed ${names}`);
      toBranch();
      return;
    }
  }

  d.log(`→ git push --force ${t.remote} ${short}:${gate} — ${where} requires ${names}; CI checks the commit there`);
  d.push(['push', '--force', t.remote, `${sha}:refs/heads/${gate}`]);
  d.log(`→ waiting for ${names} on ${short} (asking every ${Math.round(d.pollMs / 1000)} s): ${link}`);

  const started = d.now();
  const seconds = () => Math.round((d.now() - started) / 1000);
  let lastLogged = 0;
  let shown = '';
  for (;;) {
    // Between the asks, count the seconds on one line: a silent wait looks hung.
    const next = d.now() + d.pollMs;
    while (d.now() < next) {
      if (d.progress) d.progress(`  … ${seconds()} s${shown}`);
      else if (seconds() - lastLogged >= 30) {
        lastLogged = seconds();
        d.log(`  … ${lastLogged} s${shown}`);
      }
      d.sleep(1_000);
    }
    const states = ask();
    d.progress?.('');
    if (states === null) {
      if (d.now() - started >= d.timeoutMs) {
        throw new Error(
          `${silent} after ${Math.round(d.timeoutMs / 60_000)} min — ${t.branch} did not take ${short}; ${again}`,
        );
      }
      d.log(`  … ${seconds()} s — ${silent}; asking again`);
      continue;
    }
    if (isUnknown(states)) throw new Error(`${states.unknown} — ${t.branch} did not take ${short}; ${again}`);
    const failed = states.filter((s) => s.state === 'failed');
    if (failed.length > 0) {
      const which = failed.map((s) => `${s.name} — ${s.detail}${s.url ? ` (${s.url})` : ''}`).join('; ');
      throw new Error(`${which}: ${t.branch} did not take ${short}`);
    }
    if (passed(states)) {
      d.log(`✓ ${names} passed (${seconds()} s)`);
      toBranch();
      return;
    }
    if (d.now() - started >= d.timeoutMs) {
      throw new Error(
        `${brief(states)} after ${Math.round(d.timeoutMs / 60_000)} min — ${t.branch} did not take ${short}; ${again}`,
      );
    }
    shown = ` — ${brief(states)}`;
  }
}
