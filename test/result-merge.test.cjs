'use strict';
// GUARDS #10: cross-pass precedence. A counterparty stamp must never overwrite a terminal
// status the customer pass produced in the same run — that left finished records showing
// as needing attention on three real rows.

const test = require('node:test');
const assert = require('node:assert');
const { hasTerminalRecord, mergeCounterpartyUpdate } = require('../scripts/lib/result-merge.cjs');

const started = { type: 'work_started', at: '2026-08-01T11:00:00Z', evidence_msg_ids: ['m1'] };

test('a terminal customer outcome blocks a counterparty stamp in the same run', () => {
  const results = [{
    phone: '971500000000',
    records: [{ record_id: 'X', observations: [{ type: 'final_delivered', at: '2026-08-01T12:00:00Z' }] }],
  }];
  const merged = mergeCounterpartyUpdate(results, 'X', 'vendor-a', started);
  assert.equal(merged.added, false);
  assert.equal(merged.reason, 'customer_pass_terminal');
  assert.equal(results.length, 1, 'nothing may be appended when the update is refused');
});

test('a non-terminal record accepts the counterparty stamp as a work_started observation', () => {
  const results = [{
    phone: '971500000000',
    records: [{ record_id: 'X', observations: [{ type: 'payment_received', at: '2026-08-01T10:00:00Z' }] }],
  }];
  const merged = mergeCounterpartyUpdate(results, 'X', 'vendor-a', started);
  assert.equal(merged.added, true);
  const appended = results[1].records[0];
  assert.equal(appended.counterparty, 'vendor-a');
  assert.equal(appended.observations[0].type, 'work_started',
    'the counterparty lane must go through the same milestone projection as every other lane');
  assert.ok(!('status' in appended), 'no lane may write a status directly');
});

test('malformed updates are refused rather than written as partial rows', () => {
  assert.equal(mergeCounterpartyUpdate([], '', 'v', started).added, false);
  assert.equal(mergeCounterpartyUpdate([], 'X', '', started).added, false);
  assert.equal(mergeCounterpartyUpdate([], 'X', 'v', null).added, false);
  assert.equal(mergeCounterpartyUpdate([], 'X', 'v', {}).added, false);
  assert.equal(mergeCounterpartyUpdate([], null, 'v', started).added, false);
});

test('hasTerminalRecord matches only the named record, via observation or legacy status', () => {
  const viaObservation = [{ phone: '1', records: [{ record_id: 'A', observations: [{ type: 'order_cancelled' }] }] }];
  assert.ok(hasTerminalRecord(viaObservation, 'A'));
  assert.ok(!hasTerminalRecord(viaObservation, 'B'));
  assert.ok(hasTerminalRecord([{ phone: '1', records: [{ record_id: 'A', status: 'done' }] }], 'A'));
});
