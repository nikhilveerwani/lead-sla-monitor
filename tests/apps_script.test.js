// Runs Code.gs + sla_core.js against a small in-memory fake of the Apps Script services.
// Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fakeSheet(name, values = []) {
  const s = { name, values: values.map(r => r.slice()), hidden: false, formats: [], validation: null };
  const range = (r, c, nr = 1, nc = 1) => {
    const api = {
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => ((s.values[r - 1 + i] || [])[c - 1 + j]) ?? '')),
      setValues: (v) => { v.forEach((row, i) => row.forEach((x, j) => { (s.values[r - 1 + i] = s.values[r - 1 + i] || [])[c - 1 + j] = x; })); return api; },
      setNumberFormat: (f) => { s.formats.push(f); return api; },
      setFontWeight: () => api,
      setDataValidation: (dv) => { s.validation = dv; return api; },
      getRow: () => r, getColumn: () => c, getSheet: () => s.api
    };
    return api;
  };
  s.api = {
    getName: () => name,
    getRange: range,
    getDataRange: () => range(1, 1, s.values.length, Math.max(0, ...s.values.map(x => x.length))),
    getLastRow: () => s.values.filter(r => r && r.some(x => x !== '' && x != null)).length,
    clear: () => { s.values = []; },
    setFrozenRows: () => {},
    getSheetId: () => 42,
    hideSheet: () => { s.hidden = true; },
    isSheetHidden: () => s.hidden
  };
  return s;
}

function load({ leads, calls, now }) {
  const sheets = { Leads: fakeSheet('Leads', leads), Calls: fakeSheet('Calls', calls) };
  const posts = [], props = {};
  const ss = {
    getSheetByName: (n) => (sheets[n] ? sheets[n].api : null),
    insertSheet: (n) => { sheets[n] = fakeSheet(n); return sheets[n].api; },
    getUrl: () => 'https://docs.google.com/spreadsheets/d/test'
  };
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
  const ctx = {
    Date: FakeDate, JSON, Math, String, Object, Array, Number, Error,
    SpreadsheetApp: {
      getActive: () => ss,
      newDataValidation: () => { const b = { list: null, requireValueInList: (l) => { b.list = l; return b; }, setAllowInvalid: () => b, build: () => ({ list: b.list }) }; return b; }
    },
    LockService: { getDocumentLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    UrlFetchApp: { fetch: (url, o) => posts.push({ url, body: JSON.parse(o.payload) }) },
    Session: { getActiveUser: () => ({ getEmail: () => 'me@example.com' }) }
  };
  vm.createContext(ctx);
  for (const f of ['sla_core.js', 'Code.gs']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', f), 'utf8'), ctx);
  return { ctx, sheets, posts, props, ss };
}

const NOW = Date.parse('2026-11-18T12:00:00+05:30');   // a Wednesday
const H = 3600000;
const iso = (ms) => new Date(ms).toISOString();
const LEADS = [['lead_id', 'created_at', 'owner', 'team', 'source'],
  ['L1', iso(NOW - 26 * H), 'Asha', 'Team A', 'Ads'],     // called at +2h -> on time
  ['L2', iso(NOW - 30 * H), 'Ben', 'Team B', 'Ads'],      // never called -> not called
  ['L3', iso(NOW - 40 * H), 'Ben', 'Team B', 'Organic'],  // called at +30h -> late
  ['L4', iso(NOW - 3 * H), 'Asha', 'Team A', 'Ads']];     // running
const CALLS = [['lead_id', 'called_at', 'rep', 'duration_sec'],
  ['L1', iso(NOW - 24 * H), 'Asha', 60], ['L3', iso(NOW - 10 * H), 'Ben', 0]];

test('refresh builds the summary and breached tabs', () => {
  const { ctx, sheets } = load({ leads: LEADS, calls: CALLS, now: NOW });
  ctx.refreshNow();
  const b = sheets['Breached leads'].values;
  assert.equal(b[0][0], 'Lead ID');
  assert.deepEqual(b.slice(1).map(r => [r[0], r[5]]).sort(), [['L2', 'Not called'], ['L3', 'Late']]);
  assert.ok(sheets['Breached leads'].validation.list.includes('Rep on leave'));
  assert.ok(sheets['SLA summary'].values.some(r => r[0] === 'Total'));
});

test('reasons typed by the team survive the next refresh, and live in a hidden store', () => {
  const { ctx, sheets } = load({ leads: LEADS, calls: CALLS, now: NOW });
  ctx.refreshNow();
  const sh = sheets['Breached leads'];
  const row = sh.values.findIndex(r => r[0] === 'L2');
  sh.values[row][7] = 'Rep on leave'; sh.values[row][8] = 'back Monday';
  ctx.refreshNow();
  const again = sh.values.find(r => r[0] === 'L2');
  assert.equal(again[7], 'Rep on leave'); assert.equal(again[8], 'back Monday');
  assert.equal(sheets._reasons.hidden, true);
});

test('onBreachEdit stamps the editor and persists immediately', () => {
  const { ctx, sheets, ss } = load({ leads: LEADS, calls: CALLS, now: NOW });
  ctx.refreshNow();
  const sh = sheets['Breached leads'];
  const r = sh.values.findIndex(x => x[0] === 'L3') + 1;
  sh.values[r - 1][7] = 'Reassigned late';
  ctx.onBreachEdit({ range: sh.api.getRange(r, 8), source: ss, user: { getEmail: () => 'lead@example.com' } });
  assert.equal(sh.values[r - 1][9], 'lead@example.com');
  assert.ok(sheets._reasons.values.some(x => x[0] === 'L3' && x[1] === 'Reassigned late'));
});

test('postDigest sends the digest to Slack on a weekday, with a link to the breached tab', () => {
  const { ctx, posts, props } = load({ leads: LEADS, calls: CALLS, now: NOW });
  props.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/T/B/X';
  ctx.postDigest();
  assert.equal(posts.length, 1);
  assert.ok(posts[0].body.text.includes('*MTD*'));
  assert.ok(posts[0].body.text.includes('#gid=42'));
});

test('no Slack post on Sunday', () => {
  const sunday = Date.parse('2026-11-22T12:00:00+05:30');
  const { ctx, posts, props } = load({ leads: LEADS, calls: CALLS, now: sunday });
  props.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/T/B/X';
  ctx.postDigest();
  assert.equal(posts.length, 0);
});
