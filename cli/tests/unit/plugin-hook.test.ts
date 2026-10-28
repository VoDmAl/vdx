import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readConversation, topicLine } from '../../src/conversations.ts';
import { ID, hookLine, userLine } from './transcripts.ts';

// The vdx plugin's SessionStart hook, run against a stub `vdx`.
const HOOK = path.resolve(__dirname, '..', '..', '..', 'plugin', 'scripts', 'session-start.sh');

// --version answers $STUB_VERSION ("old": fails, as before 0.13.1); every other
// call is logged, and `ai --check` prints two lines and exits 3 (drift).
const STUB = `#!/bin/sh
if [ "$1" = --version ]; then
  [ "$STUB_VERSION" = old ] && { echo usage >&2; exit 1; }
  echo "$STUB_VERSION"; exit 0
fi
echo "$*" >> "$STUB_LOG"
if [ "$1 $2" = "ai --check" ]; then
  [ -n "$STUB_SILENT" ] && exit 0
  printf 'vdx ai: started with "vdx ai"\\n✗ this session runs without --flag\\n'; exit 3
fi
if [ "$1 $2" = "doctor --check" ]; then
  [ -n "$STUB_HOOKS" ] && echo "$STUB_HOOKS"
  exit 0
fi
exit 0
`;

/** What the hook hands the session: `hookSpecificOutput.additionalContext` of its JSON. */
const contextOf = (stdout: string): string =>
  (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;

describe('plugin SessionStart hook', () => {
  let dir: string;
  let bin: string;
  let log: string;
  const run = (env: Record<string, string>, withVdx = true) =>
    spawnSync('/bin/sh', [HOOK], {
      encoding: 'utf8',
      env: {
        PATH: [...(withVdx ? [bin] : []), path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
        STUB_LOG: log,
        CLAUDE_PROJECT_DIR: '/projects/my project',
        ...env,
      },
    });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-hook-'));
    bin = path.join(dir, 'bin');
    log = path.join(dir, 'calls.log');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'vdx'), STUB, { mode: 0o755 });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('hands the check to the agent as additionalContext', () => {
    for (const version of ['0.18.0', '0.19.2', '0.21.1']) {
      fs.rmSync(log, { force: true });
      const r = run({ STUB_VERSION: version });
      expect(r.status, version).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: 'vdx ai: started with "vdx ai"\n✗ this session runs without --flag',
        },
      });
      expect(calls()).toBe('ai --check /projects/my project\n');
    }
  });

  it('from 0.22 adds the hooks that do not run here, after the launch check', () => {
    for (const version of ['0.22.0', '1.0.0']) {
      fs.rmSync(log, { force: true });
      const r = run({ STUB_VERSION: version, STUB_HOOKS: 'vdx doctor: git hooks — husky off' });
      expect(contextOf(r.stdout), version).toBe(
        'vdx ai: started with "vdx ai"\n✗ this session runs without --flag\nvdx doctor: git hooks — husky off',
      );
      expect(calls(), version).toBe('ai --check /projects/my project\ndoctor --check /projects/my project\n');
    }
    // nothing from ai --check: the hooks line stands alone
    const r = run({ STUB_VERSION: '0.22.0', STUB_SILENT: '1', STUB_HOOKS: 'vdx doctor: personal hooks — off' });
    expect(contextOf(r.stdout)).toBe('vdx doctor: personal hooks — off');
  });

  it('never asks doctor --check of a vdx older than 0.22 — it would print the whole report', () => {
    run({ STUB_VERSION: '0.21.1', STUB_HOOKS: 'x' });
    expect(calls()).not.toContain('doctor');
  });

  it('never calls `vdx ai` on a vdx that would take --check for a launch', () => {
    for (const version of ['0.15.0', '0.17.0', 'old']) {
      const r = run({ STUB_VERSION: version });
      expect(r.status, version).toBe(0);
      expect(r.stdout, version).toBe('');
      expect(calls(), version).toBe('');
    }
  });

  it('is silent without vdx, and when the check has nothing to say', () => {
    expect(run({ STUB_VERSION: '0.18.0' }, false).stdout).toBe('');
    expect(run({ STUB_VERSION: '0.18.0', STUB_SILENT: '1' }).stdout).toBe('');
    expect(run({ STUB_VERSION: '0.22.0', STUB_SILENT: '1' }).stdout).toBe('');
  });
});

// The vdx plugin's UserPromptSubmit hook: a focused session's topic with every message.
const TOPIC_HOOK = path.resolve(__dirname, '..', '..', '..', 'plugin', 'scripts', 'focused-topic.sh');

describe('plugin UserPromptSubmit hook: the topic of a focused session', () => {
  let dir: string;
  let bin: string;
  let log: string;
  const run = (env: Record<string, string>) =>
    spawnSync('/bin/sh', [TOPIC_HOOK], {
      encoding: 'utf8',
      env: {
        PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
        STUB_LOG: log,
        CLAUDE_PROJECT_DIR: "/projects/it's mine",
        VDX_FOCUSED: '1',
        TMUX_PANE: '%7',
        ...env,
      },
    });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-topic-hook-'));
    bin = path.join(dir, 'bin');
    log = path.join(dir, 'calls.log');
    fs.mkdirSync(bin);
    // tmux answers the session's option; vdx only its version.
    fs.writeFileSync(
      path.join(bin, 'tmux'),
      '#!/bin/sh\necho "tmux $*" >> "$STUB_LOG"\nprintf \'%s\\n\' "$STUB_TOPIC"\n',
      {
        mode: 0o755,
      },
    );
    fs.writeFileSync(path.join(bin, 'vdx'), '#!/bin/sh\necho "vdx $*" >> "$STUB_LOG"\necho "$STUB_VERSION"\n', {
      mode: 0o755,
    });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('outside a focused session, or outside tmux, it runs nothing and says nothing', () => {
    expect(run({ VDX_FOCUSED: '', STUB_TOPIC: 'x' }).stdout).toBe('');
    expect(run({ TMUX_PANE: '', STUB_TOPIC: 'x' }).stdout).toBe('');
    expect(calls()).toBe('');
  });

  it('brings the topic on a line of its own — the one vdx reads back from the transcript — and what to do off it', () => {
    const r = run({ STUB_TOPIC: 'релиз 0.41 «тема» $HOME `x`' });
    expect(r.status).toBe(0);
    const text = contextOf(r.stdout);
    expect(text.split('\n')[0]).toBe(topicLine('релиз 0.41 «тема» $HOME `x`'));
    expect(text).toContain('«🎯 off topic «релиз 0.41 «тема» $HOME `x`»»');
    expect(text).toContain(`run \`vdx ai '/projects/it'\\''s mine' --focused "<topic>"\``);
    expect(r.stdout).toContain('"hookEventName":"UserPromptSubmit"');
    expect(calls()).toBe('tmux -u display-message -p -t %7 #{@vdx_topic}\n');
    const file = path.join(dir, `${ID.a}.jsonl`);
    fs.writeFileSync(file, [hookLine(text), userLine('hi')].join('\n') + '\n');
    expect(readConversation(file, new Date())?.topic).toBe('релиз 0.41 «тема» $HOME `x`');
  });

  it('no topic yet: asks the agent to set one — only of a vdx that takes it', () => {
    expect(contextOf(run({ STUB_TOPIC: '', STUB_VERSION: '0.41.0' }).stdout)).toContain(
      '· This focused session has no topic yet',
    );
    for (const version of ['0.40.0', ''])
      expect(run({ STUB_TOPIC: '', STUB_VERSION: version }).stdout, version).toBe('');
  });
});
