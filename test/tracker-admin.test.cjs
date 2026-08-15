'use strict';
// The correction tool's safety properties. The agent lane's contract PROMISES these, so
// they must be tested rather than asserted in prose — v1 promised them with no tool at all.

const test = require('node:test');
const assert = require('node:assert');
const { buildPlan, assertFresh, assertUnchanged, normalizeRow } = require('../scripts/tracker-admin.cjs');

const ROW = {
  record_id: 'R1', source_date: '2026-08-01', client_name: 'Example', phone: '971500000000',
  doc_type: 'passport', language_pair: 'English to Arabic', price: 'AED 100',
  delivery_time: 'within 24 hours', status: 'paid', summary: 'two pages', counterparty: '',
};
const snap = (rows = [ROW]) => ({
  schema: 'tracker-admin-snapshot-v1',
  generated_at: new Date().toISOString(),
  rows: rows.map(normalizeRow),
});

test('a correction produces an exact before/after plan with changed fields named', () => {
  const plan = buildPlan(snap(), {
    corrections: [{ record_id: 'R1', fields: { status: 'done' }, note: 'delivered by hand' }],
  });
  assert.equal(plan.writes.length, 1);
  assert.deepEqual(plan.writes[0].changed_fields, ['status']);
  assert.equal(plan.writes[0].before.status, 'paid');
  assert.equal(plan.writes[0].after.status, 'done');
});

test('an operator MAY move a record backwards — the automated guard must not apply here', () => {
  const plan = buildPlan(snap([{ ...ROW, status: 'done' }]), {
    corrections: [{ record_id: 'R1', fields: { status: 'paid' }, note: 'wrongly marked done' }],
  });
  assert.equal(plan.writes[0].after.status, 'paid',
    'this is exactly why the guard lives at the writer and not in the store API');
});

test('an unexplained correction is refused — it would be unauditable', () => {
  assert.throws(() => buildPlan(snap(), { corrections: [{ record_id: 'R1', fields: { status: 'done' } }] }),
    /requires a note/);
});

test('identity fields and unknown fields cannot be corrected', () => {
  assert.throws(() => buildPlan(snap(), {
    corrections: [{ record_id: 'R1', fields: { phone: '9999' }, note: 'x' }],
  }), /not correctable/);
  assert.throws(() => buildPlan(snap(), {
    corrections: [{ record_id: 'R1', fields: { nonsense: 'x' }, note: 'x' }],
  }), /not correctable/);
});

test('an invalid status is refused', () => {
  assert.throws(() => buildPlan(snap(), {
    corrections: [{ record_id: 'R1', fields: { status: 'vibes' }, note: 'x' }],
  }), /invalid status/);
});

test('a null clears a field, and the clear is recorded as a change', () => {
  const plan = buildPlan(snap([{ ...ROW, counterparty: 'vendor-a' }]), {
    corrections: [{ record_id: 'R1', fields: { counterparty: null }, note: 'done in house' }],
  });
  assert.equal(plan.writes[0].after.counterparty, '');
  assert.ok(plan.writes[0].changed_fields.includes('counterparty'));
});

test('a correction targeting a record absent from the snapshot is refused', () => {
  assert.throws(() => buildPlan(snap(), {
    corrections: [{ record_id: 'GHOST', fields: { status: 'done' }, note: 'x' }],
  }), /absent from the snapshot/);
});

test('one record cannot be corrected twice in a single proposal', () => {
  assert.throws(() => buildPlan(snap(), {
    corrections: [
      { record_id: 'R1', fields: { status: 'done' }, note: 'a' },
      { record_id: 'R1', fields: { price: 'AED 200' }, note: 'b' },
    ],
  }), /corrected twice/);
});

test('a no-op correction writes nothing', () => {
  const plan = buildPlan(snap(), {
    corrections: [{ record_id: 'R1', fields: { status: 'paid' }, note: 'already correct' }],
  });
  assert.equal(plan.writes.length, 0);
  assert.equal(plan.no_op_count, 1);
});

test('a stale snapshot is refused before any write', () => {
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  assert.throws(() => assertFresh({ snapshot_generated_at: old, writes: [] }), /stale/);
  assert.doesNotThrow(() => assertFresh({ snapshot_generated_at: new Date().toISOString(), writes: [] }));
});

test('optimistic concurrency: a row changed since the snapshot aborts the apply', () => {
  const plan = buildPlan(snap(), {
    corrections: [{ record_id: 'R1', fields: { status: 'done' }, note: 'x' }],
  });
  // Someone (or the automated lane) advanced the row in the meantime.
  assert.throws(() => assertUnchanged(plan, [{ ...ROW, status: 'translating' }]),
    /changed since the snapshot/);
  assert.throws(() => assertUnchanged(plan, []), /vanished/);
  assert.doesNotThrow(() => assertUnchanged(plan, [ROW]));
});
