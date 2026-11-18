// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const sla = require('../apps-script/sla_core.js');

const H = 3600000;
const created = Date.parse('2026-11-10T10:00:00+05:30');
const lead = (id, t = created) => ({ lead_id: id, created_at: new Date(t).toISOString(), owner: 'Rep 1', team: 'Team A', source: 'Ads' });
const call = (id, t) => ({ lead_id: id, called_at: new Date(t).toISOString(), rep: 'Rep 1', duration_sec: 30 });

test('called inside 24h is on time, exactly at the deadline still counts', () => {
  const rows = sla.computeSla([lead('a'), lead('b')], [call('a', created + 2 * H), call('b', created + 24 * H)], created + 48 * H);
  assert.deepEqual(rows.map(r => r.status), ['On time', 'On time']);
  assert.equal(rows[0].hours_to_first_call, 2);
});

test('first call after the deadline is late; earliest attempt wins', () => {
  const rows = sla.computeSla([lead('a')], [call('a', created + 30 * H), call('a', created + 26 * H)], created + 48 * H);
  assert.equal(rows[0].status, 'Late');
  assert.equal(rows[0].hours_to_first_call, 26);
  assert.equal(rows[0].attempts, 2);
});

test('no call: running inside the window, not called after it', () => {
  assert.equal(sla.computeSla([lead('a')], [], created + 5 * H)[0].status, 'Running');
  assert.equal(sla.computeSla([lead('a')], [], created + 25 * H)[0].status, 'Not called');
});

test('calls logged before the lead was created are ignored', () => {
  const r = sla.computeSla([lead('a')], [call('a', created - 3 * H)], created + 30 * H)[0];
  assert.equal(r.status, 'Not called');
  assert.equal(r.calls_before_creation_ignored, 1);
});

test('creation date uses the business timezone, not UTC', () => {
  // 01:00 IST on 11 Nov is still 10 Nov in UTC
  const t = Date.parse('2026-11-11T01:00:00+05:30');
  assert.equal(sla.computeSla([lead('a', t)], [], t)[0].created_date, '2026-11-11');
});

test('period ranges: Monday-start week, month to yesterday', () => {
  const now = Date.parse('2026-11-18T12:00:00+05:30');      // Wednesday
  const p = sla.periodRanges(now, 330);
  assert.deepEqual(p['D-1'], { from: '2026-11-17', to: '2026-11-17' });
  assert.deepEqual(p.WTD, { from: '2026-11-16', to: '2026-11-17' });
  assert.deepEqual(p.MTD, { from: '2026-11-01', to: '2026-11-17' });
});

test('on a Monday, WTD falls back to the previous full week (ends yesterday, Sunday)', () => {
  const p = sla.periodRanges(Date.parse('2026-11-16T12:00:00+05:30'), 330);
  assert.deepEqual(p.WTD, { from: '2026-11-09', to: '2026-11-15' });
});

test('SLA % excludes running leads', () => {
  const now = created + 25 * H;
  const leads = [lead('a'), lead('b'), lead('c', now - 2 * H)];
  const rows = sla.computeSla(leads, [call('a', created + H)], now);
  const s = sla.summarize(rows, { from: '2026-11-10', to: '2026-11-11' }, null)[0];
  assert.equal(s.leads, 3); assert.equal(s.running, 1); assert.equal(s.sla_pct, 50);
});

test('slack digest renders all three periods and the action line', () => {
  const now = Date.parse('2026-11-18T12:00:00+05:30');
  const t = Date.parse('2026-11-17T10:00:00+05:30');
  const rows = sla.computeSla([lead('a', t)], [call('a', t + H)], now);
  const msg = sla.slackDigest(rows, now, {});
  ['*D-1*', '*WTD*', '*MTD*', 'still not called'].forEach(s => assert.ok(msg.includes(s), s));
  assert.ok(msg.includes('100.0%'));
});
