import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import YAML from 'js-yaml';
import { evalPredicate } from './evaluator.ts';
import { GIT_HOOK_EVENTS } from './hooks.ts';
import { autoDetectStack, readStructured, resolveConfigPath, type Ctx } from './facts.ts';
import { loadManifestAt } from './manifest.ts';
import { type Author, effectiveAuthor, isGitRepo, rankAuthors, scanPool, writeAuthor } from './author.ts';
import type { Predicate } from './rubric.ts';
import {
  claudeTrusts,
  type Conversation,
  conversationTopic,
  describeConversation,
  describeAge,
  describeLive,
  isMachineLabel,
  LIVE_SESSIONS_SCRIPT,
  type LiveSession,
  claudeConfigDir,
  latestPerMachine,
  listConversations,
  liveConversationId,
  liveSessionsHere,
  liveStartedAt,
  HQ_LINE_PREFIX,
  STARTED_BY_LINE_PREFIX,
  INTERCOM_LINE_PREFIX,
  machineLine,
  type MachineReport,
  machineOf,
  conversationById,
  conversationFiles,
  copyAhead,
  findInConversations,
  isEmpty,
  readConversation,
  liveSessionFile,
  pidAlive,
  typedHere,
  historyMarks,
  isLeftAfterLook,
  joinMarks,
  type HistoryMarks,
  parseMachineReport,
  runsInProject,
  topicLine,
  type TranscriptCopy,
} from './conversations.ts';
import {
  describeMemory,
  fixProjectMemory,
  memoryApplies,
  memoryNeedsFix,
  memoryState,
  personalHosts,
  type PersonalHost,
} from './memory.ts';
import { at, errorMessage, isStringList, str } from './narrow.ts';
import { projectHq, sameDir, type ProjectHq } from './hq.ts';
import { CMUX_TOKEN_ENV_VAR, CMUX_TOKEN_OPTION, cmuxToken, takeCmuxLine, watchTopic } from './cmux.ts';
import {
  TAB_FROM_ENV_VAR,
  TAB_NOW_ENV_VAR,
  type CmuxSnapshot,
  type TabPlan,
  cmuxBeforeStart,
  cmuxCli,
  cmuxJustStarted,
  currentCmux,
  forgetTabRecord,
  foregroundByTty,
  ttyBySurface,
  planTabs,
  readTabRecord,
  readTabRecords,
  returnTabs,
  tabRecordDir,
  targetLabel,
  writeTabRecord,
} from './tabs.ts';
import { type Lag, sessionLag } from './session-versions.ts';
import {
  currentServer,
  forget,
  type LostRecord,
  lostRecords,
  markStays,
  pruneRecords,
  recordedPanes,
  type RecordMode,
  type TmuxServer,
  updateTopic,
  writeRecord,
} from './restore.ts';
import {
  type AgentFact,
  type SessionFact,
  agentLabel,
  type Board,
  clip,
  buildBoard,
  COMMAND_KEY,
  enterKey,
  freeWork,
  inputDraft,
  openAtSeat,
  type Pick,
  quoted,
  readAnswer,
  readPicked,
  settledState,
} from './board.ts';
import { fzfPick, type PickerAnswer, type PickerInput, rowsWidth } from './picker.ts';
import { awaitReach, reach } from './reach.ts';
import { dequeue, enqueue, intercomLimit, lettersSessions, queued } from './intercom-queue.ts';

/**
 * `vdx ai` — start the person's agent in a project, with the flags their
 * profile asks for. vdx runs nothing itself: it builds the agent's command line
 * and hands it to tmux, or runs it in this terminal when tmux is not wanted or
 * not installed.
 *
 * A start continues the project's last conversation (the profile's
 * `resume_args`) — after a reboot `vdx ai` brings the agent back where it was;
 * `--new` starts a new conversation. For Claude Code vdx picks the
 * conversation itself, and continues another machine's on that machine
 * (see chooseConversation).
 *
 * The profile is personal (which agent, which permissions), so it is never
 * bundled into the CLI: it is read from `$VDX_ENVIRONMENT` or
 * `~/.vdx-environment.yaml`. Without one, vdx starts a plain `claude` or
 * `codex` with no flags. @see docs/specs/environment-format.md
 */

/** A prompt a conditional flag is known to cause, and the tmux keys that answer it. */
interface ConfirmRule {
  screen: string;
  keys: string[];
}

interface WhenRule {
  id: string;
  description?: string;
  if: Predicate;
  args?: string[];
  confirm?: ConfirmRule[];
  /** The rule is there to wake the agent: a focused session (`vdx ai --focused`) leaves it out. */
  wakes?: boolean;
  /** The rule holds only in this kind of session (0.67): `vdx ai --hq`, `--intercom` or `--focused`. */
  session?: SessionKind;
}

/** The kinds of session a `when` rule can be limited to (`session:`). */
const SESSION_KINDS = ['hq', 'intercom', 'focused'] as const;
type SessionKind = (typeof SESSION_KINDS)[number];

export interface AgentProfile {
  command: string;
  args?: string[];
  resume_args?: string[];
  /** What an intercom session (`vdx ai --intercom`) starts with, right after the command: its first prompt. */
  intercom_args?: string[];
  /** What an HQ session (`vdx ai --hq`) starts with, right after the command: its first prompt. */
  hq_args?: string[];
  when?: WhenRule[];
}

type Multiplexer = 'tmux' | 'none';

/** A place a project's short name may come from: a structured file and a dot path into it. */
export interface NameSource {
  /** `{repo}` is the repository name; `~` the home directory; relative to the profile's directory. */
  file: string;
  jsonpath: string;
}

interface SessionProfile {
  multiplexer?: Multiplexer;
  name?: string;
  /** Tried after `[_.vdx] name` (or the older `[vdx]`) in the project's mise.toml; the first non-empty string wins. */
  project_names?: NameSource[];
  /** The machines a project's agent may run on, as ssh destinations; vdx asks the others what runs there. */
  machines?: string[];
  /** A machine's mark on the list of `vdx ai`, before its label — the one the cmux sidebar shows for it. */
  machine_icons?: Record<string, string>;
  /** What to do when a session cannot read ~/Downloads, ~/Desktop or ~/Documents (macOS): shown after the warning. */
  folders_fix?: string;
  /**
   * Skills that end a conversation (`vdm:wrap`): run, and nothing typed after, the list calls it
   * finished, and Enter passes it by (vdx-ai-predictable DL #3).
   */
  wrap_skills?: string[];
  /**
   * A project where `vdx ai` brings back every agent a fallen tmux server took down, not only the
   * project's own — the one the person's day starts in (vdx-ai-predictable DL #4): a rubric predicate.
   */
  restore_all?: Predicate;
}

/**
 * A personal hook: the owner's own gate, kept in git's user config
 * (`hook.<name>.event` / `.command`, Git 2.54) instead of in every repository.
 * `vdx doctor` checks it is there, `vdx doctor --fix` writes it.
 */
/**
 * Events git does not fire itself: a step runs them with `git hook run --allow-unknown-hook-name
 * --ignore-missing <event>` (git 2.54+), and the profile says what runs there. `pre-commit-line` —
 * git-guard's commit line, before its `git commit`: the wait for the other machine's branch
 * (vdx-push-waits DL #2).
 */
const LINE_HOOK_EVENTS: ReadonlySet<string> = new Set(['pre-commit-line']);

export interface PersonalHook {
  name: string;
  /** Git hook event(s): `pre-commit`, …, or one of LINE_HOOK_EVENTS. */
  event: string | string[];
  /** Run by git through the shell; `$HOME` and quotes work as in a hook script. */
  command: string;
  /** The hook applies on a machine where this path exists (the tool is installed); `~` is home. */
  when_exists?: string;
  description?: string;
}

interface GitProfile {
  /** Directories whose repos are the neighbours an author is proposed from; default — the project's parent. */
  author_pool?: string[];
  hooks?: PersonalHook[];
  /**
   * Hosts whose repos are the owner's alone, and where their repos are mirrored: Claude Code's
   * memory goes under git only where nobody else reads (claude-memory-in-project).
   */
  personal_hosts?: Array<string | { host: string; mirrors?: string[] }>;
}

/**
 * A command `vdx move` runs here once a project's folder has moved, for a tool that
 * keeps the project's path in its own files (claude-memory-in-project DL #17).
 */
export interface MoveHook {
  name: string;
  /** Run through the shell, with VDX_MOVE_FROM and VDX_MOVE_TO set to the old and new path. */
  command: string;
  /** Runs on a machine where this path exists (the tool is installed); `~` is home. */
  when_exists?: string;
  description?: string;
}

interface MoveProfile {
  after?: MoveHook[];
  /** `vdx take` puts projects here: the desk, laid out by name and the owner's groups (`~` is home). */
  desk?: string;
  /** The shelf: every clone, by `<host>/<path from the remote>`; `vdx shelve` puts a project back here. */
  shelf?: string;
}

export interface Environment {
  schema_version?: string;
  metadata?: Record<string, unknown>;
  agent?: AgentProfile;
  session?: SessionProfile;
  git?: GitProfile;
  move?: MoveProfile;
}

const ENVIRONMENT_ENV_VAR = 'VDX_ENVIRONMENT';
const HOST_ENV_VAR = 'VDX_HOST';
/** Set by `vdx ai@<host>` for the vdx it starts there: the machine the person sits at. */
const SEAT_ENV_VAR = 'VDX_AI_FROM';
/**
 * Set for the `vdx ai --restart` a session hands its own restart to: the pane to restart. Run inside
 * that pane, vdx would go down with it (vdx-ai-predictable Sidetrack #9).
 */
const RESTART_PANE_ENV_VAR = 'VDX_AI_RESTART_PANE';
/**
 * `1` in the environment of an agent started with `vdx ai --focused`, and so of
 * its hooks and MCP servers: nothing wakes this session or reads its inbox for it.
 */
const FOCUSED_ENV_VAR = 'VDX_FOCUSED';
/**
 * `1` in the environment of the project's intercom session (`vdx ai --intercom`): the
 * session letters and wakes go to, so that the person's own session stays quiet.
 * Nobody sits at it; it ends itself with `vdx ai --close`.
 */
const INTERCOM_ENV_VAR = 'VDX_INTERCOM';
/** `1` for a start the queue of intercom sessions makes (intercom-queue.ts): it moves the queue no further. */
const INTERCOM_QUEUED_ENV_VAR = 'VDX_INTERCOM_QUEUED';
/** The intercom session closing as a queued start begins: its place is the one taken, so it is not counted. */
const INTERCOM_FREEING_ENV_VAR = 'VDX_INTERCOM_FREEING';
/**
 * `1` in the environment of the project's HQ session (`vdx ai --hq`): the session for what comes
 * from outside, so that the person's working sessions stay quiet. The person sits at it and keeps
 * it running (hq-session-mode DL #1).
 */
const HQ_ENV_VAR = 'VDX_HQ';
/**
 * In the environment of the tmux client `vdx ai` attaches: the seat — the machine the person
 * sits at — so that another start can tell a terminal at the same seat from one at another
 * (vdx-ai-predictable DL #2). tmux does not copy it into the session's environment.
 */
const SEAT_MARK_ENV_VAR = 'VDX_AI_SEAT';
/** The tmux session option `vdx ai --close --waiting <n>` sets: questions to the person still unanswered. */
const WAITING_OPTION = '@vdx_waiting';
/**
 * The tmux session option with a focused session's topic (focused-topic DL #2): set by `vdx ai`
 * at a start and by the session's own agent; read by the terminal's title, the vdx plugin's
 * prompt hook and intercom. Every agent has a tmux session of its own (vdx-ai DL #36).
 */
const TOPIC_OPTION = '@vdx_topic';
/**
 * The tmux session option with what the agent's transcript says of it: `empty` or `finished`, the
 * words of the list (board.ts `settledState`); unset — neither. Set by the vdx plugin's hooks —
 * SessionStart (`--check`) and Stop (`--state`) — and unset when a prompt goes in and when the
 * session ends; read by the cmux sidebar, whose contract with nas-info names exactly these two
 * values (vdx-ai-predictable Sidetrack #4).
 */
export const STATE_OPTION = '@vdx_state';
/**
 * On the intercom session the person started or attached to from a terminal: it stays until they
 * end it, and `vdx ai --close` leaves its pane (intercom-session-mode DL #10). One a letter started
 * (`--detach`) has no mark and ends itself.
 */
const STAYS_OPTION = '@vdx_stays';
/** An intercom session's pane closes this long after `--close`, so the call returns and the turn ends. */
const CLOSE_DELAY_S = 2;
/** How often a terminal whose tmux server fell looks for its session to come back. */
const REATTACH_POLL_MS = 2_000;
const USER_ENVIRONMENT_FILE = '.vdx-environment.yaml';
/** Tried in order when no profile names an agent. Started plain, with no flags. */
const FALLBACK_AGENTS = ['claude', 'codex'] as const;
const DEFAULT_SESSION_NAME = '{project}';

export function resolveEnvironmentPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string | null {
  const explicit = env[ENVIRONMENT_ENV_VAR];
  if (explicit) return path.resolve(explicit.replace(/^~(?=$|\/)/, home));
  const user = path.join(home, USER_ENVIRONMENT_FILE);
  return fs.existsSync(user) ? user : null;
}

/** Parse and validate a profile. Throws with the offending key named. */
export function parseEnvironment(text: string, source: string): Environment {
  const data: unknown = YAML.load(text);
  if (data === null || data === undefined) return {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${source}: expected a YAML mapping at the top level`);
  }
  const envDoc = data as Environment;
  const fail = (key: string, what: string): never => {
    throw new Error(`${source}: ${key} ${what}`);
  };

  const agent = envDoc.agent;
  if (agent !== undefined) {
    if (typeof agent !== 'object' || agent === null) fail('agent', 'must be a mapping');
    if (typeof agent.command !== 'string' || agent.command.trim() === '') {
      fail('agent.command', 'must be a non-empty string');
    }
    for (const key of ['args', 'resume_args', 'intercom_args', 'hq_args'] as const) {
      if (agent[key] !== undefined && !isStringList(agent[key])) {
        fail(`agent.${key}`, 'must be a list of strings');
      }
    }
    if (agent.when !== undefined) {
      if (!Array.isArray(agent.when)) fail('agent.when', 'must be a list');
      agent.when.forEach((rule, i) => {
        const at = `agent.when[${i}]`;
        if (typeof rule !== 'object' || rule === null) fail(at, 'must be a mapping');
        if (typeof rule.id !== 'string' || rule.id === '') fail(`${at}.id`, 'must be a non-empty string');
        if (rule.if === undefined) fail(`${at}.if`, 'is required (a rubric predicate)');
        if (rule.args !== undefined && !isStringList(rule.args)) {
          fail(`${at}.args`, 'must be a list of strings');
        }
        if (rule.wakes !== undefined && typeof rule.wakes !== 'boolean') fail(`${at}.wakes`, 'must be true or false');
        if (rule.session !== undefined && !(SESSION_KINDS as readonly unknown[]).includes(rule.session)) {
          fail(`${at}.session`, `must be one of ${SESSION_KINDS.join(', ')}`);
        }
        if (rule.confirm !== undefined) {
          if (!Array.isArray(rule.confirm)) fail(`${at}.confirm`, 'must be a list');
          rule.confirm.forEach((c, j) => {
            const cat = `${at}.confirm[${j}]`;
            if (typeof c?.screen !== 'string' || c.screen === '') {
              fail(`${cat}.screen`, 'must be a non-empty string');
            }
            if (!isStringList(c.keys) || c.keys.length === 0) {
              fail(`${cat}.keys`, 'must be a non-empty list of tmux key names');
            }
          });
        }
      });
    }
  }

  const session = envDoc.session;
  if (session !== undefined) {
    if (typeof session !== 'object' || session === null) fail('session', 'must be a mapping');
    if (session.multiplexer !== undefined && !['tmux', 'none'].includes(session.multiplexer)) {
      fail('session.multiplexer', 'must be "tmux" or "none"');
    }
    if (session.name !== undefined && typeof session.name !== 'string') {
      fail('session.name', 'must be a string');
    }
    if (session.project_names !== undefined) {
      if (!Array.isArray(session.project_names)) fail('session.project_names', 'must be a list');
      session.project_names.forEach((src, i) => {
        const at = `session.project_names[${i}]`;
        if (typeof src !== 'object' || src === null) fail(at, 'must be a mapping');
        if (typeof src.file !== 'string' || src.file === '') fail(`${at}.file`, 'must be a non-empty string');
        const unknown = src.file.match(/\{(?!repo\})\w+\}/);
        if (unknown) fail(`${at}.file`, `has an unknown placeholder ${unknown[0]} (only {repo})`);
        if (typeof src.jsonpath !== 'string' || src.jsonpath === '') {
          fail(`${at}.jsonpath`, 'must be a non-empty string (a dot path, e.g. names.0)');
        }
      });
    }
    if (session.machines !== undefined) {
      if (!isStringList(session.machines)) fail('session.machines', 'must be a list of machine names');
      session.machines.forEach((m, i) => {
        if (!isMachineLabel(m))
          fail(`session.machines[${i}]`, 'must be an ssh destination: letters, digits, . _ - and no leading -');
      });
    }
    if (session.machine_icons !== undefined) {
      const icons: unknown = session.machine_icons;
      if (typeof icons !== 'object' || icons === null || Array.isArray(icons))
        fail('session.machine_icons', 'must be a mapping of machine names to marks');
      for (const [m, icon] of Object.entries(icons as Record<string, unknown>)) {
        if (!isMachineLabel(m))
          fail(
            `session.machine_icons.${m}`,
            'must be keyed by a machine name: letters, digits, . _ - and no leading -',
          );
        if (typeof icon !== 'string' || icon.trim() === '' || /\s/.test(icon) || [...icon].length > 4)
          fail(`session.machine_icons.${m}`, 'must be a short mark: up to 4 characters, no spaces');
      }
    }
    if (
      session.folders_fix !== undefined &&
      (typeof session.folders_fix !== 'string' || session.folders_fix.trim() === '')
    ) {
      fail('session.folders_fix', 'must be a non-empty string');
    }
    if (session.wrap_skills !== undefined && !isStringList(session.wrap_skills)) {
      fail('session.wrap_skills', 'must be a list of skill names');
    }
    if (
      session.restore_all !== undefined &&
      (typeof session.restore_all !== 'object' || session.restore_all === null || Array.isArray(session.restore_all))
    ) {
      fail('session.restore_all', 'must be a rubric predicate (has_file: …)');
    }
  }

  const gitDoc = envDoc.git;
  if (gitDoc !== undefined) {
    if (typeof gitDoc !== 'object' || gitDoc === null) fail('git', 'must be a mapping');
    if (gitDoc.author_pool !== undefined && !isStringList(gitDoc.author_pool)) {
      fail('git.author_pool', 'must be a list of directories');
    }
    if (gitDoc.personal_hosts !== undefined) {
      if (!Array.isArray(gitDoc.personal_hosts)) fail('git.personal_hosts', 'must be a list');
      // `*.<domain>` — every host under it; a star anywhere else matches nothing and is refused.
      const wildcard = (host: string, at: string) => {
        if (host.includes('*') && !/^\*\.[^*\s.]+(\.[^*\s.]+)+$/.test(host))
          fail(at, 'a star stands only as the first part of *.<domain>, with two parts after it at least');
      };
      gitDoc.personal_hosts.forEach((h, i) => {
        const at = `git.personal_hosts[${i}]`;
        if (typeof h === 'string') {
          if (h.trim() === '') fail(at, 'must be a host name');
          wildcard(h, at);
          return;
        }
        if (typeof h !== 'object' || h === null || typeof h.host !== 'string' || h.host.trim() === '') {
          fail(at, 'must be a host name, or a mapping with host');
        }
        wildcard(h.host, `${at}.host`);
        if (h.mirrors !== undefined && (!isStringList(h.mirrors) || !h.mirrors.every((m) => m.includes('{repo}')))) {
          fail(`${at}.mirrors`, 'must be a list of places like github.com/<owner>/{repo}');
        }
      });
    }
    if (gitDoc.hooks !== undefined) {
      if (!Array.isArray(gitDoc.hooks)) fail('git.hooks', 'must be a list');
      const names = new Set<string>();
      gitDoc.hooks.forEach((h, i) => {
        const at = `git.hooks[${i}]`;
        if (typeof h !== 'object' || h === null) fail(at, 'must be a mapping');
        if (typeof h.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(h.name)) {
          fail(`${at}.name`, 'must be a name of letters, digits, . _ - (the git config subsection)');
        }
        if (names.has(h.name)) fail(`${at}.name`, `"${h.name}" is declared twice`);
        names.add(h.name);
        const events = Array.isArray(h.event) ? h.event : [h.event];
        const known = (e: unknown) => typeof e === 'string' && (GIT_HOOK_EVENTS.has(e) || LINE_HOOK_EVENTS.has(e));
        if (events.length === 0 || !events.every(known)) {
          fail(
            `${at}.event`,
            `must be a git hook event (pre-commit, pre-push, …), ${[...LINE_HOOK_EVENTS].join(', ')}, or a list of them`,
          );
        }
        if (typeof h.command !== 'string' || h.command.trim() === '')
          fail(`${at}.command`, 'must be a non-empty string');
        if (h.when_exists !== undefined && (typeof h.when_exists !== 'string' || h.when_exists === '')) {
          fail(`${at}.when_exists`, 'must be a path');
        }
      });
    }
  }

  const moveDoc = envDoc.move;
  if (moveDoc !== undefined) {
    if (typeof moveDoc !== 'object' || moveDoc === null || Array.isArray(moveDoc)) fail('move', 'must be a mapping');
    for (const key of ['desk', 'shelf'] as const)
      if (moveDoc[key] !== undefined && (typeof moveDoc[key] !== 'string' || moveDoc[key].trim() === ''))
        fail(`move.${key}`, 'must be a path');
    if (moveDoc.after !== undefined) {
      if (!Array.isArray(moveDoc.after)) fail('move.after', 'must be a list');
      moveDoc.after.forEach((h, i) => {
        const at = `move.after[${i}]`;
        if (typeof h !== 'object' || h === null) fail(at, 'must be a mapping');
        if (typeof h.name !== 'string' || h.name.trim() === '') fail(`${at}.name`, 'must be a non-empty string');
        if (typeof h.command !== 'string' || h.command.trim() === '')
          fail(`${at}.command`, 'must be a non-empty string');
        if (h.when_exists !== undefined && (typeof h.when_exists !== 'string' || h.when_exists === '')) {
          fail(`${at}.when_exists`, 'must be a path');
        }
      });
    }
  }
  return envDoc;
}

export function loadEnvironment(file: string): Environment {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`cannot read profile ${file}: ${str(at(e, 'code')) ?? errorMessage(e)}`, { cause: e });
  }
  return parseEnvironment(text, file);
}

export function fallbackAgent(onPath: (bin: string) => boolean): AgentProfile | null {
  const found = FALLBACK_AGENTS.find((bin) => onPath(bin));
  return found ? { command: found } : null;
}

/**
 * tmux turns `.` and `:` in a session name into `_`; doing it here keeps the
 * name vdx looks up equal to the name tmux stores.
 */
export function renderSessionName(template: string, vars: Record<string, string>): string {
  const name = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = vars[key];
    if (v === undefined) throw new Error(`session.name: unknown placeholder {${key}}`);
    return v;
  });
  return name.replace(/[.:]/g, '_');
}

/**
 * The session for an agent started next to running ones: `name`, `name-2`, `name-3`… — the
 * first no agent of the project runs in (absent, or a shell left behind) and no other terminal
 * shows (`viewed`). Each agent has a session of its own: tmux keeps one current window per
 * session, and an agent started as a window next to another moved every terminal on the session
 * to it (vdx-ai DL #36). A session with no agent of the project here may still be on someone's
 * screen — ssh to an agent on another machine in its windows (vdx-ai-predictable Sidetrack #13).
 */
export function freeSessionName(
  name: string,
  running: { pane: { session: string } }[],
  viewed: ReadonlySet<string> = new Set(),
): string {
  const busy = new Set([...running.map((a) => a.pane.session), ...viewed]);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name}-${n}`;
    if (!busy.has(candidate)) return candidate;
  }
}

export interface LaunchPlan {
  projectRoot: string;
  project: string;
  /** Where `project` came from: mise.toml, a profile source, or the repository name. */
  projectSource: string;
  host: string;
  /** The machine the person sits at: `host`, or the one that ran `vdx ai@<host>`. */
  seat: string;
  profilePath: string | null;
  command: string;
  /** agent.args plus the args of every matched `when` rule — what a running agent must carry. */
  args: string[];
  resumeArgs: string[];
  matched: string[];
  /** `vdx ai --focused`: the agent gets VDX_FOCUSED=1, and the rules that wake it are left out. */
  focused: boolean;
  /** Matched rules a focused session leaves out (`wakes: true`). */
  skipped: string[];
  /** `vdx ai --intercom`: the project's intercom session — VDX_INTERCOM=1, a session `<name>-intercom`. */
  intercom: boolean;
  /** `vdx ai --hq`: the project's HQ session — VDX_HQ=1, a session `<name>-hq`. */
  hq: boolean;
  /**
   * What a new conversation of this session opens with, right after the command: agent.intercom_args,
   * agent.hq_args, a topic named with --focused. Not required of a running agent.
   */
  opening: string[];
  confirm: ConfirmRule[];
  multiplexer: Multiplexer;
  sessionName: string;
  /** The profile's other machines — asked over ssh what runs there before a start. */
  machines: string[];
}

export function planLaunch(input: {
  environment: Environment;
  profilePath: string | null;
  agent: AgentProfile;
  projectRoot: string;
  project: string;
  projectSource?: string;
  host: string;
  seat?: string;
  focused?: boolean;
  intercom?: boolean;
  hq?: boolean;
}): LaunchPlan {
  const { environment, agent, projectRoot } = input;
  const focused = input.focused === true;
  const intercom = input.intercom === true && !focused;
  const hq = input.hq === true && !focused && !intercom;
  const ctx: Ctx = { projectRoot, stack: autoDetectStack(projectRoot), cache: new Map() };
  const args = [...(agent.args ?? [])];
  const matched: string[] = [];
  const skipped: string[] = [];
  const confirm: ConfirmRule[] = [];
  const kind: SessionKind | null = focused ? 'focused' : intercom ? 'intercom' : hq ? 'hq' : null;
  for (const rule of agent.when ?? []) {
    // A rule of another kind of session does not hold here, as a false `if` does not: nothing to leave out.
    if (rule.session !== undefined && rule.session !== kind) continue;
    if (!evalPredicate(rule.if, ctx)) continue;
    if (focused && rule.wakes) {
      skipped.push(rule.id);
      continue;
    }
    matched.push(rule.id);
    args.push(...(rule.args ?? []));
    confirm.push(...(rule.confirm ?? []));
  }
  return {
    projectRoot,
    project: input.project,
    projectSource: input.projectSource ?? 'repository name',
    host: input.host,
    seat: input.seat ?? input.host,
    profilePath: input.profilePath,
    command: agent.command,
    args: mergeSettings(args),
    resumeArgs: [...(agent.resume_args ?? [])],
    matched,
    focused,
    skipped,
    intercom,
    hq,
    opening: intercom ? [...(agent.intercom_args ?? [])] : hq ? [...(agent.hq_args ?? [])] : [],
    confirm,
    multiplexer: environment.session?.multiplexer ?? 'none',
    sessionName:
      renderSessionName(environment.session?.name ?? DEFAULT_SESSION_NAME, {
        project: input.project,
        host: input.host,
      }) + (intercom ? '-intercom' : hq ? '-hq' : ''),
    machines: (environment.session?.machines ?? []).filter((m) => m.toLowerCase() !== input.host.toLowerCase()),
  };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function mergeObjects(into: Record<string, unknown>, from: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(from)) {
    const was = into[key];
    into[key] = isPlainObject(was) && isPlainObject(value) ? mergeObjects({ ...was }, value) : value;
  }
  return into;
}

/**
 * Two `--settings` in one start: Claude Code takes the last and drops the rest silently (2.1.331 on lft,
 * 2026-11-24: a rule's `enabledPlugins`, then `idleCompaction` of another — the plugin came back). So the JSON
 * values of every `--settings` (and `--settings=`) become one, where the first stood: objects merge key by key,
 * and for one key set twice the later wins — agent.args, then the rules in the profile's order. A value that is
 * no JSON object (a file's path) stays as it is; one JSON value alone is not rewritten, so a running agent still
 * carries it as the profile says (hq-session-mode Sidetrack #6).
 */
export function mergeSettings(args: string[]): string[] {
  const at: { i: number; width: 1 | 2; value: Record<string, unknown> }[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const inline = a.startsWith('--settings=') ? a.slice('--settings='.length) : null;
    const raw = inline ?? (a === '--settings' ? args[i + 1] : undefined);
    if (raw === undefined) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
    if (isPlainObject(value)) at.push({ i, width: inline === null ? 2 : 1, value });
    if (inline === null) i++;
  }
  if (at.length < 2) return args;
  const merged = at.reduce<Record<string, unknown>>((acc, s) => mergeObjects(acc, s.value), {});
  const drop = new Set(at.slice(1).flatMap((s) => (s.width === 2 ? [s.i, s.i + 1] : [s.i])));
  const first = at[0]!;
  return args.flatMap((a, i) => {
    if (drop.has(i)) return [];
    if (i === first.i) return ['--settings', JSON.stringify(merged)];
    if (first.width === 2 && i === first.i + 1) return [];
    return [a];
  });
}

/**
 * One word for sh and zsh alike. `=` leads a word only in quotes: zsh expands a bare `=word` to the
 * path of the command `word` (`tmux attach -t =arch@lft` → «zsh: arch@lft not found», space-hq 2026-11-05).
 */
export function shellQuote(s: string): string {
  if (s !== '' && /^[A-Za-z0-9_/.:@%+,-][A-Za-z0-9_/.:@%+=,-]*$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function commandLine(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(' ');
}

/**
 * The pane runs the agent inside the user's login shell, so the agent sees what
 * `.zshrc` sets up exactly as when it is typed by hand; the tmux server's own
 * environment does not have it. When the agent exits, the pane keeps a shell —
 * unless `keepShell` is false (an intercom session: its tab goes when it is done).
 * `-i` runs `.zshrc`, where oh-my-zsh may ask about an update and wait: nobody may be at the
 * pane, so it is told not to ask.
 */
/**
 * The pane's command: the agent in a login shell, which stays open after it quits. The shell left
 * looks like a terminal's own, and a `vdx ai@<host>` typed there opened another tmux inside this one
 * (nas-info, ai-peer-inside-tmux-nests): a line says where the pane is first.
 */
export function tmuxShellCommand(line: string, shell: string | null, keepShell = true): string {
  if (!shell) return line;
  const sh = shellQuote(shell);
  const said = `printf '\\n[vdx] the agent quit: this pane is tmux session %s; detach: Ctrl-B d\\n' "$(tmux display-message -p '#S')"`;
  return `exec env DISABLE_AUTO_UPDATE=true ${sh} -lic ${shellQuote(keepShell ? `${line}; ${said}; exec ${sh} -l` : line)}`;
}

export interface PaneInfo {
  session: string;
  paneId: string;
  panePid: number;
  cwd: string;
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  args: string;
}

const PANE_FORMAT = '#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_path}';

export function parsePanes(out: string): PaneInfo[] {
  const panes: PaneInfo[] = [];
  for (const line of out.split('\n')) {
    const [session, paneId, pid, cwd] = line.split('\t');
    if (!session || !paneId || !pid || cwd === undefined) continue;
    panes.push({ session, paneId, panePid: Number(pid), cwd });
  }
  return panes;
}

export function parsePs(out: string): ProcInfo[] {
  const procs: ProcInfo[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3]!.trim() });
  }
  return procs;
}

/** `pid` itself and everything below it. */
export function processTree(procs: ProcInfo[], pid: number): ProcInfo[] {
  const byParent = new Map<number, ProcInfo[]>();
  for (const p of procs) {
    const list = byParent.get(p.ppid) ?? [];
    list.push(p);
    byParent.set(p.ppid, list);
  }
  const tree: ProcInfo[] = [];
  const self = procs.find((p) => p.pid === pid);
  if (self) tree.push(self);
  const queue = [pid];
  while (queue.length > 0) {
    for (const child of byParent.get(queue.shift()!) ?? []) {
      tree.push(child);
      queue.push(child.pid);
    }
  }
  return tree;
}

const INTERPRETERS = new Set(['node', 'bun', 'deno', 'python', 'python3', 'ruby', 'sh', 'bash', 'zsh', 'dash']);

