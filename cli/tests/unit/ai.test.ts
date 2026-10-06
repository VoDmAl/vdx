import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  type AiDeps,
  type Environment,
  EXIT_DRIFT,
  EXIT_LAUNCH_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  Tmux,
  commandLine,
  ensureAuthor,
  fallbackAgent,
  findAgentPanes,
  findOwnAgent,
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
  remoteAiArgs,
  remotePathWord,
  renderSessionName,
  resolveProjectName,
  resolveEnvironmentPath,
  runAi,
  runAiCheck,
  shellQuote,
  sleepSync,
  tmuxShellCommand,
} from '../../src/ai.ts';
import { type LiveSession, readConversation } from '../../src/conversations.ts';
import { ID, hookLine, promptLine, startedOn, userLine, writeConversation, writeHistory } from './transcripts.ts';

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
    ask: () => null,
    ...over,
  });
  const opts = { path: '', restart: false, fresh: false, detach: false, dryRun: false };

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

  describe('in this terminal', () => {
    // Records its args; with --resume-me and no conversation it fails at once,
    // as `claude --continue` does (exit 1, "No conversation found to continue").
    const direct = () => {
      const agent = path.join(home, 'fake-agent');
      fs.writeFileSync(
        agent,
        [
          '#!/bin/sh',
          'echo "$*" >> "$(dirname "$0")/runs"',
          'case " $* " in *" --resume-me "*)',
          '  if [ -f "$(dirname "$0")/no-conversation" ]; then exit 1; fi;;',
          'esac',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      const profile = path.join(home, 'env.yaml');
      fs.writeFileSync(
        profile,
        `agent: {command: ${agent}, args: [--base], resume_args: [--resume-me]}\nsession: {multiplexer: none}\n`,
      );
      return deps({ env: { VDX_ENVIRONMENT: profile, PATH: process.env['PATH'] }, interactive: true });
    };
    const runs = () => fs.readFileSync(path.join(home, 'runs'), 'utf8').trim().split('\n');

    it('continues the last conversation by default', () => {
      expect(runAi({ ...opts, path: root }, direct())).toBe(EXIT_OK);
      expect(runs()).toEqual(['--base --resume-me']);
    });

    it('with nothing to resume, starts once more without the resume args', () => {
      const d = direct();
      fs.writeFileSync(path.join(home, 'no-conversation'), '');
      expect(runAi({ ...opts, path: root }, d)).toBe(EXIT_OK);
      expect(runs()).toEqual(['--base --resume-me', '--base']);
      expect(logs.join('\n')).toContain('nothing to resume — starting without --resume-me');
    });

    it('--new starts a new conversation', () => {
      expect(runAi({ ...opts, path: root, fresh: true }, direct())).toBe(EXIT_OK);
      expect(runs()).toEqual(['--base']);
    });
  });
});

