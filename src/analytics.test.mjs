import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTrafficPeriod } from './analytics.mjs';

const now = Date.parse('2026-11-04T06:00:00.000Z');
const event = (id, offset, detail, cameraId = 'cam-1', trackingId = 'track-1') => ({
  id,
  timestamp: new Date(now - offset * 60_000).toISOString(),
  type: 'entry_exit',
  detail,
  cameraId,
  trackingId,
});

test('period filtering counts persisted timestamped entries, exits, and unique visitors', () => {
  const result = summarizeTrafficPeriod([
    event('first-entry', 4, '(entry)'),
    event('repeat-entry', 3, '(entry)'),
    event('exit', 2, '(exit)'),
    event('another-camera', 1, '(entry)', 'cam-2'),
    event('outside-period', 6, '(entry)'),
  ], 5, now);

  assert.equal(result.footfall, 2);
  assert.equal(result.entries, 3);
  assert.equal(result.exits, 1);
  assert.equal(result.traffic.length, 4);
  assert.equal(result.traffic.reduce((sum, row) => sum + row.entries, 0), 3);
});

test('empty periods return no synthetic chart samples or visitors', () => {
  const result = summarizeTrafficPeriod([event('old', 61, '(entry)')], 60, now);

  assert.equal(result.footfall, 0);
  assert.equal(result.entries, 0);
  assert.equal(result.exits, 0);
  assert.deepEqual(result.traffic, []);
  assert.deepEqual(result.periodEvents, []);
});

test('rejects unsupported traffic periods', () => {
  assert.throws(() => summarizeTrafficPeriod([], 15, now), RangeError);
});
