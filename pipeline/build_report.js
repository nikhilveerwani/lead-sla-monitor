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

// ---------- statistics ----------
function wilson(k, n, z = 1.96) {
  if (!n) return [null, null];
  const p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d;
  const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
function erfc(x) {                       // Abramowitz-Stegun 7.1.26, |error| < 1.5e-7
  const t = 1 / (1 + 0.3275911 * x);
  return t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
}
function twoPropTest(k1, n1, k2, n2) {    // two-sided p and 95% CI for p1 - p2
  const p1 = k1 / n1, p2 = k2 / n2, pp = (k1 + k2) / (n1 + n2);
  const z = (p1 - p2) / Math.sqrt(pp * (1 - pp) * (1 / n1 + 1 / n2));
  const se = Math.sqrt(p1 * (1 - p1) / n1 + p2 * (1 - p2) / n2);
  return { diff: p1 - p2, lo: p1 - p2 - 1.96 * se, hi: p1 - p2 + 1.96 * se, p: erfc(Math.abs(z) / Math.SQRT2) };
}
const dowOf = d => new Date(d + 'T00:00:00Z').getUTCDay();
const done = r => r.status !== 'Running';
const last30 = rows.filter(r => r.created_date >= days[0] && r.created_date < today && done(r));
const sat = last30.filter(r => dowOf(r.created_date) === 6), wk = last30.filter(r => [1, 2, 3, 4].includes(dowOf(r.created_date)));
const onTime = a => a.filter(r => r.status === 'On time').length;
const satTest = twoPropTest(onTime(sat), sat.length, onTime(wk), wk.length);

const mtdAll = periods.MTD.total, mtdRate = mtdAll && mtdAll.sla_pct != null ? mtdAll.sla_pct / 100 : null;
for (const p of ['D-1', 'WTD', 'MTD']) {
  periods[p].reps.forEach(g => {
    const n = g.on_time + g.late + g.not_called, [lo, hi] = wilson(g.on_time, n);
    g.ci = [lo, hi];
    g.sig_below = mtdRate != null && hi != null && hi < mtdRate;        // even the optimistic end is below average
  });
}
const below = periods.MTD.reps.filter(g => g.sig_below).map(g => g.key);
const satPerMonth = sat.length / (days.length / 30.4);
const rescued = Math.round(satPerMonth * Math.max(0, -satTest.diff));
const fmtP = p => p < 0.001 ? 'p < 0.001' : `p = ${p.toFixed(3)}`;
const summary = {
  headline: `Saturday leads are called on time ${(100 * onTime(sat) / sat.length).toFixed(0)}% of the time, against ${(100 * onTime(wk) / wk.length).toFixed(0)}% Monday–Thursday: the biggest gap in the data.`,
  points: [
    `Month to date, ${mtdAll ? mtdAll.sla_pct.toFixed(1) : '–'}% of leads got a first call within 24 hours; ${mtdAll ? mtdAll.breached : 0} breached.`,
    `The Saturday gap is ${(100 * -satTest.diff).toFixed(0)} points (95% CI ${(100 * -satTest.hi).toFixed(0)}–${(100 * -satTest.lo).toFixed(0)}, ${fmtP(satTest.p)}, last 30 days). It isn't a people problem: nobody calls on Sunday, so Saturday-afternoon leads expire before Monday.`,
    below.length ? `${below.length} rep${below.length > 1 ? 's are' : ' is'} significantly below the team average (${below.join(', ')}), meaning even the upper end of their 95% interval is below it. The other ${periods.MTD.reps.length - below.length} reps' differences are within normal variation.`
                 : `No rep is significantly below the team average; the differences between reps are within normal variation.`,
    mtdAll ? `Of this month's ${mtdAll.breached} breaches, ${mtdAll.late} were called late and ${mtdAll.not_called} never called. The late ones are a scheduling fix; the never-called ones need the overdue list worked daily. Median time to first call: ${median != null ? median.toFixed(1) : '–'} hours.`
           : `Median time to first call: ${median != null ? median.toFixed(1) : '–'} hours.`,
  ],
  recommendation: `Add a 4-hour Sunday calling block (or a Saturday 6–9 pm block). At the weekday rate it would rescue about ${rescued} leads a month. Coach ${below.length ? below.join(' and ') : 'no one individually'}: the rest of the gap is the calendar, not the reps.`,
};

const act = sla.actionList(rows, now, 7);
const slim = r => ({ id: r.lead_id, owner: r.owner, team: r.team, source: r.source, created: r.created_ms, deadline: r.deadline_ms, reason: reasonBy[r.lead_id] || '' });

const data = {
  synthetic: true, summary,
  sat_test: { sat_n: sat.length, sat_on_time: onTime(sat), wk_n: wk.length, wk_on_time: onTime(wk), ...satTest },
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
