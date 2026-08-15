'use strict';
// INTEGRATION: validator -> aggregation -> writer. The test class v1.0 lacked entirely, and
// the coverage v1.2.0 still lacked at the aggregation seam.
//
// v1.0: the validator allowed `done -> revision` and the writer silently discarded it
//       (GUARDS #22). Both layers individually correct; the CONTRACT between them broken.
// v1.2.0: the customer and counterparty lanes each produced a row for the SAME record, and
//       the second `milestones` cell overwrote the first (GUARDS #30). The unit tests
//       verified the append and never ran it through the writer.

const test = require('node:test');
const assert = require('node:assert');
const { validateAndNormalizeClientResult } = require('../scripts/lib/client-result.cjs');
const { mergeCounterpartyUpdate } = require('../scripts/lib/result-merge.cjs');
const { compareOccurrence, mergeMilestones, projectStatus } = require('../scripts/lib/status-model.cjs');

const PHONE = '971500000000';
const DONE_ID = PHONE + '_2026-08-01#abc';
const DONE_MILESTONES = JSON.stringify({
  committed: { at: '2026-08-01T09:00:00Z', seq: 1, message_id: 'a' },
  paid: { at: '2026-08-01T10:00:00Z', seq: 2, message_id: 'b' },
  final_delivered: { at: '2026-08-01T12:00:00Z', seq: 3, message_id: 'c' },
});

const input = (rows = []) => ({
  phone: PHONE,
  existing_rows: rows,
  context: [{ id: 'old', ts: '2026-08-01T08:00:00Z', seq: 1, from: 'CUSTOMER', text: 'earlier' }],
  new_messages: [
    { id: 'm1', ts: '2026-08-15T10:00:00Z', seq: 10, from: 'CUSTOMER', text: 'please fix the spelling' },
    { id: 'm2', ts: '2026-08-15T10:00:00Z', seq: 11, from: 'BUSINESS', text: 'payment received' },
    { id: 'm3', ts: '2026-08-15T10:00:00Z', seq: 12, from: 'BUSINESS', text: 'final certified file attached' },
  ],
});

// EXACTLY what tracker-apply does: union every lane's observations for one record, order
// once, merge once, project once.
function writerDerives(storedMilestones, ...records) {
  const observations = records.flatMap((r) => r.observations || []).sort(compareOccurrence);
  const merged = mergeMilestones(storedMilestones, observations);
  return { status: projectStatus(merged.milestones), milestones: merged.milestones };
}

test('GUARDS #30: customer and counterparty updates in ONE tick do not clobber each other', () => {
  // A paid record: the customer pass observes a draft, the counterparty pass observes the
  // handoff. Written as two rows, the second milestones cell erased the first.
  const stored = JSON.stringify({ paid: { at: '2026-08-01T10:00:00Z', seq: 2, message_id: 'b' } });

  const customer = validateAndNormalizeClientResult({
    phone: PHONE,
    records: [{
      kind: 'update', record_id: DONE_ID,
      observations: [{ type: 'draft_sent', evidence_msg_ids: ['m3'] }],
    }],
  }, input([{ record_id: DONE_ID, status: 'paid', milestones: stored }])).records[0];

  const results = [{ phone: PHONE, records: [customer] }];
  const merged = mergeCounterpartyUpdate(results, DONE_ID, 'vendor-a', {
    type: 'work_started', at: '2026-08-15T10:00:00Z', seq: 11, message_id: 'm2',
  });
  assert.equal(merged.added, true);

  const counterparty = results[1].records[0];
  const out = writerDerives(stored, customer, counterparty);

  assert.ok(out.milestones.draft_sent, 'the customer pass milestone must survive');
  assert.ok(out.milestones.work_started, 'the counterparty pass milestone must survive');
  assert.ok(out.milestones.paid, 'the stored fact must survive');
  assert.equal(out.status, 'translating');
});

test('a post-delivery revision survives the FULL validator -> writer path', () => {
  const validated = validateAndNormalizeClientResult({
    phone: PHONE,
    records: [{
      kind: 'update', record_id: DONE_ID,
      observations: [{ type: 'revision_requested', evidence_msg_ids: ['m1'] }],
    }],
  }, input([{ record_id: DONE_ID, status: 'done', milestones: DONE_MILESTONES }]));

  assert.equal(writerDerives(DONE_MILESTONES, validated.records[0]).status, 'revision');
});

