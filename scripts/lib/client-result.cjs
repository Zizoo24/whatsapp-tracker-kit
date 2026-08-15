'use strict';
// client-result.cjs — FAIL-CLOSED validation of the model's output + stable id minting.
//
// This is the wall between "a language model said something" and "we wrote it down".
// Every rule here is a real production failure. A violation THROWS, which discards the
// whole chat's result and defers it (the cursor is kept, so nothing is lost and the next
// tick retries). A silently-accepted bad result is far worse than a deferred good one.
//
// THE IDENTITY PROBLEM THIS SOLVES:
// One long chat holds MANY separate records from the SAME customer. The model cannot be
// trusted to invent or reuse ids. So:
//   - a NEW record must cite an ANCHOR message proving commitment; we mint the id from
//     (phone, anchor message id, anchor date) — deterministic, immutable, collision-safe.
//   - an UPDATE must name an id that ALREADY EXISTS in the rows we handed it.
//   - a terminal record can never be reused for later work — a later order is a NEW record
//     even in the same chat on the same calendar day.
//
// EVIDENCE RULE: every cited message id must be one we marked `is_new`. Old messages may
// explain context but can never justify a write by themselves — otherwise every tick
// re-litigates the whole history and old evidence resurrects settled records.

const crypto = require('crypto');
const {
  RECORD_FIELDS,
  TERMINAL_STATUS,
  TERMINAL_TRANSITIONS,
  VALID_STATUS,
} = require('./status-model.cjs');

const canon = (value) => String(value || '').replace(/\D/g, '');

const isCalendarDate = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return false;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

// PHONE_YYYY-MM-DD#HASH. Deterministic in (phone, anchor) so re-extracting the same
// commitment mints the SAME id — which is what makes the upsert idempotent. The hash
// disambiguates two records committed by one customer on one day.
function mintAnchoredRecordId(phone, anchorId, anchorTs) {
  const day = String(anchorTs || '').slice(0, 10);
  if (!isCalendarDate(day)) throw new Error('new record anchor has no valid calendar date');
  const digest = crypto.createHash('sha1').update(`${phone}|${anchorId}`, 'utf8').digest('hex').slice(0, 10);
  return `${phone}_${day}#${digest}`;
}

function validateEvidence(record, newMessages) {
  if (!Array.isArray(record.evidence_msg_ids) || record.evidence_msg_ids.length === 0) {
    throw new Error('record requires evidence_msg_ids from is_new messages');
  }
  const ids = [];
  for (const value of record.evidence_msg_ids) {
    const id = String(value || '');
    if (!id || !newMessages.has(id)) throw new Error(`evidence_msg_id is not is_new: ${id || '(blank)'}`);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function normalizeFields(record) {
  const out = {};
  for (const field of RECORD_FIELDS) out[field] = record[field] == null ? '' : String(record[field]);
  return out;
}

function validateAndNormalizeClientResult(result, input) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('result must be an object');
  if (canon(result.phone) !== canon(input && input.phone)) throw new Error('result phone mismatch');
  if (!Array.isArray(result.records)) throw new Error('result records must be an array');

  const conversation = Array.isArray(input.conversation) ? input.conversation : [];
  const newMessages = new Map(conversation.filter((message) => message && message.is_new === true)
    .map((message) => [String(message.id), message]));
  const existing = new Map((Array.isArray(input.existing_rows) ? input.existing_rows : [])
    .filter((row) => row && row.record_id)
    .map((row) => [String(row.record_id), row]));
  const anchors = new Set();
  const targets = new Set();
  const records = [];

  for (const raw of result.records) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('record must be an object');
    const kind = String(raw.kind || '').trim();
    if (kind !== 'new' && kind !== 'update') throw new Error('record kind must be new or update');
    const status = String(raw.status || '').trim();
    if (!VALID_STATUS.has(status)) throw new Error('unknown record status: ' + status);
    const evidenceMsgIds = validateEvidence(raw, newMessages);

    if (kind === 'new') {
      if (raw.record_id != null && String(raw.record_id).trim() !== '') {
        throw new Error('new record must not carry record_id');
      }
      const anchor = String(raw.order_anchor_id || '').trim();
      if (!anchor || !newMessages.has(anchor)) throw new Error('new record requires an is_new order_anchor_id');
      if (!evidenceMsgIds.includes(anchor)) throw new Error('order_anchor_id must also appear in evidence_msg_ids');
      if (anchors.has(anchor)) throw new Error('two new records cannot share one order_anchor_id');
      anchors.add(anchor);
      const sourceDate = String(raw.start_date || '').trim();
      if (!isCalendarDate(sourceDate)) throw new Error('new record requires a valid start_date');
      const recordId = mintAnchoredRecordId(canon(input.phone), anchor, newMessages.get(anchor).ts);
      records.push({
        record_id: recordId,
        start_date: sourceDate,
        status,
        ...normalizeFields(raw),
        evidence_msg_ids: evidenceMsgIds,
      });
      continue;
    }

    if (raw.order_anchor_id != null && String(raw.order_anchor_id).trim() !== '') {
      throw new Error('update record must not carry order_anchor_id');
    }
    const recordId = String(raw.record_id || '').trim();
    const current = existing.get(recordId);
    if (!current) throw new Error('update references unknown record_id: ' + recordId);
    if (targets.has(recordId)) throw new Error('result updates one record_id more than once: ' + recordId);
    targets.add(recordId);
    const currentStatus = String(current.status || '').trim();
    if (TERMINAL_STATUS.has(currentStatus) && !TERMINAL_TRANSITIONS[currentStatus].has(status)) {
      throw new Error(
        `terminal record ${recordId} cannot become ${status}; a later order must be kind=new with its own commitment anchor`
      );
    }
    records.push({
      record_id: recordId,
      start_date: '',
      status,
      ...normalizeFields(raw),
      evidence_msg_ids: evidenceMsgIds,
    });
  }

  return { phone: canon(input.phone), records };
}

module.exports = {
  canon,
  isCalendarDate,
  mintAnchoredRecordId,
  validateAndNormalizeClientResult,
};
