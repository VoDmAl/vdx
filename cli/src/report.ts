import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import Table from 'cli-table3';
import type { AuditResult } from './audit.ts';
import type { DoctorReport, CheckStatus } from './doctor.ts';

const ANSI = {
  bold: (s: string): string => `\x1b[1m${s}\x1b[22m`,
  dim: (s: string): string => `\x1b[2m${s}\x1b[22m`,
  green: (s: string): string => `\x1b[32m${s}\x1b[39m`,
  yellow: (s: string): string => `\x1b[33m${s}\x1b[39m`,
  red: (s: string): string => `\x1b[31m${s}\x1b[39m`,
};

let terminalMarked: Marked | null = null;
function getTerminalMarked(): Marked {
  if (terminalMarked) return terminalMarked;
  const m = new Marked();
  m.use(markedTerminal({ reflowText: false, tab: 2 }) as never);
  terminalMarked = m;
  return m;
}

const SYMBOL: Record<string, string> = {
  aligned: '✅',
  gap: '⚠️ ',
  over: '🔵',
  excluded: '➖',
};

export function reportMarkdown(r: AuditResult): string {
  const lines: string[] = [];
  lines.push(`# vdx audit report`);
  lines.push('');
  lines.push(`- **Baseline**: \`${r.baseline}\``);
  lines.push(`- **Stack**: \`${r.stack}\``);
  lines.push(`- **Achieved level**: **${r.achieved_level}**`);
  lines.push('');
  lines.push(`## Axes`);
  lines.push('');
  lines.push(`| Axis | Class | Achieved | Target | Drift |`);
  lines.push(`|------|:-----:|:--------:|:------:|:------|`);
  for (const a of r.per_axis) {
    const cls = a.class === 'critical' ? '**C**' : 's';
    const drift = a.suppressed ? '— suppressed —' : `${SYMBOL[a.drift_kind] ?? ''} ${a.drift_kind}`;
    lines.push(`| \`${a.axis_id}\` | ${cls} | ${a.achieved} | ${a.target} | ${drift} |`);
  }

  if (r.overrides.length > 0) {
    lines.push('');
    lines.push(`## Overrides`);
    for (const o of r.overrides) {
      const kind = o.suppress ? 'suppress' : `target=${o.target}`;
      const until = o.until ? `, until ${o.until}` : '';
      lines.push(`- \`${o.axis}\` — ${kind}, reason: ${o.reason}${until}`);
    }
  }

  if (r.expired_overrides.length > 0) {
    lines.push('');
    lines.push(`## ⚠️  Expired overrides`);
    for (const x of r.expired_overrides) lines.push(`- \`${x}\``);
  }

  return lines.join('\n') + '\n';
}

export function reportJson(r: AuditResult): string {
  return JSON.stringify(r, null, 2);
}

export function reportAnsi(r: AuditResult): string {
  const md = reportMarkdown(r);
  const out = getTerminalMarked().parse(md) as string;
  return out.endsWith('\n') ? out : out + '\n';
}

const CHECK_SYMBOL: Record<CheckStatus, string> = {
  ok: '✅',
  warning: '⚠️ ',
  missing: '❌',
};

export function reportDoctorMarkdown(r: DoctorReport): string {
  const lines: string[] = [];
  lines.push('# vdx doctor report');
  lines.push('');
  lines.push(
    `**OK**: ${r.ok}  **Warning**: ${r.warning}  **Missing**: ${r.missing}`,
  );
  lines.push('');
  lines.push('| Check | Status | Detail | Remedy |');
  lines.push('|-------|:------:|--------|--------|');
  for (const c of r.checks) {
    const sym = CHECK_SYMBOL[c.status];
    const level = c.level !== undefined ? ` (L${c.level})` : '';
    const remedy = c.remedy ? `\`${c.remedy}\`` : '—';
    lines.push(`| **${c.label}** | ${sym} ${c.status}${level} | ${c.message} | ${remedy} |`);
  }
  return lines.join('\n') + '\n';
}

export function reportDoctorJson(r: DoctorReport): string {
  return JSON.stringify(r, null, 2);
}

const STATUS_RENDER: Record<CheckStatus, (s: string) => string> = {
  ok: ANSI.green,
  warning: ANSI.yellow,
  missing: ANSI.red,
};

function termWidth(fallback = 100): number {
  const w = process.stdout.columns;
  if (typeof w === 'number' && w >= 60) return w;
  return fallback;
}

export function reportDoctorAnsi(r: DoctorReport): string {
  const lines: string[] = [];
  lines.push(ANSI.bold('vdx doctor'));
  const summary =
    `${STATUS_RENDER.ok(`✅ ${r.ok} ok`)}  ` +
    `${STATUS_RENDER.warning(`⚠ ${r.warning} warning`)}  ` +
    `${STATUS_RENDER.missing(`✗ ${r.missing} missing`)}`;
  lines.push(summary);
  lines.push('');

  const total = termWidth();
  const checkW = 18;
  const statusW = 14;
  const remedyW = Math.max(20, Math.min(36, Math.floor((total - checkW - statusW - 6) * 0.4)));
  const detailW = Math.max(24, total - checkW - statusW - remedyW - 6);

  const table = new Table({
    head: [ANSI.bold('Check'), ANSI.bold('Status'), ANSI.bold('Detail'), ANSI.bold('Remedy')],
    colWidths: [checkW, statusW, detailW, remedyW],
    wordWrap: true,
    wrapOnWordBoundary: true,
    style: { head: [], border: [] },
  });
  for (const c of r.checks) {
    const sym = CHECK_SYMBOL[c.status];
    const level = c.level !== undefined ? ` L${c.level}` : '';
    const statusCell = STATUS_RENDER[c.status](`${sym} ${c.status}${level}`);
    table.push([ANSI.bold(c.label), statusCell, c.message, c.remedy ?? ANSI.dim('—')]);
  }
  lines.push(table.toString());
  lines.push('');
  return lines.join('\n');
}
