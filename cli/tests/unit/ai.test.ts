import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  type AiDeps,
  type AiOptions,
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
  foldersWarning,
  hostLabel,
  isAgentProcess,
  listProcesses,
  missingArgs,
  onPath,
  parseEnvironment,
  parsePanes,
  parsePs,
  planLaunch,
  processFocused,
  processMode,
  processTree,
  projectIdentity,
  remoteAiArgs,
  remotePathWord,
  renderSessionName,
  freeSessionName,
  resolveProjectName,
  resolveEnvironmentPath,
  runAi,
  runAiCheck,
  runAiClose,
  runAiRemote,
  runAiReport,
  runAiRestore,
  runAiState,
  runAiTab,
  STATE_OPTION,
  tabRecordDir,
  type RemoteReport,
  clientSeat,
  shellQuote,
  handOffRestart,
  sleepSync,
  tmuxShellCommand,
  unreadableFolders,
} from '../../src/ai.ts';
import {
  type LiveSession,
  HQ_LINE_PREFIX,
  INTERCOM_LINE_PREFIX,
  machineLine,
  readConversation,
  topicLine,
} from '../../src/conversations.ts';
import {
  ID,
  bashLine,
  commandLine as slashLine,
  hookLine,
  promptLine,
  replyLine,
  skillLine,
  startedOn,
  userLine,
  writeConversation,
  writeHistory,
} from './transcripts.ts';
import { currentServer, socketDir, writeRecord } from '../../src/restore.ts';
import type { PickerInput } from '../../src/picker.ts';

const tmpDir = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

// Run from a focused or an HQ session, the tests carry its VDX_FOCUSED=1 or VDX_HQ=1 into the
// agents and tmux servers they start, and a plain start reads as one of those.
const runnerModes = ['VDX_FOCUSED', 'VDX_HQ'].map((name) => [name, process.env[name]] as const);
beforeAll(() => {
  for (const [name] of runnerModes) delete process.env[name];
});
afterAll(() => {
  for (const [name, value] of runnerModes) if (value !== undefined) process.env[name] = value;
});

// The tests' own tmux servers, `vdx-test[-<what>]-<pid>`. kill-server leaves the socket file behind.
const tmuxSocketDir = path.join(process.env['TMUX_TMPDIR'] || '/tmp', `tmux-${process.getuid?.() ?? ''}`);
function dropServer(tmux: Tmux, socket: string): void {
  killServer(tmux);
  fs.rmSync(path.join(tmuxSocketDir, socket), { force: true });
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};
/**
 * kill-server returns before the server is gone, and a new-session right after it can reach the dying
 * one: «server exited unexpectedly» — CI on node 24 failed so twice (2026-11-06, two different tests).
 * Wait for its process to end, up to 2 s.
 */
function killServer(tmux: Tmux): void {
  const pid = Number(tmux.tryRun(['display-message', '-p', '#{pid}'])?.trim());
  tmux.tryRun(['kill-server']);
  for (let i = 0; i < 100 && pid > 0 && alive(pid); i++) sleepSync(20);
}
// A run cut short (Ctrl-C, a timeout, a worker gone) never reaches its kill-server, and its server
// keeps a fake agent alive (vdx-ai Sidetrack #23): those of runs that are gone go first.
beforeAll(() => {
  let names: string[];
  try {
    names = fs.readdirSync(tmuxSocketDir);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = /^vdx-test-(?:[a-z]+-)?(\d+)$/.exec(name)?.[1];
    if (pid && !alive(Number(pid))) dropServer(new Tmux(name), name);
  }
});

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
      wakes: true
session:
  multiplexer: tmux
  name: "{project}@{host}"
  machines: [lft, M3]
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

describe.skipIf(process.getuid?.() === 0)('guarded folders (macOS)', () => {
  let home: string;
  beforeEach(() => {
    home = tmpDir('vdx-folders-');
    fs.mkdirSync(path.join(home, 'Downloads'), { mode: 0o000 });
    fs.mkdirSync(path.join(home, 'Desktop'));
  });
  afterEach(() => {
    fs.chmodSync(path.join(home, 'Downloads'), 0o755);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('names a folder it cannot read; a missing one (Documents) is skipped', () => {
    expect(unreadableFolders(null, home)).toEqual([path.join(home, 'Downloads')]);
  });

  it.skipIf(!new Tmux().available())(
    'asks the tmux server — its sessions have its rights — and falls back without one',
    () => {
      const socket = `vdx-test-folders-${process.pid}`;
      const tmux = new Tmux(socket);
      try {
        expect(unreadableFolders(tmux, home)).toEqual([path.join(home, 'Downloads')]); // no server yet: this process
        tmux.run(['new-session', '-d', '-s', 'f', 'sleep 30']);
        expect(unreadableFolders(tmux, home)).toEqual([path.join(home, 'Downloads')]); // the server's own ls
      } finally {
        dropServer(tmux, socket);
      }
    },
  );

  it("one warning line and the fix: the profile's, else what works anywhere", () => {
    const d = [path.join(home, 'Downloads'), path.join(home, 'Desktop')];
    expect(foldersWarning(d, true, undefined, home)).toEqual([
      "⚠ this session cannot read ~/Downloads, ~/Desktop — macOS holds the denial in the tmux server; files there are out of the agent's reach",
      '  fix: restart the tmux server (it closes every session)',
    ]);
    expect(foldersWarning(d, true, 'run the fixer', home)[1]).toBe('  fix: run the fixer');
  });
});

describe('processFocused', () => {
  it('reads VDX_FOCUSED=1 from the environment of a running process', async () => {
    const run = (value: string) =>
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { env: { ...process.env, VDX_FOCUSED: value } });
    const focused = run('1');
    const plain = run('');
    try {
      await new Promise((r) => setTimeout(r, 500));
      expect(processFocused(focused.pid!)).toBe(true);
      expect(processFocused(plain.pid!)).toBe(false);
    } finally {
      focused.kill();
      plain.kill();
    }
  });

  it('processMode: VDX_HQ=1 is the HQ session; with VDX_FOCUSED=1 too, focused', async () => {
    const run = (env: NodeJS.ProcessEnv) =>
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { env: { ...process.env, ...env } });
    const hq = run({ VDX_HQ: '1', VDX_FOCUSED: '' });
    const both = run({ VDX_HQ: '1', VDX_FOCUSED: '1' });
    try {
      await new Promise((r) => setTimeout(r, 500));
      expect(processMode(hq.pid!)).toBe('hq');
      expect(processMode(both.pid!)).toBe('focused');
    } finally {
      for (const p of [hq, both]) p.kill();
    }
  });

  it('processMode: VDX_INTERCOM=1 is the intercom session; with VDX_FOCUSED=1 too, focused — deaf wins', async () => {
    const run = (env: NodeJS.ProcessEnv) =>
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { env: { ...process.env, ...env } });
    const mail = run({ VDX_INTERCOM: '1', VDX_FOCUSED: '' });
    const both = run({ VDX_INTERCOM: '1', VDX_FOCUSED: '1' });
    const plain = run({ VDX_INTERCOM: '', VDX_FOCUSED: '' });
    try {
      await new Promise((r) => setTimeout(r, 500));
      expect(processMode(mail.pid!)).toBe('mail');
      expect(processMode(both.pid!)).toBe('focused');
      expect(processMode(plain.pid!)).toBe('plain');
      expect(processFocused(mail.pid!)).toBe(false);
    } finally {
      for (const p of [mail, both, plain]) p.kill();
    }
  });
});

describe('parseEnvironment', () => {
  it('accepts the owner-shaped profile', () => {
    const env = parseEnvironment(OWNER_LIKE, 'p.yaml');
    expect(env.agent?.command).toBe('claude');
    expect(env.agent?.when?.[0]?.confirm?.[0]?.keys).toEqual(['Enter']);
    expect(env.session?.multiplexer).toBe('tmux');
  });

  it('takes *.<domain> in git.personal_hosts', () => {
    expect(
      parseEnvironment('git: {personal_hosts: ["*.zt.home.example", {host: "*.lab.home.example"}]}', 'p.yaml').git,
    ).toEqual({ personal_hosts: ['*.zt.home.example', { host: '*.lab.home.example' }] });
  });

  it('treats an empty document as an empty profile', () => {
    expect(parseEnvironment('', 'p.yaml')).toEqual({});
  });

  it.each([
    ['agent: {args: [x]}', 'agent.command'],
    ['agent: {command: claude, args: flag}', 'agent.args'],
    ['agent: {command: claude, intercom_args: "/vdm:intercom check"}', 'agent.intercom_args'],
    ['agent: {command: claude, hq_args: "/echelon:whatsup"}', 'agent.hq_args'],
    ['agent: {command: claude, when: [{id: a}]}', 'agent.when[0].if'],
    [
      'agent: {command: claude, when: [{id: a, if: true, confirm: [{screen: x, keys: []}]}]}',
      'agent.when[0].confirm[0].keys',
    ],
    ['session: {multiplexer: screen}', 'session.multiplexer'],
    ['session: {machines: m3}', 'session.machines'],
    ['session: {machines: [m3, -oProxyCommand=x]}', 'session.machines[1]'],
    ['agent: {command: claude, when: [{id: a, if: true, wakes: "true"}]}', 'agent.when[0].wakes'],
    ['session: {folders_fix: ""}', 'session.folders_fix'],
    ['session: {wrap_skills: vdm:wrap}', 'session.wrap_skills'],
    ['session: {machine_icons: [m3]}', 'session.machine_icons'],
    ['session: {machine_icons: {"-oX": "🔹"}}', 'session.machine_icons.-oX'],
    ['session: {machine_icons: {m3: "m 3"}}', 'session.machine_icons.m3'],
    ['session: {machine_icons: {m3: "longmark"}}', 'session.machine_icons.m3'],
    ['git: {personal_hosts: ["git.*.example"]}', 'git.personal_hosts[0]'],
    ['git: {personal_hosts: ["*.example"]}', 'git.personal_hosts[0]'],
    ['git: {personal_hosts: [{host: "*"}]}', 'git.personal_hosts[0].host'],
    ['- just a list', 'top level'],
  ])('rejects %s naming %s', (yaml, key) => {
    expect(() => parseEnvironment(yaml, 'p.yaml')).toThrow(key);
  });
});

describe('clientSeat: which seat a terminal on a tmux session is at', () => {
  const procs = [
    { pid: 1, ppid: 0, args: '/sbin/launchd' },
    { pid: 50, ppid: 1, args: 'sshd-session: vdm@ttys004' },
    { pid: 51, ppid: 50, args: '-zsh' },
    { pid: 52, ppid: 51, args: 'node /opt/homebrew/bin/vdx ai' },
    { pid: 53, ppid: 52, args: 'tmux attach-session -t =proj@lft' },
    { pid: 60, ppid: 1, args: '/Applications/cmux.app/Contents/MacOS/cmux' },
    { pid: 61, ppid: 60, args: 'tmux attach-session -t =proj@lft' },
  ];
  it('the mark vdx ai gave it at the attach; else under sshd another machine; else this one', () => {
    expect(clientSeat(53, procs, 'lft', () => ['tmux', 'VDX_AI_SEAT=m3'])).toBe('m3');
    expect(clientSeat(53, procs, 'lft', () => null)).toBe('?');
    expect(clientSeat(61, procs, 'lft', () => ['tmux'])).toBe('lft');
    // A mark that would read as an option to ssh is no mark.
    expect(clientSeat(61, procs, 'lft', () => ['VDX_AI_SEAT=-oX'])).toBe('lft');
  });
});

