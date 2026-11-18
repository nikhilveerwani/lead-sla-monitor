/**
 * Lead SLA Monitor: Google Sheets + Apps Script template.
 *
 * Needs two tabs (header row first):
 *   Leads : lead_id | created_at | owner | team | source
 *   Calls : lead_id | called_at  | rep   | duration_sec
 * and the file sla_core.gs (a copy of sla_core.js) in the same Apps Script project.
 *
 * What it does on each run:
 *   1. Computes every lead's SLA status with sla_core (first call within SLA_HOURS).
 *   2. Rebuilds a "SLA summary" tab: D-1 / WTD / MTD by team.
 *   3. Rebuilds a "Breached leads" tab, keeping the Reason / Comment the team already entered.
 *   4. Posts a digest to Slack (scheduled runs only, Monday to Saturday).
 *
 * Setup: see SETUP.md. Menu: Lead SLA -> Set Slack webhook, Install schedule, Refresh now.
 */

var CFG = {
  LEADS: 'Leads', CALLS: 'Calls', SUMMARY: 'SLA summary', BREACHED: 'Breached leads', STORE: '_reasons',
  SLA_HOURS: 24, TZ_OFFSET_MIN: 330,                 // IST. Change both for another timezone.
  RUN_HOURS: [10, 14, 19],                           // scheduled digests, project timezone
  REASONS: ['Lead not synced to CRM', 'Reassigned late', 'Rep on leave', 'Wrong / invalid number',
            'Called from personal phone (not logged)', 'Duplicate lead', 'Other']
};
var BREACH_HEAD = ['Lead ID', 'Created', 'Owner', 'Team', 'Source', 'Status', 'Hours to first call',
                   'Reason', 'Comment', 'Updated by', 'Updated at'];

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Lead SLA')
    .addItem('Refresh now', 'refreshNow')
    .addItem('Refresh and post to Slack', 'postDigest')
    .addSeparator()
    .addItem('Set Slack webhook', 'setSlackWebhook')
    .addItem('Install schedule (3x a day)', 'installTriggers')
    .addToUi();
}

/** Menu: rebuild the tabs without posting. */
function refreshNow() { run_(false); }

/** Scheduled entry point: rebuild, then post to Slack (skips Sunday). */
function postDigest() { run_(true); }

function run_(post) {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) return;                  // another run is in progress
  try {
    var ss = SpreadsheetApp.getActive();
    var now = Date.now();
    var leads = readTable_(ss.getSheetByName(CFG.LEADS));
    var calls = readTable_(ss.getSheetByName(CFG.CALLS));
    var opts = { slaHours: CFG.SLA_HOURS, tzOffsetMinutes: CFG.TZ_OFFSET_MIN };
    var rows = computeSla(leads, calls, now, opts);

    writeSummary_(ss, rows, now);
    writeBreached_(ss, rows, now);

    var isSunday = new Date(now + CFG.TZ_OFFSET_MIN * 60000).getUTCDay() === 0;
    var hook = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL');
    if (post && hook && !isSunday) {
      var url = ss.getUrl() + '#gid=' + ss.getSheetByName(CFG.BREACHED).getSheetId();
      var text = slackDigest(rows, now, { slaHours: CFG.SLA_HOURS, tzOffsetMinutes: CFG.TZ_OFFSET_MIN, sheetUrl: url });
      UrlFetchApp.fetch(hook, { method: 'post', contentType: 'application/json',
                                payload: JSON.stringify({ text: text }), muteHttpExceptions: false });
    }
  } finally {
    lock.releaseLock();
  }
}

/** Header row -> array of objects. Date cells stay Date objects; sla_core accepts both. */
function readTable_(sheet) {
  if (!sheet) throw new Error('Missing tab. Expected "' + CFG.LEADS + '" and "' + CFG.CALLS + '".');
  var v = sheet.getDataRange().getValues();
  var head = v.shift().map(function (h) { return String(h).trim(); });
  return v.filter(function (r) { return r[0] !== ''; }).map(function (r) {
    var o = {}; head.forEach(function (h, i) { o[h] = r[i]; }); return o;
  });
}

function sheet_(ss, name) { return ss.getSheetByName(name) || ss.insertSheet(name); }

function writeSummary_(ss, rows, now) {
  var sh = sheet_(ss, CFG.SUMMARY);
  sh.clear();
  var ranges = periodRanges(now, CFG.TZ_OFFSET_MIN), out = [];
  ['D-1', 'WTD', 'MTD'].forEach(function (p) {
    out.push([p + '  (' + ranges[p].from + ' to ' + ranges[p].to + ')', '', '', '', '', '', '']);
    out.push(['Team', 'Leads', 'On time', 'Late', 'Not called', 'Running', 'SLA %']);
    summarize(rows, ranges[p], 'team').concat(summarize(rows, ranges[p], null)).forEach(function (g) {
      out.push([g.key, g.leads, g.on_time, g.late, g.not_called, g.running, g.sla_pct == null ? '' : g.sla_pct / 100]);
    });
    out.push(['', '', '', '', '', '', '']);
  });
  out.push(['Refreshed', new Date(now), '', '', '', '', '']);
  sh.getRange(1, 1, out.length, 7).setValues(out);
  sh.getRange(1, 7, out.length, 1).setNumberFormat('0.0%');
  sh.getRange(out.length, 2).setNumberFormat('dd mmm yyyy, hh:mm');
}

