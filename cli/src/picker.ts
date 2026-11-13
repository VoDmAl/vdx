import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { COMMAND_KEY, SEARCH_KEY } from './board.ts';

/**
 * The list of `vdx ai` with a cursor (vdx-ai-predictable Sidetrack #15): at a terminal, with fzf on
 * PATH, the person moves over the rows, types to filter them and reads the row under the cursor in
 * a panel — instead of reading numbered lines and typing a number. fzf does the screen and the
 * keys; vdx gives it the rows board.ts made and reads back which one was taken. Without fzf, without
 * a terminal, and in `--list`, the list is the plain one.
 */

export interface PickerInput {
  /** Lines that stay above the rows. */
  header: string[];
  items: { text: string; detail: string[] }[];
  /** The row the cursor starts on: Enter at once takes it. */
  cursor: number;
  /** The terminal's width: fzf cuts a header line that is longer, so a long one is folded first. */
  columns?: number;
}

/** What the person did: the key that ended it (`''` — Enter), the row under the cursor, the filter typed. */
export interface PickerAnswer {
  key: string;
  index: number | null;
  query: string;
}

/** The panel beside the rows is at least this wide; narrower — it goes under them. */
const PANEL_MIN = 40;

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A line folded at spaces to `width` characters; the lines after the first are indented. */
export function fold(line: string, width: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const word of line.split(' ')) {
    if (current && current.length + 1 + word.length > width) {
      out.push(current);
      current = `    ${word}`;
    } else current = current ? `${current} ${word}` : word;
  }
  return [...out, current];
}

/**
 * The cells a row or a header line has in a terminal `columns` wide: the panel takes 40% at the right,
 * and goes under the rows when that is under 40 cells; fzf keeps a few cells at the left for itself.
 */
export function rowsWidth(columns: number): number {
  return (columns * 0.4 >= PANEL_MIN ? Math.floor(columns * 0.6) : columns) - 4;
}

/**
 * fzf's options. Each row goes in as `<index>\t<text>`: the index is not shown and not searched, it
 * comes back with the row and names its panel file in `dir`.
 */
export function fzfArgs(input: PickerInput, dir: string): string[] {
  const width = Math.max(40, rowsWidth(input.columns ?? 80));
  return [
    '--ansi',
    '--no-sort',
    '--no-multi',
    '--layout=reverse',
    '--delimiter=\t',
    '--with-nth=2..',
    '--print-query',
    `--expect=${SEARCH_KEY},${COMMAND_KEY}`,
    // The input line says what typing does; fzf's count of rows says nothing here — titles are rows too.
    '--prompt=type to filter: ',
    '--info=hidden',
    // The terminal's own selection works: a command in the panel can be copied.
    '--no-mouse',
    `--header=${input.header.flatMap((l) => fold(l, width)).join('\n')}`,
    `--bind=load:pos(${input.cursor + 1})`,
    `--preview=cat ${shellQuote(dir)}/{1}`,
    `--preview-window=right,40%,wrap,<${PANEL_MIN}(down,8,wrap)`,
  ];
}

/**
 * fzf's answer (`--print-query --expect`): the filter, the key, the row. Exit 1 — nothing matched
 * the filter: the key and the filter still came. Null — the person left (Esc, Ctrl-C).
 * `failed` — fzf did not run as asked.
 */
export function parseFzf(stdout: string, status: number | null): PickerAnswer | null | 'failed' {
  if (status === 130) return null;
  if (status !== 0 && status !== 1) return 'failed';
  const [query = '', key = '', row] = stdout.split('\n');
  const index = row ? Number(row.split('\t')[0]) : NaN;
  return { key, index: Number.isInteger(index) ? index : null, query };
}

/** Show the rows in fzf on this terminal and wait for the person. */
export function fzfPick(input: PickerInput): PickerAnswer | null | 'failed' {
  let dir: string;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-pick-'));
  } catch {
    return 'failed';
  }
  try {
    input.items.forEach((item, i) => fs.writeFileSync(path.join(dir, String(i)), item.detail.join('\n')));
    // The rows go in by stdin and the answer comes by stdout; fzf draws on the terminal itself.
    const res = spawnSync('fzf', fzfArgs(input, dir), {
      input: input.items.map((item, i) => `${i}\t${item.text}`).join('\n'),
      stdio: ['pipe', 'pipe', 'inherit'],
      encoding: 'utf8',
    });
    return res.error ? 'failed' : parseFzf(res.stdout ?? '', res.status);
  } catch {
    return 'failed';
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
