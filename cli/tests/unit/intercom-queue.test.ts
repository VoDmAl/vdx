import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dequeue, enqueue, intercomLimit, lettersSessions, queued } from '../../src/intercom-queue.ts';

// infra-hq `intercom-session-machine-limit` (2026-11-18): a limit of intercom sessions per machine, and a queue
// over it (intercom-session-mode DL #13).
describe('the limit of intercom sessions a machine runs, and the queue over it', () => {
  let home: string;
  beforeEach(() => (home = fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-queue-'))));
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('the limit comes from memory: one per 5 GB, at least two — lft 3, m3 4', () => {
    const gb = 1024 ** 3;
    expect(intercomLimit(16 * gb)).toBe(3);
    expect(intercomLimit(24 * gb)).toBe(4);
    expect(intercomLimit(8 * gb)).toBe(2);
    expect(intercomLimit(64 * gb)).toBe(12);
  });

  it('the queue: oldest first, a project queued again keeps its place, a started one leaves', () => {
    expect(queued(home)).toEqual([]);
    expect(enqueue(home, '/p/a', 100)).toBe(1);
    expect(enqueue(home, '/p/b', 200)).toBe(2);
    expect(enqueue(home, '/p/a', 300)).toBe(1);
    expect(queued(home)).toEqual([
      { project: '/p/a', at: 100 },
      { project: '/p/b', at: 200 },
    ]);
    dequeue(home, '/p/a');
    expect(queued(home).map((q) => q.project)).toEqual(['/p/b']);
    dequeue(home, '/p/never');
  });

  it("counts the intercom sessions letters started: not the person's (@vdx_stays), not the one closing", () => {
    const listed = [
      'vdx@m3\t',
      'vdx@m3-intercom\t',
      'echelon@m3-intercom\t1',
      'nas-info@m3-intercom\t',
      'space-hq@m3-hq\t',
      'x-intercom@m3\t',
    ].join('\n');
    expect(lettersSessions(listed)).toEqual(['vdx@m3-intercom', 'nas-info@m3-intercom']);
    expect(lettersSessions(listed, 'vdx@m3-intercom')).toEqual(['nas-info@m3-intercom']);
    expect(lettersSessions('')).toEqual([]);
  });
});
