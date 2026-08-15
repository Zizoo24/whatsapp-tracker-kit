'use strict';
// The correction tool's safety properties. The agent lane's contract PROMISES these, so they
// are tested rather than asserted in prose — v1.0 promised them with no tool at all.
//
// GUARDS #32: operators correct FACTS (milestones), never the projection (status).

const test = require('node:test');
const assert = require('node:assert');
const { buildPlan, assertFresh, assertUnchanged, normalizeRow } = require('../scripts/tracker-admin.cjs');

const MILESTONES = JSON.stringify({
  committed: { at: '2026-08-01T09:00:00Z', seq: 1, message_id: 'a' },
  paid: { at: '2026-08-01T10:00:00Z', seq: 2, message_id: 'b' },
});
const ROW = {
  record_id: 'R1', source_date: '2026-08-01', client_name: 'Example', phone: '971500000000',
  doc_type: 'passport', language_pair: 'English to Arabic', price: 'AED 100',
  delivery_time: 'within 24 hours', status: 'paid', summary: 'two pages', counterparty: '',
  milestones: MILESTONES,
};
const snap = (rows = [ROW]) => ({
  schema: 'tracker-admin-snapshot-v1',
  generated_at: new Date().toISOString(),
  rows: rows.map(normalizeRow),
});

test('status cannot be corrected directly — it is a projection', () => {
  assert.throws(() => buildPlan(snap(), {
    corrections: [{ record_id: 'R1', fields: { status: 'done' }, note: 'delivered by hand' }],
  }), /status is a projection/);
});

test('setting a milestone re-projects the status, and writes both together', () => {
  const plan = buildPlan(snap(), {
    corrections: [{
      record_id: 'R1',
      milestone_ops: { set: { final_delivered: { at: '2026-08-02T09:00:00Z', message_id: 'z' } } },
      note: 'delivered by hand, confirmed in chat',
    }],
  });
  const w = plan.writes[0];
  assert.equal(w.after.status, 'done', 'status must follow from the corrected facts');
  assert.ok(w.changed_fields.includes('milestones') && w.changed_fields.includes('status'));
  assert.ok(JSON.parse(w.after.milestones).final_delivered);
});

test('clearing a FALSE milestone is possible, and the status follows', () => {
  // The case a status-only correction could never express: a payment that never happened.
  const plan = buildPlan(snap(), {
    corrections: [{ record_id: 'R1', milestone_ops: { clear: ['paid'] }, note: 'payment never arrived' }],
  });
  assert.equal(plan.writes[0].after.status, 'confirmed_unpaid');
  assert.ok(!JSON.parse(plan.writes[0].after.milestones).paid);
});

test('an unknown milestone name is refused', () => {
  assert.throws(() => buildPlan(snap(), {
    corrections: [{ record_id: 'R1', milestone_ops: { clear: ['vibes'] }, note: 'x' }],
  }), /unknown milestone/);
  assert.throws(() => buildPlan(snap(), {
    corrections: [{ record_id: 'R1', milestone_ops: { set: { vibes: { at: '2026-08-02T09:00:00Z' } } }, note: 'x' }],
  }), /unknown milestone/);
});

test('a milestone must carry a parseable timestamp', () => {
  assert.throws(() => buildPlan(snap(), {
    corrections: [{ record_id: 'R1', milestone_ops: { set: { paid: { at: 'yesterday' } } }, note: 'x' }],
  }), /parseable "at" timestamp/);
});

test('corrupt stored milestones can only be repaired by an explicit full replace', () => {
  const corrupt = snap([{ ...ROW, milestones: '{broken' }]);
  assert.throws(() => buildPlan(corrupt, {
    corrections: [{ record_id: 'R1', milestone_ops: { clear: ['paid'] }, note: 'x' }],
  }), /unreadable[\s\S]*replace/);

  const plan = buildPlan(corrupt, {
    corrections: [{
      record_id: 'R1',
      milestone_ops: { replace: { paid: { at: '2026-08-01T10:00:00Z', seq: 2 } } },
      note: 'rebuilt from the chat',
    }],
  });
  assert.equal(plan.writes[0].after.status, 'paid');
});

test('descriptive fields are still correctable, and a null clears one', () => {
  const plan = buildPlan(snap([{ ...ROW, counterparty: 'vendor-a' }]), {
    corrections: [{ record_id: 'R1', fields: { counterparty: null, price: 'AED 150' }, note: 'done in house' }],
  });
  assert.equal(plan.writes[0].after.counterparty, '');
  assert.equal(plan.writes[0].after.price, 'AED 150');
});

test('an unexplained correction is refused — it would be unauditable', () => {
  assert.throws(() => buildPlan(snap(), {
    corrections: [{ record_id: 'R1', fields: { price: 'AED 150' } }],
  }), /requires a note/);
});

test('identity fields and unknown fields cannot be corrected', () => {
  assert.throws(() => buildPlan(snap(), {
    corrections: [{ record_id: 'R1', fields: { phone: '9999' }, note: 'x' }],
  }), /not correctable/);
  assert.throws(() => buildPlan(snap(), {
    corrections: [{ record_id: 'R1', fields: { nonsense: 'x' }, note: 'x' }],
  }), /not correctable/);
});

test('a correction targeting a record absent from the snapshot is refused', () => {
  assert.throws(() => buildPlan(snap(), {
    corrections: [{ record_id: 'GHOST', fields: { price: 'x' }, note: 'x' }],
  }), /absent from the snapshot/);
});

test('one record cannot be corrected twice in a single proposal', () => {
  assert.throws(() => buildPlan(snap(), {
    corrections: [
      { record_id: 'R1', fields: { price: 'AED 1' }, note: 'a' },
      { record_id: 'R1', fields: { price: 'AED 2' }, note: 'b' },
    ],
  }), /corrected twice/);
});

test('a no-op correction writes nothing', () => {
  const plan = buildPlan(snap(), {
    corrections: [{ record_id: 'R1', fields: { price: 'AED 100' }, note: 'already correct' }],
  });
  assert.equal(plan.writes.length, 0);
  assert.equal(plan.no_op_count, 1);
});

test('a stale snapshot is refused before any write', () => {
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  assert.throws(() => assertFresh({ snapshot_generated_at: old, writes: [] }), /stale/);
  assert.doesNotThrow(() => assertFresh({ snapshot_generated_at: new Date().toISOString(), writes: [] }));
});

test('optimistic concurrency covers MILESTONES, not just the visible fields', () => {
  const plan = buildPlan(snap(), {
    corrections: [{ record_id: 'R1', fields: { price: 'AED 150' }, note: 'x' }],
  });
  assert.doesNotThrow(() => assertUnchanged(plan, [ROW]));
  assert.throws(() => assertUnchanged(plan, [{ ...ROW, status: 'translating' }]), /changed since the snapshot/);
  // The automated lane advancing the authoritative state must abort the apply even when
  // every human-visible cell still looks identical.
  const movedFacts = JSON.stringify({
    ...JSON.parse(MILESTONES), work_started: { at: '2026-08-01T11:00:00Z', seq: 5, message_id: 'c' },
  });
  assert.throws(() => assertUnchanged(plan, [{ ...ROW, milestones: movedFacts }]),
    /changed since the snapshot/);
  assert.throws(() => assertUnchanged(plan, []), /vanished/);
});
