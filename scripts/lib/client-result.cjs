'use strict';
// client-result.cjs — FAIL-CLOSED validation of the model's output + stable id minting.
//
// The wall between "a language model said something" and "we wrote it down". Every rule
// here is a real production failure. A violation THROWS, which discards that chat's whole
// result and defers it — the cursor is kept, so nothing is lost and the next tick retries.
// A silently-accepted bad result is far worse than a loudly-deferred good one.
//
// THE MODEL EMITS OBSERVATIONS, NEVER A STATUS. Status is derived by the reducer in
// status-model.cjs. See the boundary argument at the top of that file.
//
// THE IDENTITY PROBLEM: one long chat holds MANY records from the SAME customer, and the
// model cannot be trusted to invent or reuse ids. So:
//   - a NEW record must cite an ANCHOR message proving commitment; the id is minted from
//     (phone, anchor id, anchor date) — deterministic, immutable, collision-safe;
//   - an UPDATE must name an id that ALREADY EXISTS in the rows we handed it;
//   - a terminal record is never reused for later work.
//
// EVIDENCE RULE: every cited message id must be one we marked `is_new`. Old messages may
// explain context but can never justify a write — otherwise every tick re-litigates history
// and settled records get resurrected by evidence that was already processed.

const crypto = require('crypto');
const {
  OBSERVATION_STAGE,
  RECORD_FIELDS,
  TERMINAL_STATUS,
  canAutomatedTransition,
  reduceObservations,
} = require('./status-model.cjs');

const canon = (value) => String(value || '').replace(/\D/g, '');

const isCalendarDate = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return false;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

// PHONE_YYYY-MM-DD#HASH. Deterministic in (phone, anchor), so re-extracting the same
// commitment mints the SAME id — which is what makes the upsert idempotent. The hash
// disambiguates two records committed by one customer on one day.
function mintAnchoredRecordId(phone, anchorId, anchorTs) {
  const day = String(anchorTs || '').slice(0, 10);
  if (!isCalendarDate(day)) throw new Error('new record anchor has no valid calendar date');
  const digest = crypto.createHash('sha1').update(`${phone}|${anchorId}`, 'utf8').digest('hex').slice(0, 10);
  return `${phone}_${day}#${digest}`;
}

// Collect the message ids the prep step marked is_new. This is the ONLY set an observation
// may cite. `new_messages` is the authoritative field; `conversation` is accepted as a
// fallback so a hand-built fixture still validates.
function newMessageMap(input) {
  const source = Array.isArray(input.new_messages) && input.new_messages.length
    ? input.new_messages
    : (Array.isArray(input.conversation) ? input.conversation.filter((m) => m && m.is_new === true) : []);
  return new Map(source.map((m) => [String(m.id), m]));
}

function validateObservations(record, newMessages) {
  const raw = Array.isArray(record.observations) ? record.observations : [];
  if (!raw.length) throw new Error('record requires at least one observation');

  const observations = [];
  const allEvidence = [];
  for (const item of raw) {
    const type = String((item && item.type) || '').trim();
    if (!OBSERVATION_STAGE[type]) throw new Error('unknown observation type: ' + (type || '(blank)'));
    const ids = Array.isArray(item.evidence_msg_ids) ? item.evidence_msg_ids : [];
    if (!ids.length) throw new Error(`observation ${type} requires evidence_msg_ids`);
    const seen = [];
    for (const value of ids) {
      const id = String(value || '');
      // THE EVIDENCE GATE. An id that is not is_new means the model is justifying a write
      // with something we already processed.
      if (!id || !newMessages.has(id)) {
        throw new Error(`evidence_msg_id is not is_new: ${id || '(blank)'} (observation ${type})`);
      }
      if (!seen.includes(id)) seen.push(id);
      if (!allEvidence.includes(id)) allEvidence.push(id);
    }
    observations.push({ type, evidence_msg_ids: seen });
  }

  // Apply in evidence order so a record committed, paid and delivered inside one delta
  // walks its whole lifecycle in a single pass.
  observations.sort((a, b) => {
    const at = String(newMessages.get(a.evidence_msg_ids[0])?.ts || '');
    const bt = String(newMessages.get(b.evidence_msg_ids[0])?.ts || '');
    return at < bt ? -1 : at > bt ? 1 : 0;
  });

  return { observations, evidenceMsgIds: allEvidence };
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

  const newMessages = newMessageMap(input);
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
    // The model must not emit a status — that is the reducer's job, and accepting one here
    // would quietly reopen the failure class the observation boundary exists to close.
    if (Object.prototype.hasOwnProperty.call(raw, 'status')) {
      throw new Error('record must not carry status; emit observations instead');
    }

    const { observations, evidenceMsgIds } = validateObservations(raw, newMessages);

    if (kind === 'new') {
      if (raw.record_id != null && String(raw.record_id).trim() !== '') {
        throw new Error('new record must not carry record_id');
      }
      const anchor = String(raw.order_anchor_id || '').trim();
      if (!anchor || !newMessages.has(anchor)) throw new Error('new record requires an is_new order_anchor_id');
      if (!evidenceMsgIds.includes(anchor)) throw new Error('order_anchor_id must also appear in observation evidence');
      if (anchors.has(anchor)) throw new Error('two new records cannot share one order_anchor_id');
      anchors.add(anchor);
      const sourceDate = String(raw.start_date || '').trim();
      if (!isCalendarDate(sourceDate)) throw new Error('new record requires a valid start_date');

      const derived = reduceObservations(null, observations);
      if (!derived.status) {
        throw new Error('new record observations derive no status: '
          + derived.refused.map((r) => r.observation + '/' + r.reason).join(','));
      }
      records.push({
        record_id: mintAnchoredRecordId(canon(input.phone), anchor, newMessages.get(anchor).ts),
        start_date: sourceDate,
        status: derived.status,
        observations,
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
    const derived = reduceObservations(currentStatus, observations);

    // A terminal record may only be reopened by an observation that genuinely implies it.
    // Anything else means the model is trying to reuse a finished record for later work,
    // which must be a NEW record with its own commitment anchor.
    if (TERMINAL_STATUS.has(currentStatus) && derived.status === currentStatus) {
      const why = derived.refused.map((r) => r.reason).join(',') || 'no_applicable_observation';
      throw new Error(
        `terminal record ${recordId} cannot be advanced by these observations (${why}); `
        + 'a later order must be kind=new with its own commitment anchor'
      );
    }

    records.push({
      record_id: recordId,
      start_date: '',
      status: derived.status,
      observations,
      ...normalizeFields(raw),
      evidence_msg_ids: evidenceMsgIds,
    });
  }

  return { phone: canon(input.phone), records };
}

module.exports = {
  canAutomatedTransition,
  canon,
  isCalendarDate,
  mintAnchoredRecordId,
  validateAndNormalizeClientResult,
};