describe('planLaunch', () => {
  let root: string;
  const env = parseEnvironment(OWNER_LIKE, 'p.yaml');
  const plan = () =>
    planLaunch({
      environment: env,
      profilePath: 'p.yaml',
      agent: env.agent!,
      projectRoot: root,
      project: 'proj',
      host: 'lft',
    });

  beforeEach(() => {
    root = tmpDir('vdx-ai-plan-');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('adds the channel flag and its prompt when the project declares mail.watch', () => {
    fs.mkdirSync(path.join(root, 'signals'));
    fs.writeFileSync(path.join(root, 'signals', 'sources.yaml'), 'mail:\n  watch:\n    zone: America/New_York\n');
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
    expect(p.machines).toEqual(['M3']); // this machine is not asked about itself
  });

  it('a focused session leaves out the rules that wake it — flag and prompt — and names them', () => {
    fs.mkdirSync(path.join(root, 'signals'));
    fs.writeFileSync(path.join(root, 'signals', 'sources.yaml'), 'mail:\n  watch:\n    zone: UTC\n');
    const p = planLaunch({
      environment: env,
      profilePath: 'p.yaml',
      agent: env.agent!,
      projectRoot: root,
      project: 'proj',
      host: 'lft',
      focused: true,
    });
    expect(p.focused).toBe(true);
    expect(p.args).toEqual(['--dangerously-skip-permissions']);
    expect(p.matched).toEqual([]);
    expect(p.skipped).toEqual(['echelon-channel']);
    expect(p.confirm).toEqual([]);
    expect(plan().focused).toBe(false);
  });

  it('the HQ session keeps the rules that wake it, has a session of its own and its first prompt', () => {
    fs.mkdirSync(path.join(root, 'signals'));
    fs.writeFileSync(path.join(root, 'signals', 'sources.yaml'), 'mail:\n  watch:\n    zone: UTC\n');
    const agent = { ...env.agent!, intercom_args: ['/mail'], hq_args: ['/echelon:whatsup'] };
    const mode = (over: { hq?: boolean; focused?: boolean; intercom?: boolean }) =>
      planLaunch({
        environment: env,
        profilePath: 'p.yaml',
        agent,
        projectRoot: root,
        project: 'proj',
        host: 'lft',
        ...over,
      });
    const p = mode({ hq: true });
    expect([p.hq, p.focused, p.intercom, p.sessionName, p.opening]).toEqual([
      true,
      false,
      false,
      'proj@lft-hq',
      ['/echelon:whatsup'],
    ]);
    expect(p.matched).toEqual(['echelon-channel']);
    expect(p.skipped).toEqual([]);
    // Asked for it with another mode: that mode, no HQ session.
    expect(mode({ hq: true, focused: true }).hq).toBe(false);
    expect(mode({ hq: true, intercom: true }).opening).toEqual(['/mail']);
    expect(mode({}).opening).toEqual([]);
  });

  it('the intercom session keeps the rules that wake it, has a session of its own and its first prompt', () => {
    fs.mkdirSync(path.join(root, 'signals'));
    fs.writeFileSync(path.join(root, 'signals', 'sources.yaml'), 'mail:\n  watch:\n    zone: UTC\n');
    const agent = { ...env.agent!, intercom_args: ['/vdm:intercom check'] };
    const mail = (over: { focused?: boolean } = {}) =>
      planLaunch({
        environment: env,
        profilePath: 'p.yaml',
        agent,
        projectRoot: root,
        project: 'proj',
        host: 'lft',
        intercom: true,
        ...over,
      });
    const p = mail();
    expect(p.intercom).toBe(true);
    expect(p.matched).toEqual(['echelon-channel']);
    expect(p.args).toContain('plugin:echelon@echelon');
    expect(p.opening).toEqual(['/vdm:intercom check']);
    expect(p.sessionName).toBe('proj@lft-intercom');
    // Asked for both, it is focused, as intercom reads it — no intercom session.
    const both = mail({ focused: true });
    expect([both.intercom, both.focused, both.sessionName, both.opening]).toEqual([false, true, 'proj@lft', []]);
    // A plain start does not carry the intercom session's first prompt.
    const plain = planLaunch({
      environment: env,
      profilePath: 'p.yaml',
      agent,
      projectRoot: root,
      project: 'proj',
      host: 'lft',
    });
    expect(plain.opening).toEqual([]);
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
    const p = planLaunch({
      environment: bare,
      profilePath: null,
      agent: bare.agent!,
      projectRoot: root,
      project: 'proj',
      host: 'lft',
    });
    expect(p.multiplexer).toBe('none');
    expect(p.sessionName).toBe('proj');
    expect(p.args).toEqual([]);
    expect(p.machines).toEqual([]);
  });
});

describe('renderSessionName', () => {
  it('fills placeholders and replaces what tmux would replace', () => {
    expect(renderSessionName('{project}@{host}', { project: 'www.t23b.org', host: 'lft' })).toBe('www_t23b_org@lft');
  });

  it('refuses an unknown placeholder', () => {
    expect(() => renderSessionName('{projcet}', { project: 'x' })).toThrow('{projcet}');
  });
});

describe('freeSessionName', () => {
  const at = (...sessions: string[]) => sessions.map((session) => ({ pane: { session } }));
  it('the name itself when no agent of the project runs in it', () => {
    expect(freeSessionName('vdx@lft', [])).toBe('vdx@lft');
    expect(freeSessionName('vdx@lft', at('vdx@lft-2'))).toBe('vdx@lft');
  });
  it('next to running agents: the first numbered one free', () => {
    expect(freeSessionName('vdx@lft', at('vdx@lft'))).toBe('vdx@lft-2');
    // Two agents in one session (windows, before vdx-ai DL #36) still take one name.
    expect(freeSessionName('vdx@lft', at('vdx@lft', 'vdx@lft', 'vdx@lft-2'))).toBe('vdx@lft-3');
    expect(freeSessionName('vdx@lft', at('vdx@lft', 'vdx@lft-3'))).toBe('vdx@lft-2');
  });
  it('…and one no other terminal shows (vdx-ai-predictable Sidetrack #13)', () => {
    expect(freeSessionName('vdx@lft', [], new Set(['vdx@lft']))).toBe('vdx@lft-2');
    expect(freeSessionName('vdx@lft', at('vdx@lft'), new Set(['vdx@lft-2']))).toBe('vdx@lft-3');
  });
});

describe('handOffRestart', () => {
  it('runs vdx apart, in a session of its own, with the env it is given and its output in the file', () => {
    const dir = tmpDir('vdx-handoff-');
    try {
      const script = path.join(dir, 'fake-vdx.cjs');
      fs.writeFileSync(
        script,
        "const { execFileSync } = require('node:child_process');\n" +
          "const pgid = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim();\n" +
          'console.log(JSON.stringify({ args: process.argv.slice(2), pane: process.env.VDX_AI_RESTART_PANE, own: pgid === String(process.pid) }));\n',
      );
      const log = path.join(dir, 'restart', 'x.log');
      const pid = handOffRestart(['ai', '/p', '--restart'], { ...process.env, VDX_AI_RESTART_PANE: '%9' }, log, script);
      expect(pid).toBeGreaterThan(0);
      for (let i = 0; i < 50 && !(fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('}')); i++)
        sleepSync(100);
      expect(JSON.parse(fs.readFileSync(log, 'utf8'))).toEqual({
        args: ['ai', '/p', '--restart'],
        pane: '%9',
        own: true,
      });
      expect(handOffRestart([], process.env, log, '')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
  const echoArgs = (line: string) => execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${line}`], { encoding: 'utf8' });

  it('round-trips awkward arguments through sh', () => {
    const args = ['plain', 'with space', "it's", '$HOME', '', 'a"b', 'plugin:echelon@echelon', '=arch@lft', 'a=b'];
    expect(echoArgs(args.map(shellQuote).join(' '))).toBe(args.join('\n') + '\n');
  });

  it('quotes a word that starts with =: zsh expands a bare =word to a command path', () => {
    expect(shellQuote('=limeflow@lft-intercom')).toBe("'=limeflow@lft-intercom'");
    expect(shellQuote('--x=y')).toBe('--x=y');
    expect(new Tmux().attachHint('limeflow@lft-intercom')).toBe("tmux attach -t '=limeflow@lft-intercom'");
    expect(new Tmux('sock').attachHint('arch@lft')).toBe("tmux -L sock attach -t '=arch@lft'");
  });

  it('wraps the agent in a login shell that stays open after it exits, and says first which tmux session it is', () => {
    const line = commandLine('claude', ['--dangerously-skip-permissions']);
    const said = `printf '\\n[vdx] the agent quit: this pane is tmux session %s; detach: Ctrl-B d\\n' "$(tmux display-message -p '#S')"`;
    expect(tmuxShellCommand(line, '/bin/zsh')).toBe(
      `exec env DISABLE_AUTO_UPDATE=true /bin/zsh -lic ${shellQuote(`claude --dangerously-skip-permissions; ${said}; exec /bin/zsh -l`)}`,
    );
    expect(tmuxShellCommand(line, '/bin/zsh', false)).toBe(
      "exec env DISABLE_AUTO_UPDATE=true /bin/zsh -lic 'claude --dangerously-skip-permissions'",
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

  it('a topic needs tmux: refused before anything starts; a focused start without one goes on', () => {
    const claude = deps({ onPath: (b) => b === 'claude' });
    expect(runAi({ ...opts, path: root, focused: true, topic: 'release', dryRun: true }, claude)).toBe(EXIT_USAGE);
    expect(logs.join('\n')).toContain("a topic lives in the agent's tmux session (@vdx_topic)");
    expect(logs.join('\n')).toContain(`without a topic: vdx ai --focused ${root}`);
    logs = [];
    expect(runAi({ ...opts, path: root, focused: true, dryRun: true }, claude)).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain('topic:    — none: a topic lives in the tmux session, and this start has none');
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

    it('macOS: a guarded folder the session cannot read is named before the start, and the agent starts anyway', () => {
      const d = direct();
      const downloads = path.join(home, 'Downloads');
      fs.mkdirSync(downloads, { mode: 0o000 });
      try {
        expect(runAi({ ...opts, path: root }, { ...d, platform: 'darwin' })).toBe(EXIT_OK);
        expect(logs).toContain(
          "⚠ this session cannot read ~/Downloads — macOS holds the denial for this terminal; files there are out of the agent's reach",
        );
        expect(runs()).toEqual(['--base --resume-me']);
        logs = [];
        const profile = path.join(home, 'env.yaml');
        fs.writeFileSync(
          profile,
          fs
            .readFileSync(profile, 'utf8')
            .replace('session: {multiplexer: none}', 'session: {multiplexer: none, folders_fix: "run the fixer"}'),
        );
        expect(runAi({ ...opts, path: root }, { ...d, platform: 'darwin' })).toBe(EXIT_OK);
        expect(logs).toContain('  fix: run the fixer');
        logs = [];
        expect(runAi({ ...opts, path: root }, { ...d, platform: 'linux' })).toBe(EXIT_OK);
        expect(logs.join('\n')).not.toContain('cannot read');
      } finally {
        fs.chmodSync(downloads, 0o755);
      }
    });

    it('--focused: VDX_FOCUSED=1 for the agent, and the rules that wake it left out', () => {
      const d = direct();
      const agent = path.join(home, 'fake-agent');
      fs.writeFileSync(agent, '#!/bin/sh\necho "${VDX_FOCUSED:-plain} $*" >> "$(dirname "$0")/runs"\n', {
        mode: 0o755,
      });
      fs.writeFileSync(path.join(root, 'marker'), '');
      fs.writeFileSync(
        path.join(home, 'env.yaml'),
        `agent: {command: ${agent}, args: [--base], when: [{id: chan, if: {has_file: {path: marker}}, args: [--chan], wakes: true}]}\n` +
          'session: {multiplexer: none}\n',
      );
      d.env['VDX_FOCUSED'] = '1'; // a shell inside a focused session: its mode is not passed on
      expect(runAi({ ...opts, path: root }, d)).toBe(EXIT_OK);
      expect(d.env['VDX_FOCUSED']).toBeUndefined();
      expect(runAi({ ...opts, path: root, focused: true }, d)).toBe(EXIT_OK);
      expect(runs()).toEqual(['plain --base --chan', '1 --base']);
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
  let remoteHome: string;
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
    remoteHome = '/Users/elsewhere';
    liveHere = [];
    // The project's memory is inside it already: these tests are about the conversation.
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(
      path.join(root, '.claude', 'settings.local.json'),
      JSON.stringify({ autoMemoryDirectory: `${fs.realpathSync(root)}/.claude/memory/` }),
    );
    // A `claude` that records its args and exits: what `vdx ai` ran it with.
    fs.mkdirSync(path.join(home, 'bin'));
    fs.writeFileSync(path.join(home, 'bin', 'claude'), '#!/bin/sh\necho "$*" >> "$(dirname "$0")/../runs"\n', {
      mode: 0o755,
    });
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
      // The list's words are what the tests read: no bold titles at the terminal they pretend to be.
      NO_COLOR: '1',
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
      if (!remoteLive) return { status: 255, stdout: '' };
      return { status: 0, stdout: [`home=${remoteHome}`, ...remoteLive.map((o) => JSON.stringify(o))].join('\n') };
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

  it('a plain choice still names a machine that did not answer', () => {
    fs.writeFileSync(
      path.join(home, 'env.yaml'),
      `agent: {command: ${path.join(home, 'bin', 'claude')}, args: [--base], resume_args: [--continue]}\n` +
        'session: {multiplexer: none, machines: [m3]}\n',
    );
    conv(ID.a, 'lft', 30);
    remoteLive = null; // an ssh session here without the key agent: m3 refuses the key
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(runs()).toEqual([`--base --resume ${ID.a}`]);
    expect(text()).toContain('note: m3 does not answer over ssh — what runs there is not known');
  });

  it("passes over the intercom session's conversations: the person continues their own", () => {
    conv(ID.a, 'lft', 30);
    const mailStart = hookLine(`${machineLine('lft')}; …\n${INTERCOM_LINE_PREFIX} (\`vdx ai --intercom\`): …`);
    writeConversation(path.join(home, 'cc'), root, ID.b, [mailStart, userLine('/vdm:intercom check')], 5);
    answers = ['should not be read'];
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(runs()).toEqual([`--base --resume ${ID.a}`]);
    expect(answers).toHaveLength(1);
    // Named, it is opened all the same.
    expect(runAi({ ...opts, path: root, conversation: ID.b }, deps())).toBe(EXIT_OK);
    expect(runs()).toEqual([`--base --resume ${ID.a}`, `--base --resume ${ID.b}`]);
  });

  it("passes over the HQ session's conversations, and says so when there are no others", () => {
    const hqStart = hookLine(`${machineLine('lft')}; …\n${HQ_LINE_PREFIX} (\`vdx ai --hq\`): …`);
    writeConversation(path.join(home, 'cc'), root, ID.b, [hqStart, userLine('/echelon:whatsup')], 5);
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(runs()).toEqual(['--base']);
    expect(text()).toContain(
      "only the HQ session's conversations here (1; vdx ai --conversation <id> opens one) — starting a new one",
    );
    conv(ID.a, 'lft', 30);
    answers = ['should not be read'];
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(runs()).toEqual(['--base', `--base --resume ${ID.a}`]);
    expect(answers).toHaveLength(1);
  });

  it("a transcript with the line under its former name stays the intercom session's", () => {
    conv(ID.a, 'lft', 30);
    const mailStart = hookLine(
      `${machineLine('lft')}; …\n· this is the project's mail session (\`vdx ai --intercom\`): …`,
    );
    writeConversation(path.join(home, 'cc'), root, ID.b, [mailStart, userLine('/vdm:intercom check')], 5);
    answers = ['should not be read'];
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(runs()).toEqual([`--base --resume ${ID.a}`]);
    expect(answers).toHaveLength(1);
  });

  it("only the intercom session's conversations: a new one, and the line says they are there", () => {
    const mailStart = hookLine(`${machineLine('lft')}; …\n${INTERCOM_LINE_PREFIX} (\`vdx ai --intercom\`): …`);
    writeConversation(path.join(home, 'cc'), root, ID.b, [mailStart, userLine('/vdm:intercom check')], 5);
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(runs()).toEqual(['--base']);
    expect(text()).toContain(
      "only the intercom session's conversations here (1; vdx ai --conversation <id> opens one) — starting a new one",
    );
  });

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
    expect(text()).toMatch(/1 {2}m3 +5 min ago +cut off/);
    expect(text()).toMatch(/2 {2}lft +30 min ago +cut off/);
    expect(text()).toContain('Enter → 1');
    expect(sshCalls[0]!.args.slice(0, 5)).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'm3']);
    // The vdx there reports on the project; an older one, or none — the script of live sessions.
    expect(asked()).toEqual([expect.stringMatching(/^vdx ai .* --report 2>\/dev\/null \|\| sh -c .*sessions/)]);
    expect(remoteRuns()).toHaveLength(1);
    expect(remoteRuns()[0]!.slice(0, 2)).toEqual(['-t', 'm3']);
    expect(remoteRuns()[0]![2]).toContain(`exec vdx ai ${root} --conversation ${ID.b}`);
  });

  it('Ctrl-D at the question starts nothing — it is a cancel, not "no terminal"', () => {
    conv(ID.a, 'lft', 30);
    conv(ID.b, 'm3', 5);
    answers = []; // ask() answers null: end of input
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_LAUNCH_FAILED);
    expect(runs()).toEqual([]);
    expect(remoteRuns()).toEqual([]);
    expect(text()).toContain('no answer — nothing started');
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
    // said under the list, before the person picks — not only after Enter
    expect(text()).toMatch(/ {2}note: m3 does not answer over ssh — what runs there is not known\n+ {2}Enter → 1/);
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
    expect(text()).toContain(
      `note: m3 has a newer conversation bbbbbbbb — continue it there: vdx ai@m3 ${root} --conversation ${ID.b}`,
    );
  });

  it("with only another machine's conversation and no terminal, a new one here — never theirs", () => {
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
    expect(text()).toMatch(/1 {2}\? +55 min ago +cut off, machine unknown/);
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

  it("the only agent of the project, running on another machine, is attached to there — even in a conversation not that machine's newest (P1)", () => {
    conv(ID.a, 'lft', 30);
    conv(ID.b, 'm3', 5);
    conv(ID.c, 'm3', 120);
    remoteLive = [{ pid: 10984, sessionId: ID.c, tmux: 'proj@m3:@25.%25', status: 'busy' }];
    answers = ['should not be read'];
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(answers).toHaveLength(1);
    expect(text()).toMatch(/the only agent of .* runs on m3 \(proj@m3\), and no terminal at your seat shows it/);
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
    liveHere = [{ pid: 4242, conversation: ID.a, tmux: null, status: 'busy', cwd: null }];
    // It runs in a terminal here: Enter passes it by (DL #2); picked, it asks.
    answers = ['1', ''];
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_LAUNCH_FAILED);
    expect(text()).toMatch(/1 {2}pid 4242 on lft {2}⏳ working {2}prompt aaaa · open here/);
    expect(text()).toContain('Enter → n');
    answers = ['1', 'y'];
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(runs()).toEqual([`--base --resume ${ID.a}`]);
  });

  it('…without a terminal it is not taken, and a machine that does not answer is named', () => {
    conv(ID.a, 'lft', 30);
    conv(ID.b, 'm3', 300);
    liveHere = [{ pid: 4242, conversation: ID.a, tmux: null, status: 'busy', cwd: null }];
    remoteLive = null;
    expect(runAi({ ...opts, path: root, dryRun: true }, deps())).toBe(EXIT_OK);
    expect(text()).toContain('resume:   —');
    expect(text()).toContain('no idle conversation of this machine — starting a new one');
    expect(text()).toContain(
      'note: a newer conversation aaaaaaaa, running here now (pid 4242, busy) — not taken: it would have two sessions',
    );
    expect(text()).toContain('note: m3 does not answer over ssh — what runs there is not known');
  });

  it('started by `vdx ai@lft` from m3: lft goes by its name, and m3 is where the person is', () => {
    conv(ID.a, 'lft', 30);
    conv(ID.c, 'm3', 5);
    liveHere = [{ pid: 4242, conversation: ID.a, tmux: null, status: 'busy', cwd: null }];
    const d = deps();
    d.env['VDX_AI_FROM'] = 'm3';
    expect(runAi({ ...opts, path: root, dryRun: true }, d)).toBe(EXIT_OK);
    expect(text()).toContain('no idle conversation on lft — starting a new one');
    expect(text()).toContain('note: a newer conversation aaaaaaaa, running on lft now (pid 4242, busy) — not taken');
    // No `vdx ai@m3` for a person sitting at m3: that is ssh to itself.
    expect(text()).toContain(
      `note: m3 has a newer conversation cccccccc — continue it where you are: vdx ai ${root} --conversation ${ID.c}`,
    );
    expect(text()).not.toMatch(/\bhere\b/);
    expect(d.env['VDX_AI_FROM']).toBeUndefined(); // the agent started on lft does not inherit it
  });

  it('…and a conversation that runs on lft is asked about on lft, not "here"', () => {
    conv(ID.a, 'lft', 30);
    liveHere = [{ pid: 4242, conversation: ID.a, tmux: null, status: 'busy', cwd: null }];
    const questions: string[] = [];
    answers = ['', ''];
    const d = deps({ ask: (q) => (questions.push(q), answers.shift() ?? null) });
    d.env['VDX_AI_FROM'] = 'm3';
    expect(runAi({ ...opts, path: root }, d)).toBe(EXIT_LAUNCH_FAILED);
    // The only agent, and no terminal at m3 shows it: no list — straight to the question.
    expect(text()).toMatch(/the only agent of .* runs on lft \(pid 4242\), and no terminal at your seat shows it/);
    expect(questions[0]).toBe(
      `Continue aaaaaaaa on lft? It runs on lft right now (pid 4242); two sessions would write to it. [y/N]: `,
    );
    expect(text()).toContain(
      `nothing started. On lft: vdx ai@lft ${root} --conversation ${ID.a} · a new conversation: vdx ai@lft --new ${root}`,
    );
  });

  describe('the profile names the machines (session.machines)', () => {
    const agentOnM3 = (cwd: string, id: string = ID.c) => ({
      pid: 10984,
      sessionId: id,
      tmux: 'proj@m3:@25.%25',
      status: 'idle',
      cwd,
    });
    const asked = () => sshCalls.filter((c) => c.capture).map((c) => c.args[4]);
    beforeEach(() => {
      fs.writeFileSync(
        path.join(home, 'env.yaml'),
        `agent: {command: ${path.join(home, 'bin', 'claude')}, args: [--base], resume_args: [--continue]}\n` +
          'session: {multiplexer: none, machines: [lft, m3]}\n',
      );
    });

    it('asks them even when no conversation names them — the t23b-program case', () => {
      conv(ID.a, 'lft', 300);
      conv(ID.c, null, 5); // started on m3 before vdx named machines; never typed in here
      remoteLive = [agentOnM3(root)];
      answers = ['should not be read'];
      expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
      expect(asked()).toEqual(['m3']); // never this machine
      expect(text()).toMatch(/the only agent of .* runs on m3 \(proj@m3\)/);
      expect(remoteRuns()[0]![2]).toContain(`--conversation ${ID.c}`);
      expect(runs()).toEqual([]);
    });

    it('--new while an agent of this project runs there: a new conversation here only after a yes', () => {
      const proj = path.join(home, 'AI Projects', 'proj'); // m3 keeps it under its own home
      fs.mkdirSync(proj, { recursive: true });
      remoteLive = [agentOnM3(path.join(remoteHome, 'AI Projects', 'proj'))];
      answers = [''];
      expect(runAi({ ...opts, path: proj, fresh: true }, deps())).toBe(EXIT_LAUNCH_FAILED);
      expect(text()).toContain(
        `an agent of this project is running on m3 now (proj@m3, idle) — there: vdx ai@m3 '${proj}'`,
      );
      expect(text()).toContain('nothing started');
      expect(runs()).toEqual([]);
      answers = ['y'];
      expect(runAi({ ...opts, path: proj, fresh: true }, deps())).toBe(EXIT_OK);
      expect(runs()).toEqual(['--base']);
    });

    it('started by `vdx ai@lft` from m3: the agent on m3 is where the person is — attach there without ssh', () => {
      const proj = path.join(home, 'AI Projects', 'proj');
      fs.mkdirSync(proj, { recursive: true });
      remoteLive = [agentOnM3(path.join(remoteHome, 'AI Projects', 'proj'))];
      const questions: string[] = [];
      answers = [''];
      const d = deps({ ask: (q) => (questions.push(q), answers.shift() ?? null) });
      d.env['VDX_AI_FROM'] = 'm3';
      expect(runAi({ ...opts, path: proj, fresh: true }, d)).toBe(EXIT_LAUNCH_FAILED);
      expect(text()).toContain(
        `an agent of this project is running on m3, where you are, now (proj@m3, idle) — attach: vdx ai '${path.join(remoteHome, 'AI Projects', 'proj')}'`,
      );
      expect(questions).toEqual(['Start a new conversation on lft anyway? [y/N]: ']);
    });

    it('an agent outside tmux gets no command — `vdx ai` attaches only to one in tmux', () => {
      remoteLive = [{ ...agentOnM3(root), tmux: null }];
      answers = [''];
      expect(runAi({ ...opts, path: root, fresh: true }, deps())).toBe(EXIT_LAUNCH_FAILED);
      expect(logs).toContain('an agent of this project is running on m3 now (pid 10984, idle)');
    });

    it('…without a terminal nothing starts', () => {
      remoteLive = [agentOnM3(root)];
      answers = ['should not be read'];
      expect(runAi({ ...opts, path: root, fresh: true }, deps({ interactive: false }))).toBe(EXIT_LAUNCH_FAILED);
      expect(answers).toHaveLength(1);
      expect(text()).toContain('nothing started');
    });

    it('a project without conversations here, its agent running there: attached to there (P1) — not a new one here', () => {
      remoteLive = [agentOnM3(root)];
      answers = ['should not be read'];
      expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
      expect(text()).toMatch(/the only agent of .* runs on m3 \(proj@m3\)/);
      expect(remoteRuns()).toHaveLength(1);
      expect(remoteRuns()[0]![2]).toContain(`--conversation ${ID.c}`);
      expect(runs()).toEqual([]);
    });

    it('…without a terminal nothing starts: a new conversation here waits for a yes', () => {
      remoteLive = [agentOnM3(root)];
      expect(runAi({ ...opts, path: root }, deps({ interactive: false }))).toBe(EXIT_LAUNCH_FAILED);
      expect(text()).toContain('no conversation of this project yet');
      expect(text()).toContain('an agent of this project is running on m3 now');
      expect(remoteRuns()).toEqual([]);
      expect(runs()).toEqual([]);
    });

    it('with no idle conversation of this machine and no terminal, the new one waits for a yes too', () => {
      conv(ID.c, 'm3', 5);
      remoteLive = [agentOnM3(root)];
      expect(runAi({ ...opts, path: root, dryRun: true }, deps())).toBe(EXIT_OK);
      expect(text()).toContain('no idle conversation of this machine — starting a new one');
      expect(text()).toContain(
        `conversation: an agent of this project is running on m3 now (proj@m3, idle) — there: vdx ai@m3 ${root}`,
      );
    });

    it('an agent of another project there is not in the way; a machine that does not answer is named', () => {
      remoteLive = [agentOnM3('/Users/elsewhere/AI Projects/other')];
      expect(runAi({ ...opts, path: root, fresh: true }, deps())).toBe(EXIT_OK);
      remoteLive = null;
      expect(runAi({ ...opts, path: root, fresh: true }, deps())).toBe(EXIT_OK);
      expect(runs()).toEqual(['--base', '--base']);
      expect(text()).toContain('note: m3 does not answer over ssh — what runs there is not known');
      expect(text()).not.toContain('an agent of this project');
    });
  });

  it('--conversation is refused for an agent that is not Claude Code', () => {
    fs.writeFileSync(
      path.join(home, 'env.yaml'),
      'agent: {command: codex, resume_args: [resume]}\nsession: {multiplexer: none}\n',
    );
    expect(runAi({ ...opts, path: root, conversation: ID.c }, deps())).toBe(EXIT_USAGE);
    expect(text()).toContain('--conversation names a Claude Code conversation');
  });

  it('another agent keeps the profile resume_args — vdx reads no conversations for it', () => {
    fs.writeFileSync(path.join(home, 'bin', 'codex'), fs.readFileSync(path.join(home, 'bin', 'claude')), {
      mode: 0o755,
    });
    fs.writeFileSync(
      path.join(home, 'env.yaml'),
      `agent: {command: ${path.join(home, 'bin', 'codex')}, args: [--base], resume_args: [resume, --last]}\nsession: {multiplexer: none}\n`,
    );
    conv(ID.b, 'm3', 5);
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(runs()).toEqual(['--base resume --last']);
  });

  describe('one list for a plain start (vdx-ai-predictable)', () => {
    const withWrap = () =>
      fs.writeFileSync(
        path.join(home, 'env.yaml'),
        `agent: {command: ${path.join(home, 'bin', 'claude')}, args: [--base], resume_args: [--continue]}\n` +
          'session: {multiplexer: none, machines: [m3], wrap_skills: [vdm:wrap]}\n',
      );
    /** What a vdx 0.44+ on m3 answers: its report on the project. */
    const report = (over: object = {}) =>
      deps({
        ssh: (args, capture) => {
          sshCalls.push({ args, capture });
          if (!capture) return { status: 0, stdout: '' };
          return {
            status: 0,
            stdout: JSON.stringify({
              vdx: '0.44.0',
              machine: 'm3',
              home: remoteHome,
              sessions: [],
              agents: [],
              typed: [],
              transcripts: [],
              ...over,
            }),
          };
        },
      });
    const agentThere = (over: object = {}) => ({
      machine: 'm3',
      session: 'proj@m3',
      pid: 10984,
      conversation: ID.c,
      status: 'idle',
      activeAt: Date.now() - 60_000,
      draft: 0,
      focused: false,
      topic: null,
      mail: false,
      openAt: [],
      title: 'On m3',
      empty: false,
      finished: false,
      ...over,
    });

    it('a finished conversation (wrap, nothing typed after) is not continued without asking; Enter passes it by', () => {
      withWrap();
      remoteLive = [];
      writeConversation(
        path.join(home, 'cc'),
        root,
        ID.a,
        [startedOn('lft'), userLine('work'), skillLine('vdm:wrap'), bashLine('sh /tmp/c.sh')],
        5,
      );
      conv(ID.b, 'lft', 60);
      answers = [''];
      expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
      expect(text()).toMatch(/1 {2}lft +5 min ago +✅ finished/);
      expect(text()).toMatch(/2 {2}lft .* cut off/);
      expect(text()).toContain('Enter → 2');
      expect(runs()).toEqual([`--base --resume ${ID.b}`]);
    });

    it('a terminal over ssh with no seat mark (an attach of vdx before 0.44) is the other machine of two: here', () => {
      withWrap();
      conv(ID.a, 'lft', 30);
      answers = [''];
      const d = report({ agents: [agentThere({ openAt: ['m3', '?'] })] });
      expect(runAi({ ...opts, path: root }, d)).toBe(EXIT_OK);
      expect(text()).toMatch(/1 {2}proj@m3 {2}💤 idle {2}On m3 · open here/);
      expect(text()).toContain('Enter → 2');
      expect(remoteRuns()).toEqual([]);
    });

    it("a program's SDK run is not listed; a conversation running there is no «not here yet»", () => {
      withWrap();
      conv(ID.a, 'lft', 30);
      writeConversation(path.join(home, 'cc'), root, ID.b, [userLine('Review this change', 'sdk-py')], 5);
      answers = ['n'];
      const running = { id: ID.c, mtime: Date.now(), size: 10_000_000 };
      const d = report({ agents: [agentThere({ openAt: ['lft'] })], transcripts: [running] });
      expect(runAi({ ...opts, path: root }, d)).toBe(EXIT_OK);
      expect(text()).not.toContain('bbbbbbbb');
      expect(text()).not.toContain('not here yet');
    });

    it('an agent a terminal at this seat shows is marked, and Enter does not take it (DL #2)', () => {
      withWrap();
      conv(ID.a, 'lft', 30);
      answers = [''];
      const d = report({ agents: [agentThere({ openAt: ['lft'] })] });
      expect(runAi({ ...opts, path: root }, d)).toBe(EXIT_OK);
      expect(text()).toMatch(/1 {2}proj@m3 {2}💤 idle {2}On m3 · open here/);
      expect(text()).toContain('Enter → 2');
      expect(runs()).toEqual([`--base --resume ${ID.a}`]);
      expect(remoteRuns()).toEqual([]);
    });

    it("the other machine's report: its agents, the machine of a conversation typed there, a copy here that is behind", () => {
      withWrap();
      conv(ID.a, 'lft', 30);
      conv(ID.b, null, 40); // no machine line: typed on m3 (its history.jsonl)
      const behind = { id: ID.a, mtime: Date.now(), size: 10_000_000 }; // m3 wrote on since our copy
      answers = ['4'];
      const focused = agentThere({
        session: 'proj@m3-2',
        pid: 10985,
        conversation: ID.d,
        status: 'busy',
        activeAt: Date.now(),
        focused: true,
        topic: 'search',
        title: 'Focused',
      });
      const d = report({
        agents: [agentThere({ draft: 12, openAt: ['m3'] }), focused],
        typed: [ID.b],
        transcripts: [behind],
      });
      expect(runAi({ ...opts, path: root }, d)).toBe(EXIT_OK);
      expect(text()).toMatch(/1 {2}proj@m3-2 {2}⏳ working +🎯 {2}Focused/);
      expect(text()).toMatch(/2 {2}proj@m3 {4}💤 draft \(12 chars\) +On m3 · open on m3/);
      expect(text()).toMatch(/3 {2}m3 +30 min ago +not here yet from m3 — continues there/);
      expect(text()).toMatch(/4 {2}m3 +40 min ago +cut off/);
      expect(text()).toContain('note: 1 conversation not here yet from another machine (sync behind)');
      expect(remoteRuns()[0]![2]).toContain(`--conversation ${ID.b}`);
      expect(runs()).toEqual([]);
    });

    it('`a` shows every conversation; n starts a new one', () => {
      withWrap();
      remoteLive = [];
      for (const [i, id] of [
        ID.a,
        ID.b,
        ID.c,
        ID.d,
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ].entries())
        conv(id, i % 2 ? 'lft' : 'm3', 10 + i);
      answers = ['a', 'n'];
      expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
      expect(text()).toContain('a all (1 more)');
      expect(text()).toMatch(/6 {2}lft +15 min ago +cut off/);
      expect(runs()).toEqual(['--base']);
    });

    it('--list prints the list and starts nothing, asks nothing', () => {
      conv(ID.a, 'lft', 30);
      conv(ID.b, 'm3', 5);
      answers = ['should not be read'];
      expect(runAi({ ...opts, path: root, list: true }, deps())).toBe(EXIT_OK);
      expect(answers).toHaveLength(1);
      expect(text()).toMatch(/\n+nothing runs now\n+CONVERSATIONS NOBODY RUNS · \d+\n/);
      // Under each row, the command that reaches it from this seat (Sidetrack #7); no question, so no keys.
      expect(text()).toContain(`       vdx ai ${shellQuote(root)} --conversation ${ID.a}`);
      expect(text()).toContain(`       vdx ai@m3 ${shellQuote(root)} --conversation ${ID.b}`);
      expect(text()).not.toContain('Enter →');
      expect(runs()).toEqual([]);
      expect(remoteRuns()).toEqual([]);
    });

    describe('the search: `/<phrase>` at the question and --find (P5)', () => {
      const said = (id: string, machine: string, lines: string[], minutesAgo: number) =>
        writeConversation(path.join(home, 'cc'), root, id, [startedOn(machine), ...lines], minutesAgo);

      it('`/<phrase>` at the list: the conversations that have it — a wrapped one too; Enter continues it', () => {
        withWrap();
        remoteLive = [];
        conv(ID.a, 'm3', 5);
        said(
          ID.b,
          'lft',
          [userLine('go'), replyLine('Список для ответа готов: 17 незаявленных'), skillLine('vdm:wrap')],
          60,
        );
        answers = ['/nothing like it', '/17 НЕЗАЯВЛЕННЫХ', ''];
        expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
        expect(text()).toContain('Enter → 1 · /<phrase> find · n new · f new focused');
        expect(text()).toContain('has «nothing like it» — searched what you and the agent said in 2 conversations');
        expect(text()).toMatch(
          /— «17 НЕЗАЯВЛЕННЫХ» in 1 of 2 conversations\n+CONVERSATIONS NOBODY RUNS · 1\n+. 1 {2}lft .* ✅ finished/,
        );
        expect(text()).toContain('       agent: «Список для ответа готов: 17 незаявленных»');
        expect(runs()).toEqual([`--base --resume ${ID.b}`]);
        expect(remoteRuns()).toEqual([]);
      });

      // The owner, 2026-11-12 (Sidetrack #15): with fzf on PATH the list has a cursor — the same choices, as rows.
      const twoMachines = () => {
        withWrap();
        remoteLive = [];
        conv(ID.a, 'm3', 5);
        said(
          ID.b,
          'lft',
          [userLine('go'), replyLine('Список для ответа готов: 17 незаявленных'), skillLine('vdm:wrap')],
          60,
        );
      };

      it('with a picker: its key searches, nothing found is said above the rows, the row under the cursor is taken', () => {
        twoMachines();
        const shown: PickerInput[] = [];
        const searches = ['nothing like it', '17 НЕЗАЯВЛЕННЫХ'];
        const pick = (input: PickerInput) => {
          shown.push(input);
          const query = searches.shift();
          return query ? { key: 'ctrl-s', index: null, query } : { key: '', index: input.cursor, query: '' };
        };
        answers = ['should not be read'];
        expect(runAi({ ...opts, path: root }, deps({ pick }))).toBe(EXIT_OK);
        expect(answers).toHaveLength(1);
        expect(shown).toHaveLength(3);
        expect(shown[0]!.items.map((i) => i.text).slice(-2)).toEqual([
          '+ new conversation',
          '+ new focused conversation',
        ]);
        expect(shown[1]!.header[0]).toContain('has «nothing like it» — searched what you and the agent said');
        expect(shown[2]!.header[0]).toContain('«17 НЕЗАЯВЛЕННЫХ» in 1 of 2 conversations');
        expect(shown[2]!.items[shown[2]!.cursor]!.text).toMatch(/lft .* ✅ finished/);
        expect(shown[2]!.items[shown[2]!.cursor]!.detail.join('\n')).toContain(
          'found: agent: «Список для ответа готов: 17 незаявленных»',
        );
        // The plain list and its question are not shown next to the picker.
        expect(text()).not.toContain('Enter →');
        expect(runs()).toEqual([`--base --resume ${ID.b}`]);
      });

      it('with a picker: Esc starts nothing; a picker that does not show leaves the plain list and its question', () => {
        twoMachines();
        expect(runAi({ ...opts, path: root }, deps({ pick: () => null }))).toBe(EXIT_LAUNCH_FAILED);
        expect(text()).toContain('nothing picked — nothing started');
        expect(runs()).toEqual([]);
        answers = ['n'];
        expect(runAi({ ...opts, path: root }, deps({ pick: () => 'failed' }))).toBe(EXIT_OK);
        expect(text()).toContain('note: fzf did not show the list — the plain one instead');
        expect(text()).toContain('Enter → 1 · /<phrase> find · n new · f new focused');
        expect(runs()).toEqual(['--base']);
      });

      it('--find at a terminal: the search first, where a plain start would continue without asking', () => {
        conv(ID.a, 'lft', 5);
        said(ID.b, 'lft', [userLine('the screen said: server exited unexpectedly')], 60);
        answers = [''];
        expect(runAi({ ...opts, path: root, find: 'server exited' }, deps())).toBe(EXIT_OK);
        expect(text()).toContain('you: «the screen said: server exited unexpectedly»');
        expect(runs()).toEqual([`--base --resume ${ID.b}`]);
      });

      it('--find with nobody to ask: printed with the command for each row; nothing asked or started', () => {
        remoteLive = [];
        conv(ID.a, 'lft', 5);
        said(ID.b, 'm3', [userLine('server exited unexpectedly')], 60);
        answers = ['should not be read'];
        expect(runAi({ ...opts, path: root, find: 'server exited' }, deps({ interactive: false }))).toBe(EXIT_OK);
        expect(text()).toContain(`       vdx ai@m3 ${shellQuote(root)} --conversation ${ID.b}`);
        expect(text()).not.toContain('Enter →');
        expect(answers).toHaveLength(1);
        expect(runs()).toEqual([]);
        expect(remoteRuns()).toEqual([]);
      });

      it('--find with --new, --focused or --conversation: refused, nothing started', () => {
        for (const over of [{ fresh: true }, { focused: true }, { conversation: ID.a }]) {
          expect(runAi({ ...opts, path: root, find: 'x', ...over }, deps())).toBe(EXIT_USAGE);
        }
        expect(text()).toContain('vdx ai: --find picks from the conversations it finds');
        expect(runs()).toEqual([]);
      });
    });

    it('--report: this machine on the project — live sessions, conversations typed here, its transcripts', () => {
      conv(ID.a, 'lft', 30);
      conv(ID.b, 'm3', 5);
      writeHistory(path.join(home, 'cc'), root, [ID.a]);
      liveHere = [{ pid: 4242, conversation: ID.a, tmux: null, status: 'busy', cwd: root }];
      const out: string[] = [];
      expect(runAiReport(root, deps({ out: (t) => out.push(t) }))).toBe(EXIT_OK);
      const r = JSON.parse(out.join('')) as RemoteReport;
      expect(r.machine).toBe('lft');
      expect(r.home).toBe(home);
      expect(r.sessions.map((l) => l.pid)).toEqual([4242]);
      expect(r.typed).toEqual([ID.a]);
      expect(r.transcripts.map((t) => t.id)).toEqual([ID.b, ID.a]);
      expect(r.agents).toEqual([]); // none in tmux here
    });
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

  const writeProfile = (args: string[], wakes = false, intercomArgs: string[] = [], hqArgs: string[] = []) =>
    fs.writeFileSync(
      profile,
      [
        'agent:',
        `  command: ${path.join(base, 'fake-agent')}`,
        `  args: [${args.join(', ')}]`,
        '  resume_args: [--resume-me]',
        ...(intercomArgs.length ? [`  intercom_args: [${intercomArgs.map((a) => JSON.stringify(a)).join(', ')}]`] : []),
        ...(hqArgs.length ? [`  hq_args: [${hqArgs.map((a) => JSON.stringify(a)).join(', ')}]`] : []),
        '  when:',
        '    - id: chan',
        '      if: {config_value: {path: signals/sources.yaml, jsonpath: mail.watch}}',
        ...(wakes ? ['      wakes: true'] : []),
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
    // The fake agent is a /bin/sh script, and macOS hides the environment of its own binaries
    // from `ps -E`: the agent marks its mode itself. processFocused has its own test.
    agentFocused: (pid) => fs.existsSync(path.join(base, `focused-${pid}`)),
    agentMail: (pid) => fs.existsSync(path.join(base, `mail-${pid}`)),
    agentHq: (pid) => fs.existsSync(path.join(base, `hq-${pid}`)),
    sleep: sleepSync,
    confirmTimeoutMs: 10_000,
    ask: () => null,
  });
  const opts = { path: '', restart: false, fresh: false, detach: false, dryRun: false };
  const agentArgs = () => findAgentPanes(tmux.panes(), listProcesses(), root, 'fake-agent').map((f) => f.proc.args);

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
        '[ "$VDX_FOCUSED" = 1 ] && touch "$(dirname "$0")/focused-$$"',
        '[ "$VDX_INTERCOM" = 1 ] && touch "$(dirname "$0")/mail-$$"',
        '[ "$VDX_HQ" = 1 ] && touch "$(dirname "$0")/hq-$$"',
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
    // A start records the agents it sees, and the tests drop their servers: what one test left would
    // be another's agents tmux took down.
    fs.rmSync(path.join(base, '.local'), { recursive: true, force: true });
  });

  afterAll(() => {
    dropServer(tmux, socket);
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

  it('in a terminal, asks on drift: Enter takes the agent as it runs, q leaves it', () => {
    writeProfile(['--base', '--extra']);
    const before = agentArgs();
    const asked: string[] = [];
    const ask = (answer: string) => (prompt: string) => (asked.push(prompt), answer);

    expect(runAi({ ...opts, path: root, detach: true }, { ...deps(), interactive: true, ask: ask('') })).toBe(EXIT_OK);
    const out = logs.join('\n');
    expect(out).toMatch(/⚠ proj@testhost: \S*fake-agent is running without --extra\n/);
    expect(out).toContain(`q      leave it; later: vdx ai --restart ${shellQuote(root)}`);
    expect(out).toContain('→ proj@testhost: as is');
    expect(out).toContain('attach: ');
    expect(asked).toEqual(['Leave it as is? [Enter/r/q]: ']);
    expect(agentArgs()).toEqual(before);

    logs = [];
    expect(runAi({ ...opts, path: root, detach: true }, { ...deps(), interactive: true, ask: ask('q') })).toBe(
      EXIT_DRIFT,
    );
    expect(logs.join('\n')).toContain('nothing done');
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

  it('in a terminal, r at the drift question restarts the agent with the profile', () => {
    writeProfile(['--base', '--extra', '--more']);
    const paneBefore = tmux.panes().map((p) => p.paneId);
    expect(runAi({ ...opts, path: root, detach: true }, { ...deps(), interactive: true, ask: () => 'r' })).toBe(
      EXIT_OK,
    );
    expect(tmux.panes().map((p) => p.paneId)).toEqual(paneBefore);
    expect(agentArgs()[0]).toMatch(/fake-agent --base --extra --more --chan plugin:x@y --resume-me$/);
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
    const saved = {
      TMUX: process.env['TMUX'],
      LANG: process.env['LANG'],
      LC_ALL: process.env['LC_ALL'],
      LC_CTYPE: process.env['LC_CTYPE'],
    };
    delete process.env['TMUX'];
    delete process.env['LC_ALL'];
    delete process.env['LC_CTYPE'];
    process.env['LANG'] = 'C';
    try {
      expect(runAi({ ...opts, path: root, dryRun: true }, deps())).toBe(EXIT_OK);
      expect(logs.join('\n')).toMatch(/running: {2}proj@testhost %\d+ — matches the profile/);
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
    expect(out).toMatch(/running: {2}proj@testhost %\d+ — matches the profile/);
  });

  it('--new starts another agent next to the running one, in a new conversation, and leaves that one alone', () => {
    writeProfile(['--base', '--extra']);
    const agents = () => findAgentPanes(tmux.panes(), listProcesses(), root, 'fake-agent');
    const [running] = agents();
    expect(agents()).toHaveLength(1);
    expect(runAi({ ...opts, path: root, fresh: true }, deps())).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain(
      `note: proj@testhost keeps running ${path.join(base, 'fake-agent')} — ` +
        'starting another one next to it, in a new conversation',
    );
    expect(agents()).toHaveLength(2);
    const added = agents().find((a) => a.proc.pid !== running!.proc.pid)!;
    // A session of its own: a window in proj@testhost would move every terminal on it to the new one.
    expect(added.pane.session).toBe('proj@testhost-2');
    expect(tmux.run(['list-windows', '-t', '=proj@testhost', '-F', '#{pane_id}']).trim()).toBe(running!.pane.paneId);
    expect(added.proc.args).toMatch(/fake-agent --base --extra --chan plugin:x@y$/);
    expect(agents().find((a) => a.proc.pid === running!.proc.pid)?.proc.args).toBe(running!.proc.args);
    tmux.tryRun(['kill-pane', '-t', added.pane.paneId]);
  });

  // nas-info, 2026-11-11 (letter tmux-session-busy-remote-relay): on m3 `vdx ai --new` took nas-info@m3 — no agent
  // of the project in it, but its windows held ssh to the agents on lft, and another tab was on it. The window
  // vdx started there became that tab's too.
  it('a session another terminal shows is not taken for a new agent; one on the terminal vdx runs in is', () => {
    writeProfile(['--base']);
    killServer(tmux);
    const shell = tmux.newSession('proj@testhost', root, 'sleep 600');
    const seen = (clients: { session: string; pid: number }[]) => {
      const t = Object.create(tmux) as typeof tmux;
      t.clients = () => clients;
      return t;
    };
    const windows = (s: string) =>
      tmux
        .run(['list-windows', '-t', `=${s}`, '-F', '#{pane_id}'])
        .trim()
        .split('\n');
    const agents = () => findAgentPanes(tmux.panes(), listProcesses(), root, 'fake-agent');

    expect(
      runAi({ ...opts, path: root, fresh: true }, { ...deps(), tmux: seen([{ session: 'proj@testhost', pid: 1 }]) }),
    ).toBe(EXIT_OK);
    expect(agents().map((a) => a.pane.session)).toEqual(['proj@testhost-2']);
    expect(windows('proj@testhost')).toEqual([shell]);

    // Started inside tmux, in that very session: the one terminal on it is the person's own.
    tmux.tryRun(['kill-session', '-t', '=proj@testhost-2']);
    const d = deps();
    const inside = { ...d.env, TMUX: `/tmp/x,${currentServer(tmux)!.pid},0`, TMUX_PANE: shell };
    expect(
      runAi(
        { ...opts, path: root, fresh: true },
        { ...d, env: inside, tmux: seen([{ session: 'proj@testhost', pid: 1 }]) },
      ),
    ).toBe(EXIT_OK);
    expect(agents().map((a) => a.pane.session)).toEqual(['proj@testhost']);
    expect(logs.join('\n')).toContain('▶ proj@testhost (new window)');
  }, 30_000);

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
    killServer(tmux);
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
    killServer(tmux);
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
      killServer(tmux);
    }
  }, 30_000); // two starts, each answering the prompt and seeing the agent twice a second apart

  it('--detach in a folder Claude Code does not trust: refused — the agent would wait on the window unseen', () => {
    killServer(tmux);
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
        'session: {multiplexer: tmux, name: "{project}@{host}"}',
        '',
      ].join('\n'),
    );
    const cc = path.join(base, 'cc-trust');
    fs.mkdirSync(cc, { recursive: true });
    fs.writeFileSync(path.join(cc, '.claude.json'), JSON.stringify({ projects: {} }));
    const d = (): AiDeps => ({ ...deps(), env: { ...deps().env, CLAUDE_CONFIG_DIR: cc } });
    try {
      expect(runAi({ ...opts, path: root, detach: true }, d())).toBe(EXIT_LAUNCH_FAILED);
      expect(logs.join('\n')).toContain(`✗ Claude Code has not trusted ${root} yet`);
      expect(logs.join('\n')).toContain(
        `start it once at a terminal and answer the window: vdx ai ${shellQuote(root)}`,
      );
      expect(findAgentPanes(tmux.panes(), listProcesses(), root, 'claude')).toEqual([]);
    } finally {
      killServer(tmux);
    }
  });

  it('--conversation attaches to the agent in it, or starts one next to the agents here', () => {
    killServer(tmux);
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
        'session: {multiplexer: tmux, name: "{project}@{host}"}',
        '',
      ].join('\n'),
    );
    const cc = path.join(base, 'cc-conversation');
    fs.mkdirSync(path.join(cc, 'sessions'), { recursive: true });
    const d = (): AiDeps => ({ ...deps(), env: { ...deps().env, CLAUDE_CONFIG_DIR: cc } });
    const agents = () => findAgentPanes(tmux.panes(), listProcesses(), root, 'claude');
    const inConversation = (pid: number, id: string) =>
      fs.writeFileSync(path.join(cc, 'sessions', `${pid}.json`), JSON.stringify({ sessionId: id }));
    try {
      expect(runAi({ ...opts, path: root, conversation: ID.c }, d())).toBe(EXIT_OK);
      const first = agents()[0]!;
      expect(first.proc.args).toMatch(new RegExp(`claude --base --resume ${ID.c}$`));
      inConversation(first.proc.pid, ID.c);

      // The agent in it: attached, nothing started.
      expect(runAi({ ...opts, path: root, conversation: ID.c }, d())).toBe(EXIT_OK);
      expect(logs.join('\n')).toContain('already running with the profile');
      expect(agents()).toHaveLength(1);

      // Another conversation: a second agent next to it.
      logs = [];
      expect(runAi({ ...opts, path: root, conversation: ID.d }, d())).toBe(EXIT_OK);
      expect(logs.join('\n')).toContain('starting another one next to it, in conversation dddddddd');
      expect(agents().map((a) => a.proc.args)).toEqual([
        first.proc.args,
        expect.stringMatching(new RegExp(`claude --base --resume ${ID.d}$`)),
      ]);

      // The second has no session file: it may be in any conversation — no third agent blindly.
      logs = [];
      expect(runAi({ ...opts, path: root, conversation: ID.a }, d())).toBe(EXIT_OK);
      expect(logs.join('\n')).toContain('in a conversation vdx cannot read — attaching to it');
      expect(agents()).toHaveLength(2);
    } finally {
      killServer(tmux);
    }
  }, 30_000);

  it('r at the drift question resumes the conversation the agent is in, not the newest in the folder', () => {
    killServer(tmux);
    const claude = path.join(base, 'bin', 'claude');
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.copyFileSync(path.join(base, 'fake-agent'), claude);
    fs.chmodSync(claude, 0o755);
    const claudeProfile = (args: string) =>
      fs.writeFileSync(
        profile,
        [
          'agent:',
          `  command: ${claude}`,
          `  args: [${args}]`,
          '  resume_args: [--continue]',
          'session: {multiplexer: tmux, name: "{project}@{host}"}',
          '',
        ].join('\n'),
      );
    claudeProfile('--base');
    const cc = path.join(base, 'cc-drift');
    fs.mkdirSync(path.join(cc, 'sessions'), { recursive: true });
    const d = (): AiDeps => ({ ...deps(), env: { ...deps().env, CLAUDE_CONFIG_DIR: cc } });
    const agents = () => findAgentPanes(tmux.panes(), listProcesses(), root, 'claude');
    try {
      expect(runAi({ ...opts, path: root, conversation: ID.c }, d())).toBe(EXIT_OK);
      fs.writeFileSync(path.join(cc, 'sessions', `${agents()[0]!.proc.pid}.json`), JSON.stringify({ sessionId: ID.c }));
      claudeProfile('--base, --extra');
      expect(runAi({ ...opts, path: root, detach: true }, { ...d(), interactive: true, ask: () => 'r' })).toBe(EXIT_OK);
      expect(agents().map((a) => a.proc.args)).toEqual([
        expect.stringMatching(new RegExp(`claude --base --extra --resume ${ID.c}$`)),
      ]);
    } finally {
      killServer(tmux);
    }
  }, 30_000);

  it('--new on a fresh start runs the agent without the resume args', () => {
    writeProfile(['--base', '--extra']);
    killServer(tmux);
    expect(runAi({ ...opts, path: root, fresh: true, dryRun: true }, deps())).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain('resume:   —');
    expect(runAi({ ...opts, path: root, fresh: true }, deps())).toBe(EXIT_OK);
    expect(logs.join('\n')).not.toContain('nothing to resume');
    expect(agentArgs()).toEqual([expect.stringMatching(/fake-agent --base --extra --chan plugin:x@y$/)]);
  });

  it('--focused starts a focused agent in a new conversation next to the running one; a plain start then picks', () => {
    writeProfile(['--base'], true);
    killServer(tmux);
    const agents = () => findAgentPanes(tmux.panes(), listProcesses(), root, 'fake-agent');
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    const plain = agents()[0]!;
    expect(plain.proc.args).toMatch(/fake-agent --base --chan plugin:x@y --resume-me$/);
    expect(deps().agentFocused!(plain.proc.pid)).toBe(false);

    // A new conversation, focused: no resume args, the channel flag left out; the plain agent runs on.
    expect(runAi({ ...opts, path: root, focused: true }, deps())).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain('starting another one next to it, in a new conversation');
    const focused = agents().find((a) => a.proc.pid !== plain.proc.pid)!;
    expect(focused.proc.args).toMatch(/fake-agent --base$/);
    expect(deps().agentFocused!(focused.proc.pid)).toBe(true);
    expect(agents().find((a) => a.proc.pid === plain.proc.pid)?.proc.args).toBe(plain.proc.args);

    // Two agents. In a terminal the person picks; the focused one is taken as it is.
    logs = [];
    const asked: string[] = [];
    const pick = { ...deps(), interactive: true, ask: (p: string) => (asked.push(p), '2') };
    expect(runAi({ ...opts, path: root, detach: true }, pick)).toBe(EXIT_OK);
    expect(asked).toEqual(['Which one? [1]: ']);
    expect(focused.pane.session).toBe('proj@testhost-2');
    expect(logs.join('\n')).toContain(`  2) proj@testhost-2 ${focused.pane.paneId} — focused`);
    expect(logs.join('\n')).toContain('already running with the profile, focused');

    // Without a terminal: the newest by the session file's start time.
    logs = [];
    const cc = path.join(base, 'cc-started');
    fs.mkdirSync(path.join(cc, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(cc, 'sessions', `${plain.proc.pid}.json`), JSON.stringify({ startedAt: 2000 }));
    fs.writeFileSync(path.join(cc, 'sessions', `${focused.proc.pid}.json`), JSON.stringify({ startedAt: 1000 }));
    const withStarts = { ...deps(), env: { ...deps().env, CLAUDE_CONFIG_DIR: cc } };
    expect(runAi({ ...opts, path: root }, withStarts)).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain(`taking the newest, proj@testhost ${plain.pane.paneId}`);

    // --restart guesses no agent to stop: without a terminal it names how to reach each (DL #18).
    logs = [];
    expect(runAi({ ...opts, path: root, focused: true, restart: true }, withStarts)).toBe(EXIT_USAGE);
    expect(logs.join('\n')).toContain('2 agents of this project run here, and nobody to ask which — nothing restarted');
    expect(logs.join('\n')).toContain(`at a terminal vdx ai --restart ${shellQuote(root)} asks which`);
    expect(agents().find((a) => a.pane.paneId === plain.pane.paneId)?.proc.pid).toBe(plain.proc.pid);

    // At a terminal --restart --focused replaces the agent picked with a new focused conversation.
    const atTerminal = { ...withStarts, interactive: true, ask: () => '' };
    expect(runAi({ ...opts, path: root, focused: true, restart: true, detach: true }, atTerminal)).toBe(EXIT_OK);
    const replaced = agents().find((a) => a.pane.paneId === plain.pane.paneId)!;
    expect(replaced.proc.args).toMatch(/fake-agent --base$/);
    expect(deps().agentFocused!(replaced.proc.pid)).toBe(true);
  }, 30_000);

  it('--focused <topic>: its tmux session carries it, a restart keeps it, its own agent changes it (focused-topic)', () => {
    writeProfile(['--base'], true);
    killServer(tmux);
    const agents = () => findAgentPanes(tmux.panes(), listProcesses(), root, 'fake-agent');
    const topicOf = (session: string) =>
      tmux.tryRun(['show-options', '-qv', '-t', `=${session}:`, '@vdx_topic'])?.trim() ?? '';
    // A shell tool of the agent `pid` — the agent's environment, VDX_FOCUSED=1 when it is focused.
    const inside = (pid: number, focused: boolean): AiDeps => ({
      ...deps(),
      env: { ...deps().env, ...(focused ? { VDX_FOCUSED: '1' } : {}) },
      processes: () => [...listProcesses(), { pid: 9_999_991, ppid: pid, args: 'node vdx ai' }],
      lag: () => null,
    });

    expect(runAi({ ...opts, path: root, focused: true, topic: 'release 0.41', dryRun: true }, deps())).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain('topic:    «release 0.41» (from --focused)');
    expect(agents()).toHaveLength(0);

    logs = [];
    expect(runAi({ ...opts, path: root, focused: true, topic: 'release 0.41' }, deps())).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain('🎯 topic «release 0.41» (from --focused)');
    const session = agents()[0]!.pane.session;
    expect(topicOf(session)).toBe('release 0.41');

    // A restart keeps its session's topic, and its session-start check gives it on a line of its own.
    logs = [];
    expect(runAi({ ...opts, path: root, focused: true, restart: true }, deps())).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain('🎯 topic «release 0.41» (kept from its tmux session)');
    const focused = agents()[0]!;
    logs = [];
    expect(runAiCheck(root, inside(focused.proc.pid, true), 9_999_991)).toBe(EXIT_OK);
    expect(logs.join('')).toContain(`\n${topicLine('release 0.41')}\n· keep the conversation in it`);

    // Its own agent names another topic: the session's changes, nothing starts.
    logs = [];
    const change = { ...opts, path: root, focused: true, topic: 'docs for 0.41' };
    expect(runAi({ ...change, dryRun: true }, inside(focused.proc.pid, true), 9_999_991)).toBe(EXIT_OK);
    expect(logs.join('')).toContain(`${session}: the topic would be «docs for 0.41», was «release 0.41»`);
    expect(topicOf(session)).toBe('release 0.41');
    expect(runAi(change, inside(focused.proc.pid, true), 9_999_991)).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain(`✓ ${session}: the topic is «docs for 0.41», was «release 0.41»`);
    expect(topicOf(session)).toBe('docs for 0.41');
    expect(agents().map((a) => a.proc.pid)).toEqual([focused.proc.pid]);

    // A plain restart makes it a plain session: the topic goes with the mode.
    expect(runAi({ ...opts, path: root, restart: true }, deps())).toBe(EXIT_OK);
    expect(topicOf(session)).toBe('');
    const plain = agents()[0]!;
    logs = [];
    expect(runAi(change, inside(plain.proc.pid, false), 9_999_991)).toBe(EXIT_USAGE);
    expect(logs.join('\n')).toContain('this session is not focused');
    expect(logs.join('\n')).toContain(`vdx ai ${shellQuote(root)} --focused 'docs for 0.41' --detach`);
    expect(agents()).toHaveLength(1);
    // Focused with no topic: its check asks the agent to set one.
    logs = [];
    expect(runAiCheck(root, inside(plain.proc.pid, true), 9_999_991)).toBe(EXIT_OK);
    expect(logs.join('')).toContain('· this focused session has no topic yet: take it from the user');

    // At a terminal a start asks; Ctrl-D starts nothing, Enter leaves it to the agent.
    const asked: string[] = [];
    const answering = (answer: string | null) => ({
      ...deps(),
      interactive: true,
      ask: (p: string) => (asked.push(p), answer),
    });
    logs = [];
    expect(runAi({ ...opts, path: root, focused: true, detach: true }, answering(null))).toBe(EXIT_LAUNCH_FAILED);
    expect(logs.join('\n')).toContain('no answer — nothing started');
    expect(agents()).toHaveLength(1);
    logs = [];
    expect(runAi({ ...opts, path: root, focused: true, detach: true }, answering(''))).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain("🎯 no topic yet — the agent takes it from the user's first message");
    expect(runAi({ ...opts, path: root, focused: true, detach: true }, answering('  the  typed\ttopic '))).toBe(
      EXIT_OK,
    );
    expect(logs.join('\n')).toContain('🎯 topic «the typed topic» (typed)');
    expect(asked).toEqual(
      Array(3).fill('Topic of this focused session [Enter: the agent takes it from your first message]: '),
    );
    const sessions = agents().map((a) => a.pane.session);
    expect(sessions.map(topicOf)).toEqual(['', '', 'the typed topic']);
  }, 60_000);

  it('--focused --conversation <id> brings back the topic the conversation last had', () => {
    killServer(tmux);
    const claude = path.join(base, 'bin', 'claude');
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.copyFileSync(path.join(base, 'fake-agent'), claude);
    fs.chmodSync(claude, 0o755);
    fs.writeFileSync(
      profile,
      `agent: {command: ${claude}, resume_args: [--continue]}\nsession: {multiplexer: tmux, name: "{project}@{host}"}\n`,
    );
    const cc = path.join(base, 'cc-topic');
    writeConversation(cc, root, ID.c, [startedOn('testhost'), userLine('hi'), hookLine(topicLine('the old one'))], 5);
    const d = { ...deps(), env: { ...deps().env, CLAUDE_CONFIG_DIR: cc } };
    expect(runAi({ ...opts, path: root, focused: true, conversation: ID.c, dryRun: true }, d)).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain('topic:    «the old one» (from the conversation)');
    logs = [];
    expect(runAi({ ...opts, path: root, focused: true, conversation: ID.d, dryRun: true }, d)).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain("topic:    — the agent takes it from the user's first message");
  });

  it('--intercom: the intercom session in a session of its own, one per project; the other starts leave it alone', () => {
    writeProfile(['--base'], true, ['/first prompt']);
    killServer(tmux);
    const agents = () => findAgentPanes(tmux.panes(), listProcesses(), root, 'fake-agent');
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    const plain = agents()[0]!;

    expect(runAi({ ...opts, path: root, intercom: true, focused: true }, deps())).toBe(EXIT_USAGE);
    expect(runAi({ ...opts, path: root, intercom: true, conversation: ID.c }, deps())).toBe(EXIT_USAGE);
    expect(agents()).toHaveLength(1);

    // VDX_INTERCOM=1, the first prompt right after the command, the waking rule kept, nothing resumed.
    logs = [];
    expect(runAi({ ...opts, path: root, intercom: true }, deps())).toBe(EXIT_OK);
    const mail = agents().find((a) => a.proc.pid !== plain.proc.pid)!;
    expect(mail.pane.session).toBe('proj@testhost-intercom');
    expect(deps().agentMail!(mail.proc.pid)).toBe(true);
    expect(mail.proc.args).toMatch(/fake-agent \/first prompt --base --chan plugin:x@y$/);
    expect(logs.join('\n')).toContain('✓ answered "FAKE PROMPT" with Enter');
    expect(logs.join('\n')).not.toContain('keeps running');

    // Asked again: the one running, never a second.
    logs = [];
    expect(runAi({ ...opts, path: root, intercom: true }, deps())).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain(
      '✓ proj@testhost-intercom: already running with the profile, the intercom session',
    );
    expect(agents()).toHaveLength(2);

    // A plain start, even in a terminal, takes the person's agent: no list of two.
    logs = [];
    const asked: string[] = [];
    const terminal = { ...deps(), interactive: true, ask: (p: string) => (asked.push(p), '2') };
    expect(runAi({ ...opts, path: root, detach: true }, terminal)).toBe(EXIT_OK);
    expect(asked).toEqual([]);
    expect(logs.join('\n')).toContain('✓ proj@testhost: already running with the profile —');
    logs = [];
    expect(runAi({ ...opts, path: root, dryRun: true }, deps())).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain(
      `aside:    proj@testhost-intercom ${mail.pane.paneId} — the intercom session, left alone`,
    );

    // --close, run by a tool of the agent: refused in the person's session, the mail pane goes in its own.
    const toolOf = (agentPid: number) => () => [
      ...listProcesses(),
      { pid: 9_999_991, ppid: agentPid, args: 'node vdx ai --close' },
    ];
    const waitingOn = (session: string) =>
      tmux.tryRun(['show-options', '-qv', '-t', `=${session}:`, '@vdx_waiting'])?.trim() ?? '';
    logs = [];
    expect(runAiClose(root, 0, { ...deps(), processes: toolOf(plain.proc.pid) }, 9_999_991)).toBe(EXIT_USAGE);
    expect(logs.join('\n')).toContain('this is not an intercom session');
    expect(agents()).toHaveLength(2);

    logs = [];
    expect(runAiClose(root, 2, { ...deps(), processes: toolOf(mail.proc.pid) }, 9_999_991)).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain('✓ 2 waiting for the user — shown on proj@testhost');
    expect(logs.join('\n')).toContain(
      `✓ proj@testhost-intercom ${mail.pane.paneId}: the intercom session closes in 2 s`,
    );
    expect(waitingOn('proj@testhost')).toBe('2');
    expect(agents()).toHaveLength(2); // not yet: the call returns first
    sleepSync(3_000);
    expect(agents().map((a) => a.proc.pid)).toEqual([plain.proc.pid]);
    // No shell left behind: the tab goes with the agent.
    expect(tmux.hasSession('proj@testhost-intercom')).toBe(false);

    // The next intercom session closes with nothing waiting: the mark goes.
    expect(runAi({ ...opts, path: root, intercom: true }, deps())).toBe(EXIT_OK);
    const next = agents().find((a) => a.proc.pid !== plain.proc.pid)!;
    expect(runAiClose(root, 0, { ...deps(), processes: toolOf(next.proc.pid) }, 9_999_991)).toBe(EXIT_OK);
    expect(waitingOn('proj@testhost')).toBe('');
    sleepSync(3_000);
    expect(agents()).toHaveLength(1);
  }, 60_000);

  it('--hq: a session of its own with its sign, one per project; the other starts leave it alone, --close too', () => {
    writeProfile(['--base'], true, [], ['/first prompt']);
    killServer(tmux);
    const agents = () => findAgentPanes(tmux.panes(), listProcesses(), root, 'fake-agent');
    const session = 'proj@testhost-hq';
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    const plain = agents()[0]!;

    expect(runAi({ ...opts, path: root, hq: true, focused: true }, deps())).toBe(EXIT_USAGE);
    expect(runAi({ ...opts, path: root, hq: true, intercom: true }, deps())).toBe(EXIT_USAGE);
    expect(agents()).toHaveLength(1);

    // VDX_HQ=1, the first prompt right after the command, the waking rule kept, nothing resumed.
    logs = [];
    expect(runAi({ ...opts, path: root, hq: true }, deps())).toBe(EXIT_OK);
    const hq = agents().find((a) => a.proc.pid !== plain.proc.pid)!;
    expect(hq.pane.session).toBe(session);
    expect(deps().agentHq!(hq.proc.pid)).toBe(true);
    expect(deps().agentMail!(hq.proc.pid)).toBe(false);
    expect(hq.proc.args).toMatch(/fake-agent \/first prompt --base --chan plugin:x@y$/);
    expect(tmux.tryRun(['show-options', '-qv', '-t', `=${session}:`, '@vdx_topic'])?.trim()).toBe('👑 HQ');
    expect(logs.join('\n')).not.toContain('keeps running');

    // Asked again: the one running, never a second.
    logs = [];
    expect(runAi({ ...opts, path: root, hq: true }, deps())).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain(`✓ ${session}: already running with the profile, the HQ session`);
    expect(agents()).toHaveLength(2);

    // A plain start, and --new, leave it alone; the plan names it.
    logs = [];
    const asked: string[] = [];
    const terminal = { ...deps(), interactive: true, ask: (p: string) => (asked.push(p), '2') };
    expect(runAi({ ...opts, path: root, detach: true }, terminal)).toBe(EXIT_OK);
    expect(asked).toEqual([]);
    expect(logs.join('\n')).toContain('✓ proj@testhost: already running with the profile —');
    logs = [];
    expect(runAi({ ...opts, path: root, dryRun: true }, deps())).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain(`aside:    ${session} ${hq.pane.paneId} — the HQ session, left alone`);
    logs = [];
    expect(runAi({ ...opts, path: root, hq: true, dryRun: true }, deps())).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain("hq:       the project's HQ session; first: /first prompt");
    expect(logs.join('\n')).toContain("topic:    «👑 HQ» (the HQ session's sign)");
    expect(logs.join('\n')).toContain(`aside:    proj@testhost ${plain.pane.paneId} — not the HQ session, left alone`);

    // --close is not for it.
    logs = [];
    const toolOf = (agentPid: number) => () => [
      ...listProcesses(),
      { pid: 9_999_991, ppid: agentPid, args: 'node vdx ai --close' },
    ];
    expect(runAiClose(root, 0, { ...deps(), processes: toolOf(hq.proc.pid) }, 9_999_991)).toBe(EXIT_USAGE);
    expect(logs.join('\n')).toContain('this is not an intercom session');
    sleepSync(2_500);
    expect(agents()).toHaveLength(2);

    // The drift of a changed profile is named with its own flag.
    writeProfile(['--base', '--more'], true, [], ['/first prompt']);
    logs = [];
    expect(runAi({ ...opts, path: root, hq: true }, deps())).toBe(EXIT_DRIFT);
    expect(logs.join('\n')).toContain(`vdx ai --restart --hq ${root}`);
  }, 60_000);

  it('--focused <topic>: the topic is the first prompt; typed at the question, or with --conversation, it is not', () => {
    writeProfile(['--base'], true);
    killServer(tmux);
    const agentOf = (session: string) =>
      findAgentPanes(tmux.panes(), listProcesses(), root, 'fake-agent').find((a) => a.pane.session === session)!;

    expect(runAi({ ...opts, path: root, focused: true, topic: 'релиз «0.49»' }, deps())).toBe(EXIT_OK);
    expect(agentOf('proj@testhost').proc.args).toMatch(/fake-agent релиз «0\.49» --base$/);

    // Next to it, with another topic: that one's first prompt.
    expect(runAi({ ...opts, path: root, focused: true, topic: 'second' }, deps())).toBe(EXIT_OK);
    expect(agentOf('proj@testhost-2').proc.args).toMatch(/fake-agent second --base$/);

    // A topic that would reach the agent as a flag stays a topic.
    logs = [];
    expect(runAi({ ...opts, path: root, focused: true, topic: '-x' }, deps())).toBe(EXIT_OK);
    expect(agentOf('proj@testhost-3').proc.args).toMatch(/fake-agent --base$/);
    expect(logs.join('\n')).toContain('does not go to the agent as a first prompt');
    expect(tmux.tryRun(['show-options', '-qv', '-t', '=proj@testhost-3:', '@vdx_topic'])?.trim()).toBe('-x');

    // Typed at the question: a topic, and no turn.
    killServer(tmux);
    const typed = Object.create(tmux) as typeof tmux;
    typed.attach = () => 0;
    expect(
      runAi({ ...opts, path: root, focused: true }, { ...deps(), interactive: true, tmux: typed, ask: () => 'typed' }),
    ).toBe(EXIT_OK);
    expect(agentOf('proj@testhost').proc.args).toMatch(/fake-agent --base$/);
    expect(tmux.tryRun(['show-options', '-qv', '-t', '=proj@testhost:', '@vdx_topic'])?.trim()).toBe('typed');
  }, 60_000);

  it('the intercom session the person started: --close leaves its pane, the line says it stays', () => {
    writeProfile(['--base'], true, ['/first prompt']);
    killServer(tmux);
    const agents = () => findAgentPanes(tmux.panes(), listProcesses(), root, 'fake-agent');
    const stays = (session: string) => tmux.tryRun(['show-options', '-qv', '-t', `=${session}:`, '@vdx_stays'])?.trim();
    const toolOf = (agentPid: number) => () => [
      ...listProcesses(),
      { pid: 9_999_991, ppid: agentPid, args: 'node vdx ai --close' },
    ];

    // Started for a letter: no mark, it ends itself.
    expect(runAi({ ...opts, path: root, intercom: true, detach: true }, deps())).toBe(EXIT_OK);
    const session = 'proj@testhost-intercom';
    expect(stays(session)).toBe('');
    const sent = agents()[0]!;
    logs = [];
    expect(runAiClose(root, 0, { ...deps(), processes: toolOf(sent.proc.pid) }, 9_999_991)).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain('the intercom session closes in 2 s');
    sleepSync(3_000);
    expect(agents()).toHaveLength(0);

    // From a terminal: marked, and --close only moves the number.
    const person = Object.create(tmux) as typeof tmux;
    person.attach = () => 0;
    expect(runAi({ ...opts, path: root, intercom: true }, { ...deps(), interactive: true, tmux: person })).toBe(
      EXIT_OK,
    );
    expect(stays(session)).toBe('1');
    const own = agents()[0]!;
    logs = [];
    expect(runAiClose(root, 0, { ...deps(), processes: toolOf(own.proc.pid) }, 9_999_991)).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain('it stays and waits for a wake');
    sleepSync(3_000);
    expect(agents().map((a) => a.proc.pid)).toEqual([own.proc.pid]);

    // What the agent is told at its start.
    logs = [];
    const inside: AiDeps = {
      ...deps(),
      env: { ...deps().env, VDX_INTERCOM: '1' },
      processes: toolOf(own.proc.pid),
      lag: () => null,
    };
    expect(runAiCheck(root, inside, 9_999_991)).toBe(EXIT_OK);
    expect(logs.join('')).toContain(`${INTERCOM_LINE_PREFIX} (\`vdx ai --intercom\`)`);
    expect(logs.join('')).toContain('The user started this one, and it stays');
  }, 60_000);

  describe('a start under way, the agent not among the processes yet', () => {
    const session = 'proj@testhost-intercom';
    const agents = () => findAgentPanes(tmux.panes(), listProcesses(), root, 'fake-agent');
    const windows = (name = session) =>
      (tmux.tryRun(['list-windows', '-t', `=${name}:`, '-F', '#{pane_id}']) ?? '').trim().split('\n');
    /** What another `vdx ai` opens: the login shell, `seconds` of it, then the agent — as `zsh -lic` does. */
    const startedElsewhere = (seconds: number, mark = 'VDX_INTERCOM=1', name = session, keepShell = false) => {
      const login = path.join(base, 'slow-login');
      fs.writeFileSync(login, `#!/bin/sh\nsleep ${seconds}\nexec /bin/sh "$@"\n`, { mode: 0o755 });
      const line = `${mark} ${path.join(base, 'fake-agent')} '/first prompt' --base`;
      return tmux.newSession(name, root, tmuxShellCommand(line, login, keepShell));
    };

    beforeEach(() => {
      writeProfile(['--base'], true, ['/first prompt'], ['/first prompt']);
      killServer(tmux);
      logs = [];
    });

    it('a letter joins it: no second window, and it says so', () => {
      startedElsewhere(2);
      expect(runAi({ ...opts, path: root, intercom: true, detach: true }, deps())).toBe(EXIT_OK);
      expect(logs.join('\n')).toContain(`✓ ${session}: another start got there first`);
      expect(windows()).toHaveLength(1);
      expect(agents()).toHaveLength(1);
    }, 30_000);

    it('tmux refuses the name to the one that looked too early: it joins too', () => {
      const late = Object.create(tmux) as typeof tmux;
      let looked = false;
      late.hasSession = (name) => {
        if (looked) return tmux.hasSession(name);
        looked = true;
        startedElsewhere(2);
        return false;
      };
      expect(runAi({ ...opts, path: root, intercom: true, detach: true }, { ...deps(), tmux: late })).toBe(EXIT_OK);
      expect(logs.join('\n')).toContain(`✓ ${session}: another start got there first`);
      expect(windows()).toHaveLength(1);
      expect(agents()).toHaveLength(1);
    }, 30_000);

    it('the person who joins it from a terminal keeps it', () => {
      startedElsewhere(2);
      const person = Object.create(tmux) as typeof tmux;
      person.attach = () => 0;
      expect(runAi({ ...opts, path: root, intercom: true }, { ...deps(), interactive: true, tmux: person })).toBe(
        EXIT_OK,
      );
      expect(tmux.tryRun(['show-options', '-qv', '-t', `=${session}:`, '@vdx_stays'])?.trim()).toBe('1');
      expect(windows()).toHaveLength(1);
    }, 30_000);

    it('one with no agent in time is started over in its pane, not next to it', () => {
      const stuck = startedElsewhere(60);
      expect(runAi({ ...opts, path: root, intercom: true, detach: true }, { ...deps(), confirmTimeoutMs: 1_000 })).toBe(
        EXIT_OK,
      );
      expect(logs.join('\n')).toContain(
        `⚠ ${session} ${stuck}: no ${path.join(base, 'fake-agent')} after 1 s — starting it again`,
      );
      expect(windows()).toEqual([stuck]);
      expect(agents()).toHaveLength(1);
    }, 30_000);

    it('the start it waits for dies with its session: this one starts on its own', () => {
      startedElsewhere(60);
      let gone = false;
      const sleep = (ms: number) => {
        if (!gone) tmux.tryRun(['kill-session', '-t', `=${session}`]);
        gone = true;
        sleepSync(ms);
      };
      expect(runAi({ ...opts, path: root, intercom: true, detach: true }, { ...deps(), sleep })).toBe(EXIT_OK);
      expect(gone).toBe(true);
      expect(logs.join('\n')).toContain(`▶ ${session}: `);
      expect(windows()).toHaveLength(1);
      expect(agents()).toHaveLength(1);
    }, 30_000);

    it('a session left with no start in it takes the agent at once, in a window of its own', () => {
      tmux.newSession(session, root, 'sleep 60');
      const startedAt = Date.now();
      expect(runAi({ ...opts, path: root, intercom: true, detach: true }, deps())).toBe(EXIT_OK);
      expect(logs.join('\n')).toContain(`▶ ${session} (new window)`);
      expect(windows()).toHaveLength(2);
      expect(agents()).toHaveLength(1);
      // settle takes about 2 s; a wait for a start nobody made would add its 10 s here.
      expect(Date.now() - startedAt).toBeLessThan(9_000);
    }, 30_000);

    it('--hq: the same, the shell that stays after the agent being no start', () => {
      startedElsewhere(2, 'VDX_HQ=1', 'proj@testhost-hq', true);
      expect(runAi({ ...opts, path: root, hq: true, detach: true }, deps())).toBe(EXIT_OK);
      expect(logs.join('\n')).toContain('✓ proj@testhost-hq: another start got there first');
      expect(windows('proj@testhost-hq')).toHaveLength(1);
      expect(agents()).toHaveLength(1);
    }, 30_000);
  });

  // echelon, 2026-11-08: exit 4 «expected prompt not seen» over an empty pane, the channels prompt on it
  // seconds later, and the intercom session waiting on it with nobody at it.
  describe('a prompt that comes late', () => {
    const session = 'proj@testhost-intercom';
    /** A login shell as slow as `zsh -lic` on a busy machine. */
    const slowLogin = (seconds: number) => {
      const login = path.join(base, `slow-login-${seconds}`);
      fs.writeFileSync(login, `#!/bin/sh\nsleep ${seconds}\nexec /bin/sh "$@"\n`, { mode: 0o755 });
      return login;
    };

    beforeEach(() => {
      writeProfile(['--base'], true, ['/first prompt']);
      killServer(tmux);
      logs = [];
    });

    it('a login shell slower than 5 s: the prompt is waited for while the start is under way', () => {
      const start = { ...opts, path: root, intercom: true, detach: true };
      expect(runAi(start, { ...deps(), shell: slowLogin(6) })).toBe(EXIT_OK);
      expect(logs.join('\n')).toContain('✓ answered "FAKE PROMPT" with Enter');
    }, 40_000);

    it('the wait ends as the agent comes up: one more look answers the prompt', () => {
      const start = { ...opts, path: root, intercom: true, detach: true };
      expect(runAi(start, { ...deps(), shell: slowLogin(2), confirmTimeoutMs: 1_000 })).toBe(EXIT_OK);
      expect(logs.join('\n')).toContain('✓ answered "FAKE PROMPT" with Enter');
    }, 30_000);

    it('a detached start finds the agent on a prompt nobody answered: it answers it', () => {
      const line = `VDX_INTERCOM=1 ${path.join(base, 'fake-agent')} '/first prompt' --base --chan plugin:x@y`;
      const pane = tmux.newSession(session, root, tmuxShellCommand(line, '/bin/sh', false));
      for (let i = 0; i < 50 && !tmux.capture(pane)?.includes('FAKE PROMPT'); i++) sleepSync(100);
      expect(runAi({ ...opts, path: root, intercom: true, detach: true }, deps())).toBe(EXIT_OK);
      const out = logs.join('\n');
      expect(out).toContain(`✓ ${session}: already running with the profile, the intercom session`);
      expect(out).toContain('✓ answered "FAKE PROMPT" with Enter');
      expect(tmux.capture(pane)).toContain('READY');
    }, 30_000);
  });

  // nas-info, 2026-11-05: after cmux restarted, 16 of 22 tabs stayed out of their sessions (DL #19).
  describe('a cmux tab goes back into its session', () => {
    const session = 'proj@testhost';
    const record = (surface: string) => path.join(tabRecordDir(base), `${surface}.json`);
    /** The person's terminal: what it attaches to, and what the tab's record says meanwhile. */
    const terminal = (surface?: string) => {
      const attached: { session: string; noted: unknown }[] = [];
      const t = Object.create(tmux) as typeof tmux;
      t.attach = (name: string) => {
        const f = surface ? record(surface) : null;
        attached.push({ session: name, noted: f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null });
        return 0;
      };
      return { t, attached };
    };
    const inTab = (surface: string | null, t: Tmux, extra: Record<string, string> = {}): AiDeps => ({
      ...deps(),
      interactive: true,
      tmux: t,
      env: { ...deps().env, ...(surface ? { CMUX_SURFACE_ID: surface } : {}), ...extra },
    });

    beforeAll(() => {
      writeProfile(['--base']);
      killServer(tmux);
      logs = [];
      expect(runAi({ ...opts, path: root, detach: true }, deps())).toBe(EXIT_OK);
    }, 30_000);
    beforeEach(() => fs.rmSync(tabRecordDir(base), { recursive: true, force: true }));

    it('vdx ai notes the session while it holds the attach in a cmux tab, and drops the note after', () => {
      const { t, attached } = terminal('SURF-1');
      expect(runAi({ ...opts, path: root }, inTab('SURF-1', t))).toBe(EXIT_OK);
      expect(attached).toHaveLength(1);
      expect(attached[0]).toMatchObject({ session, noted: { kind: 'here', surface: 'SURF-1', session, socket } });
      expect(fs.existsSync(record('SURF-1'))).toBe(false);
      // Inside tmux the tab is tmux's, not cmux's: nothing noted.
      const inner = terminal('SURF-1');
      expect(runAi({ ...opts, path: root }, inTab('SURF-1', inner.t, { TMUX: '/tmp/x,1,0' }))).toBe(EXIT_OK);
      expect(inner.attached).toEqual([{ session, noted: null }]);
    }, 30_000);

    it('gone down with cmux, the note stays: --tab goes back into that session, then drops it', () => {
      fs.mkdirSync(tabRecordDir(base), { recursive: true });
      fs.writeFileSync(record('SURF-2'), JSON.stringify({ kind: 'here', surface: 'SURF-2', session, socket, at: 1 }));
      const { t, attached } = terminal('SURF-2');
      logs = [];
      expect(runAiTab('.', inTab('SURF-2', t))).toBe(EXIT_OK);
      expect(attached.map((a) => a.session)).toEqual([session]);
      expect(logs.join('\n')).toContain(`↩ ${session}: back into the session this tab showed`);
      expect(fs.existsSync(record('SURF-2'))).toBe(false);

      // No note — a new tab: nothing, and nothing said.
      logs = [];
      const none = terminal('SURF-3');
      expect(runAiTab('.', inTab('SURF-3', none.t))).toBe(EXIT_OK);
      expect(none.attached).toEqual([]);
      expect(logs).toEqual([]);

      // The session is not there (tmux fell, no restore yet): exit 4, the note stays for the next shell.
      fs.writeFileSync(
        record('SURF-4'),
        JSON.stringify({ kind: 'here', surface: 'SURF-4', session: 'proj@gone', socket, at: 1 }),
      );
      const gone = terminal('SURF-4');
      expect(runAiTab('.', inTab('SURF-4', gone.t))).toBe(EXIT_LAUNCH_FAILED);
      expect(logs.join('\n')).toContain('proj@gone, which this tab showed, is not running');
      expect(fs.existsSync(record('SURF-4'))).toBe(true);
      expect(runAiTab('.', { ...inTab('SURF-4', gone.t), interactive: false })).toBe(EXIT_USAGE);
    }, 30_000);

    it('a session on another machine: marked @vdx_tab by the vdx there, found by the mark over ssh', () => {
      // There: the vdx that `vdx ai@<host>` starts gets the tab's mark and puts it on its session.
      const there = terminal();
      expect(runAi({ ...opts, path: root }, inTab(null, there.t, { VDX_AI_CMUX: 'abc123' }))).toBe(EXIT_OK);
      const option = (o: string) => tmux.tryRun(['show-options', '-qv', '-t', `=${session}:`, o])?.trim();
      expect(option('@vdx_tab')).toBe('abc123');
      expect(option('@vdx_cmux')).toBe(''); // no topic: the topic's watcher has nothing to poll for
      const back = terminal();
      expect(runAiTab('/somewhere', inTab(null, back.t, { VDX_AI_CMUX: 'abc123' }))).toBe(EXIT_OK);
      expect(back.attached.map((a) => a.session)).toEqual([session]);
      logs = [];
      expect(runAiTab('.', inTab(null, back.t, { VDX_AI_CMUX: 'fff999' }))).toBe(EXIT_LAUNCH_FAILED);
      expect(logs.join('\n')).toContain("carries this tab's mark");

      // Here, on the tab's machine: --tab runs `vdx ai@<host> <path> --tab` with the mark from the note.
      fs.mkdirSync(tabRecordDir(base), { recursive: true });
      fs.writeFileSync(
        record('SURF-5'),
        JSON.stringify({ kind: 'there', surface: 'SURF-5', host: 'm3', project: root, token: 'abc123', at: 1 }),
      );
      const calls: { script: string; noted: boolean }[] = [];
      const ssh = (args: string[]) => {
        calls.push({ script: args[2]!, noted: fs.existsSync(record('SURF-5')) });
        return { status: 0, stdout: '' };
      };
      expect(runAiTab('.', { ...inTab('SURF-5', tmux), ssh })).toBe(EXIT_OK);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.script).toContain('export VDX_AI_CMUX=abc123; ');
      expect(calls[0]!.script).toMatch(/exec vdx ai \S+ --tab$/);
      expect(calls[0]!.noted).toBe(true);
      expect(fs.existsSync(record('SURF-5'))).toBe(false);

      // vdx ai@<host> itself, with a mark: the note while ssh runs, none after.
      const seen: unknown[] = [];
      const ssh2 = () => {
        seen.push(JSON.parse(fs.readFileSync(record('SURF-6'), 'utf8')));
        return { status: 0, stdout: '' };
      };
      expect(runAiRemote({ ...opts, path: root }, 'm3', { ...inTab('SURF-6', tmux), ssh: ssh2 }, 'lft', 'abc123')).toBe(
        EXIT_OK,
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ kind: 'there', host: 'm3', token: 'abc123', surface: 'SURF-6' });
      expect(fs.existsSync(record('SURF-6'))).toBe(false);
    }, 30_000);
  });
});