/** Is this process the agent — run directly, or as a script under an interpreter? */
export function isAgentProcess(proc: ProcInfo, command: string): boolean {
  const want = path.basename(command);
  const [first, second] = proc.args.split(/\s+/);
  if (!first) return false;
  if (path.basename(first) === want) return true;
  return INTERPRETERS.has(path.basename(first)) && !!second && path.basename(second) === want;
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

export interface AgentPane {
  pane: PaneInfo;
  proc: ProcInfo;
}

/**
 * The project's running agent is found by what runs, not by session name: a
 * pane whose working directory lies in the project, with the agent below it.
 */
export function findAgentPanes(
  panes: PaneInfo[],
  procs: ProcInfo[],
  projectRoot: string,
  command: string,
): AgentPane[] {
  const root = realpathOr(projectRoot);
  const found: AgentPane[] = [];
  for (const pane of panes) {
    if (!isInside(realpathOr(pane.cwd), root)) continue;
    const proc = processTree(procs, pane.panePid).find((p) => isAgentProcess(p, command));
    if (proc) found.push({ pane, proc });
  }
  return found;
}

/** Required args absent from a process's command line (`ps` joins argv with spaces). */
export function missingArgs(procArgs: string, required: string[]): string[] {
  const tokens = new Set(procArgs.split(/\s+/));
  return required.filter((a) => (/\s/.test(a) ? !procArgs.includes(a) : !tokens.has(a)));
}

/** The git checkout `p` is in (its top), else the directory itself; null when `p` is no directory. */
export function resolveProjectRoot(p: string): string | null {
  const abs = path.resolve(p);
  try {
    if (!fs.statSync(abs).isDirectory()) return null;
  } catch {
    return null;
  }
  try {
    const top = execFileSync('git', ['-C', abs, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (top) return realpathOr(top);
  } catch {
    /* not a git checkout — the directory itself is the project */
  }
  return realpathOr(abs);
}

/** `{project}`: the origin remote's repository name, else the directory name. */
export function projectIdentity(projectRoot: string): string {
  try {
    const url = execFileSync('git', ['-C', projectRoot, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const slug = url
      .replace(/\/+$/, '')
      .replace(/\.git$/, '')
      .split(/[/:]/)
      .pop();
    if (slug) return slug.toLowerCase();
  } catch {
    /* no git or no origin */
  }
  return path.basename(projectRoot);
}

export interface ProjectName {
  name: string;
  source: string;
}

/**
 * `{project}`: `[_.vdx] name` (or the older `[vdx]`) in the project's mise.toml, else the first profile
 * source holding a non-empty string, else the repository name. A source that is
 * missing or unreadable is skipped — a name is a label, not a reason to fail.
 */
export function resolveProjectName(input: {
  projectRoot: string;
  repo: string;
  sources: NameSource[];
  home: string;
  profileDir: string;
}): ProjectName {
  const found = loadManifestAt(input.projectRoot);
  const own = found?.manifest.name;
  if (typeof own === 'string' && own.trim()) return { name: own.trim(), source: `mise.toml [${found!.place}] name` };
  for (const src of input.sources) {
    const file = path.resolve(
      input.profileDir,
      src.file.replace(/^~(?=$|\/)/, input.home).replace(/\{repo\}/g, input.repo),
    );
    // Readers take paths relative to a project root; from "/" an absolute path stays itself.
    const value = resolveConfigPath(
      readStructured({ projectRoot: '/', stack: '', cache: new Map() }, file),
      src.jsonpath,
    );
    if (typeof value === 'string' && value.trim()) {
      const shown = file.startsWith(input.home + path.sep) ? `~${file.slice(input.home.length)}` : file;
      return { name: value.trim(), source: `${shown} ${src.jsonpath}` };
    }
  }
  return { name: input.repo, source: 'repository name' };
}

/** `{host}`: `$VDX_HOST` when set (a machine label such as `lft`), else the short hostname. */
export function hostLabel(env: NodeJS.ProcessEnv = process.env): string {
  const label = env[HOST_ENV_VAR]?.trim();
  return label || os.hostname().split('.')[0]!;
}

/** The machine the person sits at: the one whose `vdx ai@<host>` started this vdx, else this one. */
function seatLabel(env: NodeJS.ProcessEnv = process.env): string {
  return env[SEAT_ENV_VAR]?.trim() || hostLabel(env);
}

/** Machine labels compare without case: `M3` in the profile is `m3` in a transcript. */
function sameMachine(a: string | null, b: string | null): boolean {
  return (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
}

export function onPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}

export function listProcesses(): ProcInfo[] {
  // -A (all processes) means the same on macOS and Linux; -e does not.
  return parsePs(execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' }));
}

/** How a process finds out which terminal device it has: as `ps` names it, and the device numbers. */
export interface TerminalProbe {
  /** The device number of an open descriptor; null — not a device, or closed. */
  rdev: (fd: number) => number | null;
  /** The device number of `/dev/tty`, the alias of every process's controlling terminal. */
  aliasRdev: () => number | null;
  /** The controlling terminal's own device, `/dev/ttysNNN`; null — none. */
  device: () => string | null;
}

const terminalProbe: TerminalProbe = {
  rdev: (fd) => {
    try {
      return fs.fstatSync(fd).rdev || null;
    } catch {
      return null;
    }
  },
  aliasRdev: () => {
    try {
      return fs.statSync('/dev/tty').rdev || null;
    } catch {
      return null;
    }
  },
  device: () => {
    // `ps -o tty=` reads the same on macOS of either architecture and on Linux: `ttys010`, `pts/3`; `??` — none.
    const name = spawnSync('ps', ['-o', 'tty=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout?.trim();
    return name && !name.startsWith('?') ? (name.startsWith('/') ? name : `/dev/${name}`) : null;
  },
};

/**
 * The stdio of a tmux client. tmux names its terminal by stdin and refuses `/dev/tty`: a caller that hands
 * vdx `</dev/tty` (the nas-info zsh block for `--tab`, 2026-11-12) left every attach at «open terminal
 * failed: can't use /dev/tty» (restore-after-any-crash DL #1, lft x86_64 and m3 arm64 alike). A descriptor
 * on that alias is given the terminal's own device instead; null — nothing to change.
 */
export function clientStdio(
  probe: TerminalProbe = terminalProbe,
): { stdio: ('inherit' | number)[]; close: () => void } | null {
  const alias = probe.aliasRdev();
  if (alias === null) return null;
  const onAlias = [0, 1, 2].map((fd) => probe.rdev(fd) === alias);
  if (!onAlias[0] && !onAlias[1]) return null;
  const device = probe.device();
  if (!device) return null;
  let fd: number;
  try {
    fd = fs.openSync(device, 'r+');
  } catch {
    return null;
  }
  return {
    stdio: onAlias.map((a) => (a ? fd : 'inherit')),
    close: () => {
      try {
        fs.closeSync(fd);
      } catch {
        // closed already
      }
    },
  };
}

export class Tmux {
  constructor(private readonly socket: string | null = null) {}

  /** `-L <name>`: the server's socket name; null — the default server. */
  get socketName(): string | null {
    return this.socket;
  }

  private argv(args: string[]): string[] {
    return this.socket ? ['-L', this.socket, ...args] : args;
  }

  available(): boolean {
    try {
      execFileSync('tmux', ['-V'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * `-u`: outside tmux and without a UTF-8 locale (`ssh host vdx ai`, launchd)
   * tmux prints the tabs of PANE_FORMAT as `_`, and every pane would be
   * dropped — the running agent unseen, a second one started.
   */
  run(args: string[]): string {
    return execFileSync('tmux', ['-u', ...this.argv(args)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  tryRun(args: string[]): string | null {
    try {
      return this.run(args);
    } catch {
      return null;
    }
  }

  /** Every pane on the server; none when no server is running. */
  panes(): PaneInfo[] {
    const out = this.tryRun(['list-panes', '-a', '-F', PANE_FORMAT]);
    return out ? parsePanes(out) : [];
  }

  hasSession(name: string): boolean {
    return this.tryRun(['has-session', '-t', `=${name}`]) !== null;
  }

  newSession(name: string, cwd: string, cmd: string): string {
    return this.run(['new-session', '-d', '-s', name, '-c', cwd, '-P', '-F', '#{pane_id}', cmd]).trim();
  }

  newWindow(session: string, cwd: string, cmd: string): string {
    return this.run(['new-window', '-d', '-t', `=${session}:`, '-c', cwd, '-P', '-F', '#{pane_id}', cmd]).trim();
  }

  respawn(paneId: string, cwd: string, cmd: string): void {
    this.run(['respawn-pane', '-k', '-t', paneId, '-c', cwd, cmd]);
  }

  /** Visible screen with wrapped lines joined, so a matched phrase is not split by the pane width. */
  capture(paneId: string): string | null {
    return this.tryRun(['capture-pane', '-p', '-J', '-t', paneId]);
  }

  /** The visible screen with its escapes: what is dim on it can be told apart (board.ts, inputDraft). */
  screen(paneId: string): string | null {
    return this.tryRun(['capture-pane', '-p', '-e', '-t', paneId]);
  }

  /** The terminals attached to the server: each one's session, its tmux client process and its terminal. */
  clients(): { session: string; pid: number; tty?: string }[] {
    const out = this.tryRun(['list-clients', '-F', '#{client_session}\t#{client_pid}\t#{client_tty}']);
    return (out ?? '').split('\n').flatMap((line) => {
      const [session, pid, tty] = line.split('\t');
      return session && pid && /^\d+$/.test(pid) ? [{ session, pid: Number(pid), ...(tty ? { tty } : {}) }] : [];
    });
  }

  sendKey(paneId: string, key: string): void {
    this.run(['send-keys', '-t', paneId, key]);
  }

  panePid(paneId: string): number | null {
    const out = this.tryRun(['display-message', '-p', '-t', paneId, '#{pane_pid}']);
    const pid = out ? Number(out.trim()) : NaN;
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  }

  /** Make the pane its session's current window and pane, so attaching lands on it. */
  focus(paneId: string): void {
    this.tryRun(['select-window', '-t', paneId]);
    this.tryRun(['select-pane', '-t', paneId]);
  }

  /** `env` — the client's own: SEAT_MARK_ENV_VAR in it says which seat the terminal is at. */
  attach(session: string, insideTmux: boolean, env?: NodeJS.ProcessEnv): number {
    const args = insideTmux ? ['switch-client', '-t', `=${session}`] : ['attach-session', '-t', `=${session}`];
    const stdio = insideTmux ? null : clientStdio();
    try {
      return spawnSync('tmux', this.argv(args), { stdio: stdio?.stdio ?? 'inherit', env }).status ?? 1;
    } finally {
      stdio?.close();
    }
  }

  /** A tmux command for a person to run, on this server. */
  commandHint(args: string[]): string {
    return commandLine('tmux', this.argv(args));
  }

  /** How a person reaches the session from another terminal. */
  attachHint(session: string): string {
    return this.commandHint(['attach', '-t', `=${session}`]);
  }
}

export interface AiOptions {
  path: string;
  restart: boolean;
  /** `--new`: start a new conversation — leave out the profile's resume args. */
  fresh: boolean;
  /** `--conversation <id>`: continue this Claude Code conversation. */
  conversation?: string;
  detach: boolean;
  dryRun: boolean;
  /** `--focused`: a session nothing wakes — VDX_FOCUSED=1, the profile's `wakes` rules left out. */
  focused?: boolean;
  /** `--focused <topic>`: what the focused session is about; inside it, a new topic for it. */
  topic?: string;
  /**
   * `--prompt <text>`: the first message of a new focused session, apart from its topic — the topic is
   * what senders compare and lists show, the prompt what the agent reads (vdx-ai-predictable DL #30).
   */
  prompt?: string;
  /** `--intercom`: the project's intercom session — VDX_INTERCOM=1, one per project and machine. */
  intercom?: boolean;
  /** `--hq`: the project's HQ session — VDX_HQ=1, one per project and machine. */
  hq?: boolean;
  /**
   * `--attach <session>`: attach to this tmux session as it is, start nothing — the command of a session's row in
   * the list of `~` (vdx-ai-predictable DL #32). Other terminals on it stay.
   */
  attach?: string;
  /** `--list`: the list of a plain start, printed; nothing is asked or started. */
  list?: boolean;
  /** `--find <phrase>`: the list of the conversations whose replies have it (vdx-ai-predictable P5). */
  find?: string;
  /** `--tab`: back into the session this cmux tab showed before cmux restarted (vdx-ai-predictable DL #19). */
  tab?: boolean;
  /** `-y`, `--yes`: every question answered by vdx, as Linux tools take it — y, and Enter for the rest (DL #29). */
  yes?: boolean;
  /** `--no-input`: no question asked — as without a terminal; for agents (DL #29). */
  noInput?: boolean;
}

/** A question may be put: at a terminal, or with `--yes` (vdx answers it); never with `--no-input`. */
function asks(deps: { interactive: boolean; answers?: AiDeps['answers'] }): boolean {
  return deps.answers === 'none' ? false : deps.answers === 'yes' || deps.interactive;
}

/**
 * `--yes`: every question answered by vdx — y to a `[y/N]` or `[Y/n]` one, Enter to the rest — and
 * the answer said on a line; the list is answered by its Enter, not shown with a cursor.
 * `--no-input`: no question is put (`asks`), as without a terminal (vdx-ai-predictable DL #29).
 */
function withAnswers(deps: AiDeps, answers: 'yes' | 'none'): AiDeps {
  if (answers === 'none') return { ...deps, answers };
  return {
    ...deps,
    answers,
    pick: undefined,
    ask: (prompt) => {
      const answer = /\[(y\/N|Y\/n)\]/.test(prompt) ? 'y' : '';
      deps.log(`${prompt.trim()} ${answer || 'Enter'} (--yes)`);
      return answer;
    },
  };
}

/** A topic is one line: it goes into a tmux option, a terminal's title and a transcript line. */
export function normalizeTopic(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * The topic of the agent in tmux pane `paneId`; null — it has none, or there is no such pane. A tmux
 * session may hold two agents, one per window, so a topic is the pane's (echelon, 2026-11-16: the
 * second focused agent in `echelon@lft` put its topic over the first's). Read as intercom and the
 * plugin's hook read it — the format from the pane: its own option first, then the session's, which
 * a vdx before 0.59 set.
 */
function paneTopic(tmux: Tmux, paneId: string): string | null {
  if (!paneId) return null;
  return tmux.tryRun(['display-message', '-p', '-t', paneId, `#{${TOPIC_OPTION}}`])?.trim() || null;
}

/**
 * Set the pane's topic, or clear it. Cleared, it is set empty rather than unset: an unset one would
 * show the session's, which a vdx before 0.59 set for another agent of the session.
 */
function setPaneTopic(tmux: Tmux, paneId: string, topic: string | null): boolean {
  return tmux.tryRun(['set-option', '-p', '-t', paneId, TOPIC_OPTION, topic ?? '']) !== null;
}

/**
 * Who started the pane's agent, when not the person (vdx-ai-list-owner-findings П. 3): `hq` — the project's HQ
 * session (its shell carries VDX_HQ=1), `letter` — a letter's intercom session (`--intercom --detach`), `agent` —
 * any other agent's shell (Claude Code's CLAUDECODE=1). A `!` command of the person's in Claude Code has that
 * shell too and counts as an agent's. Read by `vdx ai --check` (its line in the transcript, the list's 🤖) and
 * by the cmux sidebar of nas-info. A pane option, as the topic: a session may hold the person's agent beside it.
 */
const BY_OPTION = '@vdx_by';
type StartedBy = 'hq' | 'letter' | 'agent';

/** Read from the shell vdx runs in, before a start drops the mode marks of that shell from what it passes on. */
function startedBy(opts: AiOptions, env: NodeJS.ProcessEnv): StartedBy | null {
  if (opts.intercom && opts.detach) return 'letter';
  if (env[HQ_ENV_VAR] === '1') return 'hq';
  if (env['CLAUDECODE'] === '1') return 'agent';
  return null;
}

/** Set it empty rather than unset for the person's start: an unset pane option shows the session's. */
function setPaneBy(tmux: Tmux, paneId: string, by: StartedBy | null): void {
  tmux.tryRun(['set-option', '-p', '-t', paneId, BY_OPTION, by ?? '']);
}

function paneBy(tmux: Tmux, paneId: string): StartedBy | null {
  const v = paneId ? tmux.tryRun(['display-message', '-p', '-t', paneId, `#{${BY_OPTION}}`])?.trim() : null;
  return v === 'hq' || v === 'letter' || v === 'agent' ? v : null;
}

/** Is this a session the person started or attached to: `--close` leaves it open. */
function sessionStays(tmux: Tmux, session: string): boolean {
  return tmux.tryRun(['show-options', '-qv', '-t', `=${session}:`, STAYS_OPTION])?.trim() === '1';
}

/**
 * A start or an attach of the person's, from a terminal, marks the session: it stays. The intercom
 * session and a focused one end themselves with `--close` only when nobody did — a letter or an HQ
 * started them with `--detach` (vdx-ai-predictable Sidetrack #16); of other sessions nobody reads it.
 */
function markSessionStays(session: string, opts: AiOptions, deps: AiDeps): void {
  if (deps.interactive && !opts.detach) setStays(deps, session);
}

/**
 * The intercom session stays: the tmux option, and the records of its panes — the option goes with
 * a fallen server, and a restore brings the session back by its record (intercom-session-mode DL #12).
 */
function setStays(deps: AiDeps, session: string): void {
  deps.tmux.tryRun(['set-option', '-t', `=${session}:`, STAYS_OPTION, '1']);
  const server = currentServer(deps.tmux);
  if (!server) return;
  try {
    markStays(deps.env, deps.home, server, session);
  } catch {
    // no record to mark: the hook writes one with the option at the agent's next start
  }
}

/** The pane whose processes hold the agent `pid`; none outside tmux. */
function paneOfAgent(tmux: Tmux, procs: ProcInfo[], pid: number): PaneInfo | undefined {
  return tmux.panes().find((p) => processTree(procs, p.panePid).some((x) => x.pid === pid));
}

export interface AiDeps {
  env: NodeJS.ProcessEnv;
  home: string;
  tmux: Tmux;
  /** stdin and stdout are a terminal: an interactive agent can run here and tmux can attach. */
  interactive: boolean;
  /**
   * Who answers the questions: the person at a terminal (unset), vdx itself (`--yes`), nobody
   * (`--no-input`). A question goes by `asks`, a terminal's own work (attach, colour) by `interactive`.
   */
  answers?: 'yes' | 'none';
  shell: string | null;
  log: (line: string) => void;
  out: (text: string) => void;
  onPath: (bin: string) => boolean;
  processes: () => ProcInfo[];
  /** Was this agent process started focused; default: its environment (`processFocused`). */
  agentFocused?: (pid: number) => boolean;
  /** Is this agent process an intercom session; default: its environment (`processMode`). */
  agentMail?: (pid: number) => boolean;
  /** Is this agent process an HQ session; default: its environment (`processMode`). */
  agentHq?: (pid: number) => boolean;
  /** Take cmux's own `cmux restore --surface` off this terminal before the attach; default: `takeCmuxLine`. */
  takeCmuxLine?: () => { taken: string; waitedMs: number } | null;
  /** Runs the cmux command line (tabs.ts `returnTabs`); default: the one cmux names in its tabs. */
  cmux?: (args: string[]) => { status: number; out: string };
  /** cmux's windows now and before it last started, and what runs in front in each terminal; default: read here. */
  tabsView?: () => {
    current: CmuxSnapshot | null;
    before: CmuxSnapshot | null;
    foreground: Map<string, string[]>;
    ttys?: Map<string, string>;
  };
  /** Default `process.platform`: the folder check is for macOS. */
  platform?: NodeJS.Platform;
  sleep: (ms: number) => void;
  /** Where volumes are mounted (reach.ts); default `/Volumes`. */
  volumes?: string;
  /** How many intercom sessions letters may run here at once; default from the machine's memory (intercom-queue.ts). */
  intercomLimit?: number;
  /** This machine's addresses; default its network interfaces (DL #32). */
  addresses?: () => string[];
  confirmTimeoutMs: number;
  /** How long a start's agent is waited for while its login shell lives; default `AGENT_START_MS`. */
  agentStartMs?: number;
  /** One line from the person at the terminal, or null when there is none. */
  ask: (prompt: string) => string | null;
  /** The terminal's width in cells; not given — not known. */
  columns?: number;
  /**
   * The list with a cursor (picker.ts) for the question of a start at a terminal; not given — the
   * plain list and a typed answer. Null — the person left; `failed` — it did not show.
   */
  pick?: (input: PickerInput) => PickerAnswer | null | 'failed';
  /** This vdx's version, named to the vdx on another machine. */
  version?: string;
  /** Run ssh — capturing its output, or on this terminal; null when ssh is not on PATH. */
  ssh?: (args: string[], capture: boolean, timeoutMs?: number) => { status: number; stdout: string } | null;
  /** Claude Code processes alive on this machine; read from its session files when not given. */
  liveHere?: () => LiveSession[];
  /**
   * Start `vdx <args>` apart from this process and its terminal, output into `logFile`: a session's
   * restart of its own pane goes on there. The child's pid; null — it did not start.
   */
  handOff?: (args: string[], env: NodeJS.ProcessEnv, logFile: string) => number | null;
  /** What the agent process `pid` lags behind; read from Claude Code's files when not given. */
  lag?: (pid: number, projectRoot: string, command: string) => Lag | null;
  /** Whose HQ the project is (`--hq`); default: the access layer the intercom directory names (hq.ts). */
  projectHq?: (projectRoot: string) => ProjectHq;
}

function machineLag(deps: AiDeps, pid: number, projectRoot: string, command: string): Lag | null {
  return sessionLag({
    env: deps.env,
    home: deps.home,
    pid,
    projectRoot,
    installedClaude: () => {
      try {
        return execFileSync(command, ['--version'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5_000,
        });
      } catch {
        return null;
      }
    },
  });
}

function runSsh(args: string[], capture: boolean, timeoutMs?: number): { status: number; stdout: string } | null {
  const res = spawnSync('ssh', args, {
    stdio: capture ? ['ignore', 'pipe', 'ignore'] : 'inherit',
    encoding: 'utf8',
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  });
  return sshOutcome(res);
}

/**
 * What an ssh call came to: null — no ssh here; 255 — no answer, as ssh says it of a connection, and so is a call
 * cut by its time limit (a hung exchange, link or command: restore-after-any-crash DL #7).
 */
export function sshOutcome(res: {
  status: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string | null;
  error?: Error;
}): { status: number; stdout: string } | null {
  if (at(res.error, 'code') === 'ENOENT') return null;
  const cut = at(res.error, 'code') === 'ETIMEDOUT' || (res.status === null && Boolean(res.signal));
  return { status: cut ? 255 : (res.status ?? 1), stdout: res.stdout ?? '' };
}

/** How long a question to another machine may take: what runs there, its tab marks, its report. */
const ASK_TIMEOUT_MS = 30_000;
/** How long another machine may take to bring back its own: up to 30 s an agent while its prompts are answered. */
const PEER_RESTORE_TIMEOUT_MS = 600_000;

/**
 * Ask another machine and read its answer: BatchMode (a password prompt is no answer), 5 s to connect, a link
 * gone dead noticed within 30 s, and the whole call cut at `timeoutMs` — ConnectTimeout alone holds only the
 * connection, and a hung command there would hold this vdx for good (nas-info, 2026-11-17).
 */
function askMachineOver(
  deps: AiDeps,
  host: string,
  script: string,
  timeoutMs: number = ASK_TIMEOUT_MS,
): { status: number; stdout: string } | null {
  return (deps.ssh ?? runSsh)(
    [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=5',
      '-o',
      'ServerAliveInterval=10',
      '-o',
      'ServerAliveCountMax=3',
      host,
      script,
    ],
    true,
    timeoutMs,
  );
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Read one line from the terminal, synchronously: the prompt runs before tmux takes it. */
export function askLine(prompt: string): string | null {
  process.stderr.write(prompt);
  const buf = Buffer.alloc(256);
  let text = '';
  for (;;) {
    let n: number;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (at(e, 'code') === 'EAGAIN') {
        sleepSync(50);
        continue;
      }
      return null;
    }
    if (n === 0) return text === '' ? null : text.trim();
    text += buf.toString('utf8', 0, n);
    const nl = text.indexOf('\n');
    if (nl >= 0) return text.slice(0, nl).trim();
  }
}

export function defaultDeps(): AiDeps {
  return {
    env: process.env,
    home: os.homedir(),
    tmux: new Tmux(),
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    shell: process.env['SHELL'] || null,
    log: (line) => process.stderr.write(line + '\n'),
    out: (text) => process.stdout.write(text),
    onPath: (bin) => onPath(bin),
    processes: listProcesses,
    sleep: sleepSync,
    confirmTimeoutMs: 30_000,
    ask: askLine,
    columns: process.stdout.columns,
    // fzf on PATH is the picker; VDX_PLAIN_LIST=1 keeps the plain list and its typed answer.
    pick: onPath('fzf') && !process.env['VDX_PLAIN_LIST'] ? fzfPick : undefined,
    ssh: runSsh,
  };
}

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_DRIFT = 3;
export const EXIT_LAUNCH_FAILED = 4;
/**
 * `--intercom --detach` over the machine's limit: queued, not failed — the letter waits in the inbox, and vdx starts
 * the session when one closes (intercom-session-mode DL #13; the code `send` of vdm asked for, ai-dev-plugins
 * `intercom-session-machine-limit-send-line`).
 */
export const EXIT_QUEUED = 5;

/**
 * Without tmux the agent runs in the foreground. One that fails this soon after
 * a start with the resume args had nothing to resume (`claude --continue` exits
 * 1 at once); the window covers answering the channel prompt that comes first.
 */
const NOTHING_TO_RESUME_MS = 30_000;

/** Where a start goes in tmux: the agent it attaches to, the pane it restarts, or a place of its own. */
type PlanTarget =
  | { kind: 'attach'; session: string; drift: boolean }
  | { kind: 'restart'; session: string; paneId: string }
  | { kind: 'new'; session: string; window: boolean };

function targetLine(t: PlanTarget): string {
  switch (t.kind) {
    case 'attach':
      return t.drift
        ? `"${t.session}" runs off the profile — at a terminal it asks: as is, or a restart; without one nothing is done`
        : `attaches to "${t.session}"`;
    case 'restart':
      return `restarts the agent in "${t.session}" ${t.paneId}`;
    case 'new':
      return t.window ? `a new window in "${t.session}"` : `a new session is named "${t.session}"`;
  }
}

function renderPlan(
  plan: LaunchPlan,
  multiplexer: Multiplexer,
  running: AgentPane[],
  focusedOf: (pid: number) => boolean,
  /** Where the start goes — what the start itself does, not a name it would make anyway. */
  target: PlanTarget,
  /** The project's agents this start leaves alone, each with what it is. */
  aside: { pane: PaneInfo; what: string }[] = [],
  topic: Topic | null = null,
): string {
  const lines = [
    `vdx ai — ${plan.projectRoot}`,
    `  name:     ${plan.project} (${plan.projectSource})`,
    `  profile:  ${plan.profilePath ?? `none — built-in default (${FALLBACK_AGENTS.join(' or ')}, no flags, no tmux)`}`,
    `  agent:    ${agentLine(plan, plan.args)}`,
    `  resume:   ${plan.resumeArgs.length ? plan.resumeArgs.join(' ') : '—'}`,
    `  matched:  ${plan.matched.length ? plan.matched.join(', ') : '—'}`,
  ];
  if (plan.focused)
    lines.push(`  focused:  nothing wakes it; left out: ${plan.skipped.length ? plan.skipped.join(', ') : '—'}`);
  if (topic) lines.push(`  topic:    ${topic.text ? `«${topic.text}» (${topic.from})` : `— ${topic.from}`}`);
  if (plan.focused && plan.opening.length && plan.resumeArgs.length === 0)
    lines.push(`  first:    ${plan.opening.join(' ')}`);
  if (plan.intercom)
    lines.push(
      `  intercom: the project's intercom session, a new conversation; first: ${
        plan.opening.length ? plan.opening.join(' ') : '— (no agent.intercom_args: it waits for a wake)'
      }`,
    );
  if (plan.hq)
    lines.push(
      `  hq:       the project's HQ session; first: ${plan.opening.length ? plan.opening.join(' ') : '— (no agent.hq_args)'}`,
    );
  for (const c of plan.confirm) lines.push(`  confirm:  "${c.screen}" → ${c.keys.join(' ')}`);
  lines.push(
    multiplexer === 'tmux' ? `  session:  tmux; ${targetLine(target)}` : '  session:  this terminal (no tmux)',
  );
  if (multiplexer === 'tmux') {
    if (running.length === 0) lines.push('  running:  —');
    for (const r of running) {
      const missing = missingArgs(r.proc.args, plan.args);
      const focused = focusedOf(r.proc.pid);
      lines.push(
        `  running:  ${r.pane.session} ${r.pane.paneId} — ${
          missing.length ? `missing ${missing.join(' ')}` : 'matches the profile'
        }${focused ? ', focused' : plan.focused ? ', not focused' : ''}`,
      );
    }
    for (const a of aside) {
      lines.push(`  aside:    ${a.pane.session} ${a.pane.paneId} — ${a.what}, left alone`);
    }
  }
  return lines.join('\n') + '\n';
}

function lastLines(screen: string | null, n: number): string {
  const lines = (screen ?? '').split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return '    | (nothing on it)';
  return lines
    .slice(-n)
    .map((l) => `    | ${l}`)
    .join('\n');
}

function findAgentInPane(plan: LaunchPlan, paneId: string, deps: AiDeps): ProcInfo | null {
  const pid = deps.tmux.panePid(paneId);
  if (pid === null) return null;
  return processTree(deps.processes(), pid).find((p) => isAgentProcess(p, plan.command)) ?? null;
}

/**
 * The pane still runs the agent's start: the agent, or the login shell whose command line names it
 * (`zsh -lic '<agent> …'`). The shell a pane keeps after its agent (`exec zsh -l`) does not.
 */
function startAlive(plan: LaunchPlan, paneId: string, deps: AiDeps): boolean {
  const pid = deps.tmux.panePid(paneId);
  if (pid === null) return false;
  const name = path.basename(plan.command);
  return processTree(deps.processes(), pid).some((p) => p.args.includes(name));
}

/**
 * One look at the pane for the prompts still pending: one on screen is answered and leaves the list.
 * 'stuck' — it stayed on screen after its keys; null — none of them is on screen.
 */
function answerOnScreen(pending: ConfirmRule[], paneId: string, deps: AiDeps): 'answered' | 'stuck' | null {
  const { tmux, log } = deps;
  const screen = tmux.capture(paneId);
  const i = pending.findIndex((c) => screen?.includes(c.screen));
  if (i < 0) return null;
  const rule = pending.splice(i, 1)[0]!;
  for (const key of rule.keys) {
    tmux.sendKey(paneId, key);
    deps.sleep(250);
  }
  const goneBy = Date.now() + 5_000;
  while (Date.now() < goneBy && tmux.capture(paneId)?.includes(rule.screen)) deps.sleep(200);
  if (tmux.capture(paneId)?.includes(rule.screen)) {
    log(`✗ "${rule.screen}" is still on screen after ${rule.keys.join(' ')}`);
    return 'stuck';
  }
  log(`✓ answered "${rule.screen}" with ${rule.keys.join(' ')}`);
  return 'answered';
}

/**
 * How long a start's agent is waited for while the login shell that starts it still runs. On lft at load 23 that
 * shell took 39 s, and a wait of 10 s said «not running» over a start that came up later (global-auth-gap,
 * 2026-11-23, intercom-session-mode Sidetrack #11).
 */
const AGENT_START_MS = 90_000;

/** 'starting' — no agent yet, and its start is still under way: it may come up, so nothing starts it again. */
type SettleResult = 'ok' | 'not-running' | 'starting' | 'failed';

/**
 * After a start or restart: answer the prompts the profile says will appear,
 * then check the agent is alive and carries every required arg.
 */
function settle(plan: LaunchPlan, paneId: string, deps: AiDeps): SettleResult {
  const { tmux, log } = deps;
  const pending = [...plan.confirm];
  const deadline = Date.now() + deps.confirmTimeoutMs;
  // The prompts are waited for while the start is under way, up to the deadline: the login shell and
  // the agent come up slower on a busy machine. A wait cut at 5 s with no agent in the pane yet left an
  // intercom session on the channels prompt with nobody at it, and exit 4 (echelon, 2026-11-08). An
  // agent that quits — at its first prompt, or with nothing to resume — ends the wait.
  const grace = Date.now() + Math.min(2_000, deps.confirmTimeoutMs);
  while (pending.length > 0 && Date.now() < deadline) {
    const looked = answerOnScreen(pending, paneId, deps);
    if (looked === 'stuck') return 'failed';
    if (looked === 'answered') continue;
    if (Date.now() > grace && !startAlive(plan, paneId, deps)) break;
    deps.sleep(300);
  }

  // Seen twice a second apart: an agent can quit right after its first prompt
  // is answered (claude --continue with no conversation does).
  // Past 10 s the wait goes on only while the start is under way: a pane with nothing of it left has no agent to wait for.
  let proc: ProcInfo | null = null;
  const started = Date.now();
  const procBy = started + 10_000;
  const startBy = started + (deps.agentStartMs ?? AGENT_START_MS);
  let underWay = false;
  for (;;) {
    const first = findAgentInPane(plan, paneId, deps);
    if (first) {
      deps.sleep(1_000);
      const again = findAgentInPane(plan, paneId, deps);
      if (again?.pid === first.pid) {
        proc = again;
        break;
      }
    }
    const now = Date.now();
    if (now >= procBy) {
      underWay = startAlive(plan, paneId, deps);
      if (!underWay || now >= startBy) break;
    }
    deps.sleep(300);
  }
  if (!proc && underWay) {
    log(
      `✗ ${plan.command} is not up yet after ${Math.round((Date.now() - started) / 1000)} s: ` +
        `its start is still under way in ${paneId} (the login shell runs) and may bring it up. The pane shows:`,
    );
    log(lastLines(tmux.capture(paneId), 8));
    log(`  nothing starts it again; to stop it — ${tmux.commandHint(['kill-pane', '-t', paneId])}`);
    return 'starting';
  }
  if (!proc) {
    log(`✗ ${plan.command} is not running in the pane. The pane shows:`);
    log(lastLines(tmux.capture(paneId), 8));
    return 'not-running';
  }
  // The prompt may come as the wait ends: one more look before giving up on it.
  for (;;) {
    if (pending.length === 0) break;
    const looked = answerOnScreen(pending, paneId, deps);
    if (looked === 'stuck') return 'failed';
    if (looked === null) break;
  }
  if (pending.length > 0) {
    log(
      `✗ expected prompt not seen in ${Math.round(deps.confirmTimeoutMs / 1000)} s: ${pending.map((c) => `"${c.screen}"`).join(', ')} — ` +
        'the agent may be waiting on another question. The pane shows:',
    );
    log(lastLines(tmux.capture(paneId), 8));
    log(
      `  ${path.basename(plan.command)} keeps running in ${paneId} (pid ${proc.pid}): answer it there, ` +
        `or stop it — ${tmux.commandHint(['kill-pane', '-t', paneId])}`,
    );
    return 'failed';
  }
  const missing = missingArgs(proc.args, plan.args);
  if (missing.length > 0) {
    log(`✗ the agent is running without: ${missing.join(' ')}`);
    return 'failed';
  }
  log(`✓ running: ${proc.args}`);
  return 'ok';
}

/**
 * Settle a pane started with the plan's resume args, if it has any. An agent
 * with nothing to resume exits at once; start it once more without them rather
 * than leave the project without an agent.
 */
function settleResumed(plan: LaunchPlan, paneId: string, deps: AiDeps): boolean {
  const result = settle(plan, paneId, deps);
  if (result !== 'not-running' || plan.resumeArgs.length === 0) return result === 'ok';
  const line = agentLine({ ...plan, resumeArgs: [] }, plan.args);
  deps.log(`↻ nothing to resume — starting without ${plan.resumeArgs.join(' ')}: ${line}`);
  deps.tmux.respawn(paneId, plan.projectRoot, tmuxShellCommand(line, deps.shell, !plan.intercom));
  return settle(plan, paneId, deps) === 'ok';
}

/**
 * An intercom session whose agent has stood this long on a screen that waits — a weekly limit reached, a window
 * nobody answers — holds no place: nobody sits at it, and it would take the place for good (ai-dev-plugins,
 * `intercom-session-machine-limit-send-line`: one stood so from 14.11). A run takes 3.5–5 min, 9 in 10 under 13.
 */
const STALLED_INTERCOM_MS = 30 * 60_000;

/**
 * The intercom sessions letters started here, but the one `freeing`, and those whose agent stalls on a waiting
 * screen (intercom-session-mode DL #13).
 */
function lettersSessionsHere(deps: AiDeps, freeing: string | null, now: number = Date.now()): string[] {
  const names = lettersSessions(
    deps.tmux.tryRun(['list-sessions', '-F', `#{session_name}\t#{${STAYS_OPTION}}`]) ?? '',
    freeing,
  );
  if (names.length === 0) return names;
  const panes = deps.tmux.panes();
  const procs = deps.processes();
  return names.filter((name) => {
    const pane = panes.find((p) => p.session === name);
    const agent = pane ? processTree(procs, pane.panePid).find((p) => /^(\S*\/)?claude(\s|$)/.test(p.args)) : null;
    const live = agent ? liveSessionFile(deps.env, deps.home, agent.pid) : null;
    return !(live?.status === 'waiting' && live.activeAt !== null && now - live.activeAt > STALLED_INTERCOM_MS);
  });
}

/**
 * Start the oldest queued projects' intercom sessions, as many as `free` places — each in a vdx of its own,
 * apart from this one, which may be a closing session's (intercom-session-mode DL #13). A start the queue made
 * moves it no further. One queued twice meanwhile is not doubled: one intercom session per project and machine.
 */
function startQueued(deps: AiDeps, free: number, freeing: string | null): void {
  if (free <= 0 || deps.env[INTERCOM_QUEUED_ENV_VAR] === '1') return;
  for (const q of queued(deps.home).slice(0, free)) {
    if (!fs.existsSync(q.project)) {
      dequeue(deps.home, q.project);
      continue;
    }
    const name = path.basename(q.project);
    const logFile = path.join(deps.home, '.cache', 'vdx', 'intercom-queue', `${name.replace(/[^\w.@-]/g, '_')}.log`);
    const pid = (deps.handOff ?? handOffRestart)(
      ['ai', q.project, '--intercom', '--detach'],
      {
        ...deps.env,
        [INTERCOM_QUEUED_ENV_VAR]: '1',
        ...(freeing ? { [INTERCOM_FREEING_ENV_VAR]: freeing } : {}),
      },
      logFile,
    );
    deps.log(
      pid === null
        ? `✗ ${name}: queued for its intercom session, and it could not be started now — the next start or close tries again`
        : `↪ ${name}: queued ${describeAge(new Date(q.at))}, its intercom session starts now — what it says: ${logFile}`,
    );
  }
}

/**
 * `vdx <args>` in a session of its own (setsid), its output into `logFile`: what a pane's own restart
 * goes on in. A process of the pane's session goes down with `respawn-pane -k`; one of its own does not.
 */
export function handOffRestart(
  args: string[],
  env: NodeJS.ProcessEnv,
  logFile: string,
  script: string | undefined = process.argv[1],
): number | null {
  if (!script) return null;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = fs.openSync(logFile, 'w');
    try {
      const child = spawn(process.execPath, [...process.execArgv, script, ...args], {
        detached: true,
        stdio: ['ignore', fd, fd],
        env,
      });
      child.unref();
      return child.pid ?? null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * An agent started this long ago or less is no empty place for a new conversation, whatever its
 * transcript says: its first message may not be written yet (echelon, 2026-11-17: a start seconds
 * after another took its pane, and the first session went with no trace).
 */
const FRESH_AGENT_MS = 120_000;

/**
 * The tmux sessions where an agent's start is under way, or its agent runs: a pane whose process
 * tree names the agent's command. The agent shows among the processes only after the login shell
 * (0.2–1.5 s), and until then its pane is told by that shell's line; a shell the agent left behind
 * is `exec <shell> -l` and names it no more. A start seconds after another took the name of the
 * first's session and put a window into it (echelon, 2026-11-16).
 */
function agentSessions(tmux: Tmux, procs: ProcInfo[], command: string): Set<string> {
  const want = path.basename(command);
  const names = (args: string) =>
    args.split(/\s+/).some((w) => path.basename(w.replace(/^['"]+|['"]+$/g, '')) === want);
  return new Set(
    tmux
      .panes()
      .filter((p) => processTree(procs, p.panePid).some((x) => names(x.args)))
      .map((p) => p.session),
  );
}

/**
 * As long as a start waits for its own agent while its login shell runs (settle): past that, the start that
 * opened the pane has given up on it. At 15 s a second start killed a login shell that would have brought the
 * agent up at 39 s on a busy machine (intercom-session-mode Sidetrack #11).
 */
function startUnderWayMs(deps: AiDeps): number {
  return deps.agentStartMs ?? AGENT_START_MS;
}

/**
 * Another start of the one intercom or HQ session, in `session`. The agent shows among the processes
 * only after the login shell (`zsh -lic`, 0.2–1.5 s), and until then the pane is told by that shell's
 * command line, which carries the mode's mark; the shell an HQ pane keeps after its agent does not.
 * Waits for its agent. Null: no such start, or its pane went. `agent` null: none came in time, the
 * pane is stuck.
 */
function startUnderWay(
  plan: LaunchPlan,
  session: string,
  sameMode: (pid: number) => boolean,
  deps: AiDeps,
): { pane: PaneInfo; agent: ProcInfo | null } | null {
  const mark = `${modeEnvVar(plan)}=1`;
  const by = Date.now() + startUnderWayMs(deps);
  let seen: PaneInfo | undefined;
  for (;;) {
    const procs = deps.processes();
    const panes = deps.tmux
      .panes()
      .filter((p) => p.session === session)
      .map((pane) => ({ pane, tree: processTree(procs, pane.panePid) }));
    for (const { pane, tree } of panes) {
      const agent = tree.find((p) => isAgentProcess(p, plan.command) && sameMode(p.pid));
      if (agent) return { pane, agent };
    }
    if (seen && !panes.some(({ pane }) => pane.paneId === seen?.paneId)) return null;
    seen ??= panes.find(({ tree }) => tree.some((p) => p.args.includes(mark)))?.pane;
    if (!seen) return null;
    if (Date.now() >= by) return { pane: seen, agent: null };
    deps.sleep(300);
  }
}

/** The tmux session option a `vdx ai@<host>` from a cmux tab marks its session with: `--tab` finds it by it. */
const TAB_OPTION = '@vdx_tab';
/** The marks a session keeps in `@vdx_tab`, newest last: one per tab that showed it. */
const TAB_MARKS = 8;
/** A record of a tab closed by hand stays behind (its vdx ai went down with it): after this long it goes. */
const TAB_RECORD_DAYS = 30;

/** The cmux tab this process runs in, outside tmux; null — not one. */
function cmuxSurface(env: NodeJS.ProcessEnv): string | null {
  const surface = env['CMUX_SURFACE_ID']?.trim();
  return surface && !env['TMUX'] && /^[A-Za-z0-9-]+$/.test(surface) ? surface : null;
}

/**
 * A line in `~/.cache/vdx/tab.log` from `vdx ai --tab`: what cmux typed into the tab and when — what the
 * next restart of cmux is read by (restore-after-any-crash DL #9). Errors are swallowed.
 */
function noteTabLog(home: string, line: string): void {
  try {
    const dir = path.join(home, '.cache', 'vdx');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'tab.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // the log is for reading later; the attach does not wait on it
  }
}

/**
 * cmux opens a tab again in the directory its shell last reported, and a `vdx ai '<path>'` typed anywhere left
 * that one: told the project's directory while vdx holds the attach, cmux brings the tab back into the project
 * (the owner, 2026-11-19: «чтобы cmux запоминал рабочий каталог»). The shell's own report at its next prompt
 * sets it back. Said with cmux's own call — its shell integration reports a remote shell's directory so.
 * Outside a cmux tab, or a directory not here: nothing.
 */
function reportTabDirectory(deps: AiDeps, dir: string | null): void {
  const surface = cmuxSurface(deps.env);
  const workspace = deps.env['CMUX_WORKSPACE_ID']?.trim();
  if (!surface || !workspace || !dir) return;
  try {
    if (!fs.statSync(dir).isDirectory()) return;
  } catch {
    return;
  }
  (deps.cmux ?? runCmux(deps.env))([
    'rpc',
    'surface.report_pwd',
    JSON.stringify({ workspace_id: workspace, surface_id: surface, path: dir }),
  ]);
}

/** Note what this cmux tab shows; the function returned forgets it. Outside a cmux tab: nothing. */
function noteTab(
  deps: AiDeps,
  what:
    | { kind: 'here'; session: string; socket: string | null }
    | { kind: 'there'; host: string; project: string; token: string },
): () => void {
  const surface = cmuxSurface(deps.env);
  if (!surface) return () => {};
  const dir = tabRecordDir(deps.home);
  const file = path.join(dir, `${surface}.json`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      const old = path.join(dir, f);
      try {
        if (Date.now() - fs.statSync(old).mtimeMs > TAB_RECORD_DAYS * 86_400_000) fs.rmSync(old, { force: true });
      } catch {
        // gone already
      }
    }
    fs.writeFileSync(file, JSON.stringify({ ...what, surface, at: Date.now() }) + '\n');
  } catch {
    return () => {};
  }
  return () => fs.rmSync(file, { force: true });
}

/**
 * Attach to the session, or name how. Attached in cmux to a session with a topic — a focused one,
 * an HQ one — the workspace shows it while vdx holds the attach (focused-topic DL #6); under `vdx ai@<host>` the session gets
 * the mark the vdx there watches it by.
 */
function finish(
  ok: boolean,
  session: string,
  paneId: string,
  opts: AiOptions,
  deps: AiDeps,
  withTopic = false,
  seat: string = hostLabel(deps.env),
): number {
  if (deps.interactive && !opts.detach) {
    markSessionStays(session, opts, deps);
    if (!ok) deps.log('attaching so you can see the pane');
    deps.tmux.focus(paneId);
    const insideTmux = Boolean(deps.env['TMUX']);
    const token = deps.env[CMUX_TOKEN_ENV_VAR];
    if (token && /^[0-9a-f]+$/.test(token)) {
      // The tab's mark goes on any session; the topic's only where there is one — its watcher would poll for good.
      // Two tabs may show one session: the marks are a list, or the second tab's put the first's out
      // (`echelon@m3-hq`, 2026-11-12: its tab's mark gone, `--tab` found no session; Sidetrack #17).
      const marks = (deps.tmux.tryRun(['show-options', '-qv', '-t', `=${session}:`, TAB_OPTION]) ?? '')
        .trim()
        .split(/\s+/)
        .filter((m) => /^[0-9a-f]+$/.test(m) && m !== token);
      deps.tmux.tryRun(['set-option', '-t', `=${session}:`, TAB_OPTION, [...marks, token].slice(-TAB_MARKS).join(' ')]);
      if (withTopic) deps.tmux.tryRun(['set-option', '-t', `=${session}:`, CMUX_TOKEN_OPTION, token]);
    }
    const attach = () => {
      const watch =
        withTopic && !insideTmux ? watchTopic(deps.env, { session, socket: deps.tmux.socketName }, deps.home) : null;
      const status = deps.tmux.attach(session, insideTmux, { ...process.env, [SEAT_MARK_ENV_VAR]: seat });
      watch?.stop();
      return status;
    };
    // The tmux server fell under the attach — a crash, a kill-server: its session comes back with
    // `vdx ai --restore`, and this terminal with it (vdx-ai-predictable DL #11). A detach leaves the
    // server as it was, and so does a switch-client inside tmux.
    // Forgotten once an attach was (exit 0: a detach, the session's end): one tmux refused — «can't use
    // /dev/tty» on every tab after cmux restarted, 2026-11-17 — leaves it, and the next try still knows
    // where the tab goes (restore-after-any-crash DL #1).
    const forget = noteTab(deps, { kind: 'here', session, socket: deps.tmux.socketName });
    if (!insideTmux)
      reportTabDirectory(
        deps,
        deps.tmux.tryRun(['display-message', '-p', '-t', `=${session}:`, '#{session_path}'])?.trim() || null,
      );
    let status = EXIT_LAUNCH_FAILED;
    try {
      let before = insideTmux ? null : currentServer(deps.tmux);
      status = attach();
      while (before && fellUnder(before, session, deps)) {
        if (!awaitSession(session, before, deps)) return status;
        before = currentServer(deps.tmux);
        status = attach();
      }
      return status;
    } finally {
      if (status === EXIT_OK) forget();
    }
  }
  deps.log(`attach: ${deps.tmux.attachHint(session)}`);
  return ok ? EXIT_OK : EXIT_LAUNCH_FAILED;
}

/** The record vdx keeps of `session` under `server` (restore.ts) — what a restore brings back. */
function recordOf(session: string, server: TmuxServer, deps: AiDeps): boolean {
  try {
    return lostRecords(deps.env, deps.home, currentServer(deps.tmux), server.socket).some(
      (r) => r.session === session && r.server.pid === server.pid && r.server.started === server.started,
    );
  } catch {
    return false;
  }
}

/** The server the attach began on is gone, and vdx has the record that brings `session` back. */
function fellUnder(before: TmuxServer, session: string, deps: AiDeps): boolean {
  const now = currentServer(deps.tmux);
  if (now && now.pid === before.pid && now.started === before.started) return false;
  if (recordOf(session, before, deps)) return true;
  deps.log(`⚠ the tmux server here fell, and vdx has no record of ${session} to bring it back — vdx ai starts it`);
  return false;
}

/**
 * Wait for `session` to come back after its server fell: `vdx ai --restore` brings it, run in any
 * terminal or by whatever starts tmux again. False — the record is gone and the session did not
 * come (the restore left it out); Ctrl-C leaves at any time.
 */
function awaitSession(session: string, before: TmuxServer, deps: AiDeps): boolean {
  deps.log(
    `⚠ the tmux server here fell under ${session} — waiting for it to come back: vdx ai --restore ` +
      `(in any terminal, or after tmux starts again) brings back every agent it took down; Ctrl-C leaves`,
  );
  for (;;) {
    if (deps.tmux.hasSession(session)) {
      deps.log(`↻ ${session} is back — attaching`);
      return true;
    }
    if (!recordOf(session, before, deps)) {
      deps.log(`${session} did not come back — vdx ai starts it`);
      return false;
    }
    deps.sleep(REATTACH_POLL_MS);
  }
}

/** How long a tab's shell waits for its session while a restore brings it back: after a reboot, tmux and its agents come up later than cmux. */
const RESTORE_WAIT_MS = 180_000;

/**
 * Wait for `session`, which a cmux tab showed, while a restore brings back the agents a fallen tmux took
 * down — the record of one of them names it (restore-after-any-crash). False — none does, or it did
 * not come within RESTORE_WAIT_MS; Ctrl-C leaves at any time.
 */
function awaitRestore(session: string, deps: AiDeps): boolean {
  const pending = () => lostAgents(deps, currentServer(deps.tmux), false).some((r) => r.session === session);
  if (!pending()) return false;
  deps.log(
    `⏳ ${session}, which this tab showed, is coming back with the agents tmux took down — waiting; Ctrl-C leaves`,
  );
  for (let waited = 0; waited < RESTORE_WAIT_MS; waited += REATTACH_POLL_MS) {
    if (deps.tmux.hasSession(session)) {
      deps.log(`↻ ${session} is back — attaching`);
      return true;
    }
    if (!pending()) return deps.tmux.hasSession(session);
    deps.sleep(REATTACH_POLL_MS);
  }
  return deps.tmux.hasSession(session);
}

/** `vdx ai@<host>`: an ssh destination such as `m3` — never an option to ssh. */
export const REMOTE_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A path under the local home as a shell word under the remote home; any other path as is. */
export function remotePathWord(abs: string, home: string): string {
  const rel = path.relative(home, abs);
  if (rel === '') return '"$HOME"';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return shellQuote(abs);
  return `"$HOME"/${shellQuote(rel)}`;
}

/** The flags `vdx ai@<host>` hands the vdx there, after the path; the line it prints names them all. */
function remoteFlags(opts: AiOptions): string[] {
  return [
    opts.fresh && '--new',
    // After the path: the word after --focused is then the topic there, never the path.
    opts.focused && (opts.topic ? `--focused ${shellQuote(opts.topic)}` : '--focused'),
    opts.prompt && `--prompt ${shellQuote(opts.prompt)}`,
    opts.intercom && '--intercom',
    opts.hq && '--hq',
    opts.restart && '--restart',
    opts.detach && '--detach',
    opts.dryRun && '--dry-run',
    opts.list && '--list',
    opts.find !== undefined && `--find ${shellQuote(opts.find)}`,
    opts.conversation && `--conversation ${shellQuote(opts.conversation)}`,
    opts.tab && '--tab',
    opts.attach && `--attach ${shellQuote(opts.attach)}`,
    opts.yes && '--yes',
    opts.noInput && '--no-input',
  ].filter((f): f is string => Boolean(f));
}

/**
 * The ssh argv for `vdx ai@<host>`: the same `vdx ai` on the host, in its own
 * tmux there. The path goes first: an older vdx hands the token after a flag it
 * does not know to that flag. A different vdx version there is named, not fatal.
 * `from` — the machine the person sits at, so the vdx there speaks from it; an
 * older vdx leaves the variable alone.
 */
export function remoteAiArgs(input: {
  host: string;
  from: string;
  projectPath: string;
  home: string;
  version: string;
  opts: AiOptions;
  tty: boolean;
  /** Under cmux: the mark the vdx there puts on the focused session it attaches to (cmux.ts). */
  cmuxToken?: string | null;
}): string[] {
  const { host, opts, version } = input;
  const flags = remoteFlags(opts);
  const v = shellQuote(version);
  const script =
    // A terminal the machine there has no entry for — cmux's `xterm-ghostty`, which its shells keep until their
    // first command, the moment `--tab` runs — tmux there refuses: «missing or unsuitable terminal»
    // (restore-after-any-crash DL #8).
    (input.tty ? `infocmp "$TERM" >/dev/null 2>&1 || export TERM=xterm-256color; ` : '') +
    `v=$(vdx --version 2>/dev/null) || v='older than 0.13.1'; ` +
    `[ "$v" = ${v} ] || echo "note: vdx on ${host} is $v, here "${v} >&2; ` +
    `export ${SEAT_ENV_VAR}=${shellQuote(input.from)}; ` +
    (input.cmuxToken ? `export ${CMUX_TOKEN_ENV_VAR}=${shellQuote(input.cmuxToken)}; ` : '') +
    `exec vdx ai ${[remotePathWord(input.projectPath, input.home), ...flags].join(' ')}`;
  return [input.tty ? '-t' : '-T', host, script];
}

/** Where neighbour repos live: the profile's `git.author_pool`, else the project's parent directory. */
export function authorPoolDirs(
  environment: Environment,
  projectRoot: string,
  home: string,
  profileDir: string,
): string[] {
  const listed = environment.git?.author_pool;
  if (!listed?.length) return [path.dirname(projectRoot)];
  return listed.map((d) => path.resolve(profileDir, d.replace(/^~(?=$|\/)/, home)));
}

/**
 * A repo without its own author makes git refuse to commit (`user.useConfigOnly`).
 * At a terminal vdx proposes the likely author and Enter takes the first;
 * without one it says so and goes on — a scripted start must not stop here.
 * A running agent needs no restart: git reads the author at each commit.
 */
export function ensureAuthor(projectRoot: string, poolDirs: string[], deps: AiDeps, dryRun: boolean): void {
  if (!isGitRepo(projectRoot)) return;
  const current = effectiveAuthor(projectRoot);
  if (current) {
    if (dryRun) deps.out(`  author:   ${current.email} (${current.scope})\n`);
    return;
  }
  const top = rankAuthors(projectRoot, scanPool(poolDirs)).slice(0, 3);
  const q = shellQuote(projectRoot);
  const command = (a: Author) =>
    `git -C ${q} config --local user.name ${shellQuote(a.name)} && git -C ${q} config --local user.email ${shellQuote(a.email)}`;
  if (dryRun) {
    const proposal = top.length ? `; would propose ${top.map((c) => c.email).join(', ')}` : '';
    deps.out(`  author:   none — git refuses to commit here${proposal}\n`);
    return;
  }
  deps.log(`⚠ ${path.basename(projectRoot)}: no commit author of its own — git will refuse to commit here`);
  if (!asks(deps) || top.length === 0) {
    deps.log(`  set it: ${top[0] ? command(top[0]) : `git -C ${q} config --local user.email <address>`}`);
    return;
  }
  top.forEach((c, i) => deps.log(`  ${i + 1}) ${c.name} <${c.email}>${c.why.length ? `   ${c.why.join('; ')}` : ''}`));
  deps.log('  s) skip');
  for (let tries = 0; tries < 2; tries++) {
    const answer = deps.ask('Author [1]: ');
    if (answer === null) return;
    const a = answer.trim();
    if (/^[sn]$/i.test(a)) {
      deps.log('  skipped');
      return;
    }
    const pick: Author | undefined =
      a === ''
        ? top[0]
        : /^\d+$/.test(a)
          ? top[Number(a) - 1]
          : a.includes('@')
            ? { name: top[0]!.name, email: a }
            : undefined;
    if (pick) {
      if (writeAuthor(projectRoot, pick)) deps.log(`✓ ${pick.name} <${pick.email}> → .git/config`);
      else deps.log(`✗ could not write .git/config — ${command(pick)}`);
      return;
    }
    deps.log(`  1–${top.length}, an address, or s`);
  }
}

/**
 * Claude Code's memory of the project lives inside it, `.claude/memory/`
 * (claude-memory-in-project): a start says when it does not, and at a terminal asks
 * to put it there — Enter does. With an agent of the project running it only says so:
 * that session keeps the old place until it restarts. Without a terminal it names
 * `vdx doctor --fix`, the same move.
 */
export function ensureMemory(
  projectRoot: string,
  command: string,
  hosts: PersonalHost[],
  deps: AiDeps,
  dryRun: boolean,
  agentRunning: boolean,
): void {
  const ctx = { env: deps.env, home: deps.home };
  if (!isClaude(command) || !memoryApplies(projectRoot, ctx)) return;
  const state = memoryState(projectRoot, ctx);
  if (dryRun) {
    deps.out(`  memory:   ${describeMemory(state, ctx)}\n`);
    return;
  }
  if (!memoryNeedsFix(state)) return;
  const fix = `vdx doctor --fix ${shellQuote(projectRoot)}`;
  deps.log(`⚠ ${path.basename(projectRoot)}: Claude memory ${describeMemory(state, ctx)}`);
  if (!asks(deps) || agentRunning) {
    deps.log(`  ${agentRunning ? 'once the running agent of the project ends' : 'put it there'}: ${fix}`);
    return;
  }
  const question =
    state.kind === 'outside'
      ? 'Move it into .claude/memory/ now?'
      : state.kind === 'leftovers'
        ? 'Set the old place aside?'
        : state.kind === 'moved' && state.conversations
          ? 'Point it here, and bring the conversations along?'
          : 'Point it here?';
  const answer = deps.ask(`  ${question} [Y/n] `);
  if (answer === null || /^n(o)?$/i.test(answer.trim())) {
    deps.log(`  skipped — later: ${fix}`);
    return;
  }
  try {
    const done = fixProjectMemory(projectRoot, state, ctx, {
      ask: deps.ask,
      log: deps.log,
      today: new Date().toLocaleDateString('sv-SE'),
      personalHosts: hosts,
    });
    for (const d of done) deps.log(`✓ ${d}`);
  } catch (e) {
    deps.log(`✗ ${errorMessage(e)} — ${fix}`);
  }
}

/**
 * `vdx ai@<host>` typed in a tmux pane here, to attach: ssh would open the host's tmux inside this one —
 * two status lines, the prefix caught by the outer one, the cmux sidebar naming the outer session
 * (nas-info, ai-peer-inside-tmux-nests). The terminal's tmux client gives way to the same command
 * instead (`detach-client -E`): it runs in the terminal itself, with the terminal's environment, and
 * the session here stays as it was. With other terminals on the session, which one typed it is not
 * known: nothing is detached, and the line says how.
 */
function giveWayInTmux(opts: AiOptions, host: string, projectPath: string, deps: AiDeps): number {
  const own = ownSession(deps.tmux, deps.env);
  const terminals = own ? deps.tmux.clients().filter((c) => c.session === own) : [];
  const line = `vdx ai@${host} ${[shellQuote(projectPath), ...remoteFlags(opts)].join(' ')}`;
  const tty = terminals.length === 1 ? terminals[0]!.tty : undefined;
  if (tty && deps.tmux.tryRun(['detach-client', '-t', tty, '-E', line]) !== null) {
    deps.log(`→ ${host}: ${line} — in this terminal, in place of its tmux client; ${own} stays as it was`);
    return EXIT_OK;
  }
  deps.log(
    `vdx ai: this is a tmux pane${own ? ` of ${own}` : ''}, and ${host}'s tmux would open inside it — nothing started; ` +
      `detach (Ctrl-B d) and run in the terminal: ${line}`,
  );
  return EXIT_LAUNCH_FAILED;
}

/** How often a machine whose link dropped is asked whether it answers again (restore-after-any-crash DL #10). */
const LINK_POLL_MS = 5_000;
/** How long one such question may take. */
const LINK_ASK_TIMEOUT_MS = 15_000;

/**
 * The ssh options of an attach at a terminal (restore-after-any-crash DL #10): a link gone dead is noticed within
 * 30 s, as with a question to another machine, and `up` is touched here once the link is up — ssh runs
 * LocalCommand only then — so a 255 after it is a drop, not a start that never reached the machine.
 */
function attachSshOptions(up: string | null): string[] {
  return [
    '-o',
    'ServerAliveInterval=10',
    '-o',
    'ServerAliveCountMax=3',
    ...(up ? ['-o', 'PermitLocalCommand=yes', '-o', `LocalCommand=touch ${shellQuote(up).replace(/%/g, '%%')}`] : []),
  ];
}

/** Wait until `host` answers over ssh again: no count of tries — it may sleep for hours; Ctrl-C leaves. */
function awaitMachine(host: string, deps: AiDeps): void {
  for (;;) {
    const res = askMachineOver(deps, host, 'true', LINK_ASK_TIMEOUT_MS);
    if (!res || res.status === 0) return;
    deps.sleep(LINK_POLL_MS);
  }
}

/** `from` — where the person sits; a vdx that `vdx ai@<host>` started passes its own on. */
export function runAiRemote(
  opts: AiOptions,
  host: string,
  deps: AiDeps,
  from: string = seatLabel(deps.env),
  /** `--tab`: the mark the tab's session there carries, from the tab's record. */
  tabToken?: string,
): number {
  const projectPath = resolveProjectRoot(opts.path) ?? path.resolve(opts.path);
  const tty = deps.interactive && !opts.detach && !opts.dryRun;
  if (tty && deps.env['TMUX']) return giveWayInTmux(opts, host, projectPath, deps);
  // In cmux the workspace shows the topic of the focused session the vdx there attaches to.
  const token = tty ? (tabToken ?? cmuxToken(deps.env)) : null;
  const args = remoteAiArgs({
    host,
    from,
    projectPath,
    home: deps.home,
    version: deps.version ?? '',
    opts,
    tty,
    cmuxToken: token,
  });
  deps.log(`→ ${host}: vdx ai ${[shellQuote(projectPath), ...remoteFlags(opts)].join(' ')}`);
  const watch = token ? watchTopic(deps.env, { host, token }, deps.home) : null;
  const forget = token ? noteTab(deps, { kind: 'there', host, project: projectPath, token }) : () => {};
  if (token) reportTabDirectory(deps, projectPath);
  // One attach, and whether its link came up: the file LocalCommand touches lives only while ssh runs.
  const attach = (a: string[]) => {
    if (!tty) return { res: (deps.ssh ?? runSsh)(a, false), up: false };
    let dir: string | null = null;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-link-'));
    } catch {
      /* no mark of the link: a drop is then not told from a refused start */
    }
    const up = dir ? path.join(dir, 'up') : null;
    try {
      const res = (deps.ssh ?? runSsh)([...attachSshOptions(up), ...a], false);
      return { res, up: up !== null && fs.existsSync(up) };
    } finally {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  let { res, up } = attach(args);
  // The link was up and dropped — the machines slept, the network went — not the person leaving: back into the
  // same session by this terminal's mark, once the machine answers; never a new one (restore-after-any-crash DL #10).
  while (res?.status === 255 && up) {
    if (!token) {
      deps.log(
        `⚠ the link to ${host} dropped — its tmux session there goes on; back: vdx ai@${host} ${shellQuote(projectPath)}`,
      );
      break;
    }
    deps.log(
      `⚠ the link to ${host} dropped — waiting for ${host} to answer, then back into the same session; Ctrl-C leaves`,
    );
    awaitMachine(host, deps);
    deps.log(`↻ ${host} answers — back into the session this terminal showed`);
    const back: AiOptions = { path: opts.path, restart: false, fresh: false, detach: false, dryRun: false, tab: true };
    ({ res, up } = attach(
      remoteAiArgs({
        host,
        from,
        projectPath,
        home: deps.home,
        version: deps.version ?? '',
        opts: back,
        tty,
        cmuxToken: token,
      }),
    ));
  }
  // As here: a refused attach there, or a dropped connection, keeps the tab's record.
  if (res?.status === EXIT_OK) forget();
  watch?.stop();
  if (res === null) {
    deps.log('vdx ai: `ssh` not found on PATH');
    return 127;
  }
  if (opts.detach && res.status === EXIT_OK) {
    deps.log(`attach from here: vdx ai@${host} ${shellQuote(projectPath)}`);
  }
  return res.status;
}

/**
 * What `vdx ai --report <project>` prints on a machine — the vdx of another one asks for it over
 * ssh (vdx-ai-predictable): the Claude Code sessions alive there (as LIVE_SESSIONS_SCRIPT), the
 * project's agents with what only that machine sees (its terminals, the input line), which of
 * the project's conversations were typed in there, and its copies of their transcripts — the
 * asking machine finds where its own copies are behind.
 */
export interface RemoteReport {
  vdx: string;
  machine: string;
  home: string;
  sessions: LiveSession[];
  agents: AgentFact[];
  typed: string[];
  transcripts: { id: string; mtime: number; size: number }[];
  /** This machine's history.jsonl on the project's conversations (vdx 0.57+): an older vdx sends none. */
  history?: ({ id: string } & HistoryMarks)[];
  /** This machine's addresses (vdx 0.64+): the asking machine names its ssh clients by them (DL #32). */
  ips?: string[];
  /** Asked about the home folder (vdx 0.65+): every tmux session here, for the list of `~` (DL #32). */
  tmux?: SessionFact[];
}

/** What another machine answered: always the live sessions; the report when its vdx gives one. */
interface Reach extends MachineReport {
  report: RemoteReport | null;
}

function parseReach(stdout: string): Reach {
  const text = stdout.trim();
  if (text.startsWith('{')) {
    try {
      const r = JSON.parse(text) as RemoteReport;
      if (Array.isArray(r.sessions) && Array.isArray(r.agents))
        return { home: r.home ?? null, sessions: r.sessions, report: r };
    } catch {
      /* not a report: read it as the script's lines */
    }
  }
  return { ...parseMachineReport(stdout), report: null };
}

/**
 * What runs on `host` right now; null when it does not answer over ssh (BatchMode: a password
 * prompt counts as no answer). Its vdx reports on the project; a vdx there older than the
 * report, or none, — the script prints the live sessions alone.
 */
function askMachine(host: string, deps: AiDeps, projectRoot: string): Reach | null {
  const script = `vdx ai ${remotePathWord(projectRoot, deps.home)} --report 2>/dev/null || sh -c ${shellQuote(LIVE_SESSIONS_SCRIPT)}`;
  const res = askMachineOver(deps, host, script);
  return res && res.status === 0 ? parseReach(res.stdout) : null;
}

/** Which mode an agent process was started in. */
interface ModeOf {
  focused: (pid: number) => boolean;
  mail: (pid: number) => boolean;
  hq: (pid: number) => boolean;
}

/**
 * The facts of the project's agents running here (board.ts): its session file, its transcript,
 * the terminals on its tmux session and its input line.
 */
function agentFacts(
  agents: AgentPane[],
  plan: LaunchPlan,
  deps: AiDeps,
  procs: ProcInfo[],
  wrapSkills: readonly string[],
  modeOf: ModeOf,
): AgentFact[] {
  if (agents.length === 0) return [];
  const clients = deps.tmux.clients();
  return agents.map((a) => {
    const live = liveSessionFile(deps.env, deps.home, a.proc.pid);
    const c = live
      ? conversationById({
          env: deps.env,
          home: deps.home,
          projectRoot: plan.projectRoot,
          id: live.conversation,
          wrapSkills,
        })
      : null;
    const focused = modeOf.focused(a.proc.pid);
    return {
      machine: plan.host,
      session: a.pane.session,
      pid: a.proc.pid,
      conversation: live?.conversation ?? null,
      status: live?.status ?? null,
      activeAt: live?.activeAt ?? null,
      draft: inputDraft(deps.tmux.screen(a.pane.paneId)),
      focused,
      topic: focused ? paneTopic(deps.tmux, a.pane.paneId) : null,
      mail: modeOf.mail(a.proc.pid),
      hq: modeOf.hq(a.proc.pid),
      by: paneBy(deps.tmux, a.pane.paneId),
      openAt: clients.filter((k) => k.session === a.pane.session).map((k) => clientSeat(k.pid, procs, plan.host)),
      title: c?.title ?? null,
      ...transcriptFacts(c, live !== null),
    };
  });
}

/**
 * What a conversation's transcript says of the agent in it, for the list and `@vdx_state` alike.
 * `started` — the agent is known to run in it: then no transcript means nothing was written there yet.
 */
function transcriptFacts(c: Conversation | null, started: boolean): { empty: boolean; finished: boolean } {
  return { empty: c ? isEmpty(c) : started, finished: c?.finished ?? false };
}

/**
 * Set `@vdx_state` on the tmux session of `pane` from the transcript of `conversation`, or unset
 * it: the conversation not known says nothing. Errors are swallowed — a hook runs this.
 */
function keepState(
  deps: AiDeps,
  pane: string,
  projectRoot: string,
  wrapSkills: readonly string[],
  conversation: string | null,
): void {
  try {
    const c = conversation
      ? conversationById({ env: deps.env, home: deps.home, projectRoot, id: conversation, wrapSkills })
      : null;
    const state = conversation ? settledState(transcriptFacts(c, true)) : null;
    // A pane as the target: tmux sets the option of the session the pane is in.
    deps.tmux.tryRun(
      state ? ['set-option', '-t', pane, STATE_OPTION, state] : ['set-option', '-u', '-t', pane, STATE_OPTION],
    );
  } catch {
    // no option: the sidebar shows what it showed before
  }
}

/** The agent's own tmux pane, as the hook's environment names it; null — not in tmux. */
function ownPane(env: NodeJS.ProcessEnv): string | null {
  const pane = env['TMUX_PANE']?.trim();
  return env['TMUX'] && pane && /^%\d+$/.test(pane) ? pane : null;
}

/** The session of the server `tmux` talks to that this process runs in; null — not in one of its. */
function ownSession(tmux: Tmux, env: NodeJS.ProcessEnv): string | null {
  const pane = ownPane(env);
  // TMUX is `<socket>,<server pid>,<session>`: a pane id of another server names another pane.
  const server = currentServer(tmux);
  if (!pane || !server || env['TMUX']?.split(',')[1] !== String(server.pid)) return null;
  return tmux.panes().find((p) => p.paneId === pane)?.session ?? null;
}

/**
 * The sessions a terminal other than this one shows: a window vdx starts there, and the focus it
 * puts on it, would move that terminal too (vdx-ai-predictable Sidetrack #13). Started inside tmux,
 * one terminal on its own session is the person's own.
 */
function viewedElsewhere(tmux: Tmux, env: NodeJS.ProcessEnv): Set<string> {
  const count = new Map<string, number>();
  for (const c of tmux.clients()) count.set(c.session, (count.get(c.session) ?? 0) + 1);
  const own = ownSession(tmux, env);
  if (own !== null && count.has(own)) count.set(own, count.get(own)! - 1);
  return new Set([...count].filter(([, n]) => n > 0).map(([s]) => s));
}

/**
 * `vdx ai --state`: `@vdx_state` of the agent's own tmux session, from the transcript of the
 * conversation the hook names (or the agent's live one) — run by the vdx plugin's Stop hook, so a
 * wrap shows as finished when its turn ends. Prints nothing and exits 0 whatever happens: what a
 * hook prints goes to the agent. Outside tmux it does nothing.
 */
export function runAiState(
  pathArg: string,
  deps: AiDeps,
  selfPid: number = process.pid,
  conversation?: string,
): number {
  const pane = ownPane(deps.env);
  if (!pane) return EXIT_OK;
  const projectRoot = resolveProjectRoot(pathArg);
  if (!projectRoot) return EXIT_OK;
  let wrapSkills: readonly string[] = [];
  const profilePath = resolveEnvironmentPath(deps.env, deps.home);
  if (profilePath) {
    try {
      wrapSkills = loadEnvironment(profilePath).session?.wrap_skills ?? [];
    } catch {
      // a profile that does not load names no wrap skill: finished is never said
    }
  }
  let id = conversation ?? null;
  if (!id) {
    const own = findOwnAgent(deps.processes(), selfPid, 'claude');
    id = own ? liveConversationId(deps.env, deps.home, own.pid) : null;
  }
  keepState(deps, pane, projectRoot, wrapSkills, id);
  return EXIT_OK;
}

/** `vdx ai --report <path>`: this machine's RemoteReport on the project, as JSON on stdout. */
export function runAiReport(pathArg: string, deps: AiDeps): number {
  const prepared = prepare(pathArg, deps);
  if (typeof prepared === 'number') return prepared;
  const { plan, environment } = prepared;
  const wrapSkills = environment.session?.wrap_skills ?? [];
  const procs = deps.processes();
  const agents = deps.tmux.available() ? findAgentPanes(deps.tmux.panes(), procs, plan.projectRoot, plan.command) : [];
  const files = conversationFiles({ env: deps.env, home: deps.home, projectRoot: plan.projectRoot });
  const ids = new Set(files.map((f) => path.basename(f.file, '.jsonl')));
  const report: RemoteReport = {
    vdx: deps.version ?? '',
    machine: plan.host,
    home: deps.home,
    sessions: (deps.liveHere ?? (() => liveSessionsHere(deps.env, deps.home)))(),
    agents: agentFacts(agents, plan, deps, procs, wrapSkills, {
      focused: deps.agentFocused ?? processFocused,
      mail: deps.agentMail ?? ((pid) => processMode(pid) === 'mail'),
      hq: hqOf(deps),
    }),
    typed: [...typedHere(deps.env, deps.home, ids)],
    history: [...historyMarks(deps.env, deps.home, ids)].map(([id, m]) => ({ id, ...m })),
    transcripts: files.map((f) => ({ id: path.basename(f.file, '.jsonl'), mtime: f.updated.getTime(), size: f.size })),
    ips: (deps.addresses ?? ownAddresses)(),
    ...(realpathOr(plan.projectRoot) === realpathOr(deps.home) ? { tmux: sessionFactsHere(deps, plan.host) } : {}),
  };
  deps.out(JSON.stringify(report) + '\n');
  return EXIT_OK;
}

/** An agent another machine runs, shown to the person as a row of a list. */
interface Shown {
  machine: string;
  pid: number;
}

/** What a start continues: resume args here, or a conversation on another machine. */
interface ConversationChoice {
  args: string[];
  /**
   * Continue it on that machine (`vdx ai@<host>`); `reachable` — it answered over ssh just now. `ask` — why it
   * goes there though the start named it here: put to the person first (vdx-ai-list-owner-findings DL #8).
   */
  remote?: { host: string; id: string; reachable: boolean; ask?: string; runs?: boolean };
  /** Continue it here only after a yes: another machine's that cannot be asked, or one running here already. */
  askHere?: { id: string; why: string };
  /** The person ended the question (Ctrl-D): start nothing. */
  abort?: boolean;
  /**
   * A conversation picked on the list goes on as what it was: a focused one with its topic, the HQ session's as
   * the HQ session (vdx-ai-list-owner-findings П. 1, П. 4).
   */
  focused?: { topic: string };
  hq?: boolean;
  /** A new conversation nobody picked, while an agent of the project runs on these machines: only after a yes. */
  elsewhere?: string[];
  /** For the person: what was found and what is taken. */
  lines: string[];
}

function isClaude(command: string): boolean {
  return path.basename(command) === 'claude';
}

const resumeId = (id: string) => ['--resume', id];

/** A conversation a start of the person's may continue: not the intercom or the HQ session's, not a program's. */
const isPersons = (c: Conversation) => !c.mail && !c.hq && !c.automated;

/**
 * What a choice of conversation stands on: what runs on every machine (this one from its
 * session files, the others over ssh), each conversation's machine, and how one is continued —
 * on its own machine (vdx-ai DL #27). chooseConversation and the list of a plain start
 * (vdx-ai-predictable) both decide from it.
 */
function conversationContext(
  plan: LaunchPlan,
  deps: AiDeps,
  wrapSkills: readonly string[] = [],
  shown: readonly Shown[] = [],
) {
  const host = plan.host;
  const same = sameMachine;
  // An intercom or HQ session's conversations are its own: a start of the person's never continues one.
  const listed =
    plan.resumeArgs.length === 0
      ? []
      : listConversations({ env: deps.env, home: deps.home, projectRoot: plan.projectRoot, wrapSkills });
  // Nor a program's run through the SDK: nobody sits at it.
  const persons = listed.filter(isPersons);
  const asideCount = listed.length - persons.length;
  const hqCount = listed.filter((c) => c.hq).length;
  const whose =
    hqCount === 0
      ? "the intercom session's"
      : hqCount === asideCount
        ? "the HQ session's"
        : "the intercom and HQ sessions'";
  const onlyAside = `only ${whose} conversations here (${asideCount}; vdx ai --conversation <id> opens one) — starting a new one`;
  const root = shellQuote(plan.projectRoot);
  // Said from where the person sits: under `vdx ai@<host>` that is not this machine.
  const atSeat = same(plan.seat, host);
  const on = (m: string) => (same(m, plan.seat) ? (atSeat ? 'here' : `on ${m}, where you are,`) : `on ${m}`);

  // Who runs what right now: this machine from its session files, the others over ssh.
  const reach = new Map<string, Reach | null>();
  for (const m of [...plan.machines, ...persons.map((c) => c.machine)]) {
    if (m && !same(m, host) && ![...reach.keys()].some((k) => same(k, m)))
      reach.set(m, askMachine(m, deps, plan.projectRoot));
  }
  // Left after a look (Sidetrack #18): `/clear` is in the history.jsonl of the machine it was typed on,
  // and that file is not synced — this machine's, and the others' from their reports.
  const marks = historyMarks(deps.env, deps.home, new Set(persons.map((c) => c.id)));
  for (const [, r] of reach)
    if (r?.report?.history)
      joinMarks(
        marks,
        r.report.history.map((h) => [h.id, h]),
      );
  const all = persons.map((c) => (!c.finished && isLeftAfterLook(marks.get(c.id)) ? { ...c, leftAfterLook: true } : c));
  const silent = [...reach]
    .filter(([, r]) => r === null)
    .map(
      ([m]) =>
        `note: ${m} does not answer over ssh — what runs there is not known, nor which of its conversations were left after a look`,
    );
  const elsewhere = [...reach].flatMap(([m, r]) =>
    (r?.sessions ?? []).filter((l) => runsInProject(l, r!.home, plan.projectRoot, deps.home)).map((l) => ({ m, l })),
  );
  // The project's path on the machine `m`, by its home: the person types it there.
  const rootOn = (m: string) => {
    const theirs = [...reach].find(([k]) => same(k, m))?.[1]?.home;
    const rel = path.relative(deps.home, plan.projectRoot);
    return theirs && !rel.startsWith('..') && !path.isAbsolute(rel) ? shellQuote(path.join(theirs, rel)) : root;
  };
  // `vdx ai` attaches to an agent in tmux; one in a terminal of its own has no command to reach it.
  const reachAgent = (m: string, l: LiveSession) =>
    !l.tmux ? '' : same(m, plan.seat) ? ` — attach: vdx ai ${rootOn(m)}` : ` — there: vdx ai@${m} ${root}`;
  // An agent the person saw as a row of the list a new one was picked from is no news: the pick was
  // the yes (vdx-ai DL #29). The focused list shows only focused sessions — a plain one is still asked about.
  const unseen = elsewhere.filter(({ m, l }) => !shown.some((s) => same(s.machine, m) && s.pid === l.pid));
  const fresh = (lines: string[]): ConversationChoice => {
    if (unseen.length === 0) return { args: [], lines };
    const agents = unseen.map(({ m, l }) => `an agent of this project is ${describeLive(on(m), l)}${reachAgent(m, l)}`);
    return { args: [], elsewhere: [...new Set(unseen.map(({ m }) => m))], lines: [...lines, ...agents] };
  };

  const live = new Map<string, { machine: string; session: LiveSession; here: boolean }[]>();
  const addLive = (machine: string, session: LiveSession, here: boolean) =>
    live.set(session.conversation, [...(live.get(session.conversation) ?? []), { machine, session, here }]);
  for (const l of (deps.liveHere ?? (() => liveSessionsHere(deps.env, deps.home)))()) addLive(host, l, true);
  for (const [m, r] of reach) for (const l of r?.sessions ?? []) addLive(m, l, false);

  const machine = (c: Conversation) => live.get(c.id)?.find((l) => !l.here)?.machine ?? machineOf(c, host);
  const runsHere = (c: Conversation) => live.get(c.id)?.find((l) => l.here);
  const isOurs = (c: Conversation) => same(machine(c), host);
  const idleHere = (c: Conversation) => isOurs(c) && !runsHere(c);
  const found = [...new Set([...latestPerMachine(all, machine), ...all.filter((c) => live.has(c.id))])].sort(
    (a, b) => b.updated.getTime() - a.updated.getTime(),
  );
  const show = (c: Conversation) => describeConversation(c, machine(c));
  const running = (c: Conversation) => (live.get(c.id) ?? []).map((l) => describeLive(on(l.machine), l.session));

  const take = (c: Conversation): ConversationChoice => {
    const m = machine(c);
    const here = runsHere(c);
    if (here) {
      return {
        args: [],
        askHere: {
          id: c.id,
          why: `It runs ${on(host)} right now (${here.session.tmux ?? `pid ${here.session.pid}`}); two sessions would write to it`,
        },
        lines: [`chosen: ${show(c)}`],
      };
    }
    if (isOurs(c)) return { args: resumeId(c.id), lines: [`continuing ${show(c)}`] };
    if (m)
      return {
        args: [],
        remote: { host: m, id: c.id, reachable: reach.get(m) != null },
        lines: [`continuing on ${m}: ${show(c)}`],
      };
    return {
      args: [],
      askHere: {
        id: c.id,
        why: `Its machine is unknown (never typed in ${on(host)}); if it runs there, both machines will write to it`,
      },
      lines: [`chosen: ${show(c)}`],
    };
  };
  return {
    host,
    same,
    all,
    asideCount,
    onlyAside,
    root,
    atSeat,
    on,
    reach,
    silent,
    elsewhere,
    rootOn,
    fresh,
    live,
    machine,
    runsHere,
    isOurs,
    idleHere,
    found,
    show,
    running,
    take,
  };
}

/**
 * Before a start that names its conversation (`--conversation <id>`) goes on in it here: whether it runs on another
 * machine, or a copy there is ahead of this one — the list's check, for a start that skips the list
 * (vdx-ai-list-owner-findings П. 5, DL #8). The profile's machines and the conversation's own are asked over ssh.
 * `there` — the machine it goes on on instead, and why; `notes` — the machines that did not answer.
 */
function conversationElsewhere(
  plan: LaunchPlan,
  deps: AiDeps,
  id: string,
): { there: { host: string; why: string; runs?: boolean } | null; notes: string[] } {
  const input = { env: deps.env, home: deps.home, projectRoot: plan.projectRoot };
  const own = conversationById({ ...input, id })?.machine ?? null;
  const machines: string[] = [];
  for (const m of [...plan.machines, own])
    if (m && !sameMachine(m, plan.host) && !machines.some((x) => sameMachine(x, m))) machines.push(m);
  const file = conversationFiles(input).find((f) => path.basename(f.file, '.jsonl') === id);
  const ours: TranscriptCopy | null = file ? { mtime: file.updated.getTime(), size: file.size } : null;
  const notes: string[] = [];
  let lead: { host: string; copy: TranscriptCopy } | null = null;
  for (const m of machines) {
    const r = askMachine(m, deps, plan.projectRoot);
    if (!r) {
      notes.push(
        `note: ${m} does not answer over ssh — whether ${id.slice(0, 8)} runs there, or its copy there is newer, is not known`,
      );
      continue;
    }
    const live = r.sessions.find((l) => l.conversation === id);
    if (live) {
      const where = live.tmux ? ` (${live.tmux.replace(/:.*$/, '')})` : '';
      return { there: { host: m, why: `${id.slice(0, 8)} runs on ${m} right now${where}`, runs: true }, notes };
    }
    const t = r.report?.transcripts.find((x) => x.id === id);
    if (t && copyAhead(t, lead?.copy ?? ours)) lead = { host: m, copy: t };
  }
  if (!lead) return { there: null, notes };
  const more = ours ? lead.copy.size - ours.size : 0;
  const why = !ours
    ? `${plan.host} has no copy of ${id.slice(0, 8)} yet, ${lead.host} has`
    : `the copy of ${id.slice(0, 8)} on ${plan.host} is behind ${lead.host}'s` +
      (more > 0 ? ` by ${Math.max(1, Math.round(more / 1024))} KB` : '') +
      ' — Syncthing has not brought it yet';
  return { there: { host: lead.host, why }, notes };
}

/**
 * Which conversation a start continues. Other agents keep the profile's
 * resume_args. For Claude Code vdx reads the project's conversations and the
 * machine each belongs to (conversations.ts): `--continue` would take the
 * newest one in the folder, and with the folder synced between machines that
 * can be a conversation another machine is still writing to.
 *
 * The profile's other machines, and every other machine this project's
 * conversations name, are asked over ssh what runs there right now; this
 * machine's running ones come from its own session files. A running
 * conversation is listed even when it is not its machine's newest.
 *
 * A new conversation the person did not pick from the list — `--new`, a
 * project with none yet, none of this machine's idle — while an agent of this
 * project runs on another machine (by the directory it runs in) is started
 * only after a yes: two agents would work in one repository from two machines.
 *
 * Another machine's conversation is continued on that machine, so two
 * machines never write to one conversation; one whose machine is unknown, or
 * cannot be reached, or that already runs here, is continued here only after a
 * yes. When the choice is not plain, a person at a terminal picks — Enter
 * takes the newest overall; without a terminal it is this machine's newest
 * idle one, never another's.
 */
function chooseConversation(
  plan: LaunchPlan,
  deps: AiDeps,
  canAsk: boolean,
  shown: readonly Shown[] = [],
): ConversationChoice {
  if (!isClaude(plan.command)) return { args: plan.resumeArgs, lines: [] };
  const {
    host,
    same,
    all,
    asideCount,
    onlyAside,
    root,
    atSeat,
    on,
    silent,
    rootOn,
    fresh,
    machine,
    runsHere,
    idleHere,
    found,
    show,
    running,
    take,
  } = conversationContext(plan, deps, [], shown);
  if (plan.resumeArgs.length === 0) return fresh(silent);
  if (all.length === 0) {
    return fresh([asideCount ? onlyAside : 'no conversation of this project yet — starting a new one', ...silent]);
  }
  if (found.every(idleHere)) {
    const chosen = take(found[0]!);
    return { ...chosen, lines: [...chosen.lines, ...silent] };
  }

  const firstIdle = found.find(idleHere);
  if (canAsk && asks(deps)) {
    deps.log('conversations of this project:');
    found.forEach((c, i) => {
      const marks = [
        i === 0 && 'newest',
        c === firstIdle && (atSeat ? 'this machine' : `idle on ${host}`),
        !machine(c) && 'machine unknown',
        ...running(c),
      ];
      const m = marks.filter(Boolean);
      deps.log(`  ${i + 1}) ${show(c)}${m.length ? `   ← ${m.join(', ')}` : ''}`);
    });
    deps.log('  n) a new conversation');
    // A machine that did not answer may run any of these: say so before the person picks.
    for (const n of silent) deps.log(`  ${n}`);
    for (let tries = 0; tries < 2; tries++) {
      const answer = deps.ask(`Which one to continue? [1]: `);
      // Ctrl-D at the question is a cancel, not "no terminal": start nothing.
      if (answer === null) return { args: [], abort: true, lines: ['no answer — nothing started'] };
      const a = answer.trim();
      if (/^n(ew)?$/i.test(a)) return { args: [], lines: ['a new conversation'] };
      const c = a === '' ? found[0] : /^\d+$/.test(a) ? found[Number(a) - 1] : undefined;
      if (c) return take(c);
      deps.log(`  1–${found.length}, or n`);
    }
  }
  const notes = found
    .filter((c) => !idleHere(c))
    .map((c) => {
      const m = machine(c);
      const now = running(c);
      const which =
        `${c.updated > (firstIdle?.updated ?? new Date(0)) ? 'a newer' : 'another'} conversation ${c.id.slice(0, 8)}` +
        (now.length ? `, ${now.join(', ')}` : '');
      if (runsHere(c)) return `note: ${which} — not taken: it would have two sessions`;
      if (m && same(m, plan.seat))
        return `note: ${m} has ${which} — continue it where you are: vdx ai ${rootOn(m)} --conversation ${c.id}`;
      return m
        ? `note: ${m} has ${which} — continue it there: vdx ai@${m} ${root} --conversation ${c.id}`
        : `note: ${which} is of an unknown machine (never typed in ${on(host)}) — on its machine: vdx ai@<machine> ${root} --conversation ${c.id}`;
    });
  notes.push(...silent);
  if (firstIdle) {
    const chosen = take(firstIdle);
    return { ...chosen, lines: [...chosen.lines, ...notes] };
  }
  return fresh([`no idle conversation ${atSeat ? 'of this machine' : `on ${host}`} — starting a new one`, ...notes]);
}

/** What a plain start of Claude Code comes to, after the list or without it. */
type BoardOutcome =
  | { kind: 'attach'; agent: AgentPane; open: boolean; lines: string[] }
  | { kind: 'remote'; host: string; conversation: string | null; hq?: boolean; lines: string[] }
  | { kind: 'continue'; choice: ConversationChoice }
  | { kind: 'new'; focused: boolean; lines: string[] }
  | { kind: 'abort'; lines: string[] }
  | { kind: 'restore' }
  | { kind: 'session'; host: string; session: string; lines: string[] }
  | { kind: 'listed' };

/**
 * A plain start of Claude Code (vdx-ai-predictable): the project's agents on every machine and
 * its conversations nobody runs, in one list (board.ts). Silent in three cases only — one agent
 * runs on all the machines and no terminal at this seat shows it: attach; none runs, and the
 * newest conversation is this machine's and not finished: continue it; the project has no
 * conversation: a new one. `print` (`--list`, `--dry-run`) shows the list and decides nothing;
 * `auto` (no terminal) takes the marked row if it is this machine's. `find` (`--find`) — the
 * list is what a search for it found, never silent; `/<phrase>` at the question searches too.
 * `restore` — how many agents a fallen tmux server took down that `r` brings back: never silent
 * then, and Enter is `r` (DL #9).
 */
function boardStart(
  plan: LaunchPlan,
  deps: AiDeps,
  local: AgentPane[],
  /** The project's HQ session here: a row of the list, its number attaches to it as it is. */
  hqPanes: AgentPane[],
  procs: ProcInfo[],
  wrapSkills: readonly string[],
  modeOf: ModeOf,
  mode: 'ask' | 'print' | 'auto',
  find?: string,
  restore = 0,
  /** The profile's `session.machine_icons`. */
  machineIcons: Record<string, string> = {},
  /**
   * What a fall took down, in the list's words: notes for under it (other projects'), the panel of `r` in the
   * picker, and what `r` brings back.
   */
  lostWords: { footnotes: string[]; restoreDetail: string[]; what?: string } = { footnotes: [], restoreDetail: [] },
): BoardOutcome {
  const k = conversationContext(plan, deps, wrapSkills);
  const here = agentFacts(local, plan, deps, procs, wrapSkills, modeOf);
  const paneOf = new Map([...local, ...hqPanes].map((a) => [a.proc.pid, a]));
  const copy = (id: string | null) =>
    id ? conversationById({ env: deps.env, home: deps.home, projectRoot: plan.projectRoot, id, wrapSkills }) : null;
  const there: AgentFact[] = [];
  const typedOn = new Map<string, string>();
  const behind = new Map<string, string>();
  const files = new Map(
    conversationFiles({ env: deps.env, home: deps.home, projectRoot: plan.projectRoot }).map((f) => [
      path.basename(f.file, '.jsonl'),
      f,
    ]),
  );
  const fileCopy = (id: string): TranscriptCopy | null => {
    const f = files.get(id);
    return f ? { mtime: f.updated.getTime(), size: f.size } : null;
  };
  // Of several machines ahead of ours, the one most ahead.
  const leadCopy = new Map<string, TranscriptCopy>();
  for (const [m, r] of k.reach) {
    if (!r) continue;
    if (r.report) {
      there.push(...r.report.agents.map((a) => ({ ...a, machine: m })));
      for (const id of r.report.typed) if (!typedOn.has(id)) typedOn.set(id, m);
      // Their copy ahead of ours: ours is behind, and that machine writes it.
      for (const t of r.report.transcripts) {
        if (!copyAhead(t, leadCopy.get(t.id) ?? fileCopy(t.id))) continue;
        behind.set(t.id, m);
        leadCopy.set(t.id, t);
      }
      continue;
    }
    // An older vdx there, or none: what its session files say, the rest from our copy.
    // The project's by the directory it runs in, or by its conversation being one of the project's.
    const ofProject = (l: LiveSession) =>
      runsInProject(l, r.home, plan.projectRoot, deps.home) || files.has(l.conversation);
    for (const l of r.sessions.filter(ofProject)) {
      const c = copy(l.conversation);
      there.push({
        machine: m,
        session: l.tmux?.replace(/:.*$/, '') ?? null,
        pid: l.pid,
        conversation: l.conversation,
        status: l.status,
        activeAt: null,
        draft: 0,
        focused: false,
        topic: c?.topic ?? null,
        mail: c?.mail ?? false,
        hq: c?.hq ?? false,
        openAt: [],
        title: c?.title ?? null,
        ...transcriptFacts(c, false),
      });
    }
  }
  const machineOf = (c: Conversation) => behind.get(c.id) ?? k.machine(c) ?? typedOn.get(c.id) ?? null;
  // Claude Code running here outside tmux: no pane to attach to, and a second session in its
  // conversation would write to it — continued only after a yes (take).
  const outside: AgentFact[] = (deps.liveHere ?? (() => liveSessionsHere(deps.env, deps.home)))()
    .filter((l) => !paneOf.has(l.pid) && !local.some((a) => a.proc.pid === l.pid))
    .filter((l) => files.has(l.conversation) || runsInProject(l, deps.home, plan.projectRoot, deps.home))
    .filter((l) => !l.tmux)
    .map((l) => {
      const c = copy(l.conversation);
      const live = liveSessionFile(deps.env, deps.home, l.pid);
      return {
        machine: plan.host,
        session: null,
        pid: l.pid,
        conversation: l.conversation,
        status: l.status,
        activeAt: live?.activeAt ?? null,
        draft: 0,
        focused: modeOf.focused(l.pid),
        topic: c?.topic ?? null,
        mail: c?.mail ?? false,
        hq: c?.hq ?? false,
        openAt: [plan.host],
        title: c?.title ?? null,
        ...transcriptFacts(c, false),
      };
    });
  // `?` — a terminal over ssh from a machine nothing names: the attaches of a vdx older than 0.44
  // carry no seat mark. When the profile has one machine besides the agent's, it is that one.
  const machinesAll = [plan.host, ...plan.machines];
  // The machines a conversation nobody runs can go on on (vdx-ai-list-owner-findings П. 5): the profile's, this one first.
  const choices = machinesAll.filter((m, i) => machinesAll.findIndex((x) => sameMachine(x, m)) === i);
  // A copy of a conversation on a machine: its length and time; none there; the machine did not answer; or its vdx
  // sends no copies (older than 0.44).
  type CopyOn = { kind: 'copy'; copy: TranscriptCopy } | { kind: 'none' | 'silent' | 'old' };
  const copyOn = (m: string, id: string): CopyOn => {
    if (sameMachine(m, plan.host)) {
      const c = fileCopy(id);
      return c ? { kind: 'copy', copy: c } : { kind: 'none' };
    }
    const r = [...k.reach].find(([x]) => sameMachine(x, m))?.[1];
    if (!r) return { kind: 'silent' };
    if (!r.report) return { kind: 'old' };
    const t = r.report.transcripts.find((x) => x.id === id);
    return t ? { kind: 'copy', copy: t } : { kind: 'none' };
  };
  /**
   * Whether conversation `id` may go on on machine `m`, in the words of its row: only where the copy is the newest —
   * a copy behind another machine's would go on without its end, and Syncthing would keep two (DL #8).
   */
  const copyState = (m: string, id: string): { ok: boolean; word: string } => {
    const s = copyOn(m, id);
    if (s.kind === 'silent') return { ok: false, word: 'does not answer over ssh' };
    if (s.kind === 'old') return { ok: true, word: 'its vdx sends no copies (older than 0.44): not compared' };
    const ours = s.kind === 'copy' ? s.copy : null;
    let lead: { m: string; copy: TranscriptCopy } | null = null;
    for (const x of choices) {
      if (sameMachine(x, m)) continue;
      const o = copyOn(x, id);
      if (o.kind === 'copy' && copyAhead(o.copy, lead?.copy ?? ours)) lead = { m: x, copy: o.copy };
    }
    if (lead)
      return {
        ok: false,
        word: ours
          ? `its copy is behind ${lead.m}'s — Syncthing has not brought it yet`
          : `no copy yet — ${lead.m} has it`,
      };
    return ours ? { ok: true, word: 'its copy is the newest' } : { ok: false, word: 'no copy there' };
  };
  const seatOf = <T extends { machine: string; openAt: string[] }>(a: T): T => {
    const others = machinesAll.filter((m) => !sameMachine(m, a.machine));
    return a.openAt.includes('?') && others.length === 1
      ? { ...a, openAt: a.openAt.map((s) => (s === '?' ? others[0]! : s)) }
      : a;
  };
  // A plain `ssh` client is named by the machine its address belongs to (DL #32).
  const owners = new Map((deps.addresses ?? ownAddresses)().map((ip) => [ip, plan.host] as const));
  for (const [m, r] of k.reach) for (const ip of r?.report?.ips ?? []) owners.set(ip, m);
  const agents = nameSeats(
    [...here, ...agentFacts(hqPanes, plan, deps, procs, wrapSkills, modeOf), ...outside, ...there],
    owners,
  ).map(seatOf);
  const working = agents.filter((a) => !a.mail && !a.hq);
  // In `~` (no project): every tmux session of the machines no agent row stands for (DL #32).
  const shownSessions = new Set(agents.flatMap((a) => (a.session ? [`${a.machine}\t${a.session}`] : [])));
  const sessions =
    realpathOr(plan.projectRoot) === realpathOr(deps.home)
      ? nameSeats(
          [
            ...sessionFactsHere(deps, plan.host),
            ...[...k.reach].flatMap(([m, r]) => (r?.report?.tmux ?? []).map((x) => ({ ...x, machine: m }))),
          ],
          owners,
        )
          .map(seatOf)
          .filter((x) => !shownSessions.has(`${x.machine}\t${x.session}`))
      : undefined;
  // The HQ session is a choice of its own where no terminal at this seat shows it: the plain cases
  // below are plain only without one.
  const hqToPick = agents.filter((a) => a.hq && !openAtSeat(a, plan.seat));
  const busy = new Set(working.map((a) => a.conversation));
  // A conversation running there is written right now: its copy here is a few seconds behind, and
  // it is an agent's row, not one to continue.
  for (const id of busy) if (id) behind.delete(id);
  const continuable = k.all.filter((c) => !isEmpty(c) && !busy.has(c.id));
  const conversationOf = (a: AgentFact) => k.all.find((c) => c.id === a.conversation) ?? copy(a.conversation);
  // A conversation nobody runs goes on as what it was (vdx-ai-list-owner-findings П. 1, П. 4).
  const modeOfConversation = (c: Conversation): { focused?: { topic: string }; hq?: boolean } =>
    c.hq ? { hq: true } : c.topic !== null ? { focused: { topic: c.topic } } : {};
  const outcomeOf = (pick: Pick, why: string[]): BoardOutcome => {
    if (pick.kind === 'session')
      return { kind: 'session', host: pick.session.machine, session: pick.session.session, lines: why };
    if (pick.kind === 'agent') {
      const a = pick.agent;
      const pane = paneOf.get(a.pid);
      if (pane) return { kind: 'attach', agent: pane, open: openAtSeat(a, plan.seat), lines: why };
      // The HQ session there is reached by its flag: by its conversation, a vdx there would start
      // a second agent in it next to the HQ session.
      if (a.hq && !sameMachine(a.machine, plan.host))
        return { kind: 'remote', host: a.machine, conversation: null, hq: true, lines: why };
      if (sameMachine(a.machine, plan.host)) {
        const c = conversationOf(a);
        if (!c) return { kind: 'abort', lines: [...why, `vdx cannot read the conversation of pid ${a.pid}`] };
        const chosen = k.take(c);
        return { kind: 'continue', choice: { ...chosen, lines: [...why, ...chosen.lines] } };
      }
      return { kind: 'remote', host: a.machine, conversation: a.conversation, lines: why };
    }
    if (pick.kind === 'conversation') {
      const m = pick.on ?? pick.machine;
      const c = pick.conversation;
      const mode = modeOfConversation(c);
      // One HQ session per project and machine: the one running there is where its work goes on.
      const hqThere = c.hq && agents.find((a) => a.hq && sameMachine(a.machine, m ?? plan.host));
      if (hqThere)
        return {
          kind: 'abort',
          lines: [
            ...why,
            `the HQ session runs on ${hqThere.machine}: ${reachOf({ kind: 'agent', agent: hqThere }) ?? 'vdx ai --hq'} attaches to it; ` +
              `to go on with ${c.id.slice(0, 8)} in it instead — vdx ai${sameMachine(hqThere.machine, plan.seat) ? '' : `@${hqThere.machine}`} ${k.root} --hq --restart --conversation ${c.id}`,
          ],
        };
      // Here by the person's choice, though its machine is another: the copy here is the newest (П. 5).
      if (pick.on && sameMachine(pick.on, plan.host))
        return {
          kind: 'continue',
          choice: {
            args: resumeId(c.id),
            ...mode,
            lines: [...why, `continuing ${k.on(plan.host)}: ${describeConversation(c, pick.machine)}`],
          },
        };
      if (m && !sameMachine(m, plan.host)) {
        return {
          kind: 'continue',
          choice: {
            args: [],
            remote: { host: m, id: c.id, reachable: k.reach.get(m) != null },
            ...mode,
            lines: [...why, `continuing on ${m}: ${describeConversation(c, pick.machine)}`],
          },
        };
      }
      const chosen = k.take(c);
      return { kind: 'continue', choice: { ...chosen, ...mode, lines: [...why, ...chosen.lines] } };
    }
    if (pick.kind === 'new') return { kind: 'new', focused: pick.focused, lines: why };
    if (pick.kind === 'restore') return { kind: 'restore' };
    return { kind: 'abort', lines: why };
  };

  /**
   * The machine to continue conversation `c` on, picked by the person (`ctrl-o`, `<n>@`): the profile's machines,
   * each with the state of its copy; the cursor on the first other one where it may go on. Null — back to the list.
   */
  const pickMachine = (c: Conversation, own: string | null): string | null => {
    const states = choices.map((m) => ({ m, ...copyState(m, c.id) }));
    const line = (s: (typeof states)[number]) =>
      `${s.m}${sameMachine(s.m, plan.seat) ? ' (where you are)' : ''}  ${s.word}${own && sameMachine(s.m, own) ? ' · it was last here' : ''}`;
    const other = states.findIndex((s) => s.ok && !(own && sameMachine(s.m, own)));
    const cursor =
      other >= 0
        ? other
        : Math.max(
            0,
            states.findIndex((s) => s.ok),
          );
    const title = `${c.id.slice(0, 8)}${c.title ? ` «${clip(c.title, 50)}»` : ''} — go on on which machine?`;
    // The panel: the machine's copy, as the rows compare it.
    const copyFacts = (m: string): string[] => {
      const o = copyOn(m, c.id);
      if (o.kind === 'copy')
        return [
          `COPY      ${Math.max(1, Math.round(o.copy.size / 1024))} KB, written ${describeAge(new Date(o.copy.mtime))}`,
        ];
      return [
        `COPY      ${o.kind === 'none' ? 'none' : o.kind === 'silent' ? 'not known — no answer over ssh' : 'not known — its vdx is older than 0.44'}`,
      ];
    };
    if (deps.pick) {
      const answer = deps.pick({
        header: [title, 'Enter takes the machine · Esc — back to the list'],
        items: states.map((s) => ({ text: line(s), detail: copyFacts(s.m) })),
        cursor,
        columns: deps.columns,
      });
      if (answer === null || answer === 'failed' || answer.key !== '' || answer.index === null) return null;
      return states[answer.index]?.m ?? null;
    }
    deps.log(title);
    states.forEach((s, i) => deps.log(`  ${i + 1}) ${line(s)}`));
    const answer = deps.ask(`Which machine? [${cursor + 1}]: `);
    if (answer === null) return null;
    const a = answer.trim();
    if (a === '') return states[cursor]!.m;
    return /^\d+$/.test(a) ? (states[Number(a) - 1]?.m ?? a) : a;
  };
  /**
   * A row to continue on another machine (vdx-ai-list-owner-findings П. 5, DL #8): only a conversation nobody runs,
   * and only where its copy is the newest. A string — why not, said above the list; null — back to the list.
   */
  const goElsewhere = (p: { row: Pick; on: string | null }): BoardOutcome | string | null => {
    if (p.row.kind !== 'conversation')
      return p.row.kind === 'agent'
        ? 'that agent runs — Enter attaches to it; only a conversation nobody runs goes on on another machine'
        : 'only a conversation nobody runs goes on on another machine';
    if (choices.length < 2) return 'the profile names no other machine (session.machines)';
    const c = p.row.conversation;
    const on = p.on ?? pickMachine(c, p.row.machine);
    if (on === null) return null;
    const target = choices.find((m) => sameMachine(m, on));
    if (!target) return `${on} is not a machine of the profile: ${choices.join(', ')}`;
    const state = copyState(target, c.id);
    if (!state.ok) return `${c.id.slice(0, 8)} does not go on on ${target}: ${state.word}`;
    return outcomeOf({ kind: 'conversation', conversation: c, machine: p.row.machine, on: target }, []);
  };

  // `a`: every conversation of the project, not only the newest the start read — the HQ session's among them,
  // marked 👑: a past HQ conversation is found there, not by grep (vdx-ai-list-owner-findings DL #5).
  const everyOne = () =>
    listConversations({
      env: deps.env,
      home: deps.home,
      projectRoot: plan.projectRoot,
      limit: Infinity,
      wrapSkills,
    }).filter((c) => isPersons(c) || (c.hq && !c.mail && !c.automated));
  // The command that reaches a row from this seat (Sidetrack #7): a running agent by its conversation,
  // which attaches to it, on its machine; a conversation nobody runs, continued there.
  const reachOf = (p: Pick): string | null => {
    if (p.kind === 'session')
      return sameMachine(p.session.machine, plan.seat)
        ? `vdx ai --attach ${shellQuote(p.session.session)}`
        : `vdx ai@${p.session.machine} --attach ${shellQuote(p.session.session)}`;
    if (p.kind !== 'agent' && p.kind !== 'conversation') return null;
    if (p.kind === 'agent' && p.agent.hq)
      return sameMachine(p.agent.machine, plan.seat)
        ? `vdx ai ${k.rootOn(p.agent.machine)} --hq`
        : `vdx ai@${p.agent.machine} ${k.root} --hq`;
    if (p.kind === 'agent' && (!p.agent.session || !p.agent.conversation)) return null;
    const id = p.kind === 'agent' ? p.agent.conversation! : p.conversation.id;
    const m = p.kind === 'agent' ? p.agent.machine : p.machine;
    // A conversation nobody runs goes on as what it was; a running agent keeps its mode on its own.
    const as =
      p.kind !== 'conversation' ? '' : p.conversation.hq ? ' --hq' : p.conversation.topic !== null ? ' --focused' : '';
    if (m === null) return `on its machine: vdx ai@<machine> ${k.root}${as} --conversation ${id}`;
    return sameMachine(m, plan.seat)
      ? `vdx ai ${k.rootOn(m)}${as} --conversation ${id}`
      : `vdx ai@${m} ${k.root}${as} --conversation ${id}`;
  };
  // At a terminal the list is a table: titles bold, commands dim, captions cut to its width.
  const look = {
    ...lostWords,
    command: reachOf,
    color: deps.interactive && !deps.env['NO_COLOR'],
    columns: deps.interactive ? deps.columns : undefined,
    pickerColumns: deps.interactive && deps.columns ? rowsWidth(deps.columns) : undefined,
  };
  const make = (limit: number | 'all') =>
    buildBoard({
      project: plan.project,
      host: plan.host,
      seat: plan.seat,
      agents,
      sessions,
      conversations: limit === 'all' ? everyOne() : k.all,
      unread: files.size - k.all.length - k.asideCount,
      machineOf,
      behind,
      silent: [...k.reach].filter(([, r]) => r === null).map(([m]) => m),
      machines: choices,
      limit,
      restore: mode === 'ask' ? restore : 0,
      restoreWhat: lostWords.what,
      machineIcons,
      reach: mode === 'print' ? reachOf : undefined,
      ...look,
    });
  const show = (b: Board, to: (line: string) => void) => {
    for (const l of b.lines) to(l);
  };
  // What a search found (vdx-ai-predictable P5): the running agents and the conversations whose
  // replies have the phrase, each with the text around it. A string — nothing found, said so.
  const search = (phrase: string, print: boolean): Board | string => {
    const found = findInConversations({ env: deps.env, home: deps.home, projectRoot: plan.projectRoot, phrase });
    if (found === null) return `«${phrase}» has no letters or digits to search for`;
    const read = new Map(k.all.map((c) => [c.id, c]));
    const typed = typedHere(deps.env, deps.home, new Set(found.map((f) => f.id)));
    const conversations = found
      .map((f) => read.get(f.id) ?? readConversation(f.file, f.updated, wrapSkills))
      .filter((c): c is Conversation => c !== null && isPersons(c))
      .map((c) => (read.has(c.id) ? c : { ...c, typedHere: typed.has(c.id) }));
    const ids = new Set(conversations.map((c) => c.id));
    const ran = working.filter((a) => a.conversation !== null && ids.has(a.conversation));
    if (ids.size === 0)
      return `no conversation of ${plan.project} has «${phrase}» — searched what you and the agent said in ${files.size} conversations`;
    const around = new Map(
      found.map((f) => [f.id, `${f.who}: «${f.around}»${f.hits > 1 ? ` (${f.hits} replies have it)` : ''}`]),
    );
    return buildBoard({
      project: plan.project,
      host: plan.host,
      seat: plan.seat,
      agents: ran,
      conversations,
      machineOf,
      behind,
      silent: [...k.reach].filter(([, r]) => r === null).map(([m]) => m),
      machines: choices,
      find: { phrase, searched: files.size, around },
      // Nobody to ask: the command for each row — the conversation's id is not on the row whole.
      reach: print ? reachOf : undefined,
      restore: print ? 0 : restore,
      restoreWhat: lostWords.what,
      machineIcons,
      ...look,
    });
  };
  if (mode === 'print') {
    const b = find !== undefined ? search(find, true) : make(5);
    if (typeof b === 'string') deps.out(b + '\n');
    else show(b, (t) => deps.out(t + '\n'));
    return { kind: 'listed' };
  }

  // Nobody to ask (no terminal, or --dry-run): this machine's agent, else its newest
  // conversation, else a new one — never another machine's, and a new one while the project's
  // agent runs elsewhere only after a yes (vdx-ai DL #29). The others are named with the command
  // that reaches them.
  if (mode === 'auto') {
    // Under --dry-run at a terminal the list is shown as well: what Enter would take.
    if (deps.interactive) show(make(5), (t) => deps.out(t + '\n'));
    const rank = (a: AgentFact) => (freeWork(a, plan.seat) ? 0 : 1);
    const mineAgent = here
      .filter((a) => !a.mail)
      .sort((a, b) => rank(a) - rank(b) || (b.activeAt ?? 0) - (a.activeAt ?? 0))[0];
    const ours = continuable.filter((c) => {
      const m = machineOf(c);
      return m !== null && sameMachine(m, plan.host) && !k.runsHere(c);
    });
    const mineConv = ours.find((c) => !c.finished && !c.leftAfterLook) ?? ours[0];
    const chosenAt = mineConv?.updated ?? new Date(0);
    const notes: string[] = [];
    for (const a of [...outside, ...there].filter((x) => !x.mail && !x.hq)) {
      const c = conversationOf(a);
      const which = `${c && c.updated > chosenAt ? 'a newer' : 'another'} conversation ${(a.conversation ?? '?').slice(0, 8)}, ${describeLive(k.on(a.machine), { pid: a.pid, conversation: a.conversation ?? '', tmux: a.session, status: a.status, cwd: null })}`;
      if (sameMachine(a.machine, plan.host)) notes.push(`note: ${which} — not taken: it would have two sessions`);
      else if (sameMachine(a.machine, plan.seat))
        notes.push(
          `note: ${a.machine} has ${which} — continue it where you are: vdx ai ${k.rootOn(a.machine)} --conversation ${a.conversation}`,
        );
      else
        notes.push(
          `note: ${a.machine} has ${which} — continue it there: vdx ai@${a.machine} ${k.root} --conversation ${a.conversation}`,
        );
    }
    for (const c of continuable) {
      if (c === mineConv) continue;
      const m = machineOf(c);
      if (m && sameMachine(m, plan.host)) continue;
      const which = `${c.updated > chosenAt ? 'a newer' : 'another'} conversation ${c.id.slice(0, 8)}`;
      if (!m)
        notes.push(
          `note: ${which} is of an unknown machine (never typed in ${k.on(plan.host)}) — on its machine: vdx ai@<machine> ${k.root} --conversation ${c.id}`,
        );
      else if (sameMachine(m, plan.seat))
        notes.push(`note: ${m} has ${which} — continue it where you are: vdx ai ${k.rootOn(m)} --conversation ${c.id}`);
      else notes.push(`note: ${m} has ${which} — continue it there: vdx ai@${m} ${k.root} --conversation ${c.id}`);
    }
    notes.push(...k.silent);
    if (mineAgent) {
      const pane = paneOf.get(mineAgent.pid)!;
      const others = here.filter((a) => !a.mail).length;
      return {
        kind: 'attach',
        agent: pane,
        open: false,
        lines: [
          ...(others > 1 ? [`note: ${others} agents of this project run here — taking ${pane.pane.session}`] : []),
          ...notes,
        ],
      };
    }
    if (mineConv) {
      const chosen = k.take(mineConv);
      return {
        kind: 'continue',
        choice: { ...chosen, ...modeOfConversation(mineConv), lines: [...chosen.lines, ...notes] },
      };
    }
    const why =
      k.all.length === 0
        ? k.asideCount
          ? k.onlyAside
          : plan.resumeArgs.length
            ? 'no conversation of this project yet — starting a new one'
            : 'the profile has no resume_args — starting a new conversation'
        : `no idle conversation ${k.atSeat ? 'of this machine' : `on ${plan.host}`} — starting a new one`;
    return { kind: 'continue', choice: k.fresh([why, ...notes]) };
  }

  // At a terminal, the plain cases: nothing to choose, and nothing a terminal at this seat
  // shows already. A search is a choice, and so is what tmux took down.
  const plain = find === undefined && restore === 0 && hqToPick.length === 0;
  const only = working.length === 1 && plain ? working[0]! : null;
  if (only && !openAtSeat(only, plan.seat)) {
    const where = sameMachine(only.machine, plan.host) ? (k.atSeat ? 'here' : `on ${plan.host}`) : `on ${only.machine}`;
    return outcomeOf({ kind: 'agent', agent: only }, [
      `the only agent of ${plan.project} runs ${where}${only.session ? ` (${only.session})` : ` (pid ${only.pid})`}, and no terminal at your seat shows it`,
      ...k.silent,
    ]);
  }
  if (working.length === 0 && plain) {
    const newest = continuable[0];
    if (!newest)
      return outcomeOf({ kind: 'new', focused: false }, [
        k.asideCount
          ? k.onlyAside
          : plan.resumeArgs.length
            ? 'no conversation of this project yet — starting a new one'
            : 'the profile has no resume_args — starting a new conversation',
        ...k.silent,
      ]);
    const m = machineOf(newest);
    if (m && sameMachine(m, plan.host) && !newest.finished && !newest.leftAfterLook && !behind.has(newest.id))
      return outcomeOf({ kind: 'conversation', conversation: newest, machine: m }, k.silent);
  }

  let board = make(5);
  // With a picker (fzf on PATH): the same list with a cursor — a row is taken, not its number typed;
  // `a`, `n`, `f` and `r` are rows of it, a search is its key. Nothing found is said above the rows.
  if (deps.pick) {
    let said: string | null = null;
    const searched = (phrase: string) => {
      const b = search(phrase, false);
      if (typeof b === 'string') said = b;
      else board = b;
    };
    if (find !== undefined) searched(find);
    for (;;) {
      const { header, items, cursor } = board.picker;
      const answer = deps.pick({
        header: said ? [said, ...header] : header,
        items,
        cursor,
        columns: deps.columns,
      });
      said = null;
      // Esc there is a cancel, as Ctrl-D at the question: start nothing.
      if (answer === null) return { kind: 'abort', lines: ['nothing picked — nothing started'] };
      if (answer === 'failed') {
        deps.log('note: fzf did not show the list — the plain one instead');
        board = make(5);
        break;
      }
      // The row's command, printed where it can be copied whole; nothing is started.
      if (answer.key === COMMAND_KEY) {
        const row = answer.index === null ? null : board.picker.items[answer.index]?.pick;
        const command = row ? reachOf(row) : null;
        if (command) {
          deps.out(`${command}\n`);
          return { kind: 'listed' };
        }
        said = 'that row has no command — it is not an agent or a conversation';
        continue;
      }
      const pick = readPicked(answer, board);
      if (pick?.kind === 'all') board = make('all');
      else if (pick?.kind === 'find') searched(pick.phrase);
      else if (pick?.kind === 'where') {
        const went = goElsewhere(pick);
        if (typeof went === 'string') said = went;
        else if (went) return went;
      } else if (pick) return outcomeOf(pick, []);
    }
  }
  // Nothing found leaves the board as it was: the line says so, the question comes again.
  const searchFor = (phrase: string): boolean => {
    const b = search(phrase, false);
    if (typeof b === 'string') {
      deps.log(b);
      return false;
    }
    board = b;
    show(board, deps.log);
    return true;
  };
  if (find === undefined || !searchFor(find)) show(board, deps.log);
  // Searches and the whole list are not wrong answers: only what is not understood counts.
  for (let wrong = 0; wrong < 3;) {
    const answer = deps.ask(`Which one? [${enterKey(board)}]: `);
    // Ctrl-D at the question is a cancel, not "no terminal": start nothing.
    if (answer === null) return { kind: 'abort', lines: ['no answer — nothing started'] };
    const pick = readAnswer(answer, board);
    if (pick?.kind === 'all') {
      board = make('all');
      show(board, deps.log);
      continue;
    }
    if (pick?.kind === 'find') {
      searchFor(pick.phrase);
      continue;
    }
    if (pick?.kind === 'where') {
      const went = goElsewhere(pick);
      if (typeof went === 'string') deps.log(went);
      if (went === null || typeof went === 'string') continue;
      return went;
    }
    if (pick) return outcomeOf(pick, []);
    wrong++;
    deps.log(
      `  1–${board.rows.length}${choices.length > 1 ? ', <n>@<machine>' : ''}, a, /<phrase>, n${board.restore ? ', f or r' : ' or f'}`,
    );
  }
  return { kind: 'abort', lines: ['nothing started'] };
}

/**
 * Several agents of the project run here and the start is about one of them: a person
 * picks — Enter takes the newest; without a terminal, or under --dry-run, it is the newest.
 * null — the person left it.
 */
function pickAgent(
  running: AgentPane[],
  focusedOf: (pid: number) => boolean,
  deps: AiDeps,
  canAsk: boolean,
): AgentPane | null {
  if (running.length === 1) return running[0]!;
  const startedAt = (a: AgentPane) => liveStartedAt(deps.env, deps.home, a.proc.pid);
  const sorted = [...running].sort((a, b) => (startedAt(b) ?? 0) - (startedAt(a) ?? 0));
  const show = (a: AgentPane) => {
    const id = liveConversationId(deps.env, deps.home, a.proc.pid);
    const at = startedAt(a);
    const topic = focusedOf(a.proc.pid) ? paneTopic(deps.tmux, a.pane.paneId) : null;
    const marks = [
      id && `conversation ${id.slice(0, 8)}`,
      focusedOf(a.proc.pid) && `focused${topic ? ` «${topic}»` : ''}`,
      at !== null && `started ${describeAge(new Date(at))}`,
    ].filter(Boolean);
    return `${a.pane.session} ${a.pane.paneId}${marks.length ? ` — ${marks.join(', ')}` : ''}`;
  };
  // Start times come from Claude Code's session files; without them, tmux's order.
  const newest = startedAt(sorted[0]!) !== null ? 'the newest' : 'the first';
  if (!canAsk || !asks(deps)) {
    deps.log(`note: ${sorted.length} agents of this project run here — taking ${newest}, ${show(sorted[0]!)}`);
    return sorted[0]!;
  }
  deps.log('agents of this project running here:');
  sorted.forEach((a, i) =>
    deps.log(`  ${i + 1}) ${show(a)}${i === 0 && newest === 'the newest' ? '   ← newest' : ''}`),
  );
  for (let tries = 0; tries < 2; tries++) {
    const answer = deps.ask('Which one? [1]: ');
    if (answer === null) return null;
    const a = answer.trim();
    const agent = a === '' ? sorted[0] : /^\d+$/.test(a) ? sorted[Number(a) - 1] : undefined;
    if (agent) return agent;
    deps.log(`  1–${sorted.length}`);
  }
  return null;
}

interface Prepared {
  projectRoot: string;
  environment: Environment;
  profilePath: string | null;
  profileDir: string;
  plan: LaunchPlan;
  /** The same plan for a focused session or a plain one; `hq` — for the HQ session, picked on the list. */
  replan: (focused: boolean, hq?: boolean) => LaunchPlan;
}

/** The project, the profile and the launch plan for `pathArg`; an exit code when there is none. */
function prepare(pathArg: string, deps: AiDeps, focused = false, intercom = false, hq = false): Prepared | number {
  const { log } = deps;

  const projectRoot = resolveProjectRoot(pathArg);
  if (!projectRoot) {
    log(`vdx ai: ${path.resolve(pathArg)} is not a directory`);
    return EXIT_USAGE;
  }

  let environment: Environment = {};
  const profilePath = resolveEnvironmentPath(deps.env, deps.home);
  if (profilePath) {
    try {
      environment = loadEnvironment(profilePath);
    } catch (e) {
      log(`vdx ai: ${errorMessage(e)}`);
      return EXIT_USAGE;
    }
  }

  const agent = environment.agent ?? fallbackAgent(deps.onPath);
  if (!agent) {
    log(
      `vdx ai: no agent to start — ${FALLBACK_AGENTS.join(' / ')} not found on PATH and no profile names one.\n` +
        `hint: put an \`agent:\` section into ~/${USER_ENVIRONMENT_FILE} (or point $${ENVIRONMENT_ENV_VAR} at your profile).`,
    );
    return EXIT_USAGE;
  }

  const profileDir = profilePath ? path.dirname(profilePath) : deps.home;
  const named = resolveProjectName({
    projectRoot,
    repo: projectIdentity(projectRoot),
    sources: environment.session?.project_names ?? [],
    home: deps.home,
    profileDir,
  });

  // Read once, here: a start drops VDX_AI_FROM from the environment before its agent starts, and a
  // plan made again after that (a running focused agent, `f` on the list) would put the person's
  // terminal at this machine — a terminal from another machine was marked with the wrong seat (2026-11-05).
  const host = hostLabel(deps.env);
  const seat = seatLabel(deps.env);
  const replan = (asFocused: boolean, asHq = hq) =>
    planLaunch({
      environment,
      profilePath,
      agent,
      projectRoot,
      project: named.name,
      projectSource: named.source,
      host,
      seat,
      focused: asFocused,
      intercom,
      hq: asHq,
    });
  let plan: LaunchPlan;
  try {
    plan = replan(focused);
  } catch (e) {
    log(`vdx ai: ${profilePath ?? 'profile'}: ${errorMessage(e)}`);
    return EXIT_USAGE;
  }
  return { projectRoot, environment, profilePath, profileDir, plan, replan };
}

/**
 * A process's environment as words (`ps -E` on macOS, /proc on Linux); null — not readable.
 * `ps -E` joins it to the command line: a word is an assignment or a piece of the command.
 */
function processEnvWords(pid: number): string[] | null {
  try {
    const environ = `/proc/${pid}/environ`;
    if (fs.existsSync(environ)) return fs.readFileSync(environ, 'utf8').split('\0');
    const out = execFileSync('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split(/\s+/);
  } catch {
    return null;
  }
}

/**
 * The seat of a tmux client: the mark `vdx ai` gave it at the attach; else a client under sshd is another
 * machine's — `ssh:<address>`, the address it came from (`SSH_CONNECTION`), which the list turns into that
 * machine by the addresses each one reports (vdx-ai-predictable DL #32: m3's `echelon@m3` had a plain `ssh m3`
 * from lft, and the list said only «open on m3»); `?` — not even that; else this machine's.
 */
export function clientSeat(
  pid: number,
  procs: ProcInfo[],
  host: string,
  envOf: (pid: number) => string[] | null = processEnvWords,
): string {
  const mark = envOf(pid)
    ?.find((w) => w.startsWith(`${SEAT_MARK_ENV_VAR}=`))
    ?.slice(SEAT_MARK_ENV_VAR.length + 1);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  let underSsh = false;
  for (let p = byPid.get(pid), n = 0; p && n < 32 && !underSsh; p = byPid.get(p.ppid), n++)
    underSsh = /\bsshd(-session)?\b/.test(p.args);
  // Under sshd a mark of this very machine is a `vdx ai` typed in an `ssh <here>` session: it took itself for
  // the seat (m3, 2026-11-19: the client from lft on `echelon@m3` marked m3). Another machine's mark is the
  // seat `vdx ai@<here>` was typed at.
  if (mark && isMachineLabel(mark) && !(underSsh && mark === host)) return mark;
  for (let p = byPid.get(pid), n = 0; p && n < 32; p = byPid.get(p.ppid), n++) {
    if (/\bsshd(-session)?\b/.test(p.args)) {
      const from = envOf(pid)
        ?.find((w) => w.startsWith('SSH_CONNECTION='))
        ?.slice('SSH_CONNECTION='.length);
      return from && /^[0-9a-fA-F.:]+$/.test(from) ? `ssh:${from}` : '?';
    }
  }
  return host;
}

/** This machine's addresses, for the other machines to tell its ssh clients by (DL #32). */
function ownAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .flatMap((i) => (i && !i.internal ? [i.address] : []));
}

/**
 * `ssh:<address>` seats named by the machine that has the address — the reports' addresses, and this machine's
 * own; one nobody has stays `?`, another machine, which not known.
 */
export function nameSeats<T extends { openAt: string[] }>(agents: T[], owners: Map<string, string>): T[] {
  const named = (s: string) => (s.startsWith('ssh:') ? (owners.get(s.slice(4)) ?? '?') : s);
  return agents.map((a) => (a.openAt.some((s) => s.startsWith('ssh:')) ? { ...a, openAt: a.openAt.map(named) } : a));
}

/** How an agent process was started: `vdx ai --focused`, `vdx ai --intercom`, `vdx ai --hq`, or none. */
export type AgentMode = 'focused' | 'mail' | 'hq' | 'plain';

/**
 * The mode from the process's environment (`ps -E` on macOS, /proc on Linux). Both marks —
 * focused: deaf wins, as intercom reads it.
 */
export function processMode(pid: number): AgentMode {
  const words = processEnvWords(pid);
  if (!words) return 'plain';
  if (words.includes(`${FOCUSED_ENV_VAR}=1`)) return 'focused';
  if (words.includes(`${HQ_ENV_VAR}=1`)) return 'hq';
  return words.includes(`${INTERCOM_ENV_VAR}=1`) ? 'mail' : 'plain';
}

function hqOf(deps: AiDeps): (pid: number) => boolean {
  return deps.agentHq ?? ((pid) => processMode(pid) === 'hq');
}

/** Was the process started focused — VDX_FOCUSED=1 in its environment? */
export function processFocused(pid: number): boolean {
  return processMode(pid) === 'focused';
}

/** macOS guards these folders on their own; a tmux server can hold a denial for every session under it. */
const GUARDED_FOLDERS = ['Downloads', 'Desktop', 'Documents'];

/**
 * The guarded folders an agent started here could not read. Through the tmux server
 * (`run-shell`): its sessions have the server's rights, not vdx's. Without a server, or
 * without tmux, this process's own — the agent gets the rights of this terminal. A folder
 * that does not exist is skipped.
 */
export function unreadableFolders(tmux: Tmux | null, home: string): string[] {
  const dirs = GUARDED_FOLDERS.map((f) => path.join(home, f));
  if (tmux) {
    // `ls`, not `[ -d ]`: a denied folder still passes -d. The answer comes back in a
    // file: tmux before 3.5 prints run-shell's output into a pane, not to the caller.
    const file = path.join(os.tmpdir(), `vdx-folders-${process.pid}-${Date.now()}`);
    const checks = dirs.map(
      (d) => `{ [ ! -d ${shellQuote(d)} ] || ls ${shellQuote(d)} >/dev/null 2>&1 || echo ${shellQuote(d)}; }`,
    );
    try {
      if (tmux.tryRun(['run-shell', `{ ${checks.join('; ')}; } > ${shellQuote(file)}`]) !== null) {
        return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      }
    } catch {
      // no answer from the server: this process's own check
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
  return dirs.filter((d) => {
    try {
      fs.readdirSync(d);
      return false;
    } catch (e) {
      const code = at(e, 'code');
      return code === 'EPERM' || code === 'EACCES';
    }
  });
}

/** One warning and its fix — the profile's `session.folders_fix`, else what works anywhere. */
export function foldersWarning(denied: string[], viaTmux: boolean, fix: string | undefined, home: string): string[] {
  const names = denied.map((d) => (d.startsWith(home + path.sep) ? `~${d.slice(home.length)}` : d)).join(', ');
  return [
    `⚠ this session cannot read ${names} — macOS holds the denial ${viaTmux ? 'in the tmux server' : 'for this terminal'}; ` +
      `files there are out of the agent's reach`,
    `  fix: ${
      fix ??
      (viaTmux
        ? 'restart the tmux server (it closes every session)'
        : 'allow this terminal app in System Settings → Privacy & Security → Files and Folders')
    }`,
  ];
}

/**
 * The agent's argv after the command. What a new conversation opens with goes first: its first
 * prompt after `--dangerously-load-development-channels <servers...>` would be read as a server.
 * A conversation that goes on gets none: it would be a new turn (hq-session-mode DL #2).
 */
function launchArgs(plan: LaunchPlan, args: string[]): string[] {
  return plan.resumeArgs.length > 0 ? args : [...plan.opening, ...args];
}

/** The mark of the agent's mode in its environment, if any: `VDX_FOCUSED`, `VDX_INTERCOM` or `VDX_HQ`. */
function modeEnvVar(plan: LaunchPlan): string | null {
  return plan.focused ? FOCUSED_ENV_VAR : plan.intercom ? INTERCOM_ENV_VAR : plan.hq ? HQ_ENV_VAR : null;
}

/** The agent's command line; its mode's mark goes in front, for the shell in its tmux pane. */
function agentLine(plan: LaunchPlan, args: string[]): string {
  const mark = modeEnvVar(plan);
  return `${mark ? `${mark}=1 ` : ''}${commandLine(plan.command, launchArgs(plan, args))}`;
}

/** The nearest ancestor of `pid` that is the agent: the session a hook or a shell tool runs in. */
export function findOwnAgent(procs: ProcInfo[], pid: number, command: string): ProcInfo | null {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  let cur = byPid.get(pid);
  for (let hops = 0; cur && cur.ppid > 1 && hops < 64; hops++) {
    cur = byPid.get(cur.ppid);
    if (cur && isAgentProcess(cur, command)) return cur;
  }
  return null;
}

/**
 * What `vdx ai --check` tells a focused session about its topic: the topic on a line of its own —
 * the transcript keeps it for `--focused --conversation` — or that the agent sets it.
 */
function focusedTopicLines(projectRoot: string, tmux: Tmux, procs: ProcInfo[], agentPid: number): string[] {
  const pane = paneOfAgent(tmux, procs, agentPid);
  if (!pane) return ["· it runs outside tmux, so it has no topic: a topic lives in the agent's tmux pane."];
  const set =
    `\`vdx ai ${shellQuote(projectRoot)} --focused "<topic>"\` ` +
    "(run here, it changes this session's topic and nothing else)";
  const topic = paneTopic(tmux, pane.paneId);
  if (topic)
    return [
      topicLine(topic),
      "· keep the conversation in it: the vdx plugin (0.11+) repeats the topic with every message of the user's, " +
        `and says what to do with a message off it. When the user names another topic: ${set}.`,
    ];
  return [
    "· this focused session has no topic yet: take it from the user's first message — or the active crystal's " +
      `name, if the message is about its work — set it with ${set}, and say it to the user in one line.`,
  ];
}

/**
 * The record of the agent `pid` for a restore after tmux falls (restore.ts): its pane, project,
 * conversation, mode and topic, under the server it runs in. The current server's records of panes
 * and agents that are gone go first. Nothing outside tmux; a state folder vdx cannot write leaves
 * no record, and the session goes on.
 */
function keepRecord(
  deps: AiDeps,
  procs: ProcInfo[],
  pid: number,
  projectRoot: string,
  mode: RecordMode,
  conversation: string | undefined,
): void {
  const server = currentServer(deps.tmux);
  if (!server) return;
  const panes = deps.tmux.panes();
  try {
    pruneRecords(deps.env, deps.home, server, new Set(panes.map((p) => p.paneId)), pidAlive);
    const pane = panes.find((p) => processTree(procs, p.panePid).some((x) => x.pid === pid));
    if (pane)
      writeRecord(deps.env, deps.home, server, {
        session: pane.session,
        pane: pane.paneId,
        project: projectRoot,
        conversation: conversation ?? liveConversationId(deps.env, deps.home, pid),
        mode,
        topic: mode === 'focused' ? paneTopic(deps.tmux, pane.paneId) : null,
        pid,
        written: Date.now(),
      });
    recordRunning(deps, server, panes, procs);
  } catch {
    // no record: the hook's text is what the session needs
  }
}

/** The agent's mode, as the hook would name it: one look at its environment, unless the deps say. */
function recordModeOf(deps: AiDeps, pid: number): RecordMode {
  if (!deps.agentFocused && !deps.agentMail && !deps.agentHq) return processMode(pid);
  if ((deps.agentFocused ?? processFocused)(pid)) return 'focused';
  if (hqOf(deps)(pid)) return 'hq';
  return (deps.agentMail ?? ((p: number) => processMode(p) === 'mail'))(pid) ? 'mail' : 'plain';
}

/**
 * Records for the agents running in tmux here that have none: started before vdx kept them (0.46),
 * and not started, resumed or cleared since, so the hook has not written one, and a restore would
 * not know them (vdx-ai-predictable DL #12). What the hook writes from inside, read from outside:
 * the project from the pane's folder, the conversation from Claude Code's session file, the mode
 * from the process's environment, the topic from the tmux session. Then every intercom session marked
 * to stay: its records say so — the hook's own record too, and one written before vdx kept the mark
 * in them (0.52) (intercom-session-mode DL #12).
 */
function recordRunning(deps: AiDeps, server: TmuxServer, panes: PaneInfo[], procs: ProcInfo[]): void {
  const have = recordedPanes(deps.env, deps.home, server);
  for (const pane of panes) {
    if (have.has(pane.paneId)) continue;
    const agent = processTree(procs, pane.panePid).find((p) => isAgentProcess(p, 'claude'));
    const project = agent ? resolveProjectRoot(pane.cwd) : null;
    if (!agent || !project) continue;
    const mode = recordModeOf(deps, agent.pid);
    writeRecord(deps.env, deps.home, server, {
      session: pane.session,
      pane: pane.paneId,
      project,
      conversation: liveConversationId(deps.env, deps.home, agent.pid),
      mode,
      topic: mode === 'focused' ? paneTopic(deps.tmux, pane.paneId) : null,
      pid: agent.pid,
      written: Date.now(),
    });
  }
  const marked = (deps.tmux.tryRun(['list-sessions', '-F', `#{session_name}\t#{${STAYS_OPTION}}`]) ?? '')
    .split('\n')
    .filter((l) => l.endsWith('\t1'))
    .map((l) => l.slice(0, -2));
  for (const session of marked) markStays(deps.env, deps.home, server, session);
}

/**
 * `vdx ai --check`: what an agent should know about how it is launched here,
 * and whether the session it runs in carries the profile's flags. Prints
 * nothing without a profile — on such a machine `vdx ai` decides nothing.
 * Run by the vdx plugin's hook, it also keeps the record of the agent's tmux pane
 * for a restore after tmux falls; `conversation` — the one the hook says starts.
 */
export function runAiCheck(
  pathArg: string,
  deps: AiDeps,
  selfPid: number = process.pid,
  conversation?: string,
): number {
  if (!resolveEnvironmentPath(deps.env, deps.home)) return EXIT_OK;
  // The hook runs in the agent's environment: a focused session's carries VDX_FOCUSED=1,
  // an intercom session's VDX_INTERCOM=1, an HQ session's VDX_HQ=1.
  const focused = deps.env[FOCUSED_ENV_VAR] === '1';
  const hq = !focused && deps.env[HQ_ENV_VAR] === '1';
  const intercom = !focused && !hq && deps.env[INTERCOM_ENV_VAR] === '1';
  const prepared = prepare(pathArg, deps, focused, intercom, hq);
  if (typeof prepared === 'number') return prepared;
  const { projectRoot, profilePath, plan } = prepared;
  const vdxAi = `vdx ai${focused ? ' --focused' : intercom ? ' --intercom' : hq ? ' --hq' : ''}`;

  const lines = [
    `${machineLine(plan.host)}; the agent in this project is started with \`vdx ai\`, and its flags come from the profile ` +
      `${profilePath} — agent.args for every project, agent.when[] for a class of projects. ` +
      `Hand the user \`vdx ai\`, not \`${plan.command} --<flag>\`; a flag a class of projects needs is a ` +
      `condition in the profile, not an instruction to type. A project's agent on another machine: ` +
      `\`vdx ai@<machine>\`. More: \`vdx ai --help\`.`,
  ];
  const procs = deps.processes();
  const own = findOwnAgent(procs, selfPid, plan.command);
  if (own && isClaude(plan.command)) {
    keepRecord(
      deps,
      procs,
      own.pid,
      projectRoot,
      focused ? 'focused' : intercom ? 'mail' : hq ? 'hq' : 'plain',
      conversation,
    );
    // A start, a resume — after a restore too — a /clear or a compact: what the sidebar shows starts from the transcript.
    const pane = ownPane(deps.env);
    if (pane)
      keepState(
        deps,
        pane,
        projectRoot,
        prepared.environment.session?.wrap_skills ?? [],
        conversation ?? liveConversationId(deps.env, deps.home, own.pid),
      );
  }
  if (focused) {
    lines.push(
      `· this session is focused (\`vdx ai --focused\`): it works on what the user gave it — nothing should wake it, ` +
        `and it does not read its inbox unless the user asks` +
        (plan.skipped.length ? `; the profile's ${plan.skipped.join(', ')} is left out` : '') +
        '.',
    );
    if (own) lines.push(...focusedTopicLines(projectRoot, deps.tmux, procs, own.pid));
  }
  if (intercom) {
    const ownPane = own ? paneOfAgent(deps.tmux, procs, own.pid) : undefined;
    // The conversation is known by this line as an intercom session's (conversations.ts): keep its opening.
    if (ownPane && sessionStays(deps.tmux, ownPane.session))
      lines.push(
        `${INTERCOM_LINE_PREFIX} (\`vdx ai --intercom\`): letters and wakes for the project come here, so the user's ` +
          `own session stays quiet. The user started this one, and it stays: when nothing is left for it, say what ` +
          `was done and wait for the next wake; only the user ends it. With questions to the user still unanswered: ` +
          `\`vdx ai --close --waiting <n>\` — the pane stays, the project's other tmux sessions here show the number; ` +
          `a plain \`--close\` clears it.`,
      );
    else
      lines.push(
        `${INTERCOM_LINE_PREFIX} (\`vdx ai --intercom\`): letters and wakes for the project come here, so the user's ` +
          `own session stays quiet, and nobody sits at this one. When nothing is left for it — right after a check ` +
          `of its inbox shows nothing to take — it ends itself: \`vdx ai --close\` (the pane closes ${CLOSE_DELAY_S} s ` +
          `later, so say what was done first). With questions to the user still unanswered: ` +
          `\`vdx ai --close --waiting <n>\` — the project's other tmux sessions here show the number; a plain ` +
          `\`--close\` clears it.`,
      );
  }
  // The conversation is known by this line as started by an agent (conversations.ts): the list marks it 🤖.
  const byPane = own ? paneOfAgent(deps.tmux, procs, own.pid) : undefined;
  const by = byPane ? paneBy(deps.tmux, byPane.paneId) : null;
  if (by)
    lines.push(
      `${STARTED_BY_LINE_PREFIX} ${by === 'hq' ? "the project's HQ session" : by === 'letter' ? 'a letter, as its intercom session' : 'an agent'} ` +
        `(\`${BY_OPTION}\` ${by}), not by the user.`,
    );
  // The conversation is known by this line as an HQ session's (conversations.ts): keep its opening.
  if (hq)
    lines.push(
      `${HQ_LINE_PREFIX} (\`vdx ai --hq\`): the user sits at it, and what comes to the project from outside is ` +
        `its work; a plain \`vdx ai\` leaves it alone, and \`vdx ai --close\` is not for it. A new topic that is not ` +
        `its work goes to a session of its own: hand the user \`vdx ai ${shellQuote(projectRoot)} --focused "<topic>"\` ` +
        `— it opens with the topic as its first prompt.`,
    );
  if (!own) {
    lines.push(`· no ${plan.command} among the ancestors of this process — no session to compare with the profile.`);
    deps.out(lines.join('\n') + '\n');
    return EXIT_OK;
  }
  const missing = missingArgs(own.args, plan.args);
  const why = plan.matched.length ? ` (profile conditions met here: ${plan.matched.join(', ')})` : '';
  // A live session keeps the Claude Code and plugins it started with (vdx-ai, Sidetrack #24).
  const lag = (deps.lag ?? ((pid, root, command) => machineLag(deps, pid, root, command)))(
    own.pid,
    projectRoot,
    plan.command,
  );
  if (missing.length === 0 && !lag) {
    lines.push(`✓ this session carries the profile's flags${why}.`);
    deps.out(lines.join('\n') + '\n');
    return EXIT_OK;
  }
  const problems: string[] = [];
  if (missing.length > 0) problems.push(`✗ this session runs without ${missing.join(' ')}${why}.`);
  else lines.push(`✓ this session carries the profile's flags${why}.`);
  if (lag) problems.push(`✗ ${describeLag(lag)}.`);

  const root = shellQuote(projectRoot);
  const again = [
    missing.length > 0 ? " with the profile's flags" : '',
    lag ? `${missing.length > 0 ? ',' : ''} on the installed Claude Code and plugins` : '',
  ].join('');
  // Plugins alone: /reload-plugins loads them and the conversation goes on in the same process.
  const reload =
    missing.length === 0 && lag && !lag.claude
      ? '`/reload-plugins`: it loads the installed plugins and keeps the conversation (Claude Code stays as it is); or '
      : '';
  problems.push(
    `Hand the user the fix — ${reload}` +
      (deps.env['TMUX']
        ? `\`${vdxAi} --restart ${root}\`: it stops this session and starts it again${again}` +
          // The intercom session restarts into a new conversation, and what lives only in this one ends
          // with it (ai-dev-plugins, restart-hint-wrap-first); a focused one keeps it (Sidetrack #22).
          (intercom
            ? ", in a new conversation — before handing it over, run the project's wrap check (`/vdm:wrap` where vdm is installed): what lives only in this chat ends with it"
            : focused
              ? ', in the conversation it is in'
              : plan.resumeArgs.length
                ? `, resuming the conversation (${plan.resumeArgs.join(' ')})`
                : '') +
          `. Do not run it yourself: it ends this session.`
        : `this session runs outside tmux, so vdx cannot restart it: the user exits it and runs \`${vdxAi} ${root}\`.`),
  );
  lines.push(problems.join(' '));
  deps.out(lines.join('\n') + '\n');
  return EXIT_DRIFT;
}

/**
 * `vdx ai --tab`: the shell of a cmux tab, started again after cmux restarted, goes back into the session
 * the tab showed — its record (DL #19): a session here, or `vdx ai@<host> --tab` with the mark. Run there,
 * over ssh, it finds the session marked `@vdx_tab` with this terminal's mark. No record, but cmux, minutes
 * ago, started with a `tmux attach` noticed in this tab: that session, if no terminal here shows it. Neither:
 * nothing, exit 0. One way back (restore-after-any-crash DL #9): vdx attaches, and cmux's own line, typed
 * into the same tab, is taken off the terminal first.
 */
export function runAiTab(pathArg: string, deps: AiDeps): number {
  const { log } = deps;
  const opts: AiOptions = { path: pathArg, restart: false, fresh: false, detach: false, dryRun: false, tab: true };
  if (!deps.interactive) {
    log('vdx ai --tab: attaches this terminal — run it in one');
    return EXIT_USAGE;
  }
  const token = deps.env[CMUX_TOKEN_ENV_VAR]?.trim();
  const surface = cmuxSurface(deps.env);
  // Over ssh from the tab's machine: the session that carries its mark.
  if (!surface && token && /^[0-9a-f]+$/.test(token)) {
    const out = deps.tmux.tryRun(['list-sessions', '-F', `#{session_name}\t#{${TAB_OPTION}}`]) ?? '';
    const session = out
      .split('\n')
      .map((l) => l.split('\t'))
      .find(([, marks]) => (marks ?? '').split(/\s+/).includes(token))?.[0];
    if (!session) {
      log(
        `✗ no tmux session on ${hostLabel(deps.env)} carries this tab's mark — it may have gone with the tmux server`,
      );
      return EXIT_LAUNCH_FAILED;
    }
    const pane = deps.tmux.tryRun(['display-message', '-p', '-t', `=${session}:`, '#{pane_id}'])?.trim() ?? '';
    return finish(true, session, pane, opts, deps, Boolean(paneTopic(deps.tmux, pane)), seatLabel(deps.env));
  }
  if (!surface) return EXIT_OK;
  let record = readTabRecord(deps.home, surface);
  // A tab `vdx ai --restore` opened in place of one cmux lost: that one's record is this one's
  // (restore-after-any-crash).
  const from = deps.env[TAB_FROM_ENV_VAR]?.trim();
  if (!record && from && from !== surface) {
    const old = readTabRecord(deps.home, from);
    if (old) {
      record = { ...old, surface };
      writeTabRecord(deps.home, record);
      forgetTabRecord(deps.home, from);
    }
  }
  const before = cmuxJustStarted(deps.tabsView ? deps.tabsView().before : cmuxBeforeStart(deps.home));
  const bound = before?.panels.get(surface) ?? null;
  // A tab attached by hand, or whose record went (cmux-tabs-back, 2026-11-17): cmux noticed its attach, and
  // vdx, not cmux, takes it back (lft 2026-11-19: cmux lost the binding of nas-info@lft's tab, DL #8).
  if (
    !record &&
    bound?.tmuxSession &&
    deps.tmux.hasSession(bound.tmuxSession) &&
    !terminalsHere(deps.tmux, deps).get(bound.tmuxSession)
  ) {
    record = { kind: 'here', surface, session: bound.tmuxSession, socket: deps.tmux.socketName, at: Date.now() };
    writeTabRecord(deps.home, record);
  }
  if (!record) return EXIT_OK;
  // cmux types `cmux restore --surface` into a tab it brings back itself; attached first, the line went into
  // the agent's input (vdx-ai-predictable Sidetrack #17; lft 2026-11-19, 4 of 7). Typed by a restore
  // (VDX_TAB_NOW), cmux's line has run already.
  if (bound?.resumes && deps.env[TAB_NOW_ENV_VAR] !== '1') {
    const took = (deps.takeCmuxLine ?? takeCmuxLine)();
    noteTabLog(
      deps.home,
      `${surface} ${record.kind === 'here' ? record.session : `${record.host}:${record.project}`} cmux line: ` +
        (took ? `${JSON.stringify(took.taken.slice(0, 120))} in ${took.waitedMs} ms` : 'no terminal to read'),
    );
  }
  if (record.kind === 'there') {
    log(`↩ this tab showed a session on ${record.host} — back into it`);
    return runAiRemote({ ...opts, path: record.project }, record.host, deps, seatLabel(deps.env), record.token);
  }
  const here: AiDeps = record.socket === deps.tmux.socketName ? deps : { ...deps, tmux: new Tmux(record.socket) };
  if (!here.tmux.hasSession(record.session) && !awaitRestore(record.session, here)) {
    log(
      `✗ ${record.session}, which this tab showed, is not running — after tmux fell, vdx ai --restore brings it back; ` +
        'this tab tries again in its next shell',
    );
    return EXIT_LAUNCH_FAILED;
  }
  log(`↩ ${record.session}: back into the session this tab showed`);
  const pane = here.tmux.tryRun(['display-message', '-p', '-t', `=${record.session}:`, '#{pane_id}'])?.trim() ?? '';
  return finish(true, record.session, pane, opts, here, Boolean(paneTopic(here.tmux, pane)), seatLabel(deps.env));
}

/**
 * `vdx ai --close [--waiting <n>]`: the intercom session, or a focused one, ends itself — run inside
 * it, by its agent. Only the pane whose agent is this process's own ancestor and carries
 * VDX_INTERCOM=1 or VDX_FOCUSED=1 is closed, a few seconds later; a session the person started or
 * attached to stays (`@vdx_stays`): the command never ends the person's session. A focused one an HQ
 * started with `--detach` for a step closes once its step is done (vdx-ai-predictable Sidetrack #16).
 * The project's other tmux sessions here get `@vdx_waiting` = n, the questions to the person still
 * unanswered — the session's tab is about to go; without `--waiting`, none, and the mark is cleared:
 * the last word holds.
 */
export function runAiClose(pathArg: string, waiting: number, deps: AiDeps, selfPid: number = process.pid): number {
  const { log, tmux } = deps;
  const prepared = prepare(pathArg, deps, false, true);
  if (typeof prepared === 'number') return prepared;
  const { projectRoot, plan } = prepared;
  const procs = deps.processes();
  const own = findOwnAgent(procs, selfPid, plan.command);
  const mailOf = deps.agentMail ?? ((pid: number) => processMode(pid) === 'mail');
  const focusedOf = deps.agentFocused ?? processFocused;
  const kind = !own ? null : focusedOf(own.pid) ? 'focused session' : mailOf(own.pid) ? 'intercom session' : null;
  if (!own || !kind) {
    log(
      `vdx ai --close: this is neither an intercom session (\`vdx ai --intercom\`) nor a focused one (\`vdx ai --focused\`)` +
        `${own ? '' : ` — no ${plan.command} among the ancestors of this process`}; nothing closed`,
    );
    return EXIT_USAGE;
  }
  const panes = tmux.panes();
  const pane = panes.find((p) => processTree(procs, p.panePid).some((x) => x.pid === own.pid));
  if (!pane) {
    log(`vdx ai --close: this ${kind} runs outside tmux — nothing to close here; it ends when its agent exits`);
    return EXIT_USAGE;
  }
  const others = [
    ...new Set(findAgentPanes(panes, procs, projectRoot, plan.command).map((a) => a.pane.session)),
  ].filter((s) => s !== pane.session);
  for (const s of others) {
    // `=name:` — a session option needs the session as a target, `=name` alone is not found.
    tmux.tryRun(
      waiting > 0
        ? ['set-option', '-t', `=${s}:`, WAITING_OPTION, String(waiting)]
        : ['set-option', '-u', '-t', `=${s}:`, WAITING_OPTION],
    );
  }
  if (waiting > 0)
    log(
      others.length
        ? `✓ ${waiting} waiting for the user — shown on ${others.join(', ')}`
        : `note: ${waiting} waiting for the user, and no other session of this project here to show it`,
    );
  if (sessionStays(tmux, pane.session)) {
    log(
      kind === 'intercom session'
        ? `✓ ${pane.session} ${pane.paneId}: the user started this intercom session — it stays and waits for a wake`
        : `✓ ${pane.session} ${pane.paneId}: the user started or joined this focused session — it stays open`,
    );
    return EXIT_OK;
  }
  if (tmux.tryRun(['run-shell', '-b', '-d', String(CLOSE_DELAY_S), '-C', `kill-pane -t ${pane.paneId}`]) === null) {
    log(`✗ ${pane.session} ${pane.paneId}: tmux did not take the close — the ${kind} keeps running`);
    return EXIT_LAUNCH_FAILED;
  }
  log(`✓ ${pane.session} ${pane.paneId}: the ${kind} closes in ${CLOSE_DELAY_S} s`);
  // Its place goes to the queue's oldest (intercom-session-mode DL #13).
  if (kind === 'intercom session')
    startQueued(
      deps,
      (deps.intercomLimit ?? intercomLimit()) - lettersSessionsHere(deps, pane.session).length,
      pane.session,
    );
  return EXIT_OK;
}

/**
 * The agents a fallen tmux server took down here (restore.ts) that are still to bring back: not an
 * intercom session a letter started — the next letter starts one; one the person started stays, and
 * comes back (intercom-session-mode DL #12) — and not one whose conversation runs here now. `tidy` —
 * the current server's records of panes that are gone, and those left out here, are forgotten.
 */
function lostAgents(deps: AiDeps, server: TmuxServer | null, tidy: boolean): LostRecord[] {
  try {
    if (server && tidy) {
      const panes = deps.tmux.panes();
      pruneRecords(deps.env, deps.home, server, new Set(panes.map((p) => p.paneId)), pidAlive);
      recordRunning(deps, server, panes, deps.processes());
    }
    const live = new Set((deps.liveHere ?? (() => liveSessionsHere(deps.env, deps.home)))().map((l) => l.conversation));
    return lostRecords(deps.env, deps.home, server, server?.socket ?? deps.tmux.socketName ?? 'default').filter((r) => {
      const done = (r.mode === 'mail' && !r.stays) || (r.conversation !== null && live.has(r.conversation));
      if (done && tidy) forget(r);
      return !done;
    });
  } catch {
    // records vdx cannot read or tidy: nothing to offer
    return [];
  }
}

/** What a fallen tmux server took down, as a start in a project sees it. */
interface LostHere {
  /** Every one: what `vdx ai --restore` brings back. */
  all: LostRecord[];
  /** What `r` brings back: the project's own, or every one where session.restore_all holds (DL #4). */
  mine: LostRecord[];
  /**
   * The project's own went down: what tmux did and who ran before it — a line, then a row for each,
   * named as the list names agents, with whether work was in it. Empty — none of them is the project's.
   */
  lines: string[];
  /** The commands that bring back every one, or forget them, typed where the person sits. */
  hint: string;
  /**
   * None of them is the project's (Sidetrack #15): one line for under the list — the project's
   * list is not about them, and the person still learns that they went down and whether work did.
   */
  note: string | null;
}

/** What went down with a lost agent: a conversation with work in it, a wrapped one, or an empty place. */
function lostWork(r: LostRecord, deps: AiDeps, wrapSkills: readonly string[]): 'work' | 'finished' | 'empty' {
  const c = r.conversation
    ? conversationById({ env: deps.env, home: deps.home, projectRoot: r.project, id: r.conversation, wrapSkills })
    : null;
  return !c || isEmpty(c) ? 'empty' : c.finished ? 'finished' : 'work';
}

function lostHere(deps: AiDeps, plan: LaunchPlan, environment: Environment, tidy: boolean): LostHere | null {
  const server = currentServer(deps.tmux);
  const all = lostAgents(deps, server, tidy);
  if (all.length === 0) return null;
  const rule = environment.session?.restore_all;
  const everyOne =
    rule !== undefined &&
    evalPredicate(rule, { projectRoot: plan.projectRoot, stack: autoDetectStack(plan.projectRoot), cache: new Map() });
  const root = realpathOr(plan.projectRoot);
  const mine = everyOne ? all : all.filter((r) => realpathOr(r.project) === root);
  const agents = (n: number) => `${n} agent${n === 1 ? '' : 's'}`;
  // Said from where the person sits: `vdx ai@<host>` runs this on the host (vdx-ai-predictable Sidetrack #10).
  const here = sameMachine(plan.host, plan.seat);
  const where = here ? 'here' : `on ${plan.host}`;
  const icons = environment.session?.machine_icons ?? {};
  const wrapSkills = environment.session?.wrap_skills ?? [];
  const row = (r: LostRecord) => {
    const work = lostWork(r, deps, wrapSkills);
    const mode =
      r.mode === 'focused'
        ? `🎯 focused ${r.topic ? quoted(r.topic) : '(no topic)'}`
        : r.mode === 'mail'
          ? '📬 the intercom session'
          : r.mode === 'hq'
            ? '👑 the HQ session'
            : '';
    const label = agentLabel({ machine: plan.host, session: r.session, pid: r.pid }, icons);
    return `     ${label}${mode ? `  ${mode}` : ''}${work === 'work' ? '' : ` — ${work}, no work in it`}`;
  };
  const when = server
    ? `tmux ${where} was started again ${describeAge(new Date(server.started * 1000))}`
    : `no tmux server runs ${where}`;
  const others = all.length - mine.length;
  const count = all.length === 1 ? 'it' : all.length === 2 ? 'both' : `all ${all.length}`;
  const them = all.length === 1 ? 'it' : 'them';
  const restore = `${here ? '' : `ssh ${plan.host} `}vdx ai --restore`;
  if (mine.length === 0) {
    const projects = [...new Set(all.map((r) => path.basename(r.project)))];
    const named = `${projects.slice(0, 3).join(', ')}${projects.length > 3 ? ` and ${projects.length - 3} more` : ''}`;
    const withWork = all.filter((r) => lostWork(r, deps, wrapSkills) === 'work').length;
    const work =
      withWork === 0
        ? `no work in ${all.length === 1 ? 'it' : all.length === 2 ? 'either' : 'any of them'}`
        : `work in ${withWork === all.length ? count : `${withWork} of them`}`;
    const went = server
      ? `${agents(all.length)} of other projects (${named}) went down when ${when}`
      : `${when}; ${agents(all.length)} of other projects (${named}) went down with the last one`;
    return {
      all,
      mine,
      lines: [],
      hint: '',
      note: `${went}, ${work} — ${restore} brings back ${count}, ${restore} --forget drops ${them}`,
    };
  }
  const ran =
    `${agents(mine.length)}${everyOne ? '' : ` of ${plan.project}`} ran` +
    (others > 0 ? `, and ${others} of other projects` : '');
  return {
    all,
    mine,
    lines: [
      `⚠ ${when} — before that ${ran}:`,
      ...mine.slice(0, 6).map(row),
      ...(mine.length > 6 ? [`     … and ${mine.length - 6} more`] : []),
    ],
    hint:
      `  ${restore} brings back ${count} — each in its tmux session, ` +
      `conversation, mode and topic; --dry-run: what it would start; --forget: drops ${them}`,
    note: null,
  };
}

/** What a restore did: started, left out (and why it said), and failed to start. */
interface Restored {
  started: number;
  skipped: number;
  failed: number;
}

/** How long a start waits for Claude Code's transcripts to lead somewhere: a volume unlocks in seconds. */
const REACH_START_MS = 60_000;
/** How long `--restore` waits for them, and for its projects: it runs at login, as the volume unlocks. */
const REACH_RESTORE_MS = 10 * 60_000;

/** A path as the person reads it: under the home directory, with `~`. */
function homePath(p: string, home: string): string {
  const rel = path.relative(home, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel}` : p;
}

/**
 * Wait while Claude Code's transcripts (`projects` in its config directory) and `paths` lead nowhere — a link
 * to a volume not mounted yet (nas-info `projects-link-mount-race`): a Claude Code started then writes no
 * transcript and says nothing, and `--resume`, intercom and echelon lose it. What still leads nowhere after
 * `waitMs`, each with why.
 */
function awaitClaudeReach(deps: AiDeps, paths: string[], waitMs: number): { path: string; why: string }[] {
  const projects = path.join(claudeConfigDir(deps.env, deps.home), 'projects');
  return awaitReach(
    [projects, ...paths],
    waitMs,
    deps.sleep,
    (stuck) =>
      deps.log(
        `⏳ ${stuck.map((x) => `${homePath(x.path, deps.home)} leads nowhere yet (${x.why})`).join('; ')} — ` +
          `waiting up to ${Math.round(waitMs / 1000)} s for the volume`,
      ),
    deps.volumes,
  );
}

/** The line that says Claude Code was not started because its transcripts lead nowhere; it starts with ✗ and the path. */
function transcriptsNowhere(stuck: { path: string; why: string }, deps: AiDeps, waitMs: number): string {
  return (
    `✗ ${homePath(stuck.path, deps.home)} leads nowhere after ${Math.round(waitMs / 1000)} s (${stuck.why}) — ` +
    'Claude Code would run without its transcripts'
  );
}

/**
 * Start again the agents a fallen tmux server took down (vdx-ai-predictable P6, DL #9): each in a
 * tmux session of its old name — taken, the next free one — with its project's profile, in its
 * conversation, mode and topic; nothing attaches. An empty one (nothing typed since /clear) and a
 * wrapped one come back as places: a new conversation in the same session. Left out: a
 * conversation running on another machine now, or continued there since (its last machine is that
 * one), and a project folder that is gone. The intercom session the person started comes back marked
 * to stay; one a letter started since is not doubled — it is marked instead. Each record is forgotten
 * once tried. `dryRun` — what would start, on stdout, and nothing is forgotten or marked.
 */
function restoreAgents(lost: LostRecord[], deps: AiDeps, dryRun: boolean): Restored {
  const { tmux } = deps;
  const host = hostLabel(deps.env);
  const say = (line: string) => (dryRun ? deps.out(`${line}\n`) : deps.log(line));
  const done = (r: LostRecord) => {
    if (!dryRun) forget(r);
  };
  // What runs on the other machines now — asked once, every project's: none is started here too.
  let elsewhere: Map<string, string> | null = null;
  const runsOn = (machines: string[], id: string): string | null => {
    if (!elsewhere) {
      elsewhere = new Map();
      for (const m of machines) {
        const res = askMachineOver(deps, m, LIVE_SESSIONS_SCRIPT);
        if (res && res.status === 0)
          for (const l of parseMachineReport(res.stdout).sessions) elsewhere.set(l.conversation, m);
        else say(`note: ${m} does not answer over ssh — what runs there is not known`);
      }
    }
    return elsewhere.get(id) ?? null;
  };
  const result: Restored = { started: 0, skipped: 0, failed: 0 };
  // At login the restore can come before the volume Claude Code's transcripts, or a project, live on: it waits
  // for them, and a record whose place has not come stays for the next restore (projects-link-mount-race).
  const projects = path.join(claudeConfigDir(deps.env, deps.home), 'projects');
  if (dryRun) {
    const now = reach(projects, deps.volumes);
    if (now.kind === 'unreachable')
      say(`note: ${homePath(projects, deps.home)} leads nowhere now (${now.why}) — a restore waits for it`);
  } else {
    const stuck = awaitClaudeReach(deps, [...new Set(lost.map((r) => r.project))], REACH_RESTORE_MS);
    const transcripts = stuck.find((x) => x.path === projects);
    if (transcripts) {
      say(`${transcriptsNowhere(transcripts, deps, REACH_RESTORE_MS)}; no agent started, their records stay`);
      return { ...result, failed: lost.length };
    }
  }
  for (const r of lost) {
    const where = reach(r.project, deps.volumes);
    if (where.kind === 'unreachable') {
      say(
        `${dryRun ? '·' : '✗'} ${r.session}: ${r.project} leads nowhere ${dryRun ? 'now' : 'yet'} (${where.why}) — ` +
          (dryRun ? 'a restore waits for it' : 'not brought back; its record stays for the next restore'),
      );
      if (!dryRun) result.failed++;
      continue;
    }
    if (where.kind === 'missing') {
      say(`· ${r.session}: not brought back — ${r.project} is not there any more`);
      result.skipped++;
      done(r);
      continue;
    }
    const prepared = prepare(r.project, deps, r.mode === 'focused', r.mode === 'mail', r.mode === 'hq');
    if (typeof prepared === 'number') {
      result.failed++;
      done(r);
      continue;
    }
    let { plan } = prepared;
    // One HQ session per project and machine: `vdx ai --hq` may have started one since.
    if (
      plan.hq &&
      findAgentPanes(tmux.panes(), deps.processes(), plan.projectRoot, plan.command).some((a) => hqOf(deps)(a.proc.pid))
    ) {
      say(`· ${r.session}: not brought back — the project's HQ session runs here now`);
      result.skipped++;
      done(r);
      continue;
    }
    // One intercom session per project and machine: a letter may have started one since — it stays now.
    const mailOf = deps.agentMail ?? ((pid: number) => processMode(pid) === 'mail');
    const mail = plan.intercom
      ? findAgentPanes(tmux.panes(), deps.processes(), plan.projectRoot, plan.command).find((a) => mailOf(a.proc.pid))
      : undefined;
    if (mail) {
      if (!dryRun) setStays(deps, mail.pane.session);
      say(
        `· ${r.session}: not brought back — the project's intercom session runs here now (${mail.pane.session}); ` +
          (dryRun ? 'it would be marked to stay' : 'marked to stay'),
      );
      result.skipped++;
      done(r);
      continue;
    }
    const id = r.conversation;
    const c = id
      ? conversationById({
          env: deps.env,
          home: deps.home,
          projectRoot: plan.projectRoot,
          id,
          wrapSkills: prepared.environment.session?.wrap_skills ?? [],
        })
      : null;
    const there = id ? runsOn(plan.machines, id) : null;
    const moved = c?.machine && !sameMachine(c.machine, host) ? c.machine : null;
    if (id && (there || moved)) {
      say(
        `· ${r.session}: not brought back — its conversation ${id.slice(0, 8)} ` +
          (there ? `runs on ${there} now` : `was continued on ${moved} since`),
      );
      result.skipped++;
      done(r);
      continue;
    }
    const place = !c || isEmpty(c) || c.finished;
    plan = { ...plan, resumeArgs: place ? [] : resumeId(id!) };
    const topic = plan.focused ? (r.topic ?? c?.topic ?? null) : plan.hq ? HQ_TOPIC.text : null;
    let session = r.session;
    for (let n = 2; tmux.hasSession(session); n++) session = `${r.session}-${n}`;
    const line = agentLine(plan, [...plan.args, ...plan.resumeArgs]);
    const short = id?.slice(0, 8);
    const what = !place
      ? `conversation ${short}${c.title ? ` «${c.title.replace(/\s+/g, ' ').trim().slice(0, 50)}»` : ''}`
      : `a new conversation — ${!c ? 'none to continue' : c.finished ? `${short} was finished with a wrap` : `nothing typed in ${short} since /clear`}`;
    const mode = plan.focused
      ? `, focused${topic ? ` «${topic}»` : ''}`
      : plan.hq
        ? ', the HQ session'
        : plan.intercom
          ? ', the intercom session the user started'
          : '';
    if (dryRun) {
      deps.out(`  ${session}: ${what}${mode}\n    ${line}\n`);
      result.started++;
      continue;
    }
    deps.log(`▶ ${session}: ${what}${mode}`);
    let ok = false;
    try {
      const paneId = tmux.newSession(session, plan.projectRoot, tmuxShellCommand(line, deps.shell, !plan.intercom));
      if (topic) setPaneTopic(tmux, paneId, topic);
      if (plan.intercom) setStays(deps, session);
      ok = settleResumed(plan, paneId, deps);
    } catch (e) {
      deps.log(`✗ ${session}: tmux did not start it — ${errorMessage(e)}`);
    }
    done(r);
    if (ok) result.started++;
    else result.failed++;
  }
  return result;
}

/** Set on the `vdx ai --restore` one machine runs on another: that one brings back its own and asks nobody. */
const RESTORE_PEER_ENV_VAR = 'VDX_RESTORE_PEER';
/** How long a restore lets a tab it typed into take the attach before it looks. */
const TAB_CHECK_MS = 4_000;

/** The cmux tabs here and where each goes (tabs.ts); none when cmux's windows are not here to read. */
/**
 * The sessions on a tmux server here, each with the terminals of this machine on it. One another machine holds
 * (`vdx ai@<this one>` there, an ssh) shows the session there, not in a tab here: lft 2026-11-19, the tab of
 * `nas-info@lft` stayed out of it, its session counted as shown by m3's tab (restore-after-any-crash DL #8).
 */
function terminalsHere(t: Tmux, deps: AiDeps): Map<string, number> {
  const out = t.tryRun(['list-sessions', '-F', '#{session_name}']) ?? '';
  const sessions = new Map(
    out
      .split('\n')
      .filter(Boolean)
      .map((s): [string, number] => [s, 0]),
  );
  const me = hostLabel(deps.env);
  const procs = deps.processes();
  for (const c of t.clients())
    if (sessions.has(c.session) && clientSeat(c.pid, procs, me) === me)
      sessions.set(c.session, sessions.get(c.session)! + 1);
  return sessions;
}

function tabsHere(deps: AiDeps): TabPlan[] {
  try {
    const view = deps.tabsView?.() ?? {
      current: currentCmux(deps.home),
      before: cmuxBeforeStart(deps.home),
      foreground: foregroundByTty(),
      ttys: ttyBySurface(),
    };
    return planTabs({
      self: cmuxSurface(deps.env),
      current: view.current,
      before: view.before,
      records: readTabRecords(deps.home),
      foreground: view.foreground,
      ttys: view.ttys,
      sessionsHere: (socket) => terminalsHere(socket === deps.tmux.socketName ? deps.tmux : new Tmux(socket), deps),
      marksThere: (host) => {
        const res = askMachineOver(
          deps,
          host,
          `tmux list-sessions -F '#{session_attached} #{${TAB_OPTION}}' 2>/dev/null; true`,
        );
        if (!res || res.status !== 0) return null;
        const marks = new Map<string, number>();
        for (const line of res.stdout.split('\n')) {
          const [n, ...tokens] = line.trim().split(/\s+/);
          for (const t of tokens) if (/^[0-9a-f]+$/.test(t)) marks.set(t, Number(n) || 0);
        }
        return marks;
      },
    });
  } catch {
    // cmux's files unreadable: no tabs to say anything about
    return [];
  }
}

/** The tabs a restore sends back: at their shell with their session there, or lost by cmux. */
function tabsToSend(plans: TabPlan[]): TabPlan[] {
  return plans.filter((p) => p.state === 'ready' || p.state === 'gone');
}

function tabs(n: number): string {
  return `${n} tab${n === 1 ? '' : 's'}`;
}

/** The command a tab a restore opens starts with: this vdx by the paths it runs from — the tab's PATH is cmux's. */
function tabCommand(): string {
  const words = [process.execPath, process.argv[1] ?? ''];
  return words.every((w) => /^[A-Za-z0-9/._+@-]+$/.test(w)) ? `${words.join(' ')} ai --tab` : 'vdx ai --tab';
}

function runCmux(env: NodeJS.ProcessEnv): (args: string[]) => { status: number; out: string } {
  const cli = cmuxCli(env);
  return (args) => {
    const res = spawnSync(cli, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
    return { status: res.status ?? 1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
  };
}

/**
 * The cmux tabs that lost their sessions (restore-after-any-crash): each named with where it goes, then sent
 * back — typed into or opened by cmux, which only a process in a cmux tab outside tmux may ask; from
 * anywhere else, the line that says where to run it. A record of a tab the person closed goes. `self` — the
 * tab this runs in, when it is one of them: the restore's caller sends it back last.
 */
function restoreTabs(
  deps: AiDeps,
  dryRun: boolean,
  say: (line: string) => void,
): { any: boolean; failed: number; self: TabPlan | null } {
  const plans = tabsHere(deps);
  const self = plans.find((p) => p.state === 'self') ?? null;
  if (!dryRun)
    for (const p of plans) if (p.state === 'closed' && p.from === 'record') forgetTabRecord(deps.home, p.surface);
  const send = tabsToSend(plans);
  const stuck = plans.filter((p) => ['no-session', 'no-answer', 'busy', 'unknown'].includes(p.state));
  if (send.length === 0 && stuck.length === 0) return { any: false, failed: 0, self };
  const inCmux = cmuxSurface(deps.env) !== null;
  const title = (p: TabPlan) => (p.panel?.title ? ` («${p.panel.title}»)` : '');
  say(
    `↩ cmux tabs here: ${send.length ? `${tabs(send.length)} to send back` : 'none to send back'}` +
      (stuck.length ? `, ${stuck.length} cannot go now` : ''),
  );
  for (const p of send)
    say(
      p.state === 'ready'
        ? `  ▶ ${targetLabel(p.target)}: ${dryRun || !inCmux ? 'would type' : 'typing'} vdx ai --tab into its tab${title(p)}`
        : `  ▶ ${targetLabel(p.target)}: cmux lost its tab — ${dryRun || !inCmux ? 'would open' : 'opening'} a new one` +
            (p.panel?.directory ? ` in ${p.panel.directory}` : ''),
    );
  for (const p of stuck)
    say(
      p.state === 'busy' || p.state === 'unknown'
        ? `  · ${targetLabel(p.target)}: ${p.state === 'busy' ? 'something else runs in its tab' : 'what runs in its tab cannot be told'}${title(p)} — ` +
            `${p.state === 'busy' ? 'leave it, then ' : ''}there: vdx ai --tab`
        : p.state === 'no-answer'
          ? `  · ${targetLabel(p.target)}: ${p.target.kind === 'there' ? p.target.host : 'the machine'} does not answer over ssh — its tab waits`
          : `  · ${targetLabel(p.target)}: not running — its tab waits for it`,
    );
  if (send.length === 0) return { any: true, failed: 0, self };
  if (!inCmux) {
    say(`  cmux lets only its own tabs ask it: run vdx ai --restore in a cmux tab outside tmux`);
    return { any: true, failed: 0, self };
  }
  if (dryRun) return { any: true, failed: 0, self };
  const { sent, failed } = returnTabs(send, {
    home: deps.home,
    cmux: deps.cmux ?? runCmux(deps.env),
    tabCommand: tabCommand(),
    log: say,
  });
  if (sent.length === 0) return { any: true, failed: failed.length, self };
  // A tab that took the attach holds tmux, ssh or vdx in front; one whose `--tab` gave up is at its shell again.
  deps.sleep(TAB_CHECK_MS);
  const after = new Map(tabsHere(deps).map((p) => [p.surface, p.state]));
  const clients = (session: string) =>
    Number(deps.tmux.tryRun(['display-message', '-p', '-t', `=${session}:`, '#{session_attached}'])?.trim() ?? 0);
  const back = sent.filter((p) =>
    p.state === 'ready' ? after.get(p.surface) === 'shown' : p.target.kind === 'there' || clients(p.target.session) > 0,
  );
  for (const p of sent.filter((x) => !back.includes(x)))
    say(`  ✗ ${targetLabel(p.target)}: its tab did not take the attach — there: vdx ai --tab`);
  const bad = sent.length - back.length + failed.length;
  say(`${bad ? '✗' : '✓'} ${back.length} of ${tabs(send.length)} back in their sessions`);
  return { any: true, failed: bad, self };
}

/**
 * The other machines of the profile bring back their own (restore-after-any-crash, Q2): before the tabs here,
 * which may show their sessions. Each answers with its own lines; one that does not answer is named.
 */
function restorePeers(deps: AiDeps, dryRun: boolean, say: (line: string) => void): { any: boolean; failed: number } {
  let machines: string[] = [];
  try {
    const profile = resolveEnvironmentPath(deps.env, deps.home);
    if (profile) machines = loadEnvironment(profile).session?.machines ?? [];
  } catch {
    // a profile that does not read: no machines to ask
  }
  const self = hostLabel(deps.env);
  let any = false;
  let failed = 0;
  for (const m of machines.filter((x) => !sameMachine(x, self))) {
    const script = `${RESTORE_PEER_ENV_VAR}=1 vdx ai --restore${dryRun ? ' --dry-run' : ''} 2>&1`;
    const res = askMachineOver(deps, m, script, PEER_RESTORE_TIMEOUT_MS);
    if (!res || res.status === 255) {
      say(
        `· ${m}: does not answer over ssh, or did not finish within ${PEER_RESTORE_TIMEOUT_MS / 60_000} min — ` +
          `what went down there may still be down; there: vdx ai --restore`,
      );
      continue;
    }
    const lines = res.stdout.split('\n').filter((l) => l.trim());
    if (lines.length <= 1 && /nothing to bring back/.test(lines[0] ?? '')) continue;
    any = true;
    for (const l of lines) say(`  ${m}: ${l}`);
    if (res.status !== 0) failed++;
  }
  return { any, failed };
}

/**
 * `vdx ai --restore`: bring back everything a fall took down (restore-after-any-crash) — whatever fell: tmux,
 * cmux, the machine. Every agent a fallen tmux server took down here, of every project, without a question;
 * then the same on the profile's other machines; then the cmux tabs here that lost their sessions; then, run
 * in one of those tabs, that tab itself. For the person, and for whatever starts tmux again after a crash or
 * a reboot. `dryRun` — what it would do. Exit 4 when something did not come back. `forgetThem` (`--forget`,
 * Sidetrack #15) — no agent is started: their records go, each named with what was in it, and a
 * conversation with work stays to continue by its id. `fromList` — `r` in the list: the list goes on after,
 * so this tab stays where it is.
 */
export function runAiRestore(dryRun: boolean, deps: AiDeps, forgetThem = false, fromList = false): number {
  if (!deps.tmux.available()) {
    deps.log('vdx ai --restore: tmux is not installed here — nothing went down with it');
    return EXIT_USAGE;
  }
  const server = currentServer(deps.tmux);
  const lost = lostAgents(deps, server, !dryRun);
  const say = (line: string) => (dryRun ? deps.out(`${line}\n`) : deps.log(line));
  const when = server ? `; tmux was started again ${describeAge(new Date(server.started * 1000))}` : '';
  if (forgetThem) {
    if (lost.length === 0) {
      say('vdx ai --restore: nothing to bring back — no agent here went down with a tmux server');
      return EXIT_OK;
    }
    let wrapSkills: readonly string[] = [];
    try {
      const profile = resolveEnvironmentPath(deps.env, deps.home);
      if (profile) wrapSkills = loadEnvironment(profile).session?.wrap_skills ?? [];
    } catch {
      // a profile that does not read: a wrapped conversation is named as one with work — the careful side
    }
    say(
      `vdx ai --restore --forget — ${lost.length} agent${lost.length === 1 ? '' : 's'} went down with the tmux server here${when}; ` +
        (dryRun ? 'would forget:' : 'forgotten, not brought back:'),
    );
    for (const r of lost) {
      const work = lostWork(r, deps, wrapSkills);
      const mode =
        r.mode === 'focused'
          ? `focused ${r.topic ? quoted(r.topic) : '(no topic)'} — `
          : r.mode === 'mail'
            ? 'the intercom session — '
            : r.mode === 'hq'
              ? 'the HQ session — '
              : '';
      const what =
        work === 'work'
          ? `work in it; its conversation stays: vdx ai ${shellQuote(r.project)} --conversation ${r.conversation}`
          : `${work}, no work in it`;
      say(`  ${r.session} (${path.basename(r.project)}): ${mode}${what}`);
      if (!dryRun) forget(r);
    }
    return EXIT_OK;
  }
  let failed = 0;
  let any = false;
  if (lost.length > 0) {
    any = true;
    say(
      `vdx ai --restore — ${lost.length} agent${lost.length === 1 ? '' : 's'} went down with the tmux server here${when}` +
        (dryRun ? '; would start:' : ''),
    );
    const r = restoreAgents(lost, deps, dryRun);
    if (!dryRun) {
      const rest = [r.skipped && `${r.skipped} left out`, r.failed && `${r.failed} did not start`]
        .filter(Boolean)
        .join(', ');
      deps.log(`${r.failed ? '✗' : '✓'} ${r.started} back${rest ? ` (${rest})` : ''} — attach: vdx ai <project>`);
    }
    failed += r.failed;
  }
  // The other machine of `vdx ai@<machine>` tabs: asked by the restore a person or a start runs, not by one it asked.
  if (deps.env[RESTORE_PEER_ENV_VAR] !== '1') {
    const peers = restorePeers(deps, dryRun, say);
    any ||= peers.any;
    failed += peers.failed;
  }
  const t = restoreTabs(deps, dryRun, say);
  any ||= t.any;
  failed += t.failed;
  if (!any && !t.self)
    say(
      'vdx ai --restore: nothing to bring back — no agent here went down with a tmux server, and no cmux tab here lost its session',
    );
  // This tab last: its attach holds the terminal until a detach.
  if (t.self && !fromList && !dryRun && deps.interactive) {
    // Known from cmux's binding alone: `--tab` goes by a record.
    if (t.self.from === 'cmux' && t.self.target.kind === 'here')
      writeTabRecord(deps.home, {
        kind: 'here',
        surface: t.self.surface,
        session: t.self.target.session,
        socket: t.self.target.socket,
        at: Date.now(),
      });
    const status = runAiTab('.', { ...deps, env: { ...deps.env, [TAB_NOW_ENV_VAR]: '1' } });
    return failed > 0 ? EXIT_LAUNCH_FAILED : status;
  }
  return failed > 0 ? EXIT_LAUNCH_FAILED : EXIT_OK;
}

/** A focused session's topic for a start, and where it came from — as `--dry-run` and the start say. */
interface Topic {
  text: string | null;
  from: string;
}

/** Short words that say nothing about a topic: a match on them is no likeness. */
const TOPIC_STOP = new Set('для это как что или при над под про без над the and for with from into'.split(' '));

/**
 * The words of a topic that carry it: lower case, three letters and more, cut to five — a crude stem,
 * so «письма» and «письмо» meet (vdx-ai-predictable Sidetrack #19).
 */
function topicStems(topic: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const w of topic.toLowerCase().split(/[^\p{L}\p{N}]+/u))
    if (w.length >= 3 && !TOPIC_STOP.has(w) && !out.has(w.slice(0, 5))) out.set(w.slice(0, 5), w);
  return out;
}

/** The words of `running` a topic asked for shares — empty: not alike. */
export function sharedTopicWords(asked: string, running: string): string[] {
  const want = topicStems(asked);
  return [...topicStems(running)].filter(([stem]) => want.has(stem)).map(([, word]) => word);
}

/** A row's topic is cut to this: an HQ's step names a paragraph (echelon, 2026-11-15). */
const FOCUSED_TOPIC_ROOM = 60;

/** A focused session of the project running now, on this machine or another. */
interface FocusedRunning {
  machine: string;
  session: string;
  pid: number;
  topic: string | null;
  conversation: string | null;
  /** This machine's: its pane. */
  pane?: AgentPane;
  /** The topic's words the asked one shares. */
  shared: string[];
}

/**
 * Which focused session a `--focused` start goes into (vdx-ai-predictable DL #29, Sidetrack #19):
 * the project's focused sessions running on every machine, those on a topic like the one asked —
 * or all of them, with none asked — as rows; Enter, `n`, a new one; with no topic asked, text typed
 * is the new one's topic. Nothing alike, or nobody to ask: a new one, as before. Null — Ctrl-D.
 * One on the very topic is attached to before this is asked (its topic stays its own).
 */
function chooseFocused(input: {
  plan: LaunchPlan;
  deps: AiDeps;
  running: AgentPane[];
  focusedOf: (pid: number) => boolean;
  conversationOf: (a: AgentPane) => string | null;
  topic: string;
  ask: boolean;
  dryRun: boolean;
  icons: Record<string, string>;
}):
  | { kind: 'here'; pane: AgentPane }
  | { kind: 'there'; at: FocusedRunning }
  | { kind: 'new'; topic?: string; asked?: boolean; shown?: Shown[] }
  | null {
  const { plan, deps, topic } = input;
  const found: FocusedRunning[] = input.running
    .filter((a) => input.focusedOf(a.proc.pid))
    .map((a) => ({
      machine: plan.host,
      session: a.pane.session,
      pid: a.proc.pid,
      topic: paneTopic(deps.tmux, a.pane.paneId),
      conversation: input.conversationOf(a),
      pane: a,
      shared: [],
    }));
  // The other machines only when somebody sees the rows: a plain focused start asks nobody over ssh.
  if (input.ask || input.dryRun)
    for (const m of plan.machines)
      if (!sameMachine(m, plan.host))
        for (const f of askMachine(m, deps, plan.projectRoot)?.report?.agents ?? [])
          if (f.focused && f.session)
            found.push({
              machine: m,
              session: f.session,
              pid: f.pid,
              topic: f.topic,
              conversation: f.conversation,
              shared: [],
            });
  for (const f of found) f.shared = topic && f.topic ? sharedTopicWords(topic, f.topic) : [];
  const exact = topic ? found.find((f) => !f.pane && f.topic && normalizeTopic(f.topic) === topic) : undefined;
  if (exact && exact.conversation) return { kind: 'there', at: exact };
  const rows = topic
    ? found.filter((f) => f.shared.length > 0).sort((a, b) => b.shared.length - a.shared.length)
    : found;
  if (rows.length === 0) return { kind: 'new' };
  const show = (f: FocusedRunning) =>
    `${agentLabel(f, input.icons)}  🎯 ${f.topic ? `«${clip(f.topic, FOCUSED_TOPIC_ROOM)}»` : '(no topic yet)'}${f.shared.length ? `   alike: ${f.shared.join(', ')}` : ''}`;
  const fresh = topic ? `a new focused session «${topic}»` : 'a new focused session';
  if (!input.ask) {
    if (input.dryRun)
      deps.log(
        `note: focused session(s) ${topic ? 'on a topic like it' : 'of the project'} run: ${rows.map(show).join('; ')} — ` +
          `a start at a terminal asks; Enter — ${fresh}`,
      );
    return { kind: 'new' };
  }
  const header = topic
    ? `focused sessions on a topic like «${topic}»:`
    : `focused sessions of ${plan.project} running:`;
  // The rows the person saw: a new one picked over them asks nothing more about them (vdx-ai DL #29).
  const shown = rows.map((f) => ({ machine: f.machine, pid: f.pid }));
  // With a picker (fzf on PATH): the same rows with a cursor, as the one list has them; the cursor
  // starts on the new one, and what is typed is its topic, not a filter — the rows are few. The
  // owner, 2026-11-17: «нормального интерфейса тоже не было» (Sidetrack #20).
  if (deps.pick) {
    const detail = (f: FocusedRunning) => [
      f.topic ? `🎯 ${f.topic}` : '🎯 (no topic yet)',
      `${f.session} — ${f.pane ? 'here' : `on ${f.machine}`}`,
      ...(f.conversation ? [`conversation ${f.conversation.slice(0, 8)}`] : []),
      '',
      f.pane ? 'Enter — attach to it' : `Enter — attach to it on ${f.machine}`,
    ];
    const items = [
      ...rows.map((f) => ({ text: show(f), detail: detail(f) })),
      {
        text: `n  ${fresh}`,
        detail: [
          fresh,
          '',
          `Enter — start it; its topic is the text typed above${topic ? '' : ` — nothing typed: ${AGENT_TAKES_TOPIC}`}`,
        ],
      },
    ];
    for (let tries = 0; tries < 3; tries++) {
      const answer = deps.pick({
        header: [header],
        items,
        cursor: rows.length,
        columns: deps.columns,
        typing: 'text',
        prompt: 'topic of a new one: ',
        query: topic,
      });
      // Esc there is a cancel, as Ctrl-D at the question: start nothing.
      if (answer === null) return null;
      if (answer === 'failed') {
        deps.log('note: fzf did not show the list — the plain one instead');
        break;
      }
      // Enter only: another key that ended the picker is not a choice.
      if (answer.key !== '') continue;
      const picked = answer.index === null ? undefined : rows[answer.index];
      if (picked?.pane) return { kind: 'here', pane: picked.pane };
      if (picked) return { kind: 'there', at: picked };
      const typed = normalizeTopic(answer.query);
      return { kind: 'new', ...(typed && typed !== topic ? { topic: typed } : {}), asked: true, shown };
    }
  }
  deps.log(header);
  rows.forEach((f, i) => deps.log(`  ${i + 1}  ${show(f)}`));
  deps.log(`  n  ${fresh}${topic ? '' : ` — type its topic, or Enter: ${AGENT_TAKES_TOPIC}`}`);
  for (let tries = 0; tries < 2; tries++) {
    const answer = deps.ask(topic ? 'Which one? [Enter: n]: ' : 'Which one, or the new one’s topic? [Enter: n]: ');
    if (answer === null) return null;
    const a = answer.trim();
    if (a === '' || /^n$/i.test(a)) return { kind: 'new', asked: true, shown };
    const picked = /^\d+$/.test(a) ? rows[Number(a) - 1] : undefined;
    if (picked?.pane) return { kind: 'here', pane: picked.pane };
    if (picked) return { kind: 'there', at: picked };
    if (!topic && !/^\d+$/.test(a)) return { kind: 'new', topic: normalizeTopic(a), asked: true, shown };
    deps.log(`  no row ${a}`);
  }
  return { kind: 'new' };
}

const AGENT_TAKES_TOPIC = "the agent takes it from the user's first message";
/** An HQ session's sign: what the workspace's description shows (hq-session-mode DL #4). */
const HQ_TOPIC: Topic = { text: '👑 HQ', from: "the HQ session's sign" };

/**
 * The topic of the focused session a start makes (focused-topic DL #3): the one named with
 * `--focused`; a restart keeps its session's; a conversation brings back its last; at a terminal
 * a question — Enter leaves it to the agent, which takes it from the first message (and knows the
 * active crystal, which vdx does not). Null — Ctrl-D at the question: nothing starts.
 */
function chooseTopic(
  opts: AiOptions,
  plan: LaunchPlan,
  deps: AiDeps,
  restarted: AgentPane | undefined,
  canAsk: boolean,
): Topic | null {
  if (opts.topic) return { text: opts.topic, from: 'from --focused' };
  const kept = restarted ? paneTopic(deps.tmux, restarted.pane.paneId) : null;
  if (kept) return { text: kept, from: 'kept from its tmux pane' };
  const back = opts.conversation
    ? conversationTopic({ env: deps.env, home: deps.home, projectRoot: plan.projectRoot, id: opts.conversation })
    : null;
  if (back) return { text: back, from: 'from the conversation' };
  if (!asks(deps)) return { text: null, from: AGENT_TAKES_TOPIC };
  if (!canAsk) return { text: null, from: `asked at the start; Enter — ${AGENT_TAKES_TOPIC}` };
  const answer = deps.ask(`Topic of this focused session [Enter: the agent takes it from your first message]: `);
  if (answer === null) return null;
  const typed = normalizeTopic(answer);
  return typed ? { text: typed, from: 'typed' } : { text: null, from: AGENT_TAKES_TOPIC };
}

/** The topic of a 🎯 row picked on the list: the conversation's own (vdx-ai-list-owner-findings П. 1). */
function listTopic(choice: ConversationChoice | null): Topic | null {
  return choice?.focused ? { text: choice.focused.topic, from: 'from the conversation' } : null;
}

/**
 * `vdx ai <path> --focused <topic>` run by the agent of a focused session of the project, about
 * itself: its tmux pane gets the new topic, and nothing starts (focused-topic DL #3). In the
 * project's session that is not focused it is refused, with the command that starts a focused one
 * next to it: a topic is a focused session's. Null — not such a call: a start.
 */
function changeTopic(opts: AiOptions, plan: LaunchPlan, deps: AiDeps, selfPid: number): number | null {
  const topic = opts.topic;
  if (!topic || opts.fresh || opts.restart || opts.detach || opts.conversation) return null;
  const procs = deps.processes();
  const own = findOwnAgent(procs, selfPid, plan.command);
  if (!own) return null;
  const pane = paneOfAgent(deps.tmux, procs, own.pid);
  // An agent may start a focused session of another project: that is a start.
  if (pane && !isInside(realpathOr(pane.cwd), realpathOr(plan.projectRoot))) return null;
  const root = shellQuote(plan.projectRoot);
  if (deps.env[FOCUSED_ENV_VAR] !== '1') {
    deps.log("vdx ai --focused: this session is not focused, and a topic is a focused session's — nothing changed");
    deps.log(`  a focused session next to this one: vdx ai ${root} --focused ${shellQuote(topic)} --detach`);
    return EXIT_USAGE;
  }
  if (!pane) {
    deps.log(
      `vdx ai --focused: this focused session runs outside tmux, and its topic lives in the agent's tmux pane ` +
        `(${TOPIC_OPTION}) — nothing changed`,
    );
    return EXIT_USAGE;
  }
  const before = paneTopic(deps.tmux, pane.paneId);
  const was = before ? `, was «${before}»` : '';
  if (opts.dryRun) {
    deps.out(`vdx ai — ${pane.session}: the topic would be «${topic}»${was}\n`);
    return EXIT_OK;
  }
  if (!setPaneTopic(deps.tmux, pane.paneId, topic)) {
    deps.log(`✗ ${pane.session}: tmux did not take the topic — it stays ${before ? `«${before}»` : 'unset'}`);
    return EXIT_LAUNCH_FAILED;
  }
  // A restore after tmux falls brings the session back with the topic it has now.
  const server = currentServer(deps.tmux);
  try {
    if (server) updateTopic(deps.env, deps.home, server, pane.paneId, topic);
  } catch {
    // the record keeps the topic the hook saw
  }
  deps.log(`✓ ${pane.session}: the topic is «${topic}»${was}`);
  return EXIT_OK;
}

/**
 * `vdx ai --attach <session>`: this terminal onto a tmux session here as it is — the row of a session in the list
 * of `~` (vdx-ai-predictable DL #32). Nothing starts; the terminals already on it stay; in a cmux tab the tab notes
 * it, as any attach of vdx.
 */
function attachSession(session: string, opts: AiOptions, deps: AiDeps): number {
  if (!deps.tmux.available() || !deps.tmux.hasSession(session)) {
    deps.log(`✗ no tmux session ${session} on ${hostLabel(deps.env)} — nothing to attach to`);
    return EXIT_LAUNCH_FAILED;
  }
  const pane = deps.tmux.tryRun(['display-message', '-p', '-t', `=${session}:`, '#{pane_id}'])?.trim() ?? '';
  return finish(true, session, pane, { ...opts, detach: false }, deps, false, seatLabel(deps.env));
}

/** Every tmux session here but the intercom sessions, with the seats of the terminals on it (DL #32). */
function sessionFactsHere(deps: AiDeps, host: string): SessionFact[] {
  if (!deps.tmux.available()) return [];
  const out = deps.tmux.tryRun(['list-sessions', '-F', '#{session_name}\t#{pane_current_command}']) ?? '';
  const procs = deps.processes();
  const clients = deps.tmux.clients();
  return out
    .split('\n')
    .map((l) => l.split('\t'))
    .filter(([name]) => name && !/-intercom$/.test(name))
    .map(([name, command]) => ({
      machine: host,
      session: name!,
      command: command ?? '',
      openAt: clients.filter((c) => c.session === name).map((c) => clientSeat(c.pid, procs, host)),
    }));
}

/** `this session runs Claude Code 2.1.294 — 2.1.304 is installed; plugins updated since it loaded them: vdm 2.54.0`. */
function describeLag(lag: Lag): string {
  const names = lag.plugins.map((p) => `${p.name} ${p.version}`).join(', ');
  if (!lag.claude) return `plugins updated since this session loaded them: ${names} — it still runs the ones it loaded`;
  const claude = `this session runs Claude Code ${lag.claude.runs} — ${lag.claude.installed} is installed`;
  return lag.plugins.length > 0 ? `${claude}; plugins updated since it loaded them: ${names}` : claude;
}

/**
 * `--hq` in a project whose HQ is another one — a hand (hq-session-mode DL #10, письмо www.t23b.org
 * `hq-session-on-hands-project`): its own HQ session would take the HQ's sheet and queue for its own.
 * At a terminal the question, Enter opens the HQ's HQ session; with nobody to ask, a refusal with its
 * line. The exit code; null — the project is its own HQ, or nobody can say: the start goes on.
 */
function handsHq(
  opts: AiOptions,
  projectRoot: string,
  given: AiDeps,
  deps: AiDeps,
  selfPid: number,
  hqFrom: string[],
): number | null {
  const answer = (deps.projectHq ?? ((root: string) => projectHq(root, deps.env, deps.home)))(projectRoot);
  if (answer.kind === 'own') return null;
  if (answer.kind === 'unknown') {
    deps.log(`note: ${answer.note}`);
    return null;
  }
  const { log } = deps;
  const project = path.basename(projectRoot);
  const where = "whose hand a project is: head in echelon's mcp.yaml";
  log(`${project} is a hand of ${answer.hq} (echelon hq): the sheet and what comes from outside are its HQ's`);
  if (!answer.root) {
    log(
      `vdx ai: no HQ session here, and ${answer.hq} has no checkout on this machine — nothing started; ` +
        `its HQ session is started in its folder: vdx ai <its folder> --hq (${where})`,
    );
    return EXIT_USAGE;
  }
  const line = `vdx ai ${shellQuote(answer.root)} --hq`;
  if (opts.dryRun) {
    log(`→ dry run: a start asks to open ${answer.hq}'s HQ session instead — ${line}`);
    return EXIT_OK;
  }
  // A chain of hands (head of a head) is followed; one that comes back is not.
  const hqRoot = answer.root;
  if (hqFrom.some((p) => sameDir(p, hqRoot))) {
    log(`vdx ai: echelon names ${answer.hq} the HQ, and it leads back here — nothing started (${where})`);
    return EXIT_USAGE;
  }
  if (!asks(deps)) {
    log(`vdx ai: no HQ session in a hand — nothing started; ${answer.hq}'s HQ session: ${line} (${where})`);
    return EXIT_USAGE;
  }
  const reply = deps.ask(`Open ${answer.hq}'s HQ session instead? [Y/n]: `);
  if (reply === null || !/^(y(es)?)?$/i.test(reply.trim())) {
    log(`nothing started — ${answer.hq}'s HQ session: ${line}`);
    return EXIT_LAUNCH_FAILED;
  }
  log(`→ ${answer.hq}: ${line}`);
  return runAi({ ...opts, path: answer.root, conversation: undefined }, given, selfPid, [...hqFrom, projectRoot]);
}

export function runAi(opts: AiOptions, given: AiDeps, selfPid: number = process.pid, hqFrom: string[] = []): number {
  const { log, tmux } = given;
  if (opts.yes && opts.noInput) {
    log('vdx ai: --yes answers every question, --no-input puts none — pick one');
    return EXIT_USAGE;
  }
  const deps = opts.yes || opts.noInput ? withAnswers(given, opts.yes ? 'yes' : 'none') : given;

  // A session's row in the list of `~`: attach to it as it is, start nothing (DL #32).
  if (opts.attach !== undefined) return attachSession(opts.attach, opts, deps);

  if (opts.intercom && opts.focused) {
    log(
      'vdx ai: --intercom and --focused are different sessions — the intercom session, or one nothing wakes; pick one',
    );
    return EXIT_USAGE;
  }
  if (opts.hq && (opts.focused || opts.intercom)) {
    log(
      `vdx ai: --hq and --${opts.focused ? 'focused' : 'intercom'} are different sessions — ` +
        (opts.focused
          ? 'the one for what comes from outside, or one on a topic'
          : 'the one you sit at, or the one for letters') +
        '; pick one',
    );
    return EXIT_USAGE;
  }
  if (opts.intercom && opts.conversation) {
    log('vdx ai: --intercom starts the intercom session in a new conversation — it takes no --conversation');
    return EXIT_USAGE;
  }
  if (
    opts.find !== undefined &&
    (opts.fresh || opts.focused || opts.intercom || opts.hq || opts.conversation || opts.restart)
  ) {
    log(
      'vdx ai: --find picks from the conversations it finds — not with --new, --focused, --intercom, --hq, --conversation or --restart',
    );
    return EXIT_USAGE;
  }
  const prepared = prepare(opts.path, deps, opts.focused === true, opts.intercom === true, opts.hq === true);
  if (typeof prepared === 'number') return prepared;
  const { projectRoot, environment, profileDir } = prepared;
  let { plan } = prepared;
  // An HQ session only where the project is its own HQ (hq-session-mode DL #10). A restart is about the
  // session that runs, and from inside it no terminal is there to ask.
  if (plan.hq && !opts.restart) {
    const hands = handsHq(opts, projectRoot, given, deps, selfPid, hqFrom);
    if (hands !== null) return hands;
  }
  // Run by a focused session's agent about itself: a new topic, nothing started. Read before the
  // marks below go: VDX_FOCUSED here is the agent's.
  const changed = changeTopic(opts, plan, deps, selfPid);
  if (changed !== null) return changed;
  const by = startedBy(opts, deps.env);
  // The agent started here runs on this machine: it does not inherit where the person sat,
  // and its mode is this start's flag, not the shell vdx runs in.
  delete deps.env[SEAT_ENV_VAR];
  delete deps.env[FOCUSED_ENV_VAR];
  delete deps.env[INTERCOM_ENV_VAR];
  delete deps.env[HQ_ENV_VAR];
  const handedPane = deps.env[RESTART_PANE_ENV_VAR] ?? null;
  delete deps.env[RESTART_PANE_ENV_VAR];
  // Under `vdx ai@<host>` the person is not here: this machine goes by its name.
  const atSeat = sameMachine(plan.seat, plan.host);
  const here = atSeat ? `here, on ${plan.host}` : `on ${plan.host}`;
  const vdxAiHere = atSeat ? 'vdx ai' : `vdx ai@${plan.host}`;
  if (opts.conversation && !isClaude(plan.command)) {
    log(`vdx ai: --conversation names a Claude Code conversation; the agent here is ${plan.command}`);
    return EXIT_USAGE;
  }
  // A start continues the last conversation unless asked for a new one; a focused session and
  // the intercom session are new ones.
  const wantsNew = (opts.fresh || opts.focused === true || plan.intercom) && !opts.conversation;
  if (wantsNew) plan = { ...plan, resumeArgs: [] };
  // The new conversation's first message: --prompt, or else the topic named with the flag (DL #30).
  // One that starts with `-` would reach the agent as a flag of its own.
  const firstOf = (topic: string | undefined): string[] => {
    const first = opts.prompt ?? topic;
    if (!first) return [];
    if (!first.startsWith('-')) return [first];
    log(
      `note: the ${opts.prompt ? 'prompt' : 'topic'} starts with "-", so it does not go to the agent as a first prompt`,
    );
    return [];
  };
  if (plan.focused && (opts.topic || opts.prompt)) plan = { ...plan, opening: firstOf(opts.topic) };

  let multiplexer = plan.multiplexer;
  if (multiplexer === 'tmux' && !tmux.available()) {
    log('vdx ai: tmux is not installed — starting the agent in this terminal');
    multiplexer = 'none';
  }
  if (opts.topic && multiplexer !== 'tmux') {
    log(
      `vdx ai: a topic lives in the agent's tmux pane (${TOPIC_OPTION}), and this start has no tmux ` +
        `(session.multiplexer: tmux in the profile, and tmux installed) — nothing started; without a topic: vdx ai --focused ${shellQuote(projectRoot)}`,
    );
    return EXIT_USAGE;
  }

  const procs = multiplexer === 'tmux' ? deps.processes() : [];
  // Names a new session does not take: one a terminal elsewhere shows, and — but for the one intercom
  // or HQ session, whose start under way is waited for — one where an agent's start is under way.
  const takenNames = (single: boolean) =>
    new Set([
      ...viewedElsewhere(tmux, deps.env),
      ...(single ? [] : agentSessions(tmux, deps.processes(), plan.command)),
    ]);
  const agentsHere = multiplexer === 'tmux' ? findAgentPanes(tmux.panes(), procs, projectRoot, plan.command) : [];
  // What a fallen tmux server took down (vdx-ai-predictable P6): said before any start; a plain
  // start at a terminal offers to bring it back.
  const lost =
    multiplexer === 'tmux' && isClaude(plan.command) && !plan.intercom
      ? lostHere(deps, plan, environment, !opts.dryRun && !opts.list)
      : null;
  // The intercom session, the HQ session and the person's other sessions do not see each other:
  // --intercom and --hq are about their one session, and every other start leaves those alone.
  const mailOf = deps.agentMail ?? ((pid: number) => processMode(pid) === 'mail');
  const hqAgent = hqOf(deps);
  const running = agentsHere.filter((a) => mailOf(a.proc.pid) === plan.intercom && hqAgent(a.proc.pid) === plan.hq);
  const aside = agentsHere.filter((a) => !running.includes(a));
  const asideWords = aside.map((a) => ({
    pane: a.pane,
    what: hqAgent(a.proc.pid)
      ? 'the HQ session'
      : mailOf(a.proc.pid)
        ? 'the intercom session'
        : `not the ${plan.hq ? 'HQ' : 'intercom'} session`,
  }));
  const focusedOf = deps.agentFocused ?? processFocused;
  const conversationOf = (a: AgentPane) => liveConversationId(deps.env, deps.home, a.proc.pid);
  // Which running agent the start is about. A new conversation, or one no agent here is in, starts
  // next to them; --restart replaces one. An agent whose conversation vdx cannot read may be in the
  // one asked for: no second agent in it blindly.
  const inConversation = opts.conversation ? running.find((a) => conversationOf(a) === opts.conversation) : undefined;
  // A focused start names a topic a focused session here already has: that session is the one asked
  // for, not one more next to it (vdx-ai-predictable Sidetrack #7).
  const topicAsked =
    plan.focused && opts.topic && !opts.conversation && !opts.restart ? normalizeTopic(opts.topic) : '';
  let onTopic = topicAsked
    ? running.find((a) => focusedOf(a.proc.pid) && normalizeTopic(paneTopic(tmux, a.pane.paneId) ?? '') === topicAsked)
    : undefined;
  // The list below asked for the topic too: the question about it is not put again.
  let topicAnswered = false;
  // Its rows, when a new one was picked over them: agents of other machines the person has seen.
  let shownInList: Shown[] = [];
  if (onTopic) log(`→ ${onTopic.pane.session} is the focused session on «${topicAsked}» — attaching to it`);
  // Not one on that very topic: the focused sessions running alike — or all, with no topic — are rows
  // of a question, and Enter starts a new one (DL #29, Sidetrack #19).
  else if (plan.focused && !opts.conversation && !opts.restart && multiplexer === 'tmux' && isClaude(plan.command)) {
    const chosen = chooseFocused({
      plan,
      deps,
      running,
      focusedOf,
      conversationOf,
      topic: topicAsked,
      ask: asks(deps) && !opts.dryRun,
      dryRun: opts.dryRun,
      icons: environment.session?.machine_icons ?? {},
    });
    if (chosen === null) {
      log('no answer — nothing started');
      return EXIT_LAUNCH_FAILED;
    }
    if (chosen.kind === 'new' && chosen.asked) topicAnswered = true;
    if (chosen.kind === 'new' && chosen.shown) shownInList = chosen.shown;
    if (chosen.kind === 'here') {
      onTopic = chosen.pane;
      // Its topic stays its own: the one typed was only what to look for.
      opts = { ...opts, topic: undefined };
      log(`→ ${chosen.pane.pane.session}: attaching to it`);
    } else if (chosen.kind === 'there') {
      log(`→ ${chosen.at.session} on ${chosen.at.machine}: attaching to it there`);
      return runAiRemote(
        { ...opts, path: projectRoot, topic: undefined, conversation: chosen.at.conversation ?? undefined },
        chosen.at.machine,
        deps,
        plan.seat,
      );
    } else if (chosen.topic) {
      topicAnswered = true;
      opts = { ...opts, topic: chosen.topic };
      plan = { ...plan, opening: firstOf(chosen.topic) };
    }
  }
  const unreadable = opts.conversation && !inConversation ? running.find((a) => conversationOf(a) === null) : undefined;
  // One intercom or HQ session per project and machine: a running one is the one, never a second next to it.
  let alongside =
    !plan.intercom &&
    !plan.hq &&
    running.length > 0 &&
    !opts.restart &&
    !inConversation &&
    !unreadable &&
    !onTopic &&
    (wantsNew || !!opts.conversation);
  let current = inConversation ?? unreadable ?? onTopic;

  // A plain start of Claude Code: one list of what runs on every machine and what can be
  // continued, unless the choice is plain (vdx-ai-predictable).
  const wrapSkills = environment.session?.wrap_skills ?? [];
  const onBoard =
    opts.list === true ||
    opts.find !== undefined ||
    (isClaude(plan.command) && !opts.conversation && !opts.restart && !plan.intercom && !plan.hq && !wantsNew);
  let boardChoice: ConversationChoice | null = null;
  let boardNew = false;
  // Any other start says what tmux took down, with the command that brings it back.
  if (lost && !onBoard) {
    if (lost.note) log(`note: ${lost.note}`);
    else for (const l of [...lost.lines, lost.hint]) log(l);
  }
  if (onBoard) {
    if (!isClaude(plan.command)) {
      log(
        `vdx ai: --${opts.find !== undefined ? 'find' : 'list'} reads Claude Code's agents and conversations; the agent here is ${plan.command}`,
      );
      return EXIT_USAGE;
    }
    // A search nobody can be asked about is printed with the commands for its rows, as --list is.
    const ask = asks(deps) && !opts.dryRun;
    const listed = opts.list || (opts.find !== undefined && !ask);
    // cmux tabs here that lost their sessions (restore-after-any-crash): only a person in a cmux tab here
    // sends them back — `r` does, with every agent a fall took down.
    const tabsBack =
      ask && !listed && sameMachine(plan.host, plan.seat) && cmuxSurface(deps.env) ? tabsToSend(tabsHere(deps)) : [];
    const agentsBack = ask && !listed ? (lost?.mine.length ?? 0) : 0;
    const offer = agentsBack + tabsBack.length;
    if (lost && !lost.note) {
      const say = (l: string) => (listed ? deps.out(`${l}\n`) : log(l));
      for (const l of lost.lines) say(l);
      if (agentsBack === 0 || agentsBack < lost.all.length) say(lost.hint);
    }
    const tabLines = tabsBack.map(
      (p) =>
        `     ${targetLabel(p.target)}${p.state === 'gone' ? ' — cmux lost its tab' : p.panel?.title ? `  («${p.panel.title}»)` : ''}`,
    );
    if (tabsBack.length)
      for (const l of [
        `⚠ ${tabs(tabsBack.length)} here lost ${tabsBack.length === 1 ? 'its session' : 'their sessions'}:`,
        ...tabLines,
      ])
        log(l);
    // Each part with its verb, the tabs by name: the row reads as what it does (the owner, 2026-11-19).
    const tabNames = tabsBack.map((p) => targetLabel(p.target));
    const restoreWhat = [
      agentsBack > 0
        ? agentsBack === 1
          ? 'bring back the agent tmux took down'
          : `bring back the ${agentsBack} agents tmux took down`
        : null,
      tabsBack.length > 0
        ? `return ${tabsBack.length === 1 ? 'the cmux tab to its session' : `${tabsBack.length} cmux tabs to their sessions`}: ` +
          (tabNames.length > 3
            ? `${tabNames.slice(0, 3).join(', ')} +${tabNames.length - 3} more`
            : tabNames.join(', '))
        : null,
    ]
      .filter(Boolean)
      .join(' and ');
    const outcome = boardStart(
      plan,
      deps,
      running,
      aside.filter((a) => hqAgent(a.proc.pid)),
      procs,
      wrapSkills,
      { focused: focusedOf, mail: mailOf, hq: hqAgent },
      listed ? 'print' : ask ? 'ask' : 'auto',
      opts.find,
      offer,
      environment.session?.machine_icons ?? {},
      {
        footnotes: lost?.note ? [lost.note] : [],
        restoreDetail: [
          ...(lost && agentsBack > 0 ? [...lost.lines, lost.hint.trim()] : []),
          ...(tabsBack.length ? ['cmux tabs that go back into their sessions:', ...tabLines] : []),
        ],
        what: restoreWhat,
      },
    );
    switch (outcome.kind) {
      case 'listed':
        return EXIT_OK;
      case 'session':
        // A session's row in the list of `~`: attach to it, start nothing (DL #32).
        for (const l of outcome.lines) log(l);
        return sameMachine(outcome.host, plan.host)
          ? attachSession(outcome.session, opts, deps)
          : runAiRemote({ ...opts, attach: outcome.session }, outcome.host, deps, plan.seat);
      case 'abort':
        for (const l of outcome.lines) log(l);
        return EXIT_LAUNCH_FAILED;
      case 'remote':
        for (const l of outcome.lines) log(l);
        return runAiRemote(
          { ...opts, path: projectRoot, conversation: outcome.conversation ?? undefined, hq: outcome.hq || opts.hq },
          outcome.host,
          deps,
          plan.seat,
        );
      case 'attach': {
        for (const l of outcome.lines) log(l);
        if (outcome.open) {
          const answer = asks(deps)
            ? deps.ask(`${outcome.agent.pane.session} is open in another terminal here — attach this one too? [y/N]: `)
            : null;
          if (!/^y(es)?$/i.test(answer?.trim() ?? '')) {
            log(`nothing done — ${outcome.agent.pane.session} is in your other terminal`);
            return EXIT_LAUNCH_FAILED;
          }
        }
        current = outcome.agent;
        break;
      }
      case 'continue':
        boardChoice = outcome.choice;
        // A 🎯 row goes on focused, a 👑 one as the HQ session — not as a plain agent with the channel flag
        // (vdx-ai-list-owner-findings П. 1, П. 4).
        if (outcome.choice.hq) plan = { ...prepared.replan(false, true), resumeArgs: plan.resumeArgs };
        else if (outcome.choice.focused) plan = { ...prepared.replan(true), resumeArgs: plan.resumeArgs };
        break;
      case 'restore': {
        // Everything a fall took down, as `vdx ai --restore` (restore-after-any-crash DL #4): this tab stays.
        runAiRestore(false, deps, false, true);
        // What runs now is another list: the start goes on from there — from the same seat, which
        // this start dropped from the environment before its agents came back.
        return runAi(opts, { ...deps, env: { ...deps.env, [SEAT_ENV_VAR]: plan.seat } }, selfPid);
      }
      case 'new':
        for (const l of outcome.lines) log(l);
        boardChoice = { args: [], lines: [] };
        boardNew = true;
        plan = outcome.focused ? { ...prepared.replan(true), resumeArgs: [] } : { ...plan, resumeArgs: [] };
        break;
    }
  }

  // An empty session of the project here — nothing typed in it since /clear — is the place for a
  // new conversation, not a reason for one more next to it (vdx-ai-predictable P9). Not one a
  // terminal at this seat shows, not one with a draft, and not a focused one for a plain start.
  let reused = false;
  if (
    isClaude(plan.command) &&
    !current &&
    !opts.restart &&
    !plan.intercom &&
    !plan.hq &&
    !opts.conversation &&
    (wantsNew || boardNew) &&
    running.length > 0
  ) {
    const free = agentFacts(running, plan, deps, procs, wrapSkills, {
      focused: focusedOf,
      mail: mailOf,
      hq: hqAgent,
    }).find((f) => {
      const started = liveStartedAt(deps.env, deps.home, f.pid);
      const fresh = started !== null && Date.now() - started < FRESH_AGENT_MS;
      return f.empty && !fresh && f.draft === 0 && !openAtSeat(f, plan.seat) && (plan.focused || !f.focused);
    });
    const pane = free && running.find((a) => a.proc.pid === free.pid);
    if (pane) {
      current = pane;
      alongside = false;
      reused = true;
      log(`♻ ${pane.pane.session}: nothing typed in it since /clear — the new conversation goes there`);
    }
  }
  // --restart run inside an agent of the project — its shell, `!` at its prompt — is about that agent,
  // never the newest: the newest was another person's session (t23b-program, 2026-11-08). The restart
  // such a session hands off names its pane.
  const self = opts.restart
    ? handedPane
      ? agentsHere.find((a) => a.pane.paneId === handedPane)
      : agentsHere.find((a) => a.proc.pid === findOwnAgent(procs, selfPid, plan.command)?.pid)
    : undefined;
  if (self && !current && !opts.conversation) {
    const restartLine = (flag: string, conversation?: string | null) =>
      `vdx ai${flag} --restart ${shellQuote(projectRoot)}${conversation ? ` --conversation ${conversation}` : ''}`;
    if (!running.includes(self)) {
      const flag = hqAgent(self.proc.pid) ? ' --hq' : ' --intercom';
      log(
        `vdx ai --restart: ${self.pane.session} is ${flag === ' --hq' ? "the project's HQ session" : "the project's intercom session"}` +
          ` — nothing restarted; it: ${restartLine(flag)}`,
      );
      return EXIT_USAGE;
    }
    if (focusedOf(self.proc.pid) && !plan.focused) {
      const id = conversationOf(self);
      log(
        `vdx ai --restart: ${self.pane.session} is focused, and a plain --restart makes it a plain session — nothing restarted`,
      );
      log(`  focused, in this conversation: ${restartLine(' --focused')}`);
      log(`  focused, in a new conversation: ${restartLine(' --focused --new')}`);
      if (id) log(`  plain, in this conversation:   ${restartLine('', id)}`);
      return EXIT_USAGE;
    }
    current = self;
  }
  // Several agents and nobody to ask: a guess would stop a session someone works in.
  if (opts.restart && !current && running.length > 1 && (!asks(deps) || opts.dryRun)) {
    log(
      `vdx ai --restart: ${running.length} agents of this project run here, and nobody to ask which — nothing restarted:`,
    );
    for (const a of running) {
      const id = conversationOf(a);
      const focused = focusedOf(a.proc.pid);
      const topic = focused ? paneTopic(tmux, a.pane.paneId) : null;
      log(`  ${a.pane.session} ${a.pane.paneId}${focused ? ` — focused${topic ? ` «${topic}»` : ''}` : ''}`);
      log(
        id
          ? `    vdx ai${focused ? ' --focused' : ''} --restart ${shellQuote(projectRoot)} --conversation ${id}`
          : `    its conversation is not known here — at a terminal vdx ai --restart ${shellQuote(projectRoot)} asks which; from its own prompt: ! vdx ai --restart`,
      );
    }
    return opts.dryRun ? EXIT_OK : EXIT_USAGE;
  }
  if (!onBoard && !current && !alongside && running.length > 0) {
    const picked = pickAgent(running, focusedOf, deps, !opts.dryRun);
    if (picked === null) {
      log('nothing done');
      return EXIT_LAUNCH_FAILED;
    }
    current = picked;
  }
  // A running agent keeps its mode: plain `vdx ai` takes a focused one as it is,
  // and the rules it leaves out are not missing from it. So with the HQ session picked on the list.
  const runningFocused = current ? focusedOf(current.proc.pid) : false;
  if (current && !opts.restart && runningFocused && !plan.focused) {
    plan = { ...prepared.replan(true), resumeArgs: plan.resumeArgs };
  }
  if (current && !opts.restart && !plan.hq && hqAgent(current.proc.pid)) {
    plan = { ...prepared.replan(false, true), resumeArgs: plan.resumeArgs };
  }

  // What a start continues. A restart keeps the conversation the agent is in.
  let choice: ConversationChoice | null = boardChoice;
  if (boardChoice) plan = { ...plan, resumeArgs: boardChoice.args };
  else if (!current || opts.restart) {
    // The intercom session runs next to the person's agents on any machine by design: nothing to ask.
    if (plan.intercom) choice = { args: [], lines: [] };
    else if (opts.conversation) {
      // A focused conversation named without --focused goes on as asked, and the line says what it was and how
      // to have it back (vdx-ai-list-owner-findings П. 1: «все настройки будут восстановлены?»).
      const was = plan.focused
        ? null
        : conversationTopic({ env: deps.env, home: deps.home, projectRoot, id: opts.conversation });
      // Not on a copy behind another machine's, nor beside the agent that writes it there (DL #8).
      const away = conversationElsewhere(plan, deps, opts.conversation);
      choice = {
        args: resumeId(opts.conversation),
        ...(away.there
          ? {
              remote: {
                host: away.there.host,
                id: opts.conversation,
                reachable: true,
                ask: away.there.why,
                runs: away.there.runs,
              },
            }
          : {}),
        lines: [
          ...away.notes,
          ...(away.there ? [away.there.why] : []),
          ...(was
            ? [
                `note: ${opts.conversation.slice(0, 8)} was a focused conversation «${clip(was, 60)}» — this start is not focused; ` +
                  `focused again: vdx ai ${shellQuote(projectRoot)} --focused --conversation ${opts.conversation}`,
              ]
            : []),
        ],
      };
    }
    // So does the HQ session, and it is a new conversation — but a restart keeps the one it is in:
    // a restart for a plugin should not cost it its context (hq-session-mode DL #3).
    else if (plan.hq) {
      const live = current && plan.resumeArgs.length > 0 ? conversationOf(current) : null;
      choice = live
        ? { args: resumeId(live), lines: [`the agent is in conversation ${live.slice(0, 8)} — resuming it`] }
        : { args: [], lines: [] };
    }
    // A restart keeps the conversation the agent is in, focused too; a new one is --new. A restart for a
    // profile's flag lost the focused session its conversation (obsidianvault, 2026-11-15; Sidetrack #22).
    else if (opts.restart && current && plan.focused && !opts.fresh && isClaude(plan.command)) {
      const live = conversationOf(current);
      choice = live
        ? { args: resumeId(live), lines: [`the agent is in conversation ${live.slice(0, 8)} — resuming it`] }
        : { args: [], lines: ['its conversation is not known here — starting a new one'] };
    }
    // A focused session started with --detach is a new conversation of its own, and nobody is there
    // to answer: an HQ starts one for a step while it runs on another machine itself
    // (vdx-ai-predictable Sidetrack #16).
    else if (plan.focused && opts.detach) choice = { args: [], lines: [] };
    // A restart into a new conversation replaces the agent here, and a new one next to an agent here
    // is what was asked for: the other machines are not asked.
    else if ((current || alongside) && plan.resumeArgs.length === 0) choice = { args: [], lines: [] };
    else if (current && isClaude(plan.command)) {
      const live = liveConversationId(deps.env, deps.home, current.proc.pid);
      choice = live
        ? { args: resumeId(live), lines: [`the agent is in conversation ${live.slice(0, 8)} — resuming it`] }
        : chooseConversation(plan, deps, false);
    } else choice = chooseConversation(plan, deps, !opts.dryRun, shownInList);
    plan = { ...plan, resumeArgs: choice.args };
  }

  // A prompt opens a new conversation: a start that goes on in one does not send it.
  if (opts.prompt && ((current && !opts.restart && !(reused && plan.focused)) || plan.resumeArgs.length > 0))
    log('note: --prompt is the first message of a new conversation — this start goes on in one, so it is not sent');

  const poolDirs = authorPoolDirs(environment, projectRoot, deps.home, profileDir);
  // Said before a start or an attach, never in the way: the agent runs, without those files.
  const denied =
    (deps.platform ?? process.platform) === 'darwin'
      ? unreadableFolders(multiplexer === 'tmux' ? tmux : null, deps.home)
      : [];
  const folders = denied.length
    ? foldersWarning(denied, multiplexer === 'tmux', environment.session?.folders_fix, deps.home)
    : [];
  if (opts.dryRun) {
    const topic = plan.hq
      ? HQ_TOPIC
      : !plan.focused
        ? null
        : multiplexer === 'tmux'
          ? (listTopic(boardChoice) ?? chooseTopic(opts, plan, deps, current, false))
          : { text: null, from: 'none: a topic lives in the tmux pane, and this start has none' };
    // The same branches as the start below: an agent it attaches to, one it restarts, or a place of
    // its own. The plan used to name a new session for an agent it attaches to (2026-11-05).
    let target: PlanTarget;
    if (current && !opts.restart && !(reused && plan.focused)) {
      const unfocused = plan.focused && !runningFocused;
      const drift = unfocused || missingArgs(current.proc.args, plan.args).length > 0;
      target = { kind: 'attach', session: current.pane.session, drift };
    } else if (current) target = { kind: 'restart', session: current.pane.session, paneId: current.pane.paneId };
    else {
      const name = freeSessionName(plan.sessionName, running, takenNames(plan.intercom || plan.hq));
      target = { kind: 'new', session: name, window: multiplexer === 'tmux' && tmux.hasSession(name) };
    }
    deps.out(renderPlan(plan, multiplexer, running, focusedOf, target, asideWords, topic));
    for (const l of choice?.lines ?? []) deps.out(`  conversation: ${l}\n`);
    if (choice?.remote?.ask)
      deps.out(
        `  conversation: the start asks to continue it on ${choice.remote.host} instead (Enter — yes); with no terminal, nothing starts\n`,
      );
    for (const l of folders) deps.out(`  ${l}\n`);
    ensureAuthor(projectRoot, poolDirs, deps, true);
    ensureMemory(
      projectRoot,
      plan.command,
      personalHosts(environment.git?.personal_hosts),
      deps,
      true,
      agentsHere.length > 0,
    );
    return EXIT_OK;
  }
  for (const l of choice?.lines ?? []) log(l);
  for (const l of folders) log(l);
  if (choice?.abort) return EXIT_LAUNCH_FAILED;
  if (choice?.elsewhere && !current) {
    const answer = asks(deps) ? deps.ask(`Start a new conversation ${here}${atSeat ? ',' : ''} anyway? [y/N]: `) : null;
    if (!/^y(es)?$/i.test(answer?.trim() ?? '')) {
      // Said with the reason: without a terminal the question above was never asked.
      log(
        asks(deps)
          ? 'nothing started'
          : `nothing started: an agent of this project runs on ${choice.elsewhere.join(', ')}, and a new conversation ` +
              `${here}${atSeat ? ',' : ''} needs a yes — at a terminal, or --yes — or a session of its own: --focused "<topic>" --detach`,
      );
      return EXIT_LAUNCH_FAILED;
    }
  }

  let askHere = choice?.askHere;
  if (choice?.remote) {
    const { host, id, reachable, ask, runs } = choice.remote;
    // There the conversation brings its topic back itself (chooseTopic): the flag is enough.
    const as = choice.hq ? { hq: true } : choice.focused ? { focused: true } : {};
    // A start that named its conversation here, and it runs there or its copy there is ahead: there, after a yes
    // whose Enter is harmless; with no terminal to ask, nothing (DL #8).
    if (ask) {
      const answer = asks(deps) ? deps.ask(`Continue it on ${host} instead? [Y/n]: `) : null;
      if (answer === null || /^n(o)?$/i.test(answer.trim())) {
        const flags = `${plan.hq ? ' --hq' : plan.focused ? ' --focused' : ''} --conversation ${id}`;
        // Running there, it is that agent's: here only once Syncthing has brought a copy that is behind.
        log(
          `nothing started${asks(deps) ? '' : ' — no terminal to ask'}. On ${host}${runs ? ', where it runs' : ''}: ` +
            `vdx ai@${host} ${shellQuote(projectRoot)}${flags}` +
            (runs
              ? ''
              : ` · ${atSeat ? 'here' : `on ${plan.host}`}, once Syncthing has brought it: ${vdxAiHere} ${shellQuote(projectRoot)}${flags}`),
        );
        return EXIT_LAUNCH_FAILED;
      }
    }
    if (reachable) return runAiRemote({ ...opts, ...as, path: projectRoot, conversation: id }, host, deps, plan.seat);
    log(`✗ ${host} does not answer over ssh — its conversation ${id.slice(0, 8)} cannot be continued there`);
    askHere = { id, why: `If it still runs on ${host}, both machines will write to it` };
  }
  if (askHere) {
    const { id, why } = askHere;
    const answer = asks(deps) ? deps.ask(`Continue ${id.slice(0, 8)} ${here}? ${why}. [y/N]: `) : null;
    if (!/^y(es)?$/i.test(answer?.trim() ?? '')) {
      log(
        `nothing started. ${atSeat ? 'Here' : `On ${plan.host}`}: ${vdxAiHere} ${shellQuote(projectRoot)} --conversation ${id}` +
          ` · a new conversation: ${vdxAiHere} --new ${shellQuote(projectRoot)}`,
      );
      return EXIT_LAUNCH_FAILED;
    }
    plan = { ...plan, resumeArgs: resumeId(id) };
  }
  ensureAuthor(projectRoot, poolDirs, deps, false);
  ensureMemory(
    projectRoot,
    plan.command,
    personalHosts(environment.git?.personal_hosts),
    deps,
    false,
    agentsHere.length > 0,
  );

  if (multiplexer === 'none') {
    if (opts.restart) {
      log('vdx ai: --restart works on tmux sessions; without tmux there is nothing to restart');
      return EXIT_USAGE;
    }
    if (!deps.interactive) {
      log('vdx ai: no terminal here and no tmux — an interactive agent needs one of them');
      return EXIT_USAGE;
    }
    for (const c of plan.confirm) log(`note: the agent will ask "${c.screen}" — answer it with ${c.keys.join(' ')}`);
    const mark = modeEnvVar(plan);
    const env = mark ? { ...process.env, [mark]: '1' } : undefined;
    const startedAt = Date.now();
    let res = spawnSync(plan.command, launchArgs(plan, [...plan.args, ...plan.resumeArgs]), {
      cwd: projectRoot,
      stdio: 'inherit',
      env,
    });
    if (at(res.error, 'code') === 'ENOENT') {
      log(`vdx ai: \`${plan.command}\` not found on PATH`);
      return 127;
    }
    const failedAtOnce = res.status !== null && res.status !== 0 && Date.now() - startedAt < NOTHING_TO_RESUME_MS;
    if (plan.resumeArgs.length > 0 && failedAtOnce) {
      log(
        `↻ nothing to resume — starting without ${plan.resumeArgs.join(' ')}: ${agentLine({ ...plan, resumeArgs: [] }, plan.args)}`,
      );
      res = spawnSync(plan.command, launchArgs({ ...plan, resumeArgs: [] }, plan.args), {
        cwd: projectRoot,
        stdio: 'inherit',
        env,
      });
    }
    return res.status ?? 1;
  }

  if (alongside) {
    const icons = environment.session?.machine_icons ?? {};
    const names = running.map((r) =>
      agentLabel({ machine: plan.host, session: r.pane.session, pid: r.proc.pid }, icons),
    );
    const others = names
      .map((n, i) => (names.indexOf(n) === names.lastIndexOf(n) ? n : `${n} ${running[i]!.pane.paneId}`))
      .join(', ');
    log(
      `note: ${others} keep${running.length === 1 ? 's' : ''} running ${plan.command} — starting another one next to it, ` +
        `in ${opts.conversation ? `conversation ${opts.conversation.slice(0, 8)}` : 'a new conversation'}`,
    );
  }

  // A focused conversation in an empty session: its agent restarts focused, with the new topic.
  if (current && !opts.restart && !(reused && plan.focused)) {
    if (current === unreadable) {
      log(
        `note: ${current.pane.session} runs ${plan.command} in a conversation vdx cannot read — attaching to it; ` +
          `to switch it: vdx ai --restart ${shellQuote(projectRoot)} --conversation ${opts.conversation}`,
      );
    }
    if (plan.hq && opts.conversation && current !== inConversation && current !== unreadable) {
      log(
        `note: ${current.pane.session} is the project's HQ session, in another conversation, and there is one per project ` +
          `and machine — attaching to it; to switch it: vdx ai --hq --restart ${shellQuote(projectRoot)} --conversation ${opts.conversation}`,
      );
    }
    const unfocused = plan.focused && !runningFocused;
    // A topic named for the focused agent attached to is its topic from now on.
    const { session, paneId: attachedPane } = current.pane;
    const attachTopic = () => {
      if (!opts.topic || !runningFocused) return;
      if (setPaneTopic(tmux, attachedPane, opts.topic)) log(`🎯 ${session}: the topic is «${opts.topic}»`);
      else log(`✗ ${session}: tmux did not take the topic`);
    };
    const missing = unfocused ? [] : missingArgs(current.proc.args, plan.args);
    if (!unfocused && missing.length === 0) {
      const mode = runningFocused
        ? ', focused'
        : plan.intercom
          ? ', the intercom session'
          : plan.hq
            ? ', the HQ session'
            : '';
      log(`✓ ${current.pane.session}: already running with the profile${mode} — ${current.proc.args}`);
      attachTopic();
      // Nobody sits at a detached start: a prompt of the profile's the agent still waits on — a start
      // gave up on it before it came (echelon, 2026-11-08) — is answered now.
      let stuck = false;
      if (!deps.interactive || opts.detach) {
        const pending = [...plan.confirm];
        for (;;) {
          const looked = pending.length ? answerOnScreen(pending, current.pane.paneId, deps) : null;
          if (looked !== 'answered') {
            stuck = looked === 'stuck';
            break;
          }
        }
      }
      return finish(
        !stuck,
        current.pane.session,
        current.pane.paneId,
        opts,
        deps,
        runningFocused || plan.hq,
        plan.seat,
      );
    }
    // Drift. In a terminal the person picks: the agent as it runs, or a restart
    // with the profile; without one nothing is touched, and the fix is named.
    const drift = `${current.pane.session}: ${plan.command} is running${unfocused ? ', not focused' : ` without ${missing.join(' ')}`}`;
    const modeFlag = plan.focused ? ' --focused' : plan.intercom ? ' --intercom' : plan.hq ? ' --hq' : '';
    const fix =
      `vdx ai --restart${modeFlag}${opts.fresh ? ' --new' : ''} ${shellQuote(projectRoot)}` +
      (opts.conversation ? ` --conversation ${opts.conversation}` : '');
    const effect = plan.resumeArgs.length
      ? 'stops the running agent, then resumes its conversation'
      : opts.fresh || plan.intercom
        ? 'stops the running agent and starts a new conversation'
        : 'stops the running agent; the conversation is not resumed — the profile has no resume_args';
    if (!asks(deps)) {
      log(`✗ ${drift}`);
      log(`  ${unfocused ? 'to focus it' : 'to apply the profile'}: ${fix} (${effect})`);
      return EXIT_DRIFT;
    }
    log(`⚠ ${drift}`);
    log(
      `  Enter  ${opts.detach ? 'leave it running' : 'attach to it'} as is${unfocused ? '' : ' — the flags wait for a restart'}`,
    );
    log(`  r      restart it ${unfocused ? 'focused' : 'with the profile'}: ${effect}`);
    log(`  q      leave it; later: ${fix}`);
    const answer = deps.ask(`${opts.detach ? 'Leave it as is' : 'Attach as is'}? [Enter/r/q]: `);
    if (answer === '') {
      log(`→ ${current.pane.session}: as is — ${current.proc.args}`);
      attachTopic();
      return finish(true, current.pane.session, current.pane.paneId, opts, deps, runningFocused || plan.hq, plan.seat);
    }
    if (answer?.toLowerCase() !== 'r') {
      log('nothing done');
      return EXIT_DRIFT;
    }
    // As --restart: the conversation the agent is in, not the folder's newest — another agent's, maybe.
    const live = isClaude(plan.command) && plan.resumeArgs.length > 0 ? conversationOf(current) : null;
    if (live) plan = { ...plan, resumeArgs: resumeId(live) };
    // Not the folder's newest either: it may be a conversation of the person's.
    else if (plan.hq) plan = { ...plan, resumeArgs: [] };
  }

  // Nobody sits at a detached start, and Claude Code holds one in a folder it does not trust on
  // its trust window, unseen (intercom-session-mode Sidetrack #4). The answer is the person's.
  if (opts.detach && isClaude(plan.command) && claudeTrusts(projectRoot, deps.env, deps.home) === false) {
    log(`✗ Claude Code has not trusted ${projectRoot} yet: a detached agent would wait on its trust window, unseen`);
    log(`  start it once at a terminal and answer the window: ${vdxAiHere} ${shellQuote(projectRoot)}`);
    return EXIT_LAUNCH_FAILED;
  }

  // The topic goes into the tmux session before the agent starts: its session-start hook reads it.
  let topic: Topic | null = plan.hq ? HQ_TOPIC : null;
  if (plan.focused) {
    topic = listTopic(boardChoice) ?? chooseTopic(opts, plan, deps, reused ? undefined : current, !topicAnswered);
    if (!topic) {
      log('no answer — nothing started');
      return EXIT_LAUNCH_FAILED;
    }
  }
  const topicSaid = () => {
    if (topic) log(topic.text ? `🎯 topic «${topic.text}» (${topic.from})` : `🎯 no topic yet — ${topic.from}`);
  };

  // The pane vdx runs in: its restart would take this vdx down before it answers the new agent's
  // prompts. It goes on in a vdx of its own, apart from the pane, with what it says in a file.
  if (current && current === self && !handedPane) {
    const logFile = path.join(
      deps.home,
      '.cache',
      'vdx',
      'restart',
      `${current.pane.session.replace(/[^\w@.-]/g, '_')}.log`,
    );
    const args = [
      'ai',
      projectRoot,
      '--restart',
      ...(opts.fresh ? ['--new'] : []),
      ...(opts.conversation ? ['--conversation', opts.conversation] : []),
      ...(opts.focused ? ['--focused', ...(opts.topic ? [opts.topic] : [])] : []),
      ...(opts.hq ? ['--hq'] : []),
      ...(opts.intercom ? ['--intercom'] : []),
      '--detach',
    ];
    const pid = (deps.handOff ?? handOffRestart)(
      args,
      { ...deps.env, [RESTART_PANE_ENV_VAR]: current.pane.paneId },
      logFile,
    );
    if (pid === null) {
      log(`✗ ${current.pane.session}: the restart could not go on apart from this session — nothing restarted`);
      log(`  from another terminal: vdx ai${opts.focused ? ' --focused' : ''} --restart ${shellQuote(projectRoot)}`);
      return EXIT_LAUNCH_FAILED;
    }
    log(
      `↻ ${current.pane.session} ${current.pane.paneId}: this is the session vdx runs in — it restarts from outside it ` +
        `(pid ${pid}) and stops now; what that says: ${logFile}`,
    );
    return EXIT_OK;
  }

  // Claude Code with its transcripts nowhere would run on without them (projects-link-mount-race).
  const nowhere = awaitClaudeReach(deps, [], REACH_START_MS)[0];
  if (nowhere) {
    log(`${transcriptsNowhere(nowhere, deps, REACH_START_MS)}; nothing started`);
    return EXIT_LAUNCH_FAILED;
  }

  // A letter's intercom session over the machine's limit waits in the queue; its letter waits in the inbox
  // (intercom-session-mode DL #13). The person's own start (no --detach) is not counted, nor held.
  if (!current && plan.intercom && opts.detach) {
    const limit = deps.intercomLimit ?? intercomLimit();
    const busy = lettersSessionsHere(deps, deps.env[INTERCOM_FREEING_ENV_VAR]?.trim() || null);
    // Its own, under way from another letter, is no place to wait for: the start below finds it.
    if (busy.length >= limit && !busy.includes(plan.sessionName)) {
      // One line on stdout, for the sender's assistant to retell; queued again — the same line, its place kept.
      const place = enqueue(deps.home, projectRoot);
      deps.out(
        `⏸ queued: ${path.basename(projectRoot)} — ${busy.length} of ${limit} intercom sessions live on ` +
          `${hostLabel(deps.env)}, place ${place}; vdx starts it when one closes, and the letter waits in the inbox\n`,
      );
      return EXIT_QUEUED;
    }
    dequeue(deps.home, projectRoot);
    startQueued(deps, limit - busy.length - 1, null);
  }

  if (current) {
    const line = agentLine(plan, [...plan.args, ...plan.resumeArgs]);
    log(`↻ ${current.pane.session} ${current.pane.paneId}: restarting — ${line}`);
    setPaneTopic(tmux, current.pane.paneId, topic?.text ?? null);
    markSessionStays(current.pane.session, opts, deps);
    topicSaid();
    tmux.respawn(current.pane.paneId, projectRoot, tmuxShellCommand(line, deps.shell, !plan.intercom));
    return finish(
      settleResumed(plan, current.pane.paneId, deps),
      current.pane.session,
      current.pane.paneId,
      opts,
      deps,
      plan.focused || plan.hq,
      plan.seat,
    );
  }

  if (opts.restart) log(`note: no running ${plan.command} in this project — starting one`);
  if (plan.intercom && plan.opening.length === 0)
    log('note: the profile has no agent.intercom_args — the intercom session starts idle and waits for a wake');
  if (plan.hq && plan.opening.length === 0 && plan.resumeArgs.length === 0)
    log('note: the profile has no agent.hq_args — the HQ session starts with no first prompt');
  const line = agentLine(plan, [...plan.args, ...plan.resumeArgs]);
  const cmd = tmuxShellCommand(line, deps.shell, !plan.intercom);
  // One intercom or HQ session per project and machine holds for two starts at once too: letters
  // come in pairs, and each sender starts it (intercom-session-mode DL #11) — its start under way is
  // waited for below, under its one name.
  const single = plan.intercom || plan.hq;
  const session = freeSessionName(plan.sessionName, running, takenNames(single));
  const sameMode = (pid: number) => mailOf(pid) === plan.intercom && hqAgent(pid) === plan.hq;
  let reuse = tmux.hasSession(session);
  let other = single && reuse ? startUnderWay(plan, session, sameMode, deps) : null;
  // The start it waited for may have taken the session with it.
  if (single && reuse && !other) reuse = tmux.hasSession(session);
  let paneId = '';
  if (!other) {
    try {
      paneId = reuse ? tmux.newWindow(session, projectRoot, cmd) : tmux.newSession(session, projectRoot, cmd);
    } catch (err) {
      // tmux gives one name to one session: the other start took it after the look above.
      if (!single || reuse || !tmux.hasSession(session)) throw err;
      deps.sleep(300);
      other = startUnderWay(plan, session, sameMode, deps);
      if (!other) throw err;
    }
  }
  if (other?.agent) {
    log(`✓ ${session}: another start got there first — ${other.agent.args}`);
    return finish(true, session, other.pane.paneId, opts, deps, plan.hq, plan.seat);
  }
  if (other) {
    paneId = other.pane.paneId;
    log(
      `⚠ ${session} ${paneId}: no ${plan.command} after ${Math.round(startUnderWayMs(deps) / 1000)} s — starting it again`,
    );
    tmux.respawn(paneId, projectRoot, cmd);
  }
  // A window in a session that was there: its pane is set even with no topic, so a topic the session
  // kept from a vdx before 0.59 does not show through.
  if (paneId && (topic?.text || reuse)) setPaneTopic(tmux, paneId, topic?.text ?? null);
  if (paneId) setPaneBy(tmux, paneId, by);
  markSessionStays(session, opts, deps);
  log(`▶ ${session}${reuse && !other ? ' (new window)' : ''}: ${line}`);
  topicSaid();
  return finish(settleResumed(plan, paneId, deps), session, paneId, opts, deps, plan.focused || plan.hq, plan.seat);
}
