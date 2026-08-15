'use strict';
// INTEGRATION: validator -> writer. This is the test class v1 lacked entirely.
//
// v1's units all passed while the two layers disagreed: the validator explicitly ALLOWED
// `done -> revision`, and the writer's raw rank comparison classified it as a downgrade and
// silently discarded the status. Each layer was individually "correct". The contract between
// them was broken (docs/GUARDS.md #22).
//
// These tests exercise the real validated output through the real derivation the writer
// performs, so a future divergence fails here rather than in production.

const test = require('node:test');
const assert = require('node:assert');
const { validateAndNormalizeClientResult } = require('../scripts/lib/client-result.cjs');
const { reduceObservations } = require('../scripts/lib/status-model.cjs');

const PHONE = '971500000000';
const DONE_ID = PHONE + '_2026-08-01#abc';

const input = (rows = [{ record_id: DONE_ID, status: 'done' }]) => ({
  phone: PHONE,
  existing_rows: rows,
  context: [{ id: 'old', ts: '2026-08-01 10:00', from: 'CUSTOMER', text: 'earlier' }],
  new_messages: [
    { id: 'm1', ts: '2026-08-15 10:00', from: 'CUSTOMER', text: 'please change the spelling' },
    { id: 'm2', ts: '2026-08-15 11:00', from: 'BUSINESS', text: 'payment received' },
  ],
});

// What tracker-apply actually does with a validated record.
const writerDerives = (currentStatus, record) =>
  reduceObservations(currentStatus, record.observations).status;

test('a post-delivery revision survives the FULL validator -> writer path', () => {
  const validated = validateAndNormalizeClientResult({
    phone: PHONE,
    records: [{
      kind: 'update',
      record_id: DONE_ID,
      observations: [{ type: 'revision_requested', evidence_msg_ids: ['m1'] }],
    }],
  }, input());

  assert.equal(validated.records[0].status, 'revision', 'validator must accept it');
  assert.equal(writerDerives('done', validated.records[0]), 'revision',
    'the WRITER must also accept it — v1 silently discarded this exact move');
});

test('a stale re-read of an old payment cannot walk a completed record backwards', () => {
  assert.throws(() => validateAndNormalizeClientResult({
    phone: PHONE,
    records: [{
      kind: 'update',
      record_id: DONE_ID,
      observations: [{ type: 'payment_received', evidence_msg_ids: ['m2'] }],
    }],
  }, input()), /cannot be advanced/);
});

test('the model may not emit a status — that boundary is enforced, not merely documented', () => {
  assert.throws(() => validateAndNormalizeClientResult({
    phone: PHONE,
    records: [{
      kind: 'update', record_id: DONE_ID, status: 'paid',
      observations: [{ type: 'revision_requested', evidence_msg_ids: ['m1'] }],
    }],
  }, input()), /must not carry status/);
});

test('a new record derives its stage from observations alone, end to end', () => {
  const validated = validateAndNormalizeClientResult({
    phone: PHONE,
    records: [{
      kind: 'new',
      order_anchor_id: 'm1',
      start_date: '2026-08-15',
      doc_type: 'passport',
      observations: [
        { type: 'order_committed', evidence_msg_ids: ['m1'] },
        { type: 'payment_received', evidence_msg_ids: ['m2'] },
      ],
    }],
  }, input([]));

  const rec = validated.records[0];
  assert.equal(rec.status, 'paid');
  assert.match(rec.record_id, /^\d+_\d{4}-\d{2}-\d{2}#[0-9a-f]{10}$/);
  assert.equal(writerDerives(null, rec), 'paid', 'writer and validator must agree');
});

test('evidence must come from new_messages — context can never justify a write', () => {
  assert.throws(() => validateAndNormalizeClientResult({
    phone: PHONE,
    records: [{
      kind: 'new', order_anchor_id: 'old', start_date: '2026-08-15',
      observations: [{ type: 'order_committed', evidence_msg_ids: ['old'] }],
    }],
  }, input([])), /not is_new/);
});

test('a record with no observations is refused rather than written blank', () => {
  assert.throws(() => validateAndNormalizeClientResult({
    phone: PHONE,
    records: [{ kind: 'update', record_id: DONE_ID, observations: [] }],
  }, input()), /at least one observation/);
});
