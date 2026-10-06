import * as fs from 'node:fs';
import * as path from 'node:path';
import { machineLine, projectDirName } from '../../src/conversations.ts';

/** Transcript lines in Claude Code's shape: the hook's text, a turn, the titles. */
export const hookLine = (text: string) =>
  JSON.stringify({
    type: 'attachment',
    attachment: { type: 'hook_additional_context', content: [text], hookName: 'SessionStart', hookEvent: 'SessionStart' },
  });
export const userLine = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
export const promptLine = (text: string) => JSON.stringify({ type: 'last-prompt', lastPrompt: text });
export const titleLine = (text: string) => JSON.stringify({ type: 'ai-title', aiTitle: text });
export const startedOn = (machine: string) => hookLine(`${machineLine(machine)}; the agent in this project is started with \`vdx ai\``);

export const ID = {
  a: 'aaaaaaaa-1111-4111-8111-111111111111',
  b: 'bbbbbbbb-2222-4222-8222-222222222222',
  c: 'cccccccc-3333-4333-8333-333333333333',
  d: 'dddddddd-4444-4444-8444-444444444444',
};

/** Write a conversation into `<config>/projects/<dir>/`, its mtime `minutesAgo` back. */
export function writeConversation(config: string, root: string, id: string, lines: string[], minutesAgo: number): string {
  const dir = path.join(config, 'projects', projectDirName(root));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const t = new Date(Date.now() - minutesAgo * 60_000);
  fs.utimesSync(file, t, t);
  return file;
}

/** Prompts typed on this machine, as Claude Code records them in `<config>/history.jsonl`. */
export function writeHistory(config: string, project: string, ids: string[]): void {
  fs.mkdirSync(config, { recursive: true });
  const lines = ids.map((id) => JSON.stringify({ display: 'hi', pastedContents: {}, timestamp: 1, project, sessionId: id }));
  fs.appendFileSync(path.join(config, 'history.jsonl'), lines.join('\n') + '\n');
}
