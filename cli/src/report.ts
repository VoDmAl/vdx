import type { AuditResult } from './audit.ts';

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