describe('vdx ai picks the conversation to continue (Claude Code)', () => {
  let home: string;
  let root: string;
  let logs: string[];
  let sshCalls: { args: string[]; capture: boolean }[];
  let answers: string[];
  /** What another machine answers over ssh: its live session files; null — it does not answer. */
  let remoteLive: object[] | null;
  let liveHere: LiveSession[];
  const opts = { path: '', restart: false, fresh: false, detach: false, dryRun: false };
  const asked = () => sshCalls.filter((c) => c.capture).map((c) => c.args[5]);
  const remoteRuns = () => sshCalls.filter((c) => !c.capture).map((c) => c.args);

  beforeEach(() => {
    home = tmpDir('vdx-ai-conv-home-');
    root = tmpDir('vdx-ai-conv-root-');
    logs = [];
    sshCalls = [];
    answers = [];
    remoteLive = [];
    liveHere = [];
    // A `claude` that records its args and exits: what `vdx ai` ran it with.
    fs.mkdirSync(path.join(home, 'bin'));
    fs.writeFileSync(path.join(home, 'bin', 'claude'), '#!/bin/sh\necho "$*" >> "$(dirname "$0")/../runs"\n', { mode: 0o755 });
    fs.writeFileSync(
      path.join(home, 'env.yaml'),
      `agent: {command: ${path.join(home, 'bin', 'claude')}, args: [--base], resume_args: [--continue]}\nsession: {multiplexer: none}\n`,
    );
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  const deps = (over: Partial<AiDeps> = {}): AiDeps => ({
    env: {
      VDX_ENVIRONMENT: path.join(home, 'env.yaml'),
      VDX_HOST: 'lft',
      CLAUDE_CONFIG_DIR: path.join(home, 'cc'),
      PATH: process.env['PATH'],
    },
    home,
    tmux: new Tmux(`vdx-test-unused-${process.pid}`),
    interactive: true,
    shell: '/bin/sh',
    log: (l) => logs.push(l),
    out: (t) => logs.push(t),
    onPath: () => false,
    processes: () => [],
    sleep: () => {},
    confirmTimeoutMs: 1000,
    ask: () => answers.shift() ?? null,
    version: '0.19.0',
    ssh: (args, capture) => {
      sshCalls.push({ args, capture });
      if (!capture) return { status: 0, stdout: '' };
      return remoteLive ? { status: 0, stdout: remoteLive.map((o) => JSON.stringify(o)).join('\n') } : { status: 255, stdout: '' };
    },
    liveHere: () => liveHere,
    ...over,
  });
  const conv = (id: string, machine: string | null, minutesAgo: number) =>
    writeConversation(
      path.join(home, 'cc'),
      root,
      id,
      [...(machine ? [startedOn(machine)] : []), userLine('hi'), promptLine(`prompt ${id.slice(0, 4)}`)],
      minutesAgo,
    );
  const runs = () => {
    const f = path.join(home, 'runs');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n') : [];
  };
  const text = () => logs.join('\n');

  it("continues this machine's newest conversation and asks nothing when no other machine has one", () => {
    conv(ID.a, 'lft', 30);
    conv(ID.b, null, 60);
    writeHistory(path.join(home, 'cc'), root, [ID.b]); // typed in here before vdx named the machine
    answers = ['should not be read'];
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(runs()).toEqual([`--base --resume ${ID.a}`]);
    expect(answers).toHaveLength(1);
    expect(text()).toContain('continuing lft');
  });

  it('starts a new conversation when the project has none — not --continue', () => {
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(runs()).toEqual(['--base']);
    expect(text()).toContain('no conversation of this project yet');
  });

  it("Enter takes the newest overall; another machine's is continued on that machine, over ssh", () => {
    conv(ID.a, 'lft', 30);
    conv(ID.b, 'm3', 5);
    answers = [''];
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(runs()).toEqual([]);
    expect(text()).toMatch(/1\) m3 .*bbbbbbbb.*← newest/);
    expect(text()).toMatch(/2\) lft .*aaaaaaaa.*← this machine/);
    expect(sshCalls[0]!.args.slice(0, 5)).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'm3']);
    expect(asked()).toEqual([expect.stringMatching(/^sh -c .*sessions/)]);
    expect(remoteRuns()).toHaveLength(1);
    expect(remoteRuns()[0]!.slice(0, 2)).toEqual(['-t', 'm3']);
    expect(remoteRuns()[0]![2]).toContain(`exec vdx ai ${root} --conversation ${ID.b}`);
  });

  it("a number picks this machine's conversation instead; n — a new one", () => {
    conv(ID.a, 'lft', 30);
    conv(ID.b, 'm3', 5);
    answers = ['2'];
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    answers = ['n'];
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(runs()).toEqual([`--base --resume ${ID.a}`, '--base']);
    expect(remoteRuns()).toEqual([]);
  });

  it('the other machine does not answer: vdx asks, and y continues the conversation here', () => {
    conv(ID.a, 'lft', 30);
    conv(ID.b, 'm3', 5);
    remoteLive = null;
    answers = ['', 'y'];
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(sshCalls).toHaveLength(1); // asked once; nothing run there
    expect(text()).toContain('m3 does not answer over ssh');
    expect(runs()).toEqual([`--base --resume ${ID.b}`]);
  });

  it('…and without a yes starts nothing', () => {
    conv(ID.b, 'm3', 5);
    remoteLive = null;
    answers = ['', ''];
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_LAUNCH_FAILED);
    expect(runs()).toEqual([]);
    expect(text()).toContain('nothing started');
    expect(text()).toContain(`--conversation ${ID.b}`);
  });

  it("without a terminal: this machine's newest, and the other machine's named with the command for it", () => {
    conv(ID.a, 'lft', 30);
    conv(ID.b, 'm3', 5);
    answers = ['should not be read'];
    expect(runAi({ ...opts, path: root, dryRun: true }, deps())).toBe(EXIT_OK);
    expect(answers).toHaveLength(1);
    expect(text()).toContain(`resume:   --resume ${ID.a}`);
    expect(text()).toContain('conversation: continuing lft');
    expect(text()).toContain(`note: m3 has a newer conversation bbbbbbbb — continue it there: vdx ai@m3 ${root} --conversation ${ID.b}`);
  });

  it('with only another machine\'s conversation and no terminal, a new one here — never theirs', () => {
    conv(ID.b, 'm3', 5);
    expect(runAi({ ...opts, path: root, dryRun: true }, deps())).toBe(EXIT_OK);
    expect(text()).toContain('resume:   —');
    expect(text()).toContain('no idle conversation of this machine — starting a new one');
  });

  it('a conversation of an unknown machine is never taken without a terminal (the t23b-program case)', () => {
    conv(ID.a, null, 300);
    conv(ID.b, null, 55);
    writeHistory(path.join(home, 'cc'), root, [ID.a]);
    expect(runAi({ ...opts, path: root, dryRun: true }, deps())).toBe(EXIT_OK);
    expect(text()).toContain(`resume:   --resume ${ID.a}`);
    expect(text()).toContain('note: a newer conversation bbbbbbbb is of an unknown machine (never typed in here)');
  });

  it('…at a terminal it is offered, marked, and continued here only after a yes', () => {
    conv(ID.b, null, 55);
    answers = ['', 'y'];
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(text()).toMatch(/1\) \? .*bbbbbbbb.*← newest, machine unknown/);
    expect(runs()).toEqual([`--base --resume ${ID.b}`]);
    expect(sshCalls).toEqual([]); // no machine to ask: none is named
    answers = ['', ''];
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_LAUNCH_FAILED);
    expect(runs()).toHaveLength(1);
  });

  it('--conversation continues that one and asks nothing', () => {
    conv(ID.a, 'lft', 30);
    conv(ID.b, 'm3', 5);
    expect(runAi({ ...opts, path: root, conversation: ID.c }, deps())).toBe(EXIT_OK);
    expect(runs()).toEqual([`--base --resume ${ID.c}`]);
    expect(sshCalls).toEqual([]);
  });

  it("a conversation running on another machine right now is listed and marked, even when it is not that machine's newest", () => {
    conv(ID.a, 'lft', 30);
    conv(ID.b, 'm3', 5);
    conv(ID.c, 'm3', 120);
    remoteLive = [{ pid: 10984, sessionId: ID.c, tmux: 'proj@m3:@25.%25', status: 'busy' }];
    answers = ['3'];
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(text()).toMatch(/3\) m3 .*cccccccc.*← running on m3 now \(proj@m3, busy\)/);
    expect(remoteRuns()).toHaveLength(1);
    expect(remoteRuns()[0]![2]).toContain(`--conversation ${ID.c}`);
    expect(runs()).toEqual([]);
  });

  it('a running session tells the machine of a conversation from before vdx named machines', () => {
    conv(ID.a, 'lft', 30);
    conv(ID.b, 'm3', 300);
    conv(ID.c, null, 5); // the t23b-program case: newest, never typed in here
    remoteLive = [{ pid: 10984, sessionId: ID.c, status: 'waiting' }];
    expect(runAi({ ...opts, path: root, dryRun: true }, deps())).toBe(EXIT_OK);
    expect(text()).toContain(`resume:   --resume ${ID.a}`);
    expect(text()).toContain(
      `note: m3 has a newer conversation cccccccc, running on m3 now (pid 10984, waiting) — continue it there: vdx ai@m3 ${root} --conversation ${ID.c}`,
    );
  });

  it('a conversation running here outside tmux is continued only after a yes — two sessions would write to it', () => {
    conv(ID.a, 'lft', 30);
    liveHere = [{ pid: 4242, conversation: ID.a, tmux: null, status: 'busy' }];
    answers = ['', ''];
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_LAUNCH_FAILED);
    expect(text()).toMatch(/1\) lft .*aaaaaaaa.*← newest, running here now \(pid 4242, busy\)/);
    answers = ['', 'y'];
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(runs()).toEqual([`--base --resume ${ID.a}`]);
  });

  it('…without a terminal it is not taken, and a machine that does not answer is named', () => {
    conv(ID.a, 'lft', 30);
    conv(ID.b, 'm3', 300);
    liveHere = [{ pid: 4242, conversation: ID.a, tmux: null, status: 'busy' }];
    remoteLive = null;
    expect(runAi({ ...opts, path: root, dryRun: true }, deps())).toBe(EXIT_OK);
    expect(text()).toContain('resume:   —');
    expect(text()).toContain('no idle conversation of this machine — starting a new one');
    expect(text()).toContain('note: a newer conversation aaaaaaaa, running here now (pid 4242, busy) — not taken: it would have two sessions');
    expect(text()).toContain('note: m3 does not answer over ssh — what runs there is not known');
  });

  it('--conversation is refused for an agent that is not Claude Code', () => {
    fs.writeFileSync(path.join(home, 'env.yaml'), 'agent: {command: codex, resume_args: [resume]}\nsession: {multiplexer: none}\n');
    expect(runAi({ ...opts, path: root, conversation: ID.c }, deps())).toBe(EXIT_USAGE);
    expect(text()).toContain('--conversation names a Claude Code conversation');
  });

  it('another agent keeps the profile resume_args — vdx reads no conversations for it', () => {
    fs.writeFileSync(path.join(home, 'bin', 'codex'), fs.readFileSync(path.join(home, 'bin', 'claude')), { mode: 0o755 });
    fs.writeFileSync(
      path.join(home, 'env.yaml'),
      `agent: {command: ${path.join(home, 'bin', 'codex')}, args: [--base], resume_args: [resume, --last]}\nsession: {multiplexer: none}\n`,
    );
    conv(ID.b, 'm3', 5);
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(runs()).toEqual(['--base resume --last']);
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
  const opts = { path: '', restart: false, fresh: false, detach: false, dryRun: false };
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

  it('starts the agent in a new session, continuing the conversation, answers the prompt, verifies its args', () => {
    writeProfile(['--base']);
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(tmux.hasSession('proj@testhost')).toBe(true);
    expect(logs.join('\n')).toContain('✓ answered "FAKE PROMPT" with Enter');
    expect(agentArgs()).toHaveLength(1);
    expect(agentArgs()[0]).toMatch(/fake-agent --base --chan plugin:x@y --resume-me$/);
    const pane = tmux.panes().find((p) => p.session === 'proj@testhost')!;
    expect(tmux.capture(pane.paneId)).toContain('READY --base --chan plugin:x@y --resume-me');
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

  it('finds the running agent outside tmux without a UTF-8 locale (ssh host vdx ai)', () => {
    writeProfile(['--base', '--extra']);
    const saved = { TMUX: process.env['TMUX'], LANG: process.env['LANG'], LC_ALL: process.env['LC_ALL'], LC_CTYPE: process.env['LC_CTYPE'] };
    delete process.env['TMUX'];
    delete process.env['LC_ALL'];
    delete process.env['LC_CTYPE'];
    process.env['LANG'] = 'C';
    try {
      expect(runAi({ ...opts, path: root, dryRun: true }, deps())).toBe(EXIT_OK);
      expect(logs.join('\n')).toMatch(/running:  proj@testhost %\d+ — matches the profile/);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('--dry-run shows the plan and the running agent without touching it', () => {
    writeProfile(['--base', '--extra']);
    expect(runAi({ ...opts, path: root, dryRun: true }, deps())).toBe(EXIT_OK);
    const out = logs.join('\n');
    expect(out).toContain('resume:   --resume-me');
    expect(out).toContain('matched:  chan');
    expect(out).toContain('confirm:  "FAKE PROMPT" → Enter');
    expect(out).toMatch(/running:  proj@testhost %\d+ — matches the profile/);
  });

  it('--new leaves a running agent alone without --restart', () => {
    writeProfile(['--base', '--extra']);
    const before = agentArgs();
    expect(runAi({ ...opts, path: root, fresh: true }, deps())).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain('--new replaces it only with --restart');
    expect(agentArgs()).toEqual(before);
  });

  it('--restart --new replaces the agent in the same pane with a new conversation', () => {
    writeProfile(['--base', '--extra']);
    const paneBefore = tmux.panes().map((p) => p.paneId);
    expect(runAi({ ...opts, path: root, restart: true, fresh: true }, deps())).toBe(EXIT_OK);
    expect(tmux.panes().map((p) => p.paneId)).toEqual(paneBefore);
    expect(agentArgs()).toHaveLength(1);
    expect(agentArgs()[0]).toMatch(/fake-agent --base --extra --chan plugin:x@y$/);
  });

  it('after a reboot with nothing to resume, a plain start runs the agent without the resume args', () => {
    writeProfile(['--base', '--extra']);
    tmux.tryRun(['kill-server']);
    fs.writeFileSync(path.join(base, 'no-conversation'), '');
    try {
      expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
      expect(logs.join('\n')).toContain('nothing to resume — starting without --resume-me');
      expect(agentArgs()).toHaveLength(1);
      expect(agentArgs()[0]).toMatch(/fake-agent --base --extra --chan plugin:x@y$/);
    } finally {
      fs.rmSync(path.join(base, 'no-conversation'), { force: true });
    }
  }, 30_000); // "not running" is concluded after a 10 s wait

  it('--restart of a Claude Code agent resumes the conversation it is in, not the newest in the folder', () => {
    tmux.tryRun(['kill-server']);
    const claude = path.join(base, 'bin', 'claude');
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.copyFileSync(path.join(base, 'fake-agent'), claude);
    fs.chmodSync(claude, 0o755);
    fs.writeFileSync(
      profile,
      [
        'agent:',
        `  command: ${claude}`,
        '  args: [--base]',
        '  resume_args: [--continue]',
        '  when:',
        '    - id: chan',
        '      if: {config_value: {path: signals/sources.yaml, jsonpath: mail.watch}}',
        '      confirm: [{screen: "FAKE PROMPT", keys: [Enter]}]',
        'session: {multiplexer: tmux, name: "{project}@{host}"}',
        '',
      ].join('\n'),
    );
    const cc = path.join(base, 'cc');
    const d = (): AiDeps => ({ ...deps(), env: { ...deps().env, CLAUDE_CONFIG_DIR: cc } });
    try {
      expect(runAi({ ...opts, path: root }, d())).toBe(EXIT_OK);
      expect(logs.join('\n')).toContain('no conversation of this project yet');
      const agent = findAgentPanes(tmux.panes(), listProcesses(), root, 'claude')[0]!;
      fs.mkdirSync(path.join(cc, 'sessions'), { recursive: true });
      fs.writeFileSync(path.join(cc, 'sessions', `${agent.proc.pid}.json`), JSON.stringify({ sessionId: ID.c }));
      writeConversation(cc, root, ID.d, [startedOn('testhost'), userLine('newer, another session')], 0);
      expect(runAi({ ...opts, path: root, restart: true }, d())).toBe(EXIT_OK);
      expect(logs.join('\n')).toContain('the agent is in conversation cccccccc — resuming it');
      expect(findAgentPanes(tmux.panes(), listProcesses(), root, 'claude').map((f) => f.proc.args)).toEqual([
        expect.stringMatching(new RegExp(`claude --base --resume ${ID.c}$`)),
      ]);
    } finally {
      tmux.tryRun(['kill-server']);
    }
  }, 30_000); // two starts, each answering the prompt and seeing the agent twice a second apart

  it('--new on a fresh start runs the agent without the resume args', () => {
    writeProfile(['--base', '--extra']);
    tmux.tryRun(['kill-server']);
    expect(runAi({ ...opts, path: root, fresh: true, dryRun: true }, deps())).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain('resume:   —');
    expect(runAi({ ...opts, path: root, fresh: true }, deps())).toBe(EXIT_OK);
    expect(logs.join('\n')).not.toContain('nothing to resume');
    expect(agentArgs()).toEqual([expect.stringMatching(/fake-agent --base --extra --chan plugin:x@y$/)]);
  });
});

describe('vdx ai@host', () => {
  const opts = { path: '.', restart: false, fresh: false, detach: false, dryRun: false };

  it('maps a path under the local home to the remote home, anything else as is', () => {
    expect(remotePathWord('/Users/vdm', '/Users/vdm')).toBe('"$HOME"');
    expect(remotePathWord('/Users/vdm/AI Projects/vdx', '/Users/vdm')).toBe(`"$HOME"/'AI Projects/vdx'`);
    expect(remotePathWord('/Users/vdm2/x', '/Users/vdm')).toBe('/Users/vdm2/x');
    expect(remotePathWord('/opt/my proj', '/Users/vdm')).toBe(`'/opt/my proj'`);
  });

  it('asks ssh for a terminal only when it will attach', () => {
    const base = { host: 'm3', projectPath: '/h/p', home: '/h', version: '1.0.0', opts };
    expect(remoteAiArgs({ ...base, tty: true }).slice(0, 2)).toEqual(['-t', 'm3']);
    expect(remoteAiArgs({ ...base, tty: false }).slice(0, 2)).toEqual(['-T', 'm3']);
  });

  describe('the remote script, run by a shell against a stub vdx', () => {
    let dir: string;
    beforeAll(() => {
      dir = tmpDir('vdx-remote-');
      fs.mkdirSync(path.join(dir, 'bin'));
      fs.mkdirSync(path.join(dir, 'home', 'AI Projects', 'vdx'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'bin', 'vdx'),
        '#!/bin/sh\nif [ "$1" = --version ]; then [ -n "$STUB_VERSION" ] || exit 1; echo "$STUB_VERSION"; exit 0; fi\nprintf \'%s\\n\' "$@"\n',
        { mode: 0o755 },
      );
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    const run = (stubVersion: string, o = opts) => {
      const script = remoteAiArgs({
        host: 'm3',
        projectPath: '/Users/vdm/AI Projects/vdx',
        home: '/Users/vdm',
        version: '0.14.0',
        opts: o,
        tty: false,
      })[2]!;
      const res = spawnSync('/bin/sh', ['-c', script], {
        encoding: 'utf8',
        env: { PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin`, HOME: path.join(dir, 'home'), STUB_VERSION: stubVersion },
      });
      return { args: res.stdout.split('\n').filter(Boolean), note: res.stderr.trim(), status: res.status };
    };

    it('runs vdx ai there with the path under its own home, path first, then the flags', () => {
      const r = run('0.14.0', { ...opts, fresh: true, restart: true });
      expect(r.args).toEqual(['ai', path.join(dir, 'home', 'AI Projects', 'vdx'), '--new', '--restart']);
      expect(r.note).toBe('');
      expect(r.status).toBe(0);
    });

    it('passes the conversation to continue there', () => {
      const r = run('0.14.0', { ...opts, conversation: ID.b });
      expect(r.args).toEqual(['ai', path.join(dir, 'home', 'AI Projects', 'vdx'), '--conversation', ID.b]);
    });

    it('names a different vdx version there', () => {
      expect(run('0.13.1').note).toBe('note: vdx on m3 is 0.13.1, here 0.14.0');
    });

    it('names a vdx that predates --version', () => {
      expect(run('').note).toBe('note: vdx on m3 is older than 0.13.1, here 0.14.0');
    });
  });
});

describe('project name: mise.toml, then profile sources, then the repository name', () => {
  let dir: string;
  let project: string;
  let home: string;
  beforeEach(() => {
    dir = tmpDir('vdx-name-');
    project = path.join(dir, 'telegram.vorobyev.name');
    home = path.join(dir, 'home');
    fs.mkdirSync(project);
    fs.mkdirSync(path.join(home, 'reg'), { recursive: true });
    fs.writeFileSync(path.join(home, 'reg', 'telegram.vorobyev.name.json'), JSON.stringify({ names: ['vodmalbot', 'bot'] }));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const resolve = (sources: { file: string; jsonpath: string }[], profileDir = home) =>
    resolveProjectName({ projectRoot: project, repo: 'telegram.vorobyev.name', sources, home, profileDir });
  const registry = { file: '~/reg/{repo}.json', jsonpath: 'names.0' };

  it('takes a profile source: {repo} and ~ expanded, a dot path into the file', () => {
    expect(resolve([registry])).toEqual({ name: 'vodmalbot', source: '~/reg/telegram.vorobyev.name.json names.0' });
  });

  it('prefers [vdx] name in the project mise.toml', () => {
    fs.writeFileSync(path.join(project, 'mise.toml'), '[vdx]\nname = "tgbot"\n');
    expect(resolve([registry])).toEqual({ name: 'tgbot', source: 'mise.toml [vdx] name' });
  });

  it('skips a missing file or a value that is not a string, then falls back to the repository name', () => {
    const missing = { file: '~/reg/nope-{repo}.json', jsonpath: 'names.0' };
    const notString = { file: '~/reg/{repo}.json', jsonpath: 'names' };
    expect(resolve([missing, notString])).toEqual({ name: 'telegram.vorobyev.name', source: 'repository name' });
    expect(resolve([missing, registry]).name).toBe('vodmalbot');
  });

  it("reads a relative file from the profile's directory", () => {
    expect(resolve([{ file: 'reg/{repo}.json', jsonpath: 'names.1' }], home).name).toBe('bot');
  });

  it('rejects a malformed source in the profile', () => {
    const bad = (names: string) => () => parseEnvironment(`session:\n  project_names: ${names}\n`, 'p.yaml');
    expect(bad('x')).toThrow(/session.project_names must be a list/);
    expect(bad('[{file: "a.json"}]')).toThrow(/project_names\[0\].jsonpath/);
    expect(bad('[{file: "{project}.json", jsonpath: a}]')).toThrow(/unknown placeholder \{project\}/);
    expect(() => bad('[{file: "~/{repo}.json", jsonpath: names.0}]')()).not.toThrow();
  });
});

describe('vdx ai proposes an author where the repo has none', () => {
  const saved = { global: process.env['GIT_CONFIG_GLOBAL'], nosystem: process.env['GIT_CONFIG_NOSYSTEM'] };
  let dir: string;
  let target: string;
  let logs: string[];
  const git = (d: string, ...a: string[]) =>
    execFileSync('git', ['-C', d, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const localEmail = () => {
    try {
      return git(target, 'config', '--local', '--get', 'user.email');
    } catch {
      return null;
    }
  };
  const repo = (name: string, email?: string, remote?: string) => {
    const d = path.join(dir, name);
    fs.mkdirSync(d);
    git(d, 'init', '-q');
    if (remote) git(d, 'remote', 'add', 'origin', remote);
    if (email) {
      git(d, 'config', '--local', 'user.email', email);
      git(d, 'config', '--local', 'user.name', 'Me');
    }
    return d;
  };
  const deps = (answers: (string | null)[], interactive = true): AiDeps => ({
    env: {},
    home: dir,
    tmux: new Tmux(`vdx-test-unused-${process.pid}`),
    interactive,
    shell: '/bin/sh',
    log: (l) => logs.push(l),
    out: (t) => logs.push(t),
    onPath: () => false,
    processes: () => [],
    sleep: () => {},
    confirmTimeoutMs: 1000,
    ask: () => (answers.length ? answers.shift()! : null),
  });

  beforeEach(() => {
    dir = tmpDir('vdx-author-');
    fs.writeFileSync(path.join(dir, 'gitconfig'), '');
    process.env['GIT_CONFIG_GLOBAL'] = path.join(dir, 'gitconfig');
    process.env['GIT_CONFIG_NOSYSTEM'] = '1';
    repo('svc-a', 'me@work.example', 'git@gitlab.work:team/svc-a.git');
    repo('site', 'me@home.example', 'git@github.com:me/site.git');
    target = repo('svc-b', undefined, 'git@gitlab.work:team/svc-b.git');
    logs = [];
  });
  afterEach(() => {
    for (const [k, v] of [['GIT_CONFIG_GLOBAL', saved.global], ['GIT_CONFIG_NOSYSTEM', saved.nosystem]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('Enter takes the first proposal and writes it into .git/config', () => {
    ensureAuthor(target, [dir], deps(['']), false);
    expect(localEmail()).toBe('me@work.example');
    expect(logs.join('\n')).toContain('1) Me <me@work.example>');
  });

  it('a number picks another proposal; an address is taken as typed', () => {
    ensureAuthor(target, [dir], deps(['2']), false);
    expect(localEmail()).toBe('me@home.example');
    git(target, 'config', '--local', '--unset', 'user.email');
    ensureAuthor(target, [dir], deps(['other@x.example']), false);
    expect(localEmail()).toBe('other@x.example');
  });

  it('s skips; an unclear answer is asked once more', () => {
    ensureAuthor(target, [dir], deps(['s']), false);
    expect(localEmail()).toBeNull();
    ensureAuthor(target, [dir], deps(['what', '']), false);
    expect(localEmail()).toBe('me@work.example');
  });

  it('without a terminal it only says how, and writes nothing', () => {
    ensureAuthor(target, [dir], deps([''], false), false);
    expect(localEmail()).toBeNull();
    expect(logs.join('\n')).toMatch(/set it: git -C .* config --local user.email me@work.example/);
  });

  it('--dry-run names the proposals and asks nothing', () => {
    ensureAuthor(target, [dir], deps([]), true);
    expect(logs.join('')).toContain('author:   none — git refuses to commit here; would propose me@work.example, me@home.example');
  });

  it('says nothing to change where the repo has an author', () => {
    ensureAuthor(path.join(dir, 'site'), [dir], deps(['2']), false);
    expect(logs).toEqual([]);
  });

  it('checks the profile key', () => {
    expect(() => parseEnvironment('git:\n  author_pool: x\n', 'p.yaml')).toThrow(/git.author_pool/);
    expect(() => parseEnvironment('git:\n  author_pool: ["~/AI Projects"]\n', 'p.yaml')).not.toThrow();
  });
});

describe('vdx ai --check: the session the agent itself runs in', () => {
  // The hook's chain: tmux pane shell → claude → sh (hook) → vdx (this process, pid 40).
  const chain = (claudeArgs: string) => [
    { pid: 10, ppid: 1, args: '/bin/zsh -lic claude --continue; exec /bin/zsh -l' },
    { pid: 20, ppid: 10, args: `/opt/homebrew/bin/claude ${claudeArgs}` },
    { pid: 30, ppid: 20, args: '/bin/sh /plugin/scripts/session-start.sh' },
    { pid: 40, ppid: 30, args: 'node /usr/local/bin/vdx ai --check' },
  ];
  let home: string;
  let root: string;
  let out: string[];
  let logs: string[];
  const deps = (procs: ReturnType<typeof chain>, env: NodeJS.ProcessEnv = {}): AiDeps => ({
    env: { VDX_ENVIRONMENT: path.join(home, 'env.yaml'), TMUX: '/tmp/tmux-501/default,1,0', ...env },
    home,
    tmux: new Tmux(`vdx-test-unused-${process.pid}`),
    interactive: false,
    shell: '/bin/sh',
    log: (l) => logs.push(l),
    out: (t) => out.push(t),
    onPath: () => false,
    processes: () => procs,
    sleep: () => {},
    confirmTimeoutMs: 1000,
    ask: () => null,
  });

  beforeEach(() => {
    home = tmpDir('vdx-ai-check-home-');
    root = tmpDir('vdx-ai-check-root-');
    fs.writeFileSync(path.join(home, 'env.yaml'), OWNER_LIKE);
    fs.mkdirSync(path.join(root, 'signals'));
    fs.writeFileSync(path.join(root, 'signals', 'sources.yaml'), 'mail:\n  watch:\n    zone: America/New_York\n');
    out = [];
    logs = [];
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finds the nearest agent among the ancestors — not the shell that started it', () => {
    expect(findOwnAgent(chain('--x'), 40, 'claude')?.pid).toBe(20);
    expect(findOwnAgent(chain('--x'), 30, 'claude')?.pid).toBe(20);
    expect(findOwnAgent(chain('--x'), 20, 'claude')).toBeNull();
    expect(findOwnAgent(chain('--x'), 40, 'codex')).toBeNull();
  });

  it('says how the agent is launched and that the session matches', () => {
    const procs = chain(
      '--dangerously-skip-permissions --dangerously-load-development-channels plugin:echelon@echelon --continue',
    );
    expect(runAiCheck(root, deps(procs), 40)).toBe(EXIT_OK);
    const text = out.join('');
    expect(text).toContain('started with `vdx ai`');
    expect(text).toContain('agent.when[]');
    expect(text).toContain(path.join(home, 'env.yaml'));
    expect(text).toContain("✓ this session carries the profile's flags (profile conditions met here: echelon-channel)");
    expect(logs).toEqual([]);
  });

  it('opens with the machine — the line vdx later reads back from the transcript', () => {
    const procs = chain('--dangerously-skip-permissions --continue');
    expect(runAiCheck(root, deps(procs, { VDX_HOST: 'm3' }), 40)).toBe(EXIT_DRIFT);
    const text = out.join('');
    expect(text.startsWith('vdx ai: this machine is `m3`;')).toBe(true);
    const file = path.join(home, `${ID.a}.jsonl`);
    fs.writeFileSync(file, [hookLine(text.trimEnd()), userLine('hi')].join('\n') + '\n');
    expect(readConversation(file, new Date())?.machine).toBe('m3');
  });

  it('names the missing flag and the restart in tmux — for the user to run', () => {
    expect(runAiCheck(root, deps(chain('--dangerously-skip-permissions --continue')), 40)).toBe(EXIT_DRIFT);
    const text = out.join('');
    expect(text).toContain(
      '✗ this session runs without --dangerously-load-development-channels plugin:echelon@echelon (profile conditions met here: echelon-channel)',
    );
    expect(text).toContain(`\`vdx ai --restart ${root}\``);
    expect(text).toContain('resuming the conversation (--continue)');
    expect(text).toContain('Do not run it yourself');
  });

  it('outside tmux, tells the user to exit and run vdx ai — --restart cannot reach it', () => {
    const d = deps(chain('--dangerously-skip-permissions'), { TMUX: '' });
    expect(runAiCheck(root, d, 40)).toBe(EXIT_DRIFT);
    const text = out.join('');
    expect(text).toContain('outside tmux');
    expect(text).toContain(`exits it and runs \`vdx ai ${root}\``);
    expect(text).not.toContain('--restart');
  });

  it('without an agent among the ancestors, says so and compares nothing', () => {
    expect(runAiCheck(root, deps(chain('--x').filter((p) => p.pid !== 20)), 40)).toBe(EXIT_OK);
    const text = out.join('');
    expect(text).toContain('no claude among the ancestors');
    expect(text).not.toContain('✗');
  });

  it('prints nothing without a profile — the machine has no `vdx ai` to speak of', () => {
    fs.rmSync(path.join(home, 'env.yaml'));
    expect(runAiCheck(root, deps(chain('--x'), { VDX_ENVIRONMENT: '' }), 40)).toBe(EXIT_OK);
    expect(out).toEqual([]);
    expect(logs).toEqual([]);
  });
});
