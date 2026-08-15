'use strict';
// The correction tool's safety properties. The agent lane's contract PROMISES these, so they
// are tested rather than asserted in prose — v1.0 promised them with no tool at all.
//
// GUARDS #32: operators correct FACTS (milestones), never the projection (status).
// GUARDS #38: the tool resolves evidence itself instead of trusting the caller's assertions.

const test = require('node:test');
const assert = require('node:assert');
const { buildPlan, assertFresh, assertUnchanged, normalizeRow } = require('../scripts/tracker-admin.cjs');

// A fake message mirror. at/seq must come from HERE, never from caller-supplied values.
const MIRROR = {
  'msg-delivered': { at: '2026-08-02T09:00:00Z', seq: 501, phone: '971500000000' },
  'msg-other-chat': { at: '2026-08-02T09:00:00Z', seq: 502, phone: '971509999999' },
};
const resolver = (id) => MIRROR[id] || null;
const plan = (snapshot, proposal) => buildPlan(snapshot, proposal, resolver);

const MILESTONES = JSON.stringify({
  committed: { at: '2026-08-01T09:00:00Z', seq: 1, message_id: 'a' },
  paid: { at: '2026-08-01T10:00:00Z', seq: 2, message_id: 'b' },
});
const ROW = {
  record_id: 'R1', source_date: '2026-08-01', client_name: 'Example', phone: '971500000000',
  doc_type: 'passport', language_pair: 'English to Arabic', price: 'AED 100',
  delivery_time: 'within 24 hours', status: 'paid', summary: 'two pages', counterparty: '',
  paid_at: '2026-08-01T10:00:00Z', milestones: MILESTONES,
};
const snap = (rows = [ROW]) => ({
  schema: 'tracker-admin-snapshot-v1',
  generated_at: new Date().toISOString(),
  rows: rows.map(normalizeRow),
});

test('status cannot be corrected directly — it is a projection', () => {
  assert.throws(() => plan(snap(), {
    corrections: [{ record_id: 'R1', fields: { status: 'done' }, note: 'delivered by hand' }],
  }), /status is a projection/);
});

test('setting a milestone re-projects the status, and writes both together', () => {
  const p = plan(snap(), {
    corrections: [{
      record_id: 'R1',
      milestone_ops: { set: { final_delivered: { evidence_msg_id: 'msg-delivered' } } },
      note: 'delivered by hand, confirmed in chat',
    }],
  });
  const w = p.writes[0];
  assert.equal(w.after.status, 'done', 'status must follow from the corrected facts');
  assert.ok(w.changed_fields.includes('milestones') && w.changed_fields.includes('status'));
  assert.ok(JSON.parse(w.after.milestones).final_delivered);
});

test('GUARDS #40: clearing a false payment clears EVERY view derived from it', () => {
  // The case a status-only correction could never express: a payment that never happened.
  // v1.2.2 cleared status and the milestone but left paid_at populated, so the row read
  // "confirmed_unpaid" and "paid at X" at once — and prep feeds paid_at back to the model.
  const p = plan(snap(), {
    corrections: [{ record_id: 'R1', milestone_ops: { clear: ['paid'] }, note: 'payment never arrived' }],
  });
  const after = p.writes[0].after;
  assert.equal(after.status, 'confirmed_unpaid');
  assert.ok(!JSON.parse(after.milestones).paid);
  assert.equal(after.paid_at, '', 'the derived column must be cleared with its fact');
  assert.ok(p.writes[0].changed_fields.includes('paid_at'),
    'so the write actually carries the clear to the store');
});

test('GUARDS #40: setting a payment milestone populates paid_at from the resolved evidence', () => {
  const p = plan(snap([{ ...ROW, status: 'confirmed_unpaid', paid_at: '', milestones: '{}' }]), {
    corrections: [{
      record_id: 'R1',
      milestone_ops: { set: { paid: { evidence_msg_id: 'msg-delivered' } } },
      note: 'payment confirmed in chat',
    }],
  });
  assert.equal(p.writes[0].after.status, 'paid');
  assert.equal(p.writes[0].after.paid_at, '2026-08-02T09:00:00Z',
    'paid_at is derived from the milestone, never asserted separately');
});

