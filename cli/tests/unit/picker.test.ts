import { describe, expect, it } from 'vitest';
import { fold, fzfArgs, parseFzf, rowsWidth } from '../../src/picker.ts';

const input = { header: ['proj', 'keys'], items: [{ text: 'a', detail: [] }], cursor: 2 };
const option = (args: string[], name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

describe('fzfArgs: the list of vdx ai as fzf shows it (vdx-ai-predictable Sidetrack #15)', () => {
  it("the row's index is hidden and comes back; the cursor starts on Enter's row; the panel reads the row's file", () => {
    const args = fzfArgs(input, "/tmp/it's");
    expect(args).toContain('--with-nth=2..');
    expect(args).toContain('--delimiter=\t');
    expect(args).toContain('--no-sort');
    expect(args).toContain('--print-query');
    expect(args).toContain('--expect=ctrl-s,ctrl-y');
    // The terminal's own selection works in it, and the input line says what typing does.
    expect(args).toContain('--no-mouse');
    expect(args).toContain('--prompt=type to filter: ');
    // fzf counts rows from 1.
    expect(option(args, 'bind')).toBe('load:pos(3)');
    expect(option(args, 'preview')).toBe(`cat '/tmp/it'\\''s'/{1}`);
    expect(option(args, 'header')).toBe('proj\nkeys');
  });

  it('a header line longer than the rows are wide is folded: fzf would cut it', () => {
    const long = 'note: two agents of other projects went down when tmux here was started again';
    expect(fold(long, 40)).toEqual([
      'note: two agents of other projects went',
      '    down when tmux here was started',
      '    again',
    ]);
    expect(fold('short', 40)).toEqual(['short']);
    // The panel is beside the rows in a wide terminal: the header has 60% of it; in a narrow one — all.
    const wide = option(fzfArgs({ ...input, header: [long], columns: 100 }, '/d'), 'header')!.split('\n');
    expect(Math.max(...wide.map((l) => l.length))).toBeLessThanOrEqual(56);
    expect(option(fzfArgs({ ...input, header: [long], columns: 90 }, '/d'), 'header')).toBe(long);
    expect([rowsWidth(100), rowsWidth(99)]).toEqual([56, 95]);
  });
});

describe("parseFzf: fzf's answer", () => {
  it('Enter on a row: no key, the row by its index, the filter typed', () => {
    expect(parseFzf('\n\n2\t  beta two\n', 0)).toEqual({ key: '', index: 2, query: '' });
    expect(parseFzf('bet\n\n12\t  beta\ttwo\n', 0)).toEqual({ key: '', index: 12, query: 'bet' });
  });

  it('the search key with a phrase that matches no row (exit 1): the key and the phrase still come', () => {
    expect(parseFzf('zzz\nctrl-s\n', 1)).toEqual({ key: 'ctrl-s', index: null, query: 'zzz' });
    expect(parseFzf('zzz\n\n', 1)).toEqual({ key: '', index: null, query: 'zzz' });
  });

  it('Esc and Ctrl-C (exit 130) — the person left; any other exit — fzf did not run as asked', () => {
    expect(parseFzf('', 130)).toBeNull();
    expect(parseFzf('', 2)).toBe('failed');
    expect(parseFzf('', null)).toBe('failed');
  });
});