describe.skipIf(!tmuxAvailable)('one list and empty sessions, Claude Code in tmux (isolated server)', () => {
  const socket = `vdx-test-board-${process.pid}`;
  const tmux = new Tmux(socket);
  let base: string;
  let root: string;
  let logs: string[];
  let answers: (string | null)[];
  const claude = () => path.join(base, 'bin', 'claude');
  const cc = () => path.join(base, 'cc');

  const deps = (): AiDeps => ({
    env: {
      VDX_ENVIRONMENT: path.join(base, 'env.yaml'),
      VDX_HOST: 'testhost',
      CLAUDE_CONFIG_DIR: cc(),
      PATH: process.env['PATH'],
      NO_COLOR: '1',
    },
    home: base,
    tmux,
    interactive: true,
    shell: '/bin/sh',
    log: (l) => logs.push(l),
    out: (t) => logs.push(t),
    onPath,
    processes: listProcesses,
    agentFocused: (pid) => fs.existsSync(path.join(base, `focused-${pid}`)),
    agentMail: (pid) => fs.existsSync(path.join(base, `mail-${pid}`)),
    agentHq: (pid) => fs.existsSync(path.join(base, `hq-${pid}`)),
    sleep: sleepSync,
    confirmTimeoutMs: 5_000,
    ask: () => answers.shift() ?? null,
    ssh: () => ({ status: 255, stdout: '' }),
    liveHere: () => [],
  });
  // `detach`: nothing attaches this test's terminal; the line names the session instead.
  const opts = { path: '', restart: false, fresh: false, detach: true, dryRun: false };
  const text = () => logs.join('\n');

  /** An agent in a session of its own, in conversation `id` — its session file as Claude Code keeps it. */
  const agentIn = (session: string, id: string, lines: string[]) => {
    tmux.newSession(session, root, `${claude()} --base`);
    let pane: ReturnType<typeof findAgentPanes>[number] | undefined;
    for (let i = 0; i < 50 && !pane; i++) {
      pane = findAgentPanes(tmux.panes(), listProcesses(), root, 'claude').find((a) => a.pane.session === session);
      if (!pane) sleepSync(100);
    }
    fs.mkdirSync(path.join(cc(), 'sessions'), { recursive: true });
    fs.writeFileSync(
      path.join(cc(), 'sessions', `${pane!.proc.pid}.json`),
      JSON.stringify({ pid: pane!.proc.pid, sessionId: id, status: 'idle', statusUpdatedAt: Date.now() }),
    );
    writeConversation(cc(), root, id, lines, 1);
    return pane!;
  };

  beforeAll(() => {
    base = tmpDir('vdx-ai-board-');
    root = path.join(base, 'proj');
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'settings.local.json'),
      JSON.stringify({ autoMemoryDirectory: `${root}/.claude/memory/` }),
    );
    fs.mkdirSync(path.join(base, 'bin'));
    fs.writeFileSync(
      claude(),
      '#!/bin/sh\n[ "$VDX_FOCUSED" = 1 ] && touch "$(dirname "$0")/../focused-$$"\n' +
        '[ "$VDX_HQ" = 1 ] && touch "$(dirname "$0")/../hq-$$"\n' +
        '[ "$VDX_INTERCOM" = 1 ] && touch "$(dirname "$0")/../mail-$$"\nwhile :; do sleep 1; done\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(base, 'env.yaml'),
      `agent: {command: ${claude()}, args: [--base], resume_args: [--continue], hq_args: ["/first"], intercom_args: ["/mail"]}\n` +
        'session: {multiplexer: tmux, name: "{project}@{host}", wrap_skills: [vdm:wrap]}\n',
    );
  });
  beforeEach(() => {
    logs = [];
    answers = [];
  });
  afterEach(() => {
    killServer(tmux);
    fs.rmSync(path.join(cc(), 'sessions'), { recursive: true, force: true });
    fs.rmSync(path.join(base, '.local'), { recursive: true, force: true });
  });
  afterAll(() => {
    dropServer(tmux, socket);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('the only agent, open in no terminal: attached to without a question (P1)', () => {
    agentIn('proj@testhost', ID.a, [startedOn('testhost'), userLine('work')]);
    answers = ['should not be read'];
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(answers).toHaveLength(1);
    expect(text()).toContain('the only agent of proj runs here (proj@testhost), and no terminal at your seat shows it');
    expect(text()).toContain('✓ proj@testhost: already running with the profile');
  });

  it('two agents: one list, and the one picked is attached to', () => {
    agentIn('proj@testhost', ID.a, [startedOn('testhost'), userLine('work')]);
    agentIn('proj@testhost-2', ID.b, [startedOn('testhost'), userLine('other work')]);
    answers = ['2'];
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(text()).toMatch(
      /RUNNING NOW · 2\n+. 1 {2}proj@testhost(-2)? +💤 idle.*\n+. 2 {2}proj@testhost(-2)? +💤 idle/,
    );
    expect(text()).toMatch(/✓ proj@testhost(-2)?: already running with the profile/);
    expect(tmux.panes()).toHaveLength(2);
  });

  it('--new goes into an empty session — nothing typed since /clear — not into one more (P9)', () => {
    agentIn('proj@testhost', ID.a, [slashLine('clear'), startedOn('testhost')]);
    expect(runAi({ ...opts, path: root, fresh: true }, deps())).toBe(EXIT_OK);
    expect(text()).toContain('♻ proj@testhost: nothing typed in it since /clear — the new conversation goes there');
    expect(tmux.hasSession('proj@testhost-2')).toBe(false);
  });

  /** An agent started focused, as `processFocused` would tell from its environment. */
  const focusedIn = (session: string, id: string, topic: string) => {
    const pane = agentIn(session, id, [startedOn('testhost'), userLine('work')]);
    fs.writeFileSync(path.join(base, `focused-${pane.proc.pid}`), '');
    tmux.run(['set-option', '-t', `=${session}:`, '@vdx_topic', topic]);
    return pane;
  };

  it('--focused "<topic>": the focused session on that topic is the one asked for, not one more (Sidetrack #7)', () => {
    // A plain session with the same topic in its option, first among the panes, is not a focused one.
    agentIn('proj@testhost', ID.b, [startedOn('testhost'), userLine('other')]);
    tmux.run(['set-option', '-t', '=proj@testhost:', '@vdx_topic', 'search']);
    focusedIn('proj@testhost-2', ID.a, 'search');
    expect(runAi({ ...opts, path: root, focused: true, topic: '  search ' }, deps())).toBe(EXIT_OK);
    expect(text()).toContain('→ proj@testhost-2 is the focused session on «search» — attaching to it');
    expect(tmux.hasSession('proj@testhost-3')).toBe(false);
    // Another topic: a new focused session next to them.
    logs = [];
    expect(runAi({ ...opts, path: root, focused: true, topic: 'other' }, deps())).toBe(EXIT_OK);
    expect(text()).not.toContain('is the focused session on');
    expect(tmux.hasSession('proj@testhost-3')).toBe(true);
  });

  // t23b-program, 2026-11-08: `! vdx ai --restart` typed in one session restarted the newest of three.
  describe('--restart from inside a session', () => {
    const three = () => [
      agentIn('proj@testhost', ID.a, [startedOn('testhost'), userLine('one')]),
      agentIn('proj@testhost-2', ID.b, [startedOn('testhost'), userLine('two')]),
      agentIn('proj@testhost-3', ID.c, [startedOn('testhost'), userLine('three')]),
    ];
    /** This vdx as a process under the agent of `agentPid`: what `!` at its prompt runs. */
    const inside = (agentPid: number) => () => [
      ...listProcesses(),
      { pid: 9_999_991, ppid: agentPid, args: 'node vdx ai --restart' },
    ];
    const pids = () =>
      findAgentPanes(tmux.panes(), listProcesses(), root, 'claude')
        .map((a) => `${a.pane.session} ${a.proc.pid}`)
        .sort();

    it('is about that session: it goes on apart from its pane, and the restart handed on restarts that pane', () => {
      const middle = three()[1]!;
      const before = pids();
      const handed: { args: string[]; pane: string | undefined; log: string }[] = [];
      const d: AiDeps = {
        ...deps(),
        interactive: false,
        processes: inside(middle.proc.pid),
        handOff: (args, env, log) => (handed.push({ args, pane: env['VDX_AI_RESTART_PANE'], log }), 4242),
      };
      expect(runAi({ ...opts, path: root, restart: true, detach: false }, d, 9_999_991)).toBe(EXIT_OK);
      const logFile = path.join(base, '.cache', 'vdx', 'restart', 'proj@testhost-2.log');
      expect(handed).toEqual([{ args: ['ai', root, '--restart', '--detach'], pane: middle.pane.paneId, log: logFile }]);
      expect(text()).toContain(`↻ proj@testhost-2 ${middle.pane.paneId}: this is the session vdx runs in`);
      expect(text()).toContain(`(pid 4242) and stops now; what that says: ${logFile}`);
      expect(pids()).toEqual(before);

      // The restart handed on: that pane, in its conversation; the others as they were.
      logs = [];
      const env = { ...deps().env, VDX_AI_RESTART_PANE: middle.pane.paneId };
      expect(runAi({ ...opts, path: root, restart: true }, { ...deps(), interactive: false, env })).toBe(EXIT_OK);
      expect(text()).toContain(`↻ proj@testhost-2 ${middle.pane.paneId}: restarting — `);
      expect(text()).toContain(`--resume ${ID.b}`);
      const after = pids();
      const others = (l: string[]) => l.filter((x) => !x.startsWith('proj@testhost-2 '));
      expect(others(after)).toEqual(others(before));
      expect(after).not.toEqual(before);
    }, 30_000);

    it('with no session of its own and nobody to ask: no guess — the line for each', () => {
      three();
      const before = pids();
      expect(runAi({ ...opts, path: root, restart: true }, { ...deps(), interactive: false })).toBe(EXIT_USAGE);
      expect(text()).toContain('3 agents of this project run here, and nobody to ask which — nothing restarted');
      for (const id of [ID.a, ID.b, ID.c])
        expect(text()).toContain(`vdx ai --restart ${shellQuote(root)} --conversation ${id}`);
      expect(pids()).toEqual(before);
    }, 30_000);

    it('a focused one: a plain --restart would make it plain — nothing restarted, the lines that keep it', () => {
      const pane = focusedIn('proj@testhost', ID.a, 'search');
      const d = { ...deps(), interactive: false, processes: inside(pane.proc.pid) };
      expect(runAi({ ...opts, path: root, restart: true }, d, 9_999_991)).toBe(EXIT_USAGE);
      expect(text()).toContain(
        `focused, in this conversation: vdx ai --focused --restart ${shellQuote(root)} --conversation ${ID.a}`,
      );
      expect(pids()).toEqual([`proj@testhost ${pane.proc.pid}`]);
    }, 30_000);
  });

  /** A start from another machine (`vdx ai@testhost` from lft): what seat each attach marks its terminal with. */
  const fromLft = () => {
    const seats: Record<string, string | undefined> = {};
    const d = deps();
    const t = Object.create(tmux) as typeof tmux;
    t.attach = (session: string, _inside: boolean, env?: NodeJS.ProcessEnv) => {
      seats[session] = env?.['VDX_AI_SEAT'];
      return 0;
    };
    // A new environment for every start, as every vdx process has: a start drops VDX_AI_FROM from it.
    return { seats, deps: () => ({ ...d, tmux: t, env: { ...d.env, VDX_AI_FROM: 'lft' } }) };
  };

  it('a terminal from another machine attached to an agent is marked with that seat — a focused one too (2026-11-05)', () => {
    focusedIn('proj@testhost', ID.a, 'search');
    agentIn('proj@testhost-2', ID.b, [startedOn('testhost'), userLine('other')]);
    const from = fromLft();
    expect(runAi({ ...opts, detach: false, path: root, conversation: ID.a }, from.deps())).toBe(EXIT_OK);
    expect(runAi({ ...opts, detach: false, path: root, conversation: ID.b }, from.deps())).toBe(EXIT_OK);
    expect(from.seats).toEqual({ 'proj@testhost': 'lft', 'proj@testhost-2': 'lft' });
  });

  it('…and the start that goes on after `r` brought back what tmux took down', () => {
    const pane = agentIn('proj@testhost', ID.a, [startedOn('testhost'), userLine('work')]);
    hook(pane, ID.a);
    killServer(tmux);
    const from = fromLft();
    answers = [''];
    expect(runAi({ ...opts, detach: false, path: root }, from.deps())).toBe(EXIT_OK);
    expect(text()).toContain('✓ 1 back');
    expect(from.seats).toEqual({ 'proj@testhost': 'lft' });
  }, 30_000);

  describe('session.always_list: at a terminal nothing is gone into on its own (Sidetrack #7)', () => {
    const always = () => {
      const file = path.join(base, 'env-always.yaml');
      fs.writeFileSync(
        file,
        fs.readFileSync(path.join(base, 'env.yaml'), 'utf8').replace('session: {', 'session: {always_list: true, '),
      );
      const d = deps();
      return { ...d, env: { ...d.env, VDX_ENVIRONMENT: file } };
    };

    it('a plain start shows the list even for the only agent, which no terminal here shows', () => {
      agentIn('proj@testhost', ID.a, [startedOn('testhost'), userLine('work')]);
      answers = ['1'];
      expect(runAi({ ...opts, path: root }, always())).toBe(EXIT_OK);
      expect(answers).toEqual([]);
      expect(text()).toMatch(/RUNNING NOW · 1\n+. 1 {2}proj@testhost +💤 idle/);
      expect(text()).not.toMatch(/ 2 {2}proj@testhost/);
      expect(text()).not.toContain('the only agent of proj runs here');
      expect(text()).toContain('✓ proj@testhost: already running with the profile');
    });

    it('the focused session on the topic is a question: n starts a new one next to it', () => {
      focusedIn('proj@testhost', ID.a, 'search');
      answers = ['n'];
      expect(runAi({ ...opts, path: root, focused: true, topic: 'search' }, always())).toBe(EXIT_OK);
      expect(answers).toEqual([]);
      expect(tmux.hasSession('proj@testhost-2')).toBe(true);
    });

    it('…Enter attaches to it', () => {
      focusedIn('proj@testhost', ID.a, 'search');
      answers = [''];
      expect(runAi({ ...opts, path: root, focused: true, topic: 'search' }, always())).toBe(EXIT_OK);
      expect(answers).toEqual([]);
      expect(tmux.hasSession('proj@testhost-2')).toBe(false);
    });

    it('an empty session --new would go into is a question: Enter puts it there, n starts one more', () => {
      agentIn('proj@testhost', ID.a, [slashLine('clear'), startedOn('testhost')]);
      answers = ['n'];
      expect(runAi({ ...opts, path: root, fresh: true }, always())).toBe(EXIT_OK);
      expect(text()).not.toContain('♻');
      expect(tmux.hasSession('proj@testhost-2')).toBe(true);
    });
  });

  it('…--focused restarts it focused, with the new topic', () => {
    agentIn('proj@testhost', ID.a, [slashLine('clear'), startedOn('testhost')]);
    expect(runAi({ ...opts, path: root, focused: true, topic: 'search' }, deps())).toBe(EXIT_OK);
    expect(text()).toContain('♻ proj@testhost');
    expect(tmux.hasSession('proj@testhost-2')).toBe(false);
    expect(tmux.tryRun(['show-options', '-qv', '-t', '=proj@testhost:', '@vdx_topic'])?.trim()).toBe('search');
    const now = findAgentPanes(tmux.panes(), listProcesses(), root, 'claude');
    expect(now).toHaveLength(1);
    expect(fs.existsSync(path.join(base, `focused-${now[0]!.proc.pid}`))).toBe(true);
  });

  it('…but not one with work in it: --new starts next to it', () => {
    agentIn('proj@testhost', ID.a, [startedOn('testhost'), userLine('work')]);
    expect(runAi({ ...opts, path: root, fresh: true }, deps())).toBe(EXIT_OK);
    expect(text()).not.toContain('♻');
    expect(tmux.hasSession('proj@testhost-2')).toBe(true);
  });

  /** The vdx plugin's SessionStart hook in the agent's pane: `vdx ai --check` below the agent. */
  const hook = (pane: ReturnType<typeof agentIn>, id: string, env: NodeJS.ProcessEnv = {}) => {
    const self = 999_999;
    const d = deps();
    runAiCheck(
      root,
      {
        ...d,
        env: { ...d.env, ...env },
        out: () => {},
        processes: () => [...listProcesses(), { pid: self, ppid: pane.proc.pid, args: 'vdx ai --check' }],
        lag: () => null,
      },
      self,
      id,
    );
  };
  const records = () => {
    const dir = socketDir({}, base, socket);
    return fs.existsSync(dir) ? fs.readdirSync(dir).flatMap((s) => fs.readdirSync(path.join(dir, s))) : [];
  };

  /** `@vdx_state` of a tmux session, as the cmux sidebar reads it; '' — unset. */
  const stateOf = (session: string) =>
    tmux.tryRun(['show-options', '-qv', '-t', `=${session}:`, STATE_OPTION])?.trim() ?? '';
  /** The hook's environment in the agent's pane: tmux names the pane. */
  const inPane = (pane: ReturnType<typeof agentIn>) => ({ TMUX: `${base}/tmux,1,0`, TMUX_PANE: pane.pane.paneId });

  it('@vdx_state for the cmux sidebar: SessionStart sets empty or finished from the transcript, unsets it for work (Sidetrack #4)', () => {
    const empty = agentIn('proj@testhost', ID.a, [slashLine('clear'), startedOn('testhost')]);
    const wrapped = agentIn('proj@testhost-2', ID.b, [
      startedOn('testhost'),
      userLine('work'),
      skillLine('vdm:wrap'),
      // A `!` line after the wrap — the commit it handed over — does not undo it, as in the list.
      bashLine('sh /tmp/c.sh'),
    ]);
    const working = agentIn('proj@testhost-3', ID.c, [startedOn('testhost'), userLine('work')]);
    tmux.run(['set-option', '-t', '=proj@testhost-3:', STATE_OPTION, 'finished']);
    hook(empty, ID.a, inPane(empty));
    hook(wrapped, ID.b, inPane(wrapped));
    hook(working, ID.c, inPane(working));
    expect(['proj@testhost', 'proj@testhost-2', 'proj@testhost-3'].map(stateOf)).toEqual(['empty', 'finished', '']);
    // The list says the same words of them.
    expect(runAi({ ...opts, path: root, list: true }, deps())).toBe(EXIT_OK);
    expect(text()).toMatch(/proj@testhost +🆕 empty/);
    expect(text()).toMatch(/proj@testhost-2 +✅ finished/);
  });

  it('…outside tmux the hook sets nothing', () => {
    const empty = agentIn('proj@testhost', ID.a, [slashLine('clear'), startedOn('testhost')]);
    hook(empty, ID.a);
    expect(stateOf('proj@testhost')).toBe('');
  });

  it('--state, from the Stop hook: the same from the transcript, the live conversation when none is named; prints nothing', () => {
    const pane = agentIn('proj@testhost', ID.a, [startedOn('testhost'), userLine('work')]);
    const self = 999_998;
    const d = deps();
    const state = (env: NodeJS.ProcessEnv, id?: string) =>
      runAiState(
        root,
        {
          ...d,
          env: { ...d.env, ...env },
          processes: () => [...listProcesses(), { pid: self, ppid: pane.proc.pid, args: 'vdx ai --state' }],
        },
        self,
        id,
      );
    tmux.run(['set-option', '-t', '=proj@testhost:', STATE_OPTION, 'empty']);
    expect(state(inPane(pane), ID.a)).toBe(EXIT_OK);
    expect(stateOf('proj@testhost')).toBe('');
    // The turn ran a wrap: its Stop names no conversation here, and the session file says which.
    writeConversation(cc(), root, ID.a, [startedOn('testhost'), userLine('work'), skillLine('vdm:wrap')], 0);
    expect(state(inPane(pane))).toBe(EXIT_OK);
    expect(stateOf('proj@testhost')).toBe('finished');
    // Outside tmux nothing changes — a pane id left in the environment without TMUX is not a pane.
    writeConversation(cc(), root, ID.a, [startedOn('testhost'), userLine('work')], 0);
    expect(state({ TMUX: '', TMUX_PANE: '' }, ID.a)).toBe(EXIT_OK);
    expect(state({ TMUX: '', TMUX_PANE: pane.pane.paneId }, ID.a)).toBe(EXIT_OK);
    expect(stateOf('proj@testhost')).toBe('finished');
    expect(text()).toBe('');
  });

  it('tmux fell: the list opens with what it took down, Enter brings it back, and the start goes on (P6)', () => {
    const pane = agentIn('proj@testhost', ID.a, [startedOn('testhost'), userLine('work')]);
    hook(pane, ID.a);
    expect(records()).toEqual([`${pane.pane.paneId.slice(1)}.json`]);
    killServer(tmux);
    answers = [''];
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(text()).toContain('⚠ no tmux server runs here — before that 1 agent of proj ran:\n     proj@testhost\n');
    expect(text()).not.toContain('vdx ai --restore brings back');
    expect(text()).toContain('Enter → r · r bring back the agent tmux took down');
    expect(text()).toContain(`▶ proj@testhost: conversation ${ID.a.slice(0, 8)}`);
    expect(text()).toContain('✓ 1 back');
    // The start goes on from what runs now: the one agent of the project, shown by no terminal.
    expect(text()).toContain('the only agent of proj runs here (proj@testhost)');
    const now = findAgentPanes(tmux.panes(), listProcesses(), root, 'claude');
    expect(now.map((a) => [a.pane.session, a.proc.args])).toEqual([
      ['proj@testhost', `/bin/sh ${claude()} --base --resume ${ID.a}`],
    ]);
    // The old server's record is gone; the start that went on recorded the agent under the new one.
    expect(records()).toEqual([`${now[0]!.pane.paneId.slice(1)}.json`]);
  }, 30_000);

  it('an agent the hook never recorded: the next vdx ai records it, and a restore brings it back (DL #12)', () => {
    agentIn('proj@testhost', ID.a, [startedOn('testhost'), userLine('work')]);
    tmux.run(['set-option', '-t', '=proj@testhost:', '@vdx_topic', 'search']);
    expect(records()).toEqual([]);
    // --list and --dry-run write nothing.
    expect(runAi({ ...opts, path: root, list: true }, deps())).toBe(EXIT_OK);
    expect(records()).toEqual([]);
    expect(runAi({ ...opts, path: root }, { ...deps(), agentFocused: () => true })).toBe(EXIT_OK);
    expect(records()).toHaveLength(1);
    killServer(tmux);
    logs = [];
    expect(runAiRestore(false, deps())).toBe(EXIT_OK);
    expect(text()).toContain(`▶ proj@testhost: conversation ${ID.a.slice(0, 8)}, focused «search»`);
    expect(findAgentPanes(tmux.panes(), listProcesses(), root, 'claude').map((a) => a.proc.args)).toEqual([
      `/bin/sh ${claude()} --base --resume ${ID.a}`,
    ]);
  }, 30_000);

  // The owner, 2026-11-11: `vdx ai@lft --new` from m3 printed «tmux here», a whole paragraph of a topic and
  // `vdx ai --restore`, which on m3 brings back m3's (vdx-ai-predictable Sidetrack #10).
  it('a start past the list says what tmux took down from where the person sits, as the list names agents', () => {
    const topic =
      'Кристалл outgoing-vs-unread, Sidetrack #7 по DL #17: новая задача Jira и связь, переход без комментария';
    const a = agentIn('proj@testhost', ID.a, [startedOn('testhost'), userLine('work')]);
    tmux.run(['set-option', '-t', '=proj@testhost:', '@vdx_topic', topic]);
    hook(a, ID.a, { VDX_FOCUSED: '1' });
    hook(agentIn('proj@testhost-2', ID.b, [startedOn('testhost'), userLine('more')]), ID.b);
    killServer(tmux);
    const d = deps();
    expect(
      runAi({ ...opts, path: root, fresh: true, dryRun: true }, { ...d, env: { ...d.env, VDX_AI_FROM: 'm3' } }),
    ).toBe(EXIT_OK);
    expect(text()).toContain(
      '⚠ no tmux server runs on testhost — before that 2 agents of proj ran:\n' +
        `     proj@testhost  🎯 focused «${topic.slice(0, 50)}»\n     proj@testhost-2\n` +
        '  ssh testhost vdx ai --restore brings back both — each in its tmux session',
    );
  }, 30_000);

  it('--restore: every project, focused with its topic, an empty one as a place; one continued elsewhere left out', () => {
    const a = agentIn('proj@testhost', ID.a, [startedOn('testhost'), userLine('work')]);
    tmux.run(['set-option', '-t', '=proj@testhost:', '@vdx_topic', 'search']);
    hook(a, ID.a, { VDX_FOCUSED: '1' });
    hook(agentIn('proj@testhost-2', ID.b, [slashLine('clear'), startedOn('testhost')]), ID.b);
    hook(agentIn('proj@testhost-3', ID.c, [startedOn('testhost'), userLine('x'), startedOn('lft')]), ID.c);
    const other = path.join(base, 'other');
    fs.mkdirSync(other, { recursive: true });
    const server = currentServer(tmux)!;
    writeRecord({}, base, server, {
      session: 'other@testhost',
      pane: '%99',
      project: other,
      conversation: null,
      mode: 'plain',
      topic: null,
      pid: 1,
      written: Date.now(),
    });
    killServer(tmux);

    // The project's start says what tmux took down, of it and of the others, and how to bring all back.
    expect(runAi({ ...opts, path: root, list: true }, deps())).toBe(EXIT_OK);
    expect(text()).toMatch(
      /⚠ no tmux server runs here — before that 3 agents of proj ran, and 1 of other projects:\n+ {5}proj@testhost {2}🎯 focused «search»\n+ {5}proj@testhost-2 — empty, no work in it\n+ {5}proj@testhost-3\n/,
    );
    expect(text()).toContain('vdx ai --restore brings back all 4');

    logs = [];
    expect(runAiRestore(true, deps())).toBe(EXIT_OK);
    expect(text()).toContain('vdx ai --restore — 4 agents went down with the tmux server here; would start:');
    expect(text()).toContain(`  other@testhost: a new conversation — none to continue\n    ${claude()} --base\n`);
    expect(text()).toContain(
      `  proj@testhost: conversation ${ID.a.slice(0, 8)}, focused «search»\n    VDX_FOCUSED=1 ${claude()} --base --resume ${ID.a}\n`,
    );
    expect(text()).toContain(
      `  proj@testhost-2: a new conversation — nothing typed in ${ID.b.slice(0, 8)} since /clear`,
    );
    expect(text()).toContain(
      `· proj@testhost-3: not brought back — its conversation ${ID.c.slice(0, 8)} was continued on lft since`,
    );
    expect(tmux.panes()).toEqual([]);
    expect(records()).toHaveLength(4);

    logs = [];
    expect(runAiRestore(false, deps())).toBe(EXIT_OK);
    expect(text()).toContain('✓ 3 back (1 left out)');
    const sessions = tmux.panes().map((p) => p.session);
    expect(sessions.sort()).toEqual(['other@testhost', 'proj@testhost', 'proj@testhost-2']);
    const mine = findAgentPanes(tmux.panes(), listProcesses(), root, 'claude');
    const focusedNow = mine.find((x) => x.pane.session === 'proj@testhost')!;
    expect(focusedNow.proc.args).toContain(`--resume ${ID.a}`);
    expect(fs.existsSync(path.join(base, `focused-${focusedNow.proc.pid}`))).toBe(true);
    expect(tmux.tryRun(['show-options', '-qv', '-t', '=proj@testhost:', '@vdx_topic'])?.trim()).toBe('search');
    expect(mine.find((x) => x.pane.session === 'proj@testhost-2')!.proc.args).not.toContain('--resume');
    expect(records()).toEqual([]);

    logs = [];
    expect(runAiRestore(false, deps())).toBe(EXIT_OK);
    expect(text()).toContain('nothing to bring back');
  }, 60_000);

  // The owner, 2026-11-12, in vdx on lft: «Я в проекте vdx нахожусь при чем тут echelon или ga-plugins?» — the
  // block with ⚠ stood first there, and both agents it named had no work in them (Sidetrack #15).
  it('agents of other projects only went down: one note under the list, with whether work was in them', () => {
    const work = agentIn('proj@testhost', ID.a, [startedOn('testhost'), userLine('work')]);
    hook(work, ID.a);
    hook(agentIn('proj@testhost-2', ID.b, [slashLine('clear'), startedOn('testhost')]), ID.b);
    hook(agentIn('proj@testhost-3', ID.c, [startedOn('testhost'), userLine('x'), skillLine('vdm:wrap')]), ID.c);
    killServer(tmux);
    const third = path.join(base, 'third');
    fs.mkdirSync(third, { recursive: true });
    const restore = 'vdx ai --restore brings back all 3, vdx ai --restore --forget drops them';
    expect(runAi({ ...opts, path: third, list: true }, deps())).toBe(EXIT_OK);
    expect(text()).not.toContain('⚠');
    expect(text()).toMatch(
      new RegExp(
        `nothing runs now\\n+ {2}note: no tmux server runs here; 3 agents of other projects \\(proj\\) went down with the last one, work in 1 of them — ${restore}\\n`.replace(
          'proj',
          path.basename(root),
        ),
      ),
    );
    // A start past the list says the same line, and no block.
    logs = [];
    expect(runAi({ ...opts, path: third, fresh: true, dryRun: true }, deps())).toBe(EXIT_OK);
    expect(text()).toContain(
      `note: no tmux server runs here; 3 agents of other projects (${path.basename(root)}) went down`,
    );
    expect(text()).not.toContain('⚠');
    // Their own project still opens with the block; each row says when no work was in it.
    logs = [];
    expect(runAi({ ...opts, path: root, list: true }, deps())).toBe(EXIT_OK);
    expect(text()).toMatch(
      /⚠ no tmux server runs here — before that 3 agents of proj ran:\n+ {5}proj@testhost\n+ {5}proj@testhost-2 — empty, no work in it\n+ {5}proj@testhost-3 — finished, no work in it\n+ {2}vdx ai --restore brings back all 3 — .*; --forget: drops them\n/,
    );
    expect(text()).not.toContain('note: no tmux server');
    // The one with work forgotten by hand: the note says no work was in any.
    const dir = socketDir({}, base, socket);
    for (const server of fs.readdirSync(dir))
      fs.rmSync(path.join(dir, server, `${work.pane.paneId.slice(1)}.json`), { force: true });
    logs = [];
    expect(runAi({ ...opts, path: third, list: true }, deps())).toBe(EXIT_OK);
    expect(text()).toContain(
      `2 agents of other projects (${path.basename(root)}) went down with the last one, no work in either — vdx ai --restore brings back both`,
    );
  }, 60_000);

  it('--restore --forget: none is started, the records go, each named with whether work was in it', () => {
    hook(agentIn('proj@testhost', ID.a, [startedOn('testhost'), userLine('work')]), ID.a);
    const b = agentIn('proj@testhost-2', ID.b, [slashLine('clear'), startedOn('testhost')]);
    tmux.run(['set-option', '-t', '=proj@testhost-2:', '@vdx_topic', 'search']);
    hook(b, ID.b, { VDX_FOCUSED: '1' });
    killServer(tmux);
    const named = [
      `  proj@testhost (${path.basename(root)}): work in it; its conversation stays: vdx ai `,
      ` --conversation ${ID.a}`,
      `  proj@testhost-2 (${path.basename(root)}): focused «search» — empty, no work in it`,
    ];
    // --dry-run: what it would forget; nothing is forgotten.
    expect(runAiRestore(true, deps(), true)).toBe(EXIT_OK);
    expect(text()).toContain('vdx ai --restore --forget — 2 agents went down with the tmux server here; would forget:');
    for (const part of named) expect(text()).toContain(part);
    expect(records()).toHaveLength(2);
    logs = [];
    expect(runAiRestore(false, deps(), true)).toBe(EXIT_OK);
    expect(text()).toContain('2 agents went down with the tmux server here; forgotten, not brought back:');
    expect(records()).toEqual([]);
    expect(tmux.panes()).toEqual([]);
    // Nothing is left to say or to bring back.
    logs = [];
    expect(runAi({ ...opts, path: root, list: true }, deps())).toBe(EXIT_OK);
    expect(text()).not.toMatch(/⚠|went down/);
    expect(runAiRestore(true, deps())).toBe(EXIT_OK);
    expect(text()).toContain('nothing to bring back');
  }, 60_000);

  /** The HQ session in conversation `id`, started by vdx as it would be: its pane, with the mark on the agent. */
  const hqIn = (id: string) => {
    expect(runAi({ ...opts, path: root, hq: true }, deps())).toBe(EXIT_OK);
    const pane = findAgentPanes(tmux.panes(), listProcesses(), root, 'claude').find(
      (a) => a.pane.session === 'proj@testhost-hq',
    )!;
    fs.mkdirSync(path.join(cc(), 'sessions'), { recursive: true });
    fs.writeFileSync(
      path.join(cc(), 'sessions', `${pane.proc.pid}.json`),
      JSON.stringify({ pid: pane.proc.pid, sessionId: id, status: 'idle', statusUpdatedAt: Date.now() }),
    );
    writeConversation(
      cc(),
      root,
      id,
      [hookLine(`${machineLine('testhost')}; …\n${HQ_LINE_PREFIX} (\`vdx ai --hq\`): …`), userLine('/first')],
      1,
    );
    return pane;
  };

  it('--hq --restart keeps its conversation, no first prompt; with --new a new one, with it', () => {
    const before = hqIn(ID.a);
    expect(before.proc.args).toBe(`/bin/sh ${claude()} /first --base`);
    expect(runAi({ ...opts, path: root, hq: true, restart: true }, deps())).toBe(EXIT_OK);
    const resumed = findAgentPanes(tmux.panes(), listProcesses(), root, 'claude');
    expect(resumed.map((a) => [a.pane.session, a.proc.args])).toEqual([
      ['proj@testhost-hq', `/bin/sh ${claude()} --base --resume ${ID.a}`],
    ]);
    expect(fs.existsSync(path.join(base, `hq-${resumed[0]!.proc.pid}`))).toBe(true);
    // Its sign stays through the restart.
    expect(tmux.tryRun(['show-options', '-qv', '-t', '=proj@testhost-hq:', '@vdx_topic'])?.trim()).toBe('👑 HQ');
    fs.writeFileSync(
      path.join(cc(), 'sessions', `${resumed[0]!.proc.pid}.json`),
      JSON.stringify({ pid: resumed[0]!.proc.pid, sessionId: ID.a, status: 'idle', statusUpdatedAt: Date.now() }),
    );

    expect(runAi({ ...opts, path: root, hq: true, restart: true, fresh: true }, deps())).toBe(EXIT_OK);
    expect(findAgentPanes(tmux.panes(), listProcesses(), root, 'claude').map((a) => a.proc.args)).toEqual([
      `/bin/sh ${claude()} /first --base`,
    ]);
  }, 30_000);

  it('--hq --conversation: back to it when none runs; a running one in another conversation stays, and it is said', () => {
    writeConversation(
      cc(),
      root,
      ID.b,
      [hookLine(`${machineLine('testhost')}; …\n${HQ_LINE_PREFIX} (\`vdx ai --hq\`): …`), userLine('/first')],
      1,
    );
    expect(runAi({ ...opts, path: root, hq: true, conversation: ID.b }, deps())).toBe(EXIT_OK);
    const back = findAgentPanes(tmux.panes(), listProcesses(), root, 'claude');
    expect(back.map((a) => [a.pane.session, a.proc.args])).toEqual([
      ['proj@testhost-hq', `/bin/sh ${claude()} --base --resume ${ID.b}`],
    ]);
    fs.mkdirSync(path.join(cc(), 'sessions'), { recursive: true });
    fs.writeFileSync(
      path.join(cc(), 'sessions', `${back[0]!.proc.pid}.json`),
      JSON.stringify({ pid: back[0]!.proc.pid, sessionId: ID.b, status: 'idle', statusUpdatedAt: Date.now() }),
    );
    logs = [];
    expect(runAi({ ...opts, path: root, hq: true, conversation: ID.c }, deps())).toBe(EXIT_OK);
    expect(text()).toContain(`to switch it: vdx ai --hq --restart ${root} --conversation ${ID.c}`);
    expect(findAgentPanes(tmux.panes(), listProcesses(), root, 'claude')).toHaveLength(1);
  }, 30_000);

  it('--focused <topic> --conversation: the session gets the topic, the agent no new turn', () => {
    writeConversation(cc(), root, ID.b, [startedOn('testhost'), userLine('work')], 1);
    expect(runAi({ ...opts, path: root, focused: true, topic: 'back', conversation: ID.b }, deps())).toBe(EXIT_OK);
    const now = findAgentPanes(tmux.panes(), listProcesses(), root, 'claude');
    expect(now.map((a) => a.proc.args)).toEqual([`/bin/sh ${claude()} --base --resume ${ID.b}`]);
    expect(tmux.tryRun(['show-options', '-qv', '-t', '=proj@testhost:', '@vdx_topic'])?.trim()).toBe('back');
  }, 30_000);

  // The owner, 2026-11-05 (nas-info): plain `vdx ai` reaches the HQ session too; --hq only narrows the choice.
  it('the HQ session is a row of the list: its number attaches to it as it is; Enter does not lead there', () => {
    const hq = hqIn(ID.a);
    agentIn('proj@testhost', ID.b, [startedOn('testhost'), userLine('work')]);
    expect(runAi({ ...opts, path: root, list: true }, deps())).toBe(EXIT_OK);
    expect(text()).toContain('RUNNING NOW · 1');
    expect(text()).toMatch(/1 {2}proj@testhost +💤 idle/);
    expect(text()).toMatch(/HQ SESSION\n+ {2}2 {2}proj@testhost-hq {2}💤 idle +👑\n+ {7}vdx ai \S+ --hq\n/);

    // At a terminal its number takes it, in its mode: no drift, no second agent.
    logs = [];
    answers = ['2'];
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(text()).toContain(`✓ proj@testhost-hq: already running with the profile, the HQ session — ${hq.proc.args}`);
    expect(findAgentPanes(tmux.panes(), listProcesses(), root, 'claude')).toHaveLength(2);

    // Enter is the person's agent; with no terminal the HQ session is left to --hq.
    logs = [];
    answers = [''];
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(text()).toContain('✓ proj@testhost: already running with the profile —');
    logs = [];
    expect(runAi({ ...opts, path: root }, { ...deps(), interactive: false })).toBe(EXIT_OK);
    expect(text()).toContain('✓ proj@testhost: already running with the profile —');
  }, 30_000);

  it('the HQ session alone, open in no terminal here: a choice — the list, not a silent start', () => {
    hqIn(ID.a);
    answers = ['1'];
    expect(runAi({ ...opts, path: root }, deps())).toBe(EXIT_OK);
    expect(answers).toHaveLength(0);
    expect(text()).toContain('✓ proj@testhost-hq: already running with the profile, the HQ session');
    expect(findAgentPanes(tmux.panes(), listProcesses(), root, 'claude')).toHaveLength(1);
  }, 30_000);

  it('--restore brings the HQ session back in its conversation, mode and sign — unless one runs now', () => {
    const pane = hqIn(ID.a);
    hook(pane, ID.a, { VDX_HQ: '1' });
    killServer(tmux);

    logs = [];
    expect(runAiRestore(true, deps())).toBe(EXIT_OK);
    expect(text()).toContain(
      `  proj@testhost-hq: conversation ${ID.a.slice(0, 8)}, the HQ session\n    VDX_HQ=1 ${claude()} --base --resume ${ID.a}\n`,
    );

    // Started by hand since, in another conversation: the one record does not make a second.
    logs = [];
    expect(runAi({ ...opts, path: root, hq: true }, deps())).toBe(EXIT_OK);
    expect(text()).toContain('vdx ai --restore brings back it');
    logs = [];
    expect(runAiRestore(false, deps())).toBe(EXIT_OK);
    expect(text()).toContain("· proj@testhost-hq: not brought back — the project's HQ session runs here now");
    expect(findAgentPanes(tmux.panes(), listProcesses(), root, 'claude')).toHaveLength(1);
    killServer(tmux);

    // With none running: back, marked, with its sign and no new turn.
    hook(hqIn(ID.a), ID.a, { VDX_HQ: '1' });
    killServer(tmux);
    logs = [];
    expect(runAiRestore(false, deps())).toBe(EXIT_OK);
    const now = findAgentPanes(tmux.panes(), listProcesses(), root, 'claude');
    expect(now.map((a) => [a.pane.session, a.proc.args])).toEqual([
      ['proj@testhost-hq', `/bin/sh ${claude()} --base --resume ${ID.a}`],
    ]);
    expect(fs.existsSync(path.join(base, `hq-${now[0]!.proc.pid}`))).toBe(true);
    expect(tmux.tryRun(['show-options', '-qv', '-t', '=proj@testhost-hq:', '@vdx_topic'])?.trim()).toBe('👑 HQ');
  }, 60_000);

  it("--restore brings back the intercom session the person started, to stay; a letter's is left out (DL #12)", () => {
    const session = 'proj@testhost-intercom';
    const staysOf = () => tmux.tryRun(['show-options', '-qv', '-t', `=${session}:`, '@vdx_stays'])?.trim() ?? '';
    const intercom = () =>
      findAgentPanes(tmux.panes(), listProcesses(), root, 'claude').filter((a) => a.pane.session === session);
    /** The intercom session as a letter starts it, in conversation `id`, recorded by its hook. */
    const fromLetter = (id: string) => {
      expect(runAi({ ...opts, path: root, intercom: true }, deps())).toBe(EXIT_OK);
      const pane = intercom()[0]!;
      fs.mkdirSync(path.join(cc(), 'sessions'), { recursive: true });
      fs.writeFileSync(
        path.join(cc(), 'sessions', `${pane.proc.pid}.json`),
        JSON.stringify({ pid: pane.proc.pid, sessionId: id, status: 'idle', statusUpdatedAt: Date.now() }),
      );
      writeConversation(cc(), root, id, [startedOn('testhost'), userLine('/mail')], 1);
      hook(pane, id, { VDX_INTERCOM: '1' });
      return pane;
    };

    // A letter's: the next letter starts one.
    expect(fromLetter(ID.a).proc.args).toBe(`/bin/sh ${claude()} /mail --base`);
    killServer(tmux);
    logs = [];
    expect(runAiRestore(true, deps())).toBe(EXIT_OK);
    expect(text()).toContain('nothing to bring back');

    // The person attaches to the running one: it stays, and its record says so.
    fromLetter(ID.a);
    const person = Object.create(tmux) as typeof tmux;
    person.attach = () => 0;
    expect(runAi({ ...opts, path: root, intercom: true, detach: false }, { ...deps(), tmux: person })).toBe(EXIT_OK);
    expect(staysOf()).toBe('1');
    killServer(tmux);
    logs = [];
    expect(runAiRestore(true, deps())).toBe(EXIT_OK);
    expect(text()).toContain(
      `  ${session}: conversation ${ID.a.slice(0, 8)}, the intercom session the user started\n` +
        `    VDX_INTERCOM=1 ${claude()} --base --resume ${ID.a}\n`,
    );

    // A letter started one since: no second, and that one stays now.
    fromLetter(ID.b);
    logs = [];
    expect(runAiRestore(false, deps())).toBe(EXIT_OK);
    expect(text()).toContain(
      `· ${session}: not brought back — the project's intercom session runs here now (${session}); marked to stay`,
    );
    expect(intercom()).toHaveLength(1);
    expect(staysOf()).toBe('1');

    // With none running: back in its conversation, no first prompt, marked to stay.
    killServer(tmux);
    logs = [];
    expect(runAiRestore(false, deps())).toBe(EXIT_OK);
    expect(text()).toContain('✓ 1 back');
    const now = intercom();
    expect(now.map((a) => a.proc.args)).toEqual([`/bin/sh ${claude()} --base --resume ${ID.b}`]);
    expect(fs.existsSync(path.join(base, `mail-${now[0]!.proc.pid}`))).toBe(true);
    expect(staysOf()).toBe('1');

    // A record without the mark — written by vdx before 0.52 — learns it at the next pass of vdx here.
    writeRecord({}, base, currentServer(tmux)!, {
      session,
      pane: now[0]!.pane.paneId,
      project: root,
      conversation: ID.b,
      mode: 'mail',
      topic: null,
      pid: now[0]!.proc.pid,
      written: Date.now(),
    });
    expect(runAiRestore(false, deps())).toBe(EXIT_OK);
    killServer(tmux);
    logs = [];
    expect(runAiRestore(true, deps())).toBe(EXIT_OK);
    expect(text()).toContain(`  ${session}: conversation ${ID.b.slice(0, 8)}, the intercom session the user started`);
  }, 60_000);

  /** A Tmux whose attach plays the terminal: `onAttach` decides what happens while it is attached. */
  const attaching = (onAttach: (n: number, t: Tmux) => number) => {
    const sessions: string[] = [];
    const t = new (class extends Tmux {
      override attach(session: string): number {
        sessions.push(session);
        return onAttach(sessions.length, this);
      }
    })(socket);
    return { t, sessions };
  };

  it('the tmux server falls under the attach: the terminal waits for its session and attaches again (DL #11)', () => {
    hook(agentIn('proj@testhost', ID.a, [startedOn('testhost'), userLine('work')]), ID.a);
    const { t, sessions } = attaching((n, self) => {
      if (n === 1) self.tryRun(['kill-server']);
      return n === 1 ? 1 : 0;
    });
    let restored = false;
    const d: AiDeps = {
      ...deps(),
      tmux: t,
      // The first wait is when something brings the agents back: here, a restore from another terminal.
      sleep: (ms) => {
        if (restored) return sleepSync(ms);
        restored = true;
        runAiRestore(false, { ...deps(), log: () => {} });
      },
    };
    expect(runAi({ ...opts, path: root, detach: false }, d)).toBe(EXIT_OK);
    expect(sessions).toEqual(['proj@testhost', 'proj@testhost']);
    expect(text()).toContain('⚠ the tmux server here fell under proj@testhost — waiting for it to come back');
    expect(text()).toContain('↻ proj@testhost is back — attaching');
    expect(findAgentPanes(tmux.panes(), listProcesses(), root, 'claude').map((a) => a.proc.args)).toEqual([
      `/bin/sh ${claude()} --base --resume ${ID.a}`,
    ]);
  }, 30_000);

  it('a detach leaves the server as it was: no wait; a fallen server with no record: said, no wait', () => {
    hook(agentIn('proj@testhost', ID.a, [startedOn('testhost'), userLine('work')]), ID.a);
    const detached = attaching(() => 0);
    expect(runAi({ ...opts, path: root, detach: false }, { ...deps(), tmux: detached.t })).toBe(EXIT_OK);
    expect(detached.sessions).toHaveLength(1);
    expect(text()).not.toContain('fell');

    fs.rmSync(path.join(base, '.local'), { recursive: true, force: true });
    logs = [];
    // The start records the agent before it attaches: the record goes with the server here.
    const fell = attaching((_, self) => {
      fs.rmSync(path.join(base, '.local'), { recursive: true, force: true });
      self.tryRun(['kill-server']);
      return 1;
    });
    expect(runAi({ ...opts, path: root, detach: false }, { ...deps(), tmux: fell.t })).toBe(1);
    expect(fell.sessions).toHaveLength(1);
    expect(text()).toContain(
      '⚠ the tmux server here fell, and vdx has no record of proj@testhost to bring it back — vdx ai starts it',
    );
  }, 30_000);
});

