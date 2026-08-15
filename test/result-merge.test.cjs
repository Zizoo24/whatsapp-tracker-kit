'use strict';
// How the counterparty lane contributes to a record.
//
// GUARDS #35: this file used to DISCARD the counterparty contribution whenever the customer
// pass emitted a "terminal" observation in the same tick. That belonged to the direct-status
// era. `final_delivered` is no longer terminal by itself (delivery while unpaid keeps the
// record in chase-payment), and the writer now merges every lane's observations into one row
// and projects once — so the suppression discarded true historical facts for no safety gain.

const test = require('node:test');
const assert = require('node:assert');
const { mergeCounterpartyUpdate } = require('../scripts/lib/result-merge.cjs');
const { mergeMilestones, projectStatus } = require('../scripts/lib/status-model.cjs');

const started = {
  type: 'work_started', at: '2026-08-01T11:00:00Z', seq: 11, message_id: 'm11',
};

test('the counterparty contribution is recorded as a work_started observation', () => {
  const results = [];
  const merged = mergeCounterpartyUpdate(results, 'X', 'vendor-a', started);
  assert.equal(merged.added, true);
  const appended = results[0].records[0];
  assert.equal(appended.counterparty, 'vendor-a');
  assert.equal(appended.observations[0].type, 'work_started');
  assert.ok(!('status' in appended), 'no lane may write a status directly');
});

test('a same-tick terminal customer observation NO LONGER discards the work fact', () => {
  const results = [{
    phone: '971500000000',
    records: [{
      record_id: 'X',
      observations: [{ type: 'final_delivered', at: '2026-08-01T12:00:00Z', seq: 12, message_id: 'm12' }],
    }],
  }];
  const merged = mergeCounterpartyUpdate(results, 'X', 'vendor-a', started);
  assert.equal(merged.added, true, 'who did the work is a true fact worth keeping');

  // The writer unions both and projects once — the terminal outcome still wins the STATUS
  // while the work history survives.
  const observations = results.flatMap((r) => r.records[0].observations);
  const { milestones } = mergeMilestones(
    { paid: { at: '2026-08-01T10:00:00Z', seq: 10, message_id: 'm10' } }, observations
  );
  assert.ok(milestones.work_started, 'the counterparty work fact must persist');
  assert.equal(projectStatus(milestones), 'done', 'and the projection still resolves correctly');
});

test('an order that ends cancelled still keeps the record of who worked on it', () => {
  const observations = [
    started,
    { type: 'order_cancelled', at: '2026-08-02T09:00:00Z', seq: 20, message_id: 'm20' },
  ];
  const { milestones } = mergeMilestones(
    { paid: { at: '2026-08-01T10:00:00Z', seq: 10, message_id: 'm10' } }, observations
  );
  assert.ok(milestones.work_started);
  assert.equal(projectStatus(milestones), 'cancelled');
});

test('malformed updates are refused rather than written as partial rows', () => {
  assert.equal(mergeCounterpartyUpdate([], '', 'v', started).added, false);
  assert.equal(mergeCounterpartyUpdate([], 'X', '', started).added, false);
  assert.equal(mergeCounterpartyUpdate([], 'X', 'v', null).added, false);
  assert.equal(mergeCounterpartyUpdate([], 'X', 'v', {}).added, false);
  assert.equal(mergeCounterpartyUpdate([], null, 'v', started).added, false);
});
