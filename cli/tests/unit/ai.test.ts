import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  type AiDeps,
  type Environment,
  EXIT_DRIFT,
  EXIT_OK,
  EXIT_USAGE,
  Tmux,
  commandLine,
  fallbackAgent,
  findAgentPanes,
  hostLabel,
  isAgentProcess,
  listProcesses,
  missingArgs,
  onPath,
  parseEnvironment,
  parsePanes,
  parsePs,
  planLaunch,
  processTree,
  projectIdentity,
  renderSessionName,
  resolveEnvironmentPath,
  runAi,
  shellQuote,
  sleepSync,
  tmuxShellCommand,
} from '../../src/ai.ts';

const tmpDir = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

const OWNER_LIKE = `
schema_version: "0.1"
agent:
  command: claude
  args: [--dangerously-skip-permissions]
  resume_args: [--continue]
  when:
    - id: echelon-channel
      if: {config_value: {path: signals/sources.yaml, jsonpath: mail.watch}}
      args: [--dangerously-load-development-channels, plugin:echelon@echelon]
      confirm:
        - screen: "Loading development channels"
          keys: [Enter]
session:
  multiplexer: tmux
  name: "{project}@{host}"
`;

describe('resolveEnvironmentPath', () => {
  let home: string;
  beforeEach(() => {
    home = tmpDir('vdx-ai-home-');
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('prefers $VDX_ENVIRONMENT and expands ~', () => {
    expect(resolveEnvironmentPath({ VDX_ENVIRONMENT: '~/sets/env.yaml' }, home)).toBe(
      path.join(home, 'sets', 'env.yaml'),
    );
  });

  it('falls back to ~/.vdx-environment.yaml when it exists', () => {
    expect(resolveEnvironmentPath({}, home)).toBeNull();
    fs.writeFileSync(path.join(home, '.vdx-environment.yaml'), '{}\n');
    expect(resolveEnvironmentPath({}, home)).toBe(path.join(home, '.vdx-environment.yaml'));
  });
});

describe('parseEnvironment', () => {
  it('accepts the owner-shaped profile', () => {
    const env = parseEnvironment(OWNER_LIKE, 'p.yaml');
    expect(env.agent?.command).toBe('claude');
    expect(env.agent?.when?.[0]?.confirm?.[0]?.keys).toEqual(['Enter']);
    expect(env.session?.multiplexer).toBe('tmux');
  });

  it('treats an empty document as an empty profile', () => {
    expect(parseEnvironment('', 'p.yaml')).toEqual({});
  });

  it.each([
    ['agent: {args: [x]}', 'agent.command'],
    ['agent: {command: claude, args: flag}', 'agent.args'],
    ['agent: {command: claude, when: [{id: a}]}', 'agent.when[0].if'],
    ['agent: {command: claude, when: [{id: a, if: true, confirm: [{screen: x, keys: []}]}]}', 'agent.when[0].confirm[0].keys'],
    ['session: {multiplexer: screen}', 'session.multiplexer'],
    ['- just a list', 'top level'],
  ])('rejects %s naming %s', (yaml, key) => {
    expect(() => parseEnvironment(yaml, 'p.yaml')).toThrow(key);
  });
});

describe('planLaunch', () => {
  let root: string;
  const env = parseEnvironment(OWNER_LIKE, 'p.yaml');
  const plan = () =>
    planLaunch({ environment: env, profilePath: 'p.yaml', agent: env.agent!, projectRoot: root, project: 'proj', host: 'lft' });

  beforeEach(() => {
    root = tmpDir('vdx-ai-plan-');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('adds the channel flag and its prompt when the project declares mail.watch', () => {
    fs.mkdirSync(path.join(root, 'signals'));
    fs.writeFileSync(
      path.join(root, 'signals', 'sources.yaml'),
      'mail:\n  watch:\n    zone: America/New_York\n',
    );
    const p = plan();
    expect(p.args).toEqual([
      '--dangerously-skip-permissions',
      '--dangerously-load-development-channels',
      'plugin:echelon@echelon',
    ]);
    expect(p.matched).toEqual(['echelon-channel']);
    expect(p.confirm).toEqual([{ screen: 'Loading development channels', keys: ['Enter'] }]);
    expect(p.sessionName).toBe('proj@lft');
    expect(p.resumeArgs).toEqual(['--continue']);
  });

  it('leaves the flag out when sources.yaml has mail but no watch (the space-hq case)', () => {
    fs.mkdirSync(path.join(root, 'signals'));
    fs.writeFileSync(path.join(root, 'signals', 'sources.yaml'), 'mail:\n  config: mail.yaml\n');
    const p = plan();
    expect(p.args).toEqual(['--dangerously-skip-permissions']);
    expect(p.matched).toEqual([]);
    expect(p.confirm).toEqual([]);
  });

  it('defaults to no multiplexer and the bare project name without a session section', () => {
    const bare: Environment = { agent: { command: 'codex' } };
    const p = planLaunch({ environment: bare, profilePath: null, agent: bare.agent!, projectRoot: root, project: 'proj', host: 'lft' });
    expect(p.multiplexer).toBe('none');
    expect(p.sessionName).toBe('proj');
    expect(p.args).toEqual([]);
  });
});

describe('renderSessionName', () => {
  it('fills placeholders and replaces what tmux would replace', () => {
    expect(renderSessionName('{project}@{host}', { project: 'www.t23b.org', host: 'lft' })).toBe(
      'www_t23b_org@lft',
    );
  });

  it('refuses an unknown placeholder', () => {
    expect(() => renderSessionName('{projcet}', { project: 'x' })).toThrow('{projcet}');
  });
});

describe('fallbackAgent', () => {
  it('takes the first known agent on PATH, with no flags', () => {
    expect(fallbackAgent((b) => b === 'codex')).toEqual({ command: 'codex' });
    expect(fallbackAgent(() => true)).toEqual({ command: 'claude' });
    expect(fallbackAgent(() => false)).toBeNull();
  });
});

describe('shell quoting', () => {
  const echoArgs = (line: string) =>
    execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${line}`], { encoding: 'utf8' });

  it('round-trips awkward arguments through sh', () => {
    const args = ['plain', 'with space', "it's", '$HOME', '', 'a"b', 'plugin:echelon@echelon'];
    expect(echoArgs(args.map(shellQuote).join(' '))).toBe(args.join('\n') + '\n');
  });

  it('wraps the agent in a login shell that stays open after it exits', () => {
    const line = commandLine('claude', ['--dangerously-skip-permissions']);
    expect(tmuxShellCommand(line, '/bin/zsh')).toBe(
      "exec /bin/zsh -lic 'claude --dangerously-skip-permissions; exec /bin/zsh -l'",
    );
    expect(tmuxShellCommand(line, null)).toBe(line);
  });
});

describe('process and pane matching', () => {
  const procs = parsePs(
    [
      '  100     1 -zsh',
      '  200   100 /usr/local/bin/claude --dangerously-skip-permissions --continue',
      '  300     1 /bin/zsh -lic claude --dangerously-skip-permissions; exec /bin/zsh -l',
      '  301   300 /usr/local/bin/claude --dangerously-skip-permissions --dangerously-load-development-channels plugin:echelon@echelon',
      '  400     1 -zsh',
      '  401   400 node /opt/homebrew/bin/codex --full-auto',
      '  500     1 -zsh',
      '  501   500 vim claude.md',
    ].join('\n'),
  );

  it('parses ps and walks the tree below a pane', () => {
    expect(procs).toHaveLength(8);
    expect(processTree(procs, 300).map((p) => p.pid)).toEqual([300, 301]);
  });

  it('recognises the agent directly or under an interpreter, not the wrapper or an editor', () => {
    const byPid = (pid: number) => procs.find((p) => p.pid === pid)!;
    expect(isAgentProcess(byPid(200), 'claude')).toBe(true);
    expect(isAgentProcess(byPid(300), 'claude')).toBe(false);
    expect(isAgentProcess(byPid(401), 'codex')).toBe(true);
    expect(isAgentProcess(byPid(501), 'claude')).toBe(false);
  });

  it('finds the project agent by pane working directory, including subdirectories', () => {
    const root = tmpDir('vdx-ai-panes-');
    const other = tmpDir('vdx-ai-other-');
    fs.mkdirSync(path.join(root, 'sub'));
    try {
      const panes = parsePanes(
        [
          `t23b-program@lft\t%1\t100\t${root}`,
          `ga-gap@lft\t%2\t300\t${path.join(root, 'sub')}`,
          `limeflow@lft\t%3\t400\t${other}`,
          `notes@lft\t%4\t500\t${root}`,
        ].join('\n'),
      );
      const found = findAgentPanes(panes, procs, root, 'claude');
      expect(found.map((f) => [f.pane.session, f.proc.pid])).toEqual([
        ['t23b-program@lft', 200],
        ['ga-gap@lft', 301],
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('reports the required args a running agent lacks', () => {
    const running = '/usr/local/bin/claude --dangerously-skip-permissions --continue';
    expect(
      missingArgs(running, [
        '--dangerously-skip-permissions',
        '--dangerously-load-development-channels',
        'plugin:echelon@echelon',
      ]),
    ).toEqual(['--dangerously-load-development-channels', 'plugin:echelon@echelon']);
    expect(missingArgs('agent --prompt be brief', ['be brief'])).toEqual([]);
  });
});

describe('projectIdentity and hostLabel', () => {
  let root: string;
  beforeEach(() => {
    root = tmpDir('vdx-ai-id-');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('uses the origin repository name, lowercased', () => {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'git@git.example.org:Global-Auth-Gap.git']);
    expect(projectIdentity(root)).toBe('global-auth-gap');
  });

  it('falls back to the directory name without an origin (the t23b-program case)', () => {
    execFileSync('git', ['init', '-q', root]);
    expect(projectIdentity(root)).toBe(path.basename(root));
  });

  it('takes $VDX_HOST over the hostname', () => {
    expect(hostLabel({ VDX_HOST: 'lft' })).toBe('lft');
    expect(hostLabel({})).toBe(os.hostname().split('.')[0]);
  });
});

describe('runAi without tmux', () => {
  let home: string;
  let root: string;
  let logs: string[];
  const deps = (over: Partial<AiDeps> = {}): AiDeps => ({
    env: { PATH: process.env['PATH'] },
    home,
    tmux: new Tmux(`vdx-test-unused-${process.pid}`),
    interactive: false,
    shell: '/bin/sh',
    log: (l) => logs.push(l),
    out: (t) => logs.push(t),
    onPath: () => false,
    processes: () => [],
    sleep: () => {},
    confirmTimeoutMs: 1000,
    ...over,
  });
  const opts = { path: '', restart: false, resume: false, detach: false, dryRun: false };

  beforeEach(() => {
    home = tmpDir('vdx-ai-home-');
    root = tmpDir('vdx-ai-root-');
    logs = [];
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses when there is no profile and no known agent on PATH', () => {
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_USAGE);
    expect(logs.join('\n')).toContain('no agent to start');
  });

  it('names the broken key of a bad profile', () => {
    const profile = path.join(home, 'env.yaml');
    fs.writeFileSync(profile, 'agent: {args: [x]}\n');
    expect(runAi({ ...opts, path: root }, deps({ env: { VDX_ENVIRONMENT: profile } }))).toBe(EXIT_USAGE);
    expect(logs.join('\n')).toContain('agent.command');
  });

  it('will not start an interactive agent without a terminal', () => {
    expect(runAi({ ...opts, path: root }, deps({ onPath: (b) => b === 'claude' }))).toBe(EXIT_USAGE);
    expect(logs.join('\n')).toContain('no terminal');
  });

  it('prints the plan on --dry-run: built-in default, plain agent, no tmux', () => {
    expect(runAi({ ...opts, path: root, dryRun: true }, deps({ onPath: (b) => b === 'codex' }))).toBe(EXIT_OK);
    const out = logs.join('\n');
    expect(out).toContain('profile:  none');
    expect(out).toContain('agent:    codex\n');
    expect(out).toContain('this terminal');
  });
});

const tmuxAvailable = new Tmux().available();

describe.skipIf(!tmuxAvailable)('runAi in tmux (isolated server)', () => {
  const socket = `vdx-test-${process.pid}`;
  const tmux = new Tmux(socket);
  let base: string;
  let root: string;
  let profile: string;
  let logs: string[];

  const writeProfile = (args: string[]) =>
    fs.writeFileSync(
      profile,
      [
        'agent:',
        `  command: ${path.join(base, 'fake-agent')}`,
        `  args: [${args.join(', ')}]`,
        '  resume_args: [--resume-me]',
        '  when:',
        '    - id: chan',
        '      if: {config_value: {path: signals/sources.yaml, jsonpath: mail.watch}}',
        '      args: [--chan, plugin:x@y]',
        '      confirm:',
        '        - screen: "FAKE PROMPT"',
        '          keys: [Enter]',
        'session:',
        '  multiplexer: tmux',
        '  name: "{project}@{host}"',
        '',
      ].join('\n'),
    );

  const deps = (): AiDeps => ({
    env: { VDX_ENVIRONMENT: profile, VDX_HOST: 'testhost', PATH: process.env['PATH'] },
    home: base,
    tmux,
    interactive: false,
    shell: '/bin/sh',
    log: (l) => logs.push(l),
    out: (t) => logs.push(t),
    onPath,
    processes: listProcesses,
    sleep: sleepSync,
    confirmTimeoutMs: 10_000,
  });
  const opts = { path: '', restart: false, resume: false, detach: false, dryRun: false };
  const agentArgs = () =>
    findAgentPanes(tmux.panes(), listProcesses(), root, 'fake-agent').map((f) => f.proc.args);

  beforeAll(() => {
    base = tmpDir('vdx-ai-tmux-');
    root = path.join(base, 'proj');
    fs.mkdirSync(path.join(root, 'signals'), { recursive: true });
    fs.writeFileSync(path.join(root, 'signals', 'sources.yaml'), 'mail:\n  watch: {zone: UTC}\n');
    // Behaves like claude with the channel flag: a prompt that leaves the screen
    // once answered; with --resume-me and no conversation it then quits, as
    // `claude --continue` does.
    fs.writeFileSync(
      path.join(base, 'fake-agent'),
      [
        '#!/bin/sh',
        'echo "FAKE PROMPT: press enter"',
        'read answer',
        "printf '\\033[2J\\033[H'",
        'case " $* " in *" --resume-me "*)',
        '  if [ -f "$(dirname "$0")/no-conversation" ]; then echo "No conversation found"; exit 1; fi;;',
        'esac',
        'echo "READY $*"',
        'while :; do sleep 1; done',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    profile = path.join(base, 'env.yaml');
  });

  beforeEach(() => {
    logs = [];
  });

  afterAll(() => {
    tmux.tryRun(['kill-server']);
    // kill-server leaves the socket file behind.
    const dir = path.join(process.env['TMUX_TMPDIR'] || '/tmp', `tmux-${process.getuid?.() ?? ''}`);
    fs.rmSync(path.join(dir, socket), { force: true });
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('starts the agent in a new session, answers the expected prompt, verifies its args', () => {
    writeProfile(['--base']);
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(tmux.hasSession('proj@testhost')).toBe(true);
    expect(logs.join('\n')).toContain('✓ answered "FAKE PROMPT" with Enter');
    expect(agentArgs()).toHaveLength(1);
    expect(agentArgs()[0]).toMatch(/fake-agent --base --chan plugin:x@y$/);
    const pane = tmux.panes().find((p) => p.session === 'proj@testhost')!;
    expect(tmux.capture(pane.paneId)).toContain('READY --base --chan plugin:x@y');
  });

  it('is idempotent: a second run finds the running agent and starts nothing', () => {
    writeProfile(['--base']);
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain('already running with the profile');
    expect(tmux.panes()).toHaveLength(1);
  });

  it('reports drift and leaves the running agent alone without --restart', () => {
    writeProfile(['--base', '--extra']);
    const before = agentArgs();
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_DRIFT);
    expect(logs.join('\n')).toContain('running without --extra');
    expect(agentArgs()).toEqual(before);
  });

  it('--restart replaces the agent in the same pane, resumes, and answers the prompt again', () => {
    writeProfile(['--base', '--extra']);
    const paneBefore = tmux.panes().map((p) => p.paneId);
    expect(runAi({ ...opts, path: root, restart: true }, deps())).toBe(EXIT_OK);
    expect(tmux.panes().map((p) => p.paneId)).toEqual(paneBefore);
    expect(agentArgs()[0]).toMatch(/fake-agent --base --extra --chan plugin:x@y --resume-me$/);
    expect(logs.join('\n')).toContain('✓ answered "FAKE PROMPT" with Enter');
  });

  it('--restart with nothing to resume starts the agent again without the resume args', () => {
    writeProfile(['--base', '--extra']);
    fs.writeFileSync(path.join(base, 'no-conversation'), '');
    try {
      expect(runAi({ ...opts, path: root, restart: true }, deps())).toBe(EXIT_OK);
      const out = logs.join('\n');
      expect(out).toContain('not running in the pane');
      expect(out).toContain('nothing to resume — starting without --resume-me');
      expect(agentArgs()).toHaveLength(1);
      expect(agentArgs()[0]).toMatch(/fake-agent --base --extra --chan plugin:x@y$/);
    } finally {
      fs.rmSync(path.join(base, 'no-conversation'), { force: true });
    }
  }, 30_000); // "not running" is concluded after a 10 s wait

  it('--dry-run shows the plan and the running agent without touching it', () => {
    writeProfile(['--base', '--extra']);
    expect(runAi({ ...opts, path: root, dryRun: true }, deps())).toBe(EXIT_OK);
    const out = logs.join('\n');
    expect(out).toContain('matched:  chan');
    expect(out).toContain('confirm:  "FAKE PROMPT" → Enter');
    expect(out).toMatch(/running:  proj@testhost %\d+ — matches the profile/);
  });
});