test('GUARDS #38: at/seq come from the mirror, never from the caller', () => {
  const p = plan(snap(), {
    corrections: [{
      record_id: 'R1',
      // Deliberately bogus assertions alongside the real id — they must be ignored.
      milestone_ops: {
        set: { final_delivered: { evidence_msg_id: 'msg-delivered', at: '1999-01-01T00:00:00Z', seq: 7 } },
      },
      note: 'x',
    }],
  });
  const stored = JSON.parse(p.writes[0].after.milestones).final_delivered;
  assert.equal(stored.at, '2026-08-02T09:00:00Z');
  assert.equal(stored.seq, 501);
  assert.equal(stored.source, 'evidence');
});

test('a cited message must exist and belong to this record’s conversation', () => {
  assert.throws(() => plan(snap(), {
    corrections: [{ record_id: 'R1', milestone_ops: { set: { paid: { evidence_msg_id: 'nope' } } }, note: 'x' }],
  }), /not in the message/);
  assert.throws(() => plan(snap(), {
    corrections: [{ record_id: 'R1', milestone_ops: { set: { paid: { evidence_msg_id: 'msg-other-chat' } } }, note: 'x' }],
  }), /DIFFERENT conversation/);
});

test('a fact with no message evidence must be LABELLED, not disguised', () => {
  assert.throws(() => plan(snap(), {
    corrections: [{ record_id: 'R1', milestone_ops: { set: { paid: { at: '2026-06-02T00:00:00Z' } } }, note: 'x' }],
  }), /requires evidence_msg_id/);

  const p = plan(snap(), {
    corrections: [{
      record_id: 'R1',
      milestone_ops: { set: { paid: { at: '2026-06-02T00:00:00Z', source: 'operator_baseline' } } },
      note: 'paid by bank transfer; chat history lost',
    }],
  });
  const stored = JSON.parse(p.writes[0].after.milestones).paid;
  assert.equal(stored.source, 'operator_baseline');
  assert.equal(stored.seq, null, 'a baseline has no ingestion position');
});

test('a baseline still needs a parseable timestamp', () => {
  assert.throws(() => plan(snap(), {
    corrections: [{
      record_id: 'R1',
      milestone_ops: { set: { paid: { at: 'yesterday', source: 'operator_baseline' } } },
      note: 'x',
    }],
  }), /parseable "at" timestamp/);
});

test('an unknown milestone name is refused', () => {
  assert.throws(() => plan(snap(), {
    corrections: [{ record_id: 'R1', milestone_ops: { clear: ['vibes'] }, note: 'x' }],
  }), /unknown milestone/);
  assert.throws(() => plan(snap(), {
    corrections: [{ record_id: 'R1', milestone_ops: { set: { vibes: { evidence_msg_id: 'msg-delivered' } } }, note: 'x' }],
  }), /unknown milestone/);
});

test('corrupt stored milestones can only be repaired by an explicit full replace', () => {
  const corrupt = snap([{ ...ROW, milestones: '{broken' }]);
  assert.throws(() => plan(corrupt, {
    corrections: [{ record_id: 'R1', milestone_ops: { clear: ['paid'] }, note: 'x' }],
  }), /unreadable[\s\S]*replace/);

  // GUARDS #41: replace means "replace the COLLECTION", not "skip provenance". An
  // unverified occurrence is refused here exactly as it would be in `set`.
  assert.throws(() => plan(corrupt, {
    corrections: [{
      record_id: 'R1',
      milestone_ops: { replace: { paid: { at: '2026-08-01T10:00:00Z', seq: 2 } } },
      note: 'x',
    }],
  }), /requires evidence_msg_id/);

  const p = plan(corrupt, {
    corrections: [{
      record_id: 'R1',
      milestone_ops: { replace: { paid: { evidence_msg_id: 'msg-delivered' } } },
      note: 'rebuilt from the chat',
    }],
  });
  assert.equal(p.writes[0].after.status, 'paid');
  assert.equal(JSON.parse(p.writes[0].after.milestones).paid.source, 'evidence');
  assert.equal(p.writes[0].after.paid_at, '2026-08-02T09:00:00Z');
});

