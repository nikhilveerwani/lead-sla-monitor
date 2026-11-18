/**
 * Lead SLA core: pure functions, no I/O.
 *
 * The SAME file runs in two places:
 *   - Google Apps Script (V8), inside the Sheets template (apps-script/Code.gs)
 *   - Node.js, for the unit tests and the demo report pipeline
 *
 * Rules
 *   - SLA = the first call ATTEMPT must happen within SLA_HOURS of the lead being created.
 *   - Only calls made AFTER the lead was created count. A call logged before creation
 *     belongs to an earlier registration of the same person, so it is ignored.
 *   - Status:  On time  | Late (called after the deadline) | Not called (deadline passed, no call)
 *              Running  (still inside its window, no call yet: excluded from SLA %)
 *   - Periods are grouped on the LEAD CREATION date, in the business timezone:
 *       D-1 = yesterday, WTD = Monday..yesterday, MTD = 1st..yesterday.
 *   - SLA % = On time / (On time + Late + Not called).
 */

var SLA_DEFAULTS = { slaHours: 24, tzOffsetMinutes: 330 };   // IST = UTC+05:30

function toMs(x) { return x instanceof Date ? x.getTime() : new Date(x).getTime(); }

/** Calendar date (YYYY-MM-DD) of an instant, in the business timezone. */
function localDate(ms, tzOffsetMinutes) {
  return new Date(ms + tzOffsetMinutes * 60000).toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  var d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** D-1, WTD (Mon-start) and MTD ranges, all ending yesterday. Inclusive date strings. */
function periodRanges(nowMs, tzOffsetMinutes) {
  var today = localDate(nowMs, tzOffsetMinutes);
  var yesterday = addDays(today, -1);
  var dow = new Date(yesterday + 'T00:00:00Z').getUTCDay();          // 0=Sun
  var monday = addDays(yesterday, -((dow + 6) % 7));
  var first = yesterday.slice(0, 8) + '01';
  return {
    'D-1': { from: yesterday, to: yesterday },
    'WTD': { from: monday, to: yesterday },
    'MTD': { from: first, to: yesterday }
  };
}

/**
 * One row per lead with its SLA status.
 * leads: [{lead_id, created_at, owner, team, source}]
 * calls: [{lead_id, called_at, rep, duration_sec}]
 */
function computeSla(leads, calls, nowMs, opts) {
  opts = opts || {};
  var slaHours = opts.slaHours || SLA_DEFAULTS.slaHours;
  var tz = opts.tzOffsetMinutes != null ? opts.tzOffsetMinutes : SLA_DEFAULTS.tzOffsetMinutes;

  var byLead = {};
  calls.forEach(function (c) { (byLead[c.lead_id] = byLead[c.lead_id] || []).push(toMs(c.called_at)); });

  return leads.map(function (l) {
    var created = toMs(l.created_at);
    var deadline = created + slaHours * 3600000;
    var first = null, ignored = 0, attempts = 0;
    (byLead[l.lead_id] || []).forEach(function (t) {
      if (t < created) { ignored++; return; }
      attempts++;
      if (first === null || t < first) first = t;
    });
    var status;
    if (first !== null) status = first <= deadline ? 'On time' : 'Late';
    else status = nowMs > deadline ? 'Not called' : 'Running';
    return {
      lead_id: l.lead_id, owner: l.owner, team: l.team, source: l.source,
      created_ms: created, created_date: localDate(created, tz), deadline_ms: deadline,
      first_call_ms: first,
      hours_to_first_call: first === null ? null : Math.round((first - created) / 36000) / 100,
      attempts: attempts, calls_before_creation_ignored: ignored, status: status
    };
  });
}

/** Counts and SLA % for rows in a date range, grouped by a key ('team', 'owner', or null for total). */
function summarize(rows, range, groupKey) {
  var groups = {};
  rows.forEach(function (r) {
    if (r.created_date < range.from || r.created_date > range.to) return;
    var k = groupKey ? r[groupKey] : 'Total';
    var g = groups[k] = groups[k] || { key: k, leads: 0, on_time: 0, late: 0, not_called: 0, running: 0 };
    g.leads++;
    if (r.status === 'On time') g.on_time++;
    else if (r.status === 'Late') g.late++;
    else if (r.status === 'Not called') g.not_called++;
    else g.running++;
  });
  return Object.keys(groups).sort().map(function (k) {
    var g = groups[k], done = g.on_time + g.late + g.not_called;
    g.sla_pct = done ? Math.round(1000 * g.on_time / done) / 10 : null;
    g.breached = g.late + g.not_called;
    return g;
  });
}

/** Leads to call right now: not called and past deadline (newest first), then running leads closest to breaching. */
function actionList(rows, nowMs, lookbackDays) {
  var since = nowMs - (lookbackDays || 7) * 86400000;
  var overdue = rows.filter(function (r) { return r.status === 'Not called' && r.created_ms >= since; })
    .sort(function (a, b) { return b.created_ms - a.created_ms; });
  var atRisk = rows.filter(function (r) { return r.status === 'Running' && r.deadline_ms - nowMs < 6 * 3600000; })
    .sort(function (a, b) { return a.deadline_ms - b.deadline_ms; });
  return { overdue: overdue, at_risk: atRisk };
}

function pad(s, n, right) { s = String(s); while (s.length < n) s = right ? ' ' + s : s + ' '; return s; }

/** Plain-text Slack digest (mrkdwn with a monospaced table). Identical in the template and the demo. */
function slackDigest(rows, nowMs, opts) {
  opts = opts || {};
  var tz = opts.tzOffsetMinutes != null ? opts.tzOffsetMinutes : SLA_DEFAULTS.tzOffsetMinutes;
  var ranges = periodRanges(nowMs, tz);
  var lines = ['*Lead SLA: first call within ' + (opts.slaHours || SLA_DEFAULTS.slaHours) + 'h*  ·  ' +
               'D-1 ' + ranges['D-1'].from + '  ·  WTD from ' + ranges.WTD.from + '  ·  MTD from ' + ranges.MTD.from, ''];
  ['D-1', 'WTD', 'MTD'].forEach(function (p) {
    var t = summarize(rows, ranges[p], 'team'), tot = summarize(rows, ranges[p], null)[0];
    lines.push('*' + p + '*');
    lines.push('```' + pad('Team', 10) + pad('Leads', 7, true) + pad('On time', 9, true) + pad('Late', 6, true) +
               pad('Missed', 8, true) + pad('SLA', 8, true));
    t.concat(tot ? [tot] : []).forEach(function (g) {
      lines.push(pad(g.key, 10) + pad(g.leads, 7, true) + pad(g.on_time, 9, true) + pad(g.late, 6, true) +
                 pad(g.not_called, 8, true) + pad(g.sla_pct == null ? '-' : g.sla_pct.toFixed(1) + '%', 8, true));
    });
    lines[lines.length - 1] += '```';
  });
  var a = actionList(rows, nowMs, 7);
  lines.push('', ':rotating_light: *' + a.overdue.length + '* leads from the last 7 days still not called · ' +
             '*' + a.at_risk.length + '* will breach in the next 6h');
  if (opts.sheetUrl) lines.push('<' + opts.sheetUrl + '|Open the lead list>');
  return lines.join('\n');
}

if (typeof module !== 'undefined') {
  module.exports = { SLA_DEFAULTS: SLA_DEFAULTS, localDate: localDate, addDays: addDays, periodRanges: periodRanges,
                     computeSla: computeSla, summarize: summarize, actionList: actionList, slackDigest: slackDigest };
}