test('a stale re-read of an old payment cannot change a completed record', () => {
  assert.throws(() => validateAndNormalizeClientResult({
    phone: PHONE,
    records: [{
      kind: 'update', record_id: DONE_ID,
      observations: [{ type: 'payment_received', evidence_msg_ids: ['m2'] }],
    }],
  }, input([{ record_id: DONE_ID, status: 'done', milestones: DONE_MILESTONES }])),
  /not changed by these observations/);
});

test('the model may not emit a status — enforced, not merely documented', () => {
  assert.throws(() => validateAndNormalizeClientResult({
    phone: PHONE,
    records: [{
      kind: 'update', record_id: DONE_ID, status: 'paid',
      observations: [{ type: 'revision_requested', evidence_msg_ids: ['m1'] }],
    }],
  }, input([{ record_id: DONE_ID, status: 'done', milestones: DONE_MILESTONES }])),
  /must not carry status/);
});

test('a new record delivered while unpaid stays confirmed_unpaid end to end', () => {
  const validated = validateAndNormalizeClientResult({
    phone: PHONE,
    records: [{
      kind: 'new', order_anchor_id: 'm1', start_date: '2026-08-15', doc_type: 'passport',
      observations: [
        { type: 'order_committed', evidence_msg_ids: ['m1'] },
        { type: 'final_delivered', evidence_msg_ids: ['m3'] },
      ],
    }],
  }, input());

  const rec = validated.records[0];
  assert.match(rec.record_id, /^\d+_\d{4}-\d{2}-\d{2}#[0-9a-f]{10}$/);
  assert.equal(writerDerives({}, rec).status, 'confirmed_unpaid');
});

test('GUARDS #28: identical timestamps are ordered by ingestion seq end to end', () => {
  // m1, m2 and m3 all share ONE timestamp and differ only by seq. Deriving the right stage
  // depends entirely on that tiebreak surviving validation AND storage.
  const validated = validateAndNormalizeClientResult({
    phone: PHONE,
    records: [{
      kind: 'new', order_anchor_id: 'm1', start_date: '2026-08-15',
      observations: [
        { type: 'final_delivered', evidence_msg_ids: ['m3'] },
        { type: 'order_committed', evidence_msg_ids: ['m1'] },
        { type: 'payment_received', evidence_msg_ids: ['m2'] },
      ],
    }],
  }, input());

  assert.deepEqual(validated.records[0].observations.map((o) => o.type),
    ['order_committed', 'payment_received', 'final_delivered'],
    'observations must be ordered by ingestion seq, not model output order');

  const out = writerDerives({}, validated.records[0]);
  assert.equal(out.status, 'done');
  assert.equal(out.milestones.final_delivered.seq, 12, 'seq must be persisted, not discarded');
});

test('the model never supplies timestamps — code resolves them from cited evidence', () => {
  const validated = validateAndNormalizeClientResult({
    phone: PHONE,
    records: [{
      kind: 'new', order_anchor_id: 'm1', start_date: '2026-08-15',
      observations: [{
        type: 'order_committed', evidence_msg_ids: ['m1'],
        at: '1999-01-01T00:00:00Z', seq: 999999, // a hallucinated time must be ignored
      }],
    }],
  }, input());
  const o = validated.records[0].observations[0];
  assert.equal(o.at, '2026-08-15T10:00:00Z');
  assert.equal(o.seq, 10);
});

test('evidence must be new — context can never justify a write', () => {
  assert.throws(() => validateAndNormalizeClientResult({
    phone: PHONE,
    records: [{
      kind: 'new', order_anchor_id: 'old', start_date: '2026-08-15',
      observations: [{ type: 'order_committed', evidence_msg_ids: ['old'] }],
    }],
  }, input()), /not new evidence/);
});

test('a record with no observations is refused rather than written blank', () => {
  assert.throws(() => validateAndNormalizeClientResult({
    phone: PHONE,
    records: [{ kind: 'update', record_id: DONE_ID, observations: [] }],
  }, input([{ record_id: DONE_ID, status: 'done', milestones: DONE_MILESTONES }])),
  /at least one observation/);
});