/** Breached = late or not called this month, plus anything overdue in the last 7 days. Keeps team input. */
function writeBreached_(ss, rows, now) {
  var store = loadStore_(ss);
  var sh = sheet_(ss, CFG.BREACHED);

  // save anything typed since the last run, before clearing
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, BREACH_HEAD.length).getValues().forEach(function (r) {
      if (r[0] && (r[7] || r[8])) store[r[0]] = { reason: r[7], comment: r[8], by: r[9], at: r[10] };
    });
  }

  var mtd = periodRanges(now, CFG.TZ_OFFSET_MIN).MTD, since = now - 7 * 86400000;
  var list = rows.filter(function (r) {
    var breached = r.status === 'Late' || r.status === 'Not called';
    return breached && ((r.created_date >= mtd.from && r.created_date <= mtd.to) || r.created_ms >= since);
  }).sort(function (a, b) { return b.created_ms - a.created_ms; });

  var out = list.map(function (r) {
    var s = store[r.lead_id] || {};
    return [r.lead_id, new Date(r.created_ms), r.owner, r.team, r.source, r.status,
            r.hours_to_first_call == null ? '' : r.hours_to_first_call, s.reason || '', s.comment || '', s.by || '', s.at || ''];
  });

  sh.clear();
  sh.getRange(1, 1, 1, BREACH_HEAD.length).setValues([BREACH_HEAD]).setFontWeight('bold');
  sh.setFrozenRows(1);
  if (out.length) {
    sh.getRange(2, 1, out.length, BREACH_HEAD.length).setValues(out);
    sh.getRange(2, 2, out.length, 1).setNumberFormat('dd mmm, hh:mm');
    sh.getRange(2, 8, out.length, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(CFG.REASONS, true).setAllowInvalid(false).build());
  }
  saveStore_(ss, store);
}

/** Installable onEdit: stamp who changed a Reason or Comment, and persist it immediately. */
function onBreachEdit(e) {
  var sh = e.range.getSheet();
  if (sh.getName() !== CFG.BREACHED || e.range.getRow() < 2) return;
  var col = e.range.getColumn();
  if (col !== 8 && col !== 9) return;
  var row = e.range.getRow();
  var who = (e.user && e.user.getEmail && e.user.getEmail()) || Session.getActiveUser().getEmail() || 'unknown';
  sh.getRange(row, 10, 1, 2).setValues([[who, new Date()]]);
  var r = sh.getRange(row, 1, 1, 11).getValues()[0];
  var store = loadStore_(e.source);
  store[r[0]] = { reason: r[7], comment: r[8], by: who, at: new Date() };
  saveStore_(e.source, store);
}

/** Reasons live in a hidden tab keyed by lead ID, so they survive every rebuild. */
function loadStore_(ss) {
  var sh = ss.getSheetByName(CFG.STORE), store = {};
  if (!sh || sh.getLastRow() < 2) return store;
  sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues().forEach(function (r) {
    store[r[0]] = { reason: r[1], comment: r[2], by: r[3], at: r[4] };
  });
  return store;
}

function saveStore_(ss, store) {
  var sh = sheet_(ss, CFG.STORE);
  var rows = Object.keys(store).map(function (k) { var s = store[k]; return [k, s.reason || '', s.comment || '', s.by || '', s.at || '']; });
  sh.clear();
  sh.getRange(1, 1, 1, 5).setValues([['lead_id', 'reason', 'comment', 'updated_by', 'updated_at']]);
  if (rows.length) sh.getRange(2, 1, rows.length, 5).setValues(rows);
  if (!sh.isSheetHidden()) sh.hideSheet();
}

function setSlackWebhook() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Slack incoming webhook URL', 'Paste the https://hooks.slack.com/services/... URL', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var url = r.getResponseText().trim();
  if (url.indexOf('https://hooks.slack.com/') !== 0) { ui.alert('That does not look like a Slack webhook URL.'); return; }
  PropertiesService.getScriptProperties().setProperty('SLACK_WEBHOOK_URL', url);
  ui.alert('Saved. Use "Refresh and post to Slack" to test it.');
}

/** Replace this project's triggers with: digests at RUN_HOURS every day, plus the onEdit stamp. */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  CFG.RUN_HOURS.forEach(function (h) {
    ScriptApp.newTrigger('postDigest').timeBased().atHour(h).nearMinute(0).everyDays(1).create();
  });
  ScriptApp.newTrigger('onBreachEdit').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();
  SpreadsheetApp.getUi().alert('Scheduled at ' + CFG.RUN_HOURS.join(':00, ') + ':00 (project timezone). Sundays are skipped.');
}