describe('vdx ai@host', () => {
  const opts: AiOptions = { path: '.', restart: false, fresh: false, detach: false, dryRun: false };

  it('maps a path under the local home to the remote home, anything else as is', () => {
    expect(remotePathWord('/Users/vdm', '/Users/vdm')).toBe('"$HOME"');
    expect(remotePathWord('/Users/vdm/AI Projects/vdx', '/Users/vdm')).toBe(`"$HOME"/'AI Projects/vdx'`);
    expect(remotePathWord('/Users/vdm2/x', '/Users/vdm')).toBe('/Users/vdm2/x');
    expect(remotePathWord('/opt/my proj', '/Users/vdm')).toBe(`'/opt/my proj'`);
  });

  it('asks ssh for a terminal only when it will attach', () => {
    const base = { host: 'm3', from: 'lft', projectPath: '/h/p', home: '/h', version: '1.0.0', opts };
    expect(remoteAiArgs({ ...base, tty: true }).slice(0, 2)).toEqual(['-t', 'm3']);
    expect(remoteAiArgs({ ...base, tty: false }).slice(0, 2)).toEqual(['-T', 'm3']);
    expect(remoteAiArgs({ ...base, opts: { ...opts, find: "it's here" }, tty: true })[2]).toContain(
      `--find 'it'\\''s here'`,
    );
    expect(remoteAiArgs({ ...base, opts: { ...opts, hq: true }, tty: true })[2]).toContain(' --hq');
  });

  it('the line before ssh names every flag the vdx there gets (vdx-ai-predictable Sidetrack #10)', () => {
    const said: string[] = [];
    const d = {
      env: {},
      home: '/h',
      interactive: false,
      version: '1.0.0',
      log: (l: string) => said.push(l),
      ssh: () => ({ status: 0, stdout: '' }),
    } as unknown as AiDeps;
    expect(runAiRemote({ ...opts, path: '/h/p', fresh: true, focused: true, topic: 'two words' }, 'm3', d, 'lft')).toBe(
      0,
    );
    expect(said[0]).toMatch(/^→ m3: vdx ai \S+ --new --focused 'two words'$/);
  });

  // nas-info, 2026-11-11 (letter ai-peer-inside-tmux-nests): `vdx ai@lft --hq` typed in a pane of global-auth-gap@m3-hq
  // put lft's tmux client inside m3's — two status lines, the prefix taken by the outer one.
  describe('typed in a tmux pane here, to attach: no tmux inside tmux', () => {
    const inPane = (terminals: { session: string; pid: number; tty?: string }[], interactive = true) => {
      const ran: string[][] = [];
      const said: string[] = [];
      let sshed = false;
      const tmux = {
        socketName: null,
        tryRun: (args: string[]) => {
          ran.push(args);
          return args[0] === 'display-message' ? '4242\t1700000000\t/tmp/tmux-501/default\n' : '';
        },
        panes: () => [{ session: 'proj@m3-hq', paneId: '%7', panePid: 1, cwd: '/h' }],
        clients: () => terminals,
      };
      const d = {
        env: { TMUX: '/tmp/tmux-501/default,4242,3', TMUX_PANE: '%7' },
        home: '/h',
        interactive,
        version: '1.0.0',
        log: (l: string) => said.push(l),
        ssh: () => {
          sshed = true;
          return { status: 0, stdout: '' };
        },
        tmux,
      } as unknown as AiDeps;
      const status = runAiRemote({ ...opts, path: '/h/p', hq: true }, 'lft', d, 'm3');
      return { status, ran, said, sshed: () => sshed };
    };

    it("the terminal's tmux client gives way to the same command, run in the terminal itself", () => {
      const r = inPane([{ session: 'proj@m3-hq', pid: 9, tty: '/dev/ttys004' }]);
      expect(r.status).toBe(EXIT_OK);
      expect(r.sshed()).toBe(false);
      expect(r.ran).toContainEqual([
        'detach-client',
        '-t',
        '/dev/ttys004',
        '-E',
        expect.stringMatching(/^vdx ai@lft \S+ --hq$/),
      ]);
      expect(r.said[0]).toMatch(
        /^→ lft: vdx ai@lft \S+ --hq — in this terminal, in place of its tmux client; proj@m3-hq stays/,
      );
    });

    it('two terminals on the session: which one typed it is not known — nothing detached, the line says how', () => {
      const r = inPane([
        { session: 'proj@m3-hq', pid: 9, tty: '/dev/ttys004' },
        { session: 'proj@m3-hq', pid: 10, tty: '/dev/ttys042' },
      ]);
      expect(r.status).toBe(EXIT_LAUNCH_FAILED);
      expect(r.sshed()).toBe(false);
      expect(r.ran.some((a) => a[0] === 'detach-client')).toBe(false);
      expect(r.said[0]).toMatch(
        /tmux pane of proj@m3-hq, and lft's tmux would open inside it — nothing started; detach \(Ctrl-B d\)/,
      );
    });

    it('nobody to attach (no terminal, as with `!` in Claude Code): ssh as before', () => {
      const r = inPane([{ session: 'proj@m3-hq', pid: 9, tty: '/dev/ttys004' }], false);
      expect(r.sshed()).toBe(true);
      expect(r.ran.some((a) => a[0] === 'detach-client')).toBe(false);
    });
  });

  describe('the remote script, run by a shell against a stub vdx', () => {
    let dir: string;
    beforeAll(() => {
      dir = tmpDir('vdx-remote-');
      fs.mkdirSync(path.join(dir, 'bin'));
      fs.mkdirSync(path.join(dir, 'home', 'AI Projects', 'vdx'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'bin', 'vdx'),
        '#!/bin/sh\nif [ "$1" = --version ]; then [ -n "$STUB_VERSION" ] || exit 1; echo "$STUB_VERSION"; exit 0; fi\nprintf \'%s\\n\' "$@"\necho "from=$VDX_AI_FROM"\n',
        { mode: 0o755 },
      );
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    const run = (stubVersion: string, o = opts) => {
      const script = remoteAiArgs({
        host: 'm3',
        from: 'lft',
        projectPath: '/Users/vdm/AI Projects/vdx',
        home: '/Users/vdm',
        version: '0.14.0',
        opts: o,
        tty: false,
      })[2]!;
      const res = spawnSync('/bin/sh', ['-c', script], {
        encoding: 'utf8',
        env: {
          PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin`,
          HOME: path.join(dir, 'home'),
          STUB_VERSION: stubVersion,
        },
      });
      const out = res.stdout.split('\n').filter(Boolean);
      return {
        args: out.filter((l) => !l.startsWith('from=')),
        from: out.find((l) => l.startsWith('from='))?.slice(5),
        note: res.stderr.trim(),
        status: res.status,
      };
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

    it('tells the vdx there which machine the person sits at', () => {
      expect(run('0.14.0').from).toBe('lft');
    });

    it('passes --focused on', () => {
      expect(run('0.14.0', { ...opts, focused: true }).args).toEqual([
        'ai',
        path.join(dir, 'home', 'AI Projects', 'vdx'),
        '--focused',
      ]);
    });

    it('…with its topic as one word, after the path: there it is the topic, never the path', () => {
      expect(run('0.14.0', { ...opts, focused: true, topic: "release 0.41 — it's due" }).args).toEqual([
        'ai',
        path.join(dir, 'home', 'AI Projects', 'vdx'),
        '--focused',
        "release 0.41 — it's due",
      ]);
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
    fs.writeFileSync(
      path.join(home, 'reg', 'telegram.vorobyev.name.json'),
      JSON.stringify({ names: ['vodmalbot', 'bot'] }),
    );
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

  it('reads the name from [_.vdx] too, and says so', () => {
    fs.writeFileSync(path.join(project, 'mise.toml'), '[_.vdx]\nname = "tgbot"\n');
    expect(resolve([registry])).toEqual({ name: 'tgbot', source: 'mise.toml [_.vdx] name' });
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
    for (const [k, v] of [
      ['GIT_CONFIG_GLOBAL', saved.global],
      ['GIT_CONFIG_NOSYSTEM', saved.nosystem],
    ] as const) {
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
    expect(logs.join('')).toContain(
      'author:   none — git refuses to commit here; would propose me@work.example, me@home.example',
    );
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

  it('a focused session: says so, and the rule that wakes it is not missing', () => {
    expect(runAiCheck(root, deps(chain('--dangerously-skip-permissions --continue'), { VDX_FOCUSED: '1' }), 40)).toBe(
      EXIT_OK,
    );
    const text = out.join('');
    expect(text).toContain('· this session is focused (`vdx ai --focused`)');
    expect(text).toContain("the profile's echelon-channel is left out");
    // No tmux pane holds this agent: it has nowhere to keep a topic.
    expect(text).toContain("· it runs outside tmux, so it has no topic: a topic lives in the agent's tmux session.");
    expect(text).toContain("✓ this session carries the profile's flags");
  });

  it("a topic line in the transcript: the last one is the conversation's topic", () => {
    const file = path.join(home, `${ID.a}.jsonl`);
    const prompt = (text: string) =>
      JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [text] } });
    fs.writeFileSync(
      file,
      [
        startedOn('lft'),
        userLine('hi'),
        prompt(`${topicLine('first')}\n· keep the conversation in it`),
        prompt(`${topicLine('the «second» one')}\n· keep the conversation in it`),
        userLine('more'),
      ].join('\n') + '\n',
    );
    expect(readConversation(file, new Date())?.topic).toBe('the «second» one');
    expect(readConversation(file, new Date())?.machine).toBe('lft');
    const plain = path.join(home, `${ID.b}.jsonl`);
    fs.writeFileSync(plain, [startedOn('lft'), userLine('hi')].join('\n') + '\n');
    expect(readConversation(plain, new Date())?.topic).toBeNull();
  });

  it('the intercom session: says what it is and how it ends; the transcript keeps it as a mail one', () => {
    const procs = chain(
      '--dangerously-skip-permissions --dangerously-load-development-channels plugin:echelon@echelon /vdm:intercom',
    );
    expect(runAiCheck(root, deps(procs, { VDX_INTERCOM: '1' }), 40)).toBe(EXIT_OK);
    const text = out.join('');
    expect(text).toContain(`${INTERCOM_LINE_PREFIX} (\`vdx ai --intercom\`)`);
    expect(text).toContain('`vdx ai --close`');
    expect(text).toContain('`vdx ai --close --waiting <n>`');
    expect(text).toContain("✓ this session carries the profile's flags");
    const file = path.join(home, `${ID.a}.jsonl`);
    fs.writeFileSync(file, [hookLine(text.trimEnd()), userLine('hi')].join('\n') + '\n');
    expect(readConversation(file, new Date())?.mail).toBe(true);

    // A restart of an intercom session — and of a focused one — starts a new conversation, it resumes none.
    for (const [mode, flag] of [
      ['VDX_INTERCOM', '--intercom'],
      ['VDX_FOCUSED', '--focused'],
    ] as const) {
      out = [];
      expect(runAiCheck(root, deps(chain('--x'), { [mode]: '1' }), 40)).toBe(EXIT_DRIFT);
      expect(out.join('')).toContain(`\`vdx ai ${flag} --restart ${root}\`: it stops this session and starts it again`);
      expect(out.join('')).toContain(
        ", in a new conversation — before handing it over, run the project's wrap check (`/vdm:wrap` where vdm is installed)",
      );
      expect(out.join('')).not.toContain('resuming the conversation');
    }
    // A restart that resumes keeps the chat: no wrap first.
    out = [];
    expect(runAiCheck(root, deps(chain('--x')), 40)).toBe(EXIT_DRIFT);
    expect(out.join('')).not.toContain('wrap check');
  });

  it('the HQ session: says what it is, names the line for a new topic; a restart resumes; the transcript keeps it', () => {
    const procs = chain(
      '--dangerously-skip-permissions --dangerously-load-development-channels plugin:echelon@echelon',
    );
    expect(runAiCheck(root, deps(procs, { VDX_HQ: '1' }), 40)).toBe(EXIT_OK);
    const text = out.join('');
    expect(text).toContain(`${HQ_LINE_PREFIX} (\`vdx ai --hq\`)`);
    expect(text).toContain(`\`vdx ai ${root} --focused "<topic>"\``);
    const file = path.join(home, `${ID.a}.jsonl`);
    fs.writeFileSync(file, [hookLine(text.trimEnd()), userLine('hi')].join('\n') + '\n');
    const c = readConversation(file, new Date());
    expect([c?.hq, c?.mail]).toEqual([true, false]);

    // Its restart keeps the conversation: nothing to wrap first.
    out = [];
    expect(runAiCheck(root, deps(chain('--x'), { VDX_HQ: '1' }), 40)).toBe(EXIT_DRIFT);
    expect(out.join('')).toContain(`\`vdx ai --hq --restart ${root}\`: it stops this session and starts it again`);
    expect(out.join('')).toContain('resuming the conversation');
    expect(out.join('')).not.toContain('wrap check');
  });

  it('a plain session is not a mail one in the transcript', () => {
    expect(runAiCheck(root, deps(chain('--dangerously-skip-permissions')), 40)).toBe(EXIT_DRIFT);
    const file = path.join(home, `${ID.b}.jsonl`);
    fs.writeFileSync(file, [hookLine(out.join('').trimEnd()), userLine('hi')].join('\n') + '\n');
    expect(readConversation(file, new Date())?.mail).toBe(false);
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

  it('plugins updated since the session loaded them — /reload-plugins or a restart, exit 3 (Sidetrack #24)', () => {
    const procs = chain(
      '--dangerously-skip-permissions --dangerously-load-development-channels plugin:echelon@echelon --continue',
    );
    const d = {
      ...deps(procs),
      lag: (pid: number) => (pid === 20 ? { claude: null, plugins: [{ name: 'vdm', version: '2.54.0' }] } : null),
    };
    expect(runAiCheck(root, d, 40)).toBe(EXIT_DRIFT);
    const text = out.join('');
    expect(text).toContain("✓ this session carries the profile's flags");
    expect(text).toContain(
      '✗ plugins updated since this session loaded them: vdm 2.54.0 — it still runs the ones it loaded.',
    );
    expect(text).toContain('`/reload-plugins`: it loads the installed plugins and keeps the conversation');
    expect(text).toContain(`\`vdx ai --restart ${root}\`: it stops this session and starts it again on the installed`);
  });

  it('an older Claude Code: a restart, not /reload-plugins — it does not update Claude Code', () => {
    const procs = chain(
      '--dangerously-skip-permissions --dangerously-load-development-channels plugin:echelon@echelon --continue',
    );
    const d = {
      ...deps(procs),
      lag: () => ({ claude: { runs: '2.1.294', installed: '2.1.304' }, plugins: [{ name: 'vdm', version: '2.54.0' }] }),
    };
    expect(runAiCheck(root, d, 40)).toBe(EXIT_DRIFT);
    const text = out.join('');
    expect(text).toContain(
      '✗ this session runs Claude Code 2.1.294 — 2.1.304 is installed; plugins updated since it loaded them: vdm 2.54.0.',
    );
    expect(text).not.toContain('/reload-plugins');
    expect(text).toContain('`vdx ai --restart');
  });

  it('missing flags and an older Claude Code: one restart fixes both', () => {
    const d = {
      ...deps(chain('--dangerously-skip-permissions --continue')),
      lag: () => ({ claude: { runs: '2.1.294', installed: '2.1.304' }, plugins: [] }),
    };
    expect(runAiCheck(root, d, 40)).toBe(EXIT_DRIFT);
    const text = out.join('');
    expect(text).toContain('✗ this session runs without --dangerously-load-development-channels');
    expect(text).toContain('✗ this session runs Claude Code 2.1.294 — 2.1.304 is installed.');
    expect(text).toContain("starts it again with the profile's flags, on the installed Claude Code and plugins");
    expect(text).not.toContain('✓');
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
