'use strict';
// INTEGRATION: validator -> writer. This is the test class v1.0 lacked entirely.
//
// v1.0's units all passed while the two layers disagreed: the validator ALLOWED
// `done -> revision` and the writer's rank comparison silently discarded it (GUARDS #22).
// Each layer was individually correct; the CONTRACT between them was broken.
//
// These tests drive real validated output through the exact derivation tracker-apply
// performs, so a future divergence fails here instead of in production.

const test = require('node:test');
const assert = require('node:assert');
const { validateAndNormalizeClientResult } = require('../scripts/lib/client-result.cjs');
const { mergeMilestones, projectStatus } = require('../scripts/lib/status-model.cjs');

const PHONE = '971500000000';
const DONE_ID = PHONE + '_2026-08-01#abc';
const DONE_MILESTONES = JSON.stringify({
  committed_at: '2026-08-01T09:00:00Z',
  paid_at: '2026-08-01T10:00:00Z',
  final_delivered_at: '2026-08-01T12:00:00Z',
});

const input = (rows = []) => ({
  phone: PHONE,
  existing_rows: rows,
  context: [{ id: 'old', ts: '2026-08-01T08:00:00Z', seq: 1, from: 'CUSTOMER', text: 'earlier' }],
  new_messages: [
    { id: 'm1', ts: '2026-08-15T10:00:00Z', seq: 10, from: 'CUSTOMER', text: 'please fix the spelling' },
    { id: 'm2', ts: '2026-08-15T10:00:30Z', seq: 11, from: 'BUSINESS', text: 'payment received' },
    { id: 'm3', ts: '2026-08-15T10:00:45Z', seq: 12, from: 'BUSINESS', text: 'final certified file attached' },
  ],
});

// Exactly what tracker-apply does with a validated record.
const writerDerives = (storedMilestones, record) =>
  projectStatus(mergeMilestones(storedMilestones, record.observations).milestones);

test('a post-delivery revision survives the FULL validator -> writer path', () => {
  const validated = validateAndNormalizeClientResult({
    phone: PHONE,
    records: [{
      kind: 'update',
      record_id: DONE_ID,
      observations: [{ type: 'revision_requested', evidence_msg_ids: ['m1'] }],
    }],
  }, input([{ record_id: DONE_ID, status: 'done', milestones: DONE_MILESTONES }]));

  assert.equal(writerDerives(DONE_MILESTONES, validated.records[0]), 'revision',
    'v1.0 accepted this at validation and silently discarded it at the writer');
});

test('a stale re-read of an old payment cannot change a completed record', () => {
  assert.throws(() => validateAndNormalizeClientResult({
    phone: PHONE,
    records: [{
      kind: 'update',
      record_id: DONE_ID,
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
  assert.equal(writerDerives({}, rec), 'confirmed_unpaid',
    'delivering early must not stop us chasing payment');
});

test('sub-minute evidence ordering is exact (payment and delivery in the same minute)', () => {
  // m2 (payment, seq 11) and m3 (delivery, seq 12) fall inside ONE minute. v1.1 truncated
  // timestamps to the minute, so their order — which decides paid vs done — was arbitrary.
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

  const order = validated.records[0].observations.map((o) => o.type);
  assert.deepEqual(order, ['order_committed', 'payment_received', 'final_delivered'],
    'observations must be ordered by ingestion seq, not by model output order');
  assert.equal(writerDerives({}, validated.records[0]), 'done');
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
