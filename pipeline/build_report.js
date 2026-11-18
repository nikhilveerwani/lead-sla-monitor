// Build the demo report data from the synthetic CSVs, using the SAME sla_core.js the Apps Script template runs.
// Usage: node pipeline/build_report.js data site/data.js
const fs = require('fs');
const path = require('path');
const sla = require('../apps-script/sla_core.js');

const [dataDir = 'data', out = 'site/data.js'] = process.argv.slice(2);

function readCsv(file) {
  const [head, ...lines] = fs.readFileSync(path.join(dataDir, file), 'utf8').trim().split(/\r?\n/);
  const keys = head.split(',');
  return lines.map(l => Object.fromEntries(l.split(',').map((v, i) => [keys[i], v])));
}

const leads = readCsv('leads.csv'), calls = readCsv('calls.csv'), reasons = readCsv('reasons.csv');
const now = Date.now();
const tz = sla.SLA_DEFAULTS.tzOffsetMinutes;
const rows = sla.computeSla(leads, calls, now);
const ranges = sla.periodRanges(now, tz);

const periods = {};
for (const p of ['D-1', 'WTD', 'MTD']) {
  periods[p] = { range: ranges[p], teams: sla.summarize(rows, ranges[p], 'team'),
                 reps: sla.summarize(rows, ranges[p], 'owner'), total: sla.summarize(rows, ranges[p], null)[0] || null };
}

// daily SLA trend (completed days only)
const today = sla.localDate(now, tz);
const days = [...new Set(rows.map(r => r.created_date))].filter(d => d < today).sort().slice(-30);
const daily = days.map(d => {
  const t = sla.summarize(rows, { from: d, to: d }, null)[0];
  const teams = Object.fromEntries(sla.summarize(rows, { from: d, to: d }, 'team').map(g => [g.key, g.sla_pct]));
  return { date: d, leads: t.leads, sla_pct: t.sla_pct, breached: t.breached, teams };
});

// time to first call distribution, last 30 complete days
const buckets = [['< 1h', 0, 1], ['1–4h', 1, 4], ['4–8h', 4, 8], ['8–24h', 8, 24], ['24–48h', 24, 48], ['48h+', 48, 1e9]];
const recent = rows.filter(r => r.created_date >= days[0] && r.created_date < today);
const dist = buckets.map(([label, lo, hi]) => ({ label, n: recent.filter(r => r.hours_to_first_call != null && r.hours_to_first_call >= lo && r.hours_to_first_call < hi).length }));
dist.push({ label: 'Not called', n: recent.filter(r => r.status === 'Not called').length });
const hrs = recent.map(r => r.hours_to_first_call).filter(x => x != null).sort((a, b) => a - b);
const median = hrs.length ? hrs[Math.floor(hrs.length / 2)] : null;

// breach reasons for MTD breaches
const reasonBy = Object.fromEntries(reasons.map(r => [r.lead_id, r.reason]));
const mtdBreached = rows.filter(r => r.created_date >= ranges.MTD.from && r.created_date <= ranges.MTD.to && (r.status === 'Late' || r.status === 'Not called'));
const reasonCounts = {};
mtdBreached.forEach(r => { const k = reasonBy[r.lead_id] || 'No reason logged'; reasonCounts[k] = (reasonCounts[k] || 0) + 1; });

const act = sla.actionList(rows, now, 7);
const slim = r => ({ id: r.lead_id, owner: r.owner, team: r.team, source: r.source, created: r.created_ms, deadline: r.deadline_ms, reason: reasonBy[r.lead_id] || '' });

const data = {
  synthetic: true,
  generated_at: new Date(now + tz * 60000).toISOString().slice(0, 16).replace('T', ' ') + ' IST',
  now, sla_hours: sla.SLA_DEFAULTS.slaHours, periods,
  rep_team: Object.fromEntries(leads.map(l => [l.owner, l.team])), daily, dist, median_hours: median,
  reasons: Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]),
  action: { overdue: act.overdue.slice(0, 60).map(slim), overdue_total: act.overdue.length, at_risk: act.at_risk.slice(0, 40).map(slim), at_risk_total: act.at_risk.length },
  slack: sla.slackDigest(rows, now, { sheetUrl: 'https://docs.google.com/spreadsheets/d/your-sheet' }),
  checks: { leads: leads.length, calls: calls.length, ignored_pre_creation: rows.reduce((s, r) => s + r.calls_before_creation_ignored, 0),
            running: rows.filter(r => r.status === 'Running').length }
};
fs.writeFileSync(out, 'window.SLA_DATA = ' + JSON.stringify(data) + ';\n');
console.log(`report: ${rows.length} leads, MTD SLA ${periods.MTD.total && periods.MTD.total.sla_pct}% , ${act.overdue.length} overdue, ${act.at_risk.length} at risk -> ${out}`);
