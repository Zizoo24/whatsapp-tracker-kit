'use strict';
// The fail-closed wall between "a model said something" and "we wrote it down".
// Each rejection below maps to a production incident — see docs/GUARDS.md.

const test = require('node:test');
const assert = require('node:assert');
const {
  mintAnchoredRecordId, validateAndNormalizeClientResult,
} = require('../scripts/lib/client-result.cjs');

const PHONE = '971500000000';
const input = () => ({
  phone: PHONE,
  existing_rows: [{ record_id: PHONE + '_2026-08-01#abc', status: 'done' }],
  conversation: [
    { id: 'm1', ts: '2026-08-15 10:00', from: 'CUSTOMER', is_new: true, text: 'go ahead' },
    { id: 'old', ts: '2026-08-01 10:00', from: 'CUSTOMER', is_new: false, text: 'older' },
  ],
});
const rejects = (records, re) => assert.throws(
  () => validateAndNormalizeClientResult({ phone: PHONE, records }, input()), re
);

test('id minting is deterministic in (phone, anchor) — this is what makes upsert idempotent', () => {
  const a = mintAnchoredRecordId(PHONE, 'MSG', '2026-08-15 10:00');
  assert.equal(a, mintAnchoredRecordId(PHONE, 'MSG', '2026-08-15 10:00'));
  assert.notEqual(a, mintAnchoredRecordId(PHONE, 'OTHER', '2026-08-15 10:00'));
  assert.match(a, /^\d+_\d{4}-\d{2}-\d{2}#[0-9a-f]{10}$/);
});

test('evidence must cite an is_new message — old context can never justify a write', () => {
  rejects([{ kind: 'new', order_anchor_id: 'old', start_date: '2026-08-15', status: 'paid', evidence_msg_ids: ['old'] }],
    /not is_new/);
});

test('GUARDS #14: a terminal record can never be reused for later work', () => {
  rejects([{ kind: 'update', record_id: PHONE + '_2026-08-01#abc', status: 'paid', evidence_msg_ids: ['m1'] }],
    /terminal record/);
});

test('an off-model status is rejected loudly, not dropped silently', () => {
  rejects([{ kind: 'new', order_anchor_id: 'm1', start_date: '2026-08-15', status: 'with_vendor', evidence_msg_ids: ['m1'] }],
    /unknown record status/);
});

test('a phone mismatch is rejected (the model must not retarget another chat)', () => {
  assert.throws(() => validateAndNormalizeClientResult({ phone: '999', records: [] }, input()), /phone mismatch/);
});

test('an update must name an id that already exists — never an invented one', () => {
  rejects([{ kind: 'update', record_id: 'nope', status: 'paid', evidence_msg_ids: ['m1'] }],
    /unknown record_id/);
});

test('a new record must not carry an id, and must carry an is_new anchor', () => {
  rejects([{ kind: 'new', record_id: 'x', order_anchor_id: 'm1', start_date: '2026-08-15', status: 'paid', evidence_msg_ids: ['m1'] }],
    /must not carry record_id/);
  rejects([{ kind: 'new', order_anchor_id: 'old', start_date: '2026-08-15', status: 'paid', evidence_msg_ids: ['m1'] }],
    /requires an is_new order_anchor_id/);
});

test('two new records cannot share one commitment anchor', () => {
  rejects([
    { kind: 'new', order_anchor_id: 'm1', start_date: '2026-08-15', status: 'paid', evidence_msg_ids: ['m1'] },
    { kind: 'new', order_anchor_id: 'm1', start_date: '2026-08-15', status: 'paid', evidence_msg_ids: ['m1'] },
  ], /cannot share one order_anchor_id/);
});

test('valid results pass, and a post-delivery revision is allowed', () => {
  const ok = validateAndNormalizeClientResult({
    phone: PHONE,
    records: [{ kind: 'new', order_anchor_id: 'm1', start_date: '2026-08-15', status: 'paid', doc_type: 'passport', evidence_msg_ids: ['m1'] }],
  }, input());
  assert.equal(ok.records[0].status, 'paid');
  assert.equal(ok.records[0].doc_type, 'passport');

  const rev = validateAndNormalizeClientResult({
    phone: PHONE,
    records: [{ kind: 'update', record_id: PHONE + '_2026-08-01#abc', status: 'revision', evidence_msg_ids: ['m1'] }],
  }, input());
  assert.equal(rev.records[0].status, 'revision');
});
