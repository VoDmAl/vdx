import { describe, expect, it } from 'vitest';
import { reportAnsi, reportMarkdown, reportJson } from '../../src/report.ts';
import type { AuditResult } from '../../src/audit.ts';

const FIXTURE: AuditResult = {
  baseline: 'github.com/VoDmAl/vdx-rubric-vodmal@v0.3.1',
  stack: 'node',
  achieved_level: 'L2',
  per_axis: [
    {
      axis_id: 'lifecycle-interface',
      class: 'critical',
      achieved: 'L2',
      target: 'L4',
      drift_kind: 'gap',
    },
    {
      axis_id: 'ci',
      class: 'critical',
      achieved: 'L4',
      target: 'L4',
      drift_kind: 'aligned',
    },
    {
      axis_id: 'secrets-config',
      class: 'supporting',
      achieved: 'L0',
      target: 'L4',
      drift_kind: 'excluded',
      suppressed: true,
    },
  ],
  overrides: [
    {
      axis: 'secrets-config',
      suppress: true,
      reason: 'CLI/docs repo, no runtime env',
    },
  ],
  expired_overrides: [],
};

describe('reportMarkdown', () => {
  it('emits headers, table, and bullets as raw markdown', () => {
    const out = reportMarkdown(FIXTURE);
    expect(out).toContain('# vdx audit report');
    expect(out).toContain('**Achieved level**: **L2**');
    expect(out).toContain('| Axis | Class | Achieved | Target | Drift |');
    expect(out).toContain('`lifecycle-interface`');
    expect(out).toContain('## Overrides');
  });
});

describe('reportJson', () => {
  it('returns valid JSON containing per_axis array', () => {
    const out = reportJson(FIXTURE);
    const parsed = JSON.parse(out);
    expect(parsed.achieved_level).toBe('L2');
    expect(parsed.per_axis).toHaveLength(3);
    expect(parsed.per_axis[0].axis_id).toBe('lifecycle-interface');
  });
});

describe('reportAnsi', () => {
  const stripAnsi = (s: string): string =>
    s.replace(/\x1b\[[0-9;]*m/g, '');

  it('contains ANSI escape sequences when chalk colors are forced', () => {
    const prev = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = '1';
    try {
      const out = reportAnsi(FIXTURE);
      expect(out).toMatch(/\x1b\[/);
    } finally {
      if (prev === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = prev;
    }
  });

  it('surfaces level + axis names + report title in the rendered text', () => {
    const plain = stripAnsi(reportAnsi(FIXTURE));
    expect(plain).toContain('L2');
    expect(plain).toContain('lifecycle-interface');
    expect(plain).toContain('vdx audit report');
  });

  it('renders the table using box-drawing characters (cli-table)', () => {
    const plain = stripAnsi(reportAnsi(FIXTURE));
    expect(plain).toMatch(/[─│┌┐└┘├┤┬┴┼]/);
  });
});
