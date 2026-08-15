'use strict';
// GUARDS #10: cross-pass precedence. A counterparty stamp must never overwrite a terminal
// status the customer pass produced in the same run — that left finished records showing
// as needing attention on three real rows.

const test = require('node:test');
const assert = require('node:assert');
const { hasTerminalRecord, mergeCounterpartyUpdate } = require('../scripts/lib/result-merge.cjs');

test('a terminal customer record blocks a counterparty stamp in the same run', () => {
  const results = [{ phone: '971500000000', records: [{ record_id: 'X', status: 'done' }] }];
  const merged = mergeCounterpartyUpdate(results, 'X', 'vendor-a', 'translating');
  assert.equal(merged.added, false);
  assert.equal(merged.reason, 'customer_pass_terminal');
  assert.equal(results.length, 1, 'nothing may be appended when the update is refused');
});

test('a non-terminal record accepts the counterparty stamp', () => {
  const results = [{ phone: '971500000000', records: [{ record_id: 'X', status: 'paid' }] }];
  const merged = mergeCounterpartyUpdate(results, 'X', 'vendor-a', 'translating');
  assert.equal(merged.added, true);
  const appended = results[1].records[0];
  assert.equal(appended.counterparty, 'vendor-a');
  assert.equal(appended.status, 'translating');
});

test('malformed updates are refused rather than written as partial rows', () => {
  assert.equal(mergeCounterpartyUpdate([], '', 'v', 'translating').added, false);
  assert.equal(mergeCounterpartyUpdate([], 'X', '', 'translating').added, false);
  assert.equal(mergeCounterpartyUpdate([], 'X', 'v', '').added, false);
  assert.equal(mergeCounterpartyUpdate([], null, 'v', 'translating').added, false);
});

test('hasTerminalRecord only matches the named record', () => {
  const results = [{ phone: '1', records: [{ record_id: 'A', status: 'done' }] }];
  assert.ok(hasTerminalRecord(results, 'A'));
  assert.ok(!hasTerminalRecord(results, 'B'));
});
