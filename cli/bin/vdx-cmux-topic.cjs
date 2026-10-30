#!/usr/bin/env node
'use strict';
/**
 * The topic of a focused session as the description of the cmux workspace that shows it
 * (focused-topic DL #6). Started by `vdx ai`, the process cmux started: only such a process
 * reaches cmux's socket (`automation.socketControlMode` = `cmuxOnly`).
 *
 *   vdx-cmux-topic.cjs watch|clear --workspace <id> --cli <cmux> --state <file> --snapshot <file>
 *                      (--session <tmux session> [--socket <name>] | --host <ssh host> --token <t>)
 *                      [--parent <pid>] [--every <ms>]
 *
 * watch — until the parent ends: reads the session's @vdx_topic (on <host> over ssh, the
 *   session marked @vdx_cmux = <token>; none marked within 30 s — it exits) and sets the
 *   description when the topic changes; no topic — clears it. When the parent is gone, clears and
 *   exits.
 * clear — clears the description, if it is still the one set here.
 *
 * --every: one poll interval throughout, and ten of them instead of the first 30 s (tests).
 *
 * A description is ours when it is the text last set here (kept in --state); one the person set
 * by hand — any other text in cmux's session snapshot — is never touched.
 */
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const FIRST_MS = 3_000;
const FIRST_FOR_MS = 30_000;
const EVERY_MS = 15_000;

function parse(argv) {
  const opts = { mode: argv[0] };
  for (let i = 1; i < argv.length; i += 2) opts[argv[i].replace(/^--/, '')] = argv[i + 1];
  return opts;
}

/** Markdown: these would turn the topic into emphasis, a link or code. */
function escapeMarkdown(text) {
  return text.replace(/[\\`*_[\]]/g, '\\$&');
}

function readTopic(o) {
  const run = (cmd, args) =>
    spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
  if (o.host) {
    const res = run('ssh', [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=5',
      o.host,
      "tmux -u list-sessions -F '#{@vdx_cmux}|#{@vdx_topic}'",
    ]);
    if (res.status !== 0) return undefined;
    const line = res.stdout.split('\n').find((l) => l.startsWith(`${o.token}|`));
    if (line === undefined) return null;
    o.found = true;
    return line.slice(o.token.length + 1).trim() || null;
  }
  const res = run('tmux', [
    '-u',
    ...(o.socket ? ['-L', o.socket] : []),
    'show-options',
    '-qv',
    '-t',
    `=${o.session}:`,
    '@vdx_topic',
  ]);
  return res.status === 0 ? res.stdout.trim() || null : undefined;
}

/** The workspace's description in cmux's session snapshot; undefined — not known. */
function currentDescription(o) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(o.snapshot, 'utf8'));
  } catch {
    return undefined;
  }
  const seen = [data];
  while (seen.length) {
    const v = seen.pop();
    if (Array.isArray(v)) seen.push(...v);
    else if (v && typeof v === 'object') {
      if (v.workspaceId === o.workspace) return typeof v.customDescription === 'string' ? v.customDescription : '';
      seen.push(...Object.values(v));
    }
  }
  return undefined;
}

function ours(o) {
  try {
    return fs.readFileSync(o.state, 'utf8');
  } catch {
    return null;
  }
}

function cmux(o, args) {
  return (
    spawnSync(o.cli, ['workspace-action', '--workspace', o.workspace, ...args], { stdio: 'ignore', timeout: 10_000 })
      .status === 0
  );
}

/** Set the description to the topic, or clear ours; a description set by hand stays. */
function apply(o, topic) {
  const mine = ours(o);
  const now = currentDescription(o);
  if (now && now !== mine) return;
  if (topic) {
    const text = escapeMarkdown(topic);
    if (text === mine && now === mine) return;
    // Written first: stopped right after the set, the clear still knows the description is ours.
    fs.writeFileSync(o.state, text);
    if (!cmux(o, ['--action', 'set-description', '--description', text])) fs.rmSync(o.state, { force: true });
  } else if (mine !== null) clear(o);
}

function clear(o) {
  const mine = ours(o);
  if (mine === null) return;
  const now = currentDescription(o);
  if (now === undefined || now === '' || now === mine) cmux(o, ['--action', 'clear-description']);
  fs.rmSync(o.state, { force: true });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const o = parse(process.argv.slice(2));
if (o.mode === 'clear') clear(o);
else if (o.mode === 'watch') {
  const parent = Number(o.parent || process.ppid);
  const every = Number(o.every) || 0;
  const firstMs = every || FIRST_MS;
  const firstFor = every ? 10 * every : FIRST_FOR_MS;
  const laterMs = every || EVERY_MS;
  const started = Date.now();
  let last;
  const tick = () => {
    if (!alive(parent)) {
      clear(o);
      process.exit(0);
    }
    const topic = readTopic(o);
    // The vdx there marks only a focused session it attaches to (or is older): none marked — nothing to show.
    if (o.host && !o.found && Date.now() - started > firstFor) {
      clear(o);
      process.exit(0);
    }
    // Not known (tmux or ssh did not answer): leave the description as it is.
    if (topic !== undefined && topic !== last) {
      apply(o, topic);
      last = topic;
    }
    setTimeout(tick, Date.now() - started < firstFor ? firstMs : laterMs);
  };
  tick();
} else {
  console.error(
    'usage: vdx-cmux-topic.cjs watch|clear --workspace <id> --cli <cmux> --state <file> --snapshot <file> …',
  );
  process.exit(2);
}
