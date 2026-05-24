import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import type { AuditResult } from './audit.ts';
import type { DoctorReport, CheckStatus } from './doctor.ts';

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
    `- **OK**: ${r.ok}  **Warning**: ${r.warning}  **Missing**: ${r.missing}`,
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

export function reportDoctorAnsi(r: DoctorReport): string {
  const md = reportDoctorMarkdown(r);
  const out = getTerminalMarked().parse(md) as string;
  return out.endsWith('\n') ? out : out + '\n';
}