test('GUARDS #41: replace accepts a labelled baseline, and replaces the whole set', () => {
  const p = plan(snap(), {
    corrections: [{
      record_id: 'R1',
      milestone_ops: { replace: { paid: { at: '2026-06-02T00:00:00Z', source: 'operator_baseline' } } },
      note: 'rebuilt from bank records; chat history lost',
    }],
  });
  const m = JSON.parse(p.writes[0].after.milestones);
  assert.equal(m.paid.source, 'operator_baseline');
  assert.ok(!m.committed, 'replace REPLACES the collection rather than merging into it');
});

test('GUARDS #42: unprovable conversation identity fails closed', () => {
  // An unmapped @lid chat resolves to a blank phone. That is UNKNOWN identity, not a pass.
  const blindResolver = (id) => (id === 'msg-unmapped'
    ? { at: '2026-08-02T09:00:00Z', seq: 700, phone: '' }
    : null);
  assert.throws(() => buildPlan(snap(), {
    corrections: [{
      record_id: 'R1',
      milestone_ops: { set: { paid: { evidence_msg_id: 'msg-unmapped' } } },
      note: 'x',
    }],
  }, blindResolver), /could not be resolved to a phone/);
});

test('descriptive fields are still correctable, and a null clears one', () => {
  const p = plan(snap([{ ...ROW, counterparty: 'vendor-a' }]), {
    corrections: [{ record_id: 'R1', fields: { counterparty: null, price: 'AED 150' }, note: 'done in house' }],
  });
  assert.equal(p.writes[0].after.counterparty, '');
  assert.equal(p.writes[0].after.price, 'AED 150');
});

test('an unexplained correction is refused — it would be unauditable', () => {
  assert.throws(() => plan(snap(), {
    corrections: [{ record_id: 'R1', fields: { price: 'AED 150' } }],
  }), /requires a note/);
});

test('identity fields and unknown fields cannot be corrected', () => {
  assert.throws(() => plan(snap(), {
    corrections: [{ record_id: 'R1', fields: { phone: '9999' }, note: 'x' }],
  }), /not correctable/);
  assert.throws(() => plan(snap(), {
    corrections: [{ record_id: 'R1', fields: { nonsense: 'x' }, note: 'x' }],
  }), /not correctable/);
});

test('a correction targeting a record absent from the snapshot is refused', () => {
  assert.throws(() => plan(snap(), {
    corrections: [{ record_id: 'GHOST', fields: { price: 'x' }, note: 'x' }],
  }), /absent from the snapshot/);
});

test('one record cannot be corrected twice in a single proposal', () => {
  assert.throws(() => plan(snap(), {
    corrections: [
      { record_id: 'R1', fields: { price: 'AED 1' }, note: 'a' },
      { record_id: 'R1', fields: { price: 'AED 2' }, note: 'b' },
    ],
  }), /corrected twice/);
});

test('a no-op correction writes nothing', () => {
  const p = plan(snap(), {
    corrections: [{ record_id: 'R1', fields: { price: 'AED 100' }, note: 'already correct' }],
  });
  assert.equal(p.writes.length, 0);
  assert.equal(p.no_op_count, 1);
});

test('a stale snapshot is refused before any write', () => {
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  assert.throws(() => assertFresh({ snapshot_generated_at: old, writes: [] }), /stale/);
  assert.doesNotThrow(() => assertFresh({ snapshot_generated_at: new Date().toISOString(), writes: [] }));
});

test('optimistic concurrency covers MILESTONES, not just the visible fields', () => {
  const p = plan(snap(), {
    corrections: [{ record_id: 'R1', fields: { price: 'AED 150' }, note: 'x' }],
  });
  assert.doesNotThrow(() => assertUnchanged(p, [ROW]));
  assert.throws(() => assertUnchanged(p, [{ ...ROW, status: 'translating' }]), /changed since the snapshot/);
  // The automated lane advancing the authoritative state must abort the apply even when
  // every human-visible cell still looks identical.
  const movedFacts = JSON.stringify({
    ...JSON.parse(MILESTONES),
    work_started: { at: '2026-08-01T11:00:00Z', seq: 5, message_id: 'c' },
  });
  assert.throws(() => assertUnchanged(p, [{ ...ROW, milestones: movedFacts }]), /changed since the snapshot/);
  assert.throws(() => assertUnchanged(p, []), /vanished/);
});
