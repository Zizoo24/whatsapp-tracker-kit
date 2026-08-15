'use strict';
// counterparty-heuristic.cjs — OPTIONAL deterministic fallback. DOMAIN EXAMPLE.
//
// ============================================================================
// This file is an ILLUSTRATION, not infrastructure. Ships DISABLED by default.
// ============================================================================
//
// WHAT IT IS FOR: sometimes a handoff is so unambiguous that code can see it and a model
// call is wasted — "do the passport one now" when exactly ONE eligible record is a
// passport. A cheap deterministic rule catches those and makes the lane robust when the
// model is unavailable.
//
// WHY IT IS SAFE: it fires ONLY when the match is unique (exactly one eligible candidate).
// Ambiguity returns nothing and lets the model decide. That uniqueness condition is the
// whole safety argument — do not relax it to "the best match".
//
// TO ENABLE: set DOC_KEYWORDS to your domain's document vocabulary. With an empty list
// inferUniqueHandoffs() always returns [], which is the intended default.

// Words that identify the document/work type in YOUR domain. Empty = disabled.
const DOC_KEYWORDS = [
  // 'passport', 'licence', 'license', 'contract',
];

// Words meaning "start work on it". Includes non-English forms in the source domain.
const ACTION_WORDS = /\b(do|start|translate|proceed|work on|begin)\b/i;
// Words that NEGATE a directive. Checked FIRST — "cancel the passport one" must never
// read as a handoff.
const CANCEL_WORDS = /\b(cancel|cancelled|canceled|stop|void|hold)\b/i;

// Reads the CURRENT prep shape: `new_messages` is the only valid evidence. (Earlier versions
// accepted `delta`/`conversation`; those fields no longer exist, so the heuristic silently
// matched nothing.)
function newBusinessMessages(input) {
  return (input.new_messages || []).filter((message) => message && message.from === 'BUSINESS');
}

function docPattern() {
  if (!DOC_KEYWORDS.length) return null;
  return new RegExp('\\b(' + DOC_KEYWORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i');
}

function isHandoffDirective(text) {
  const pattern = docPattern();
  if (!pattern) return false;
  const value = String(text || '');
  if (CANCEL_WORDS.test(value)) return false;
  return ACTION_WORDS.test(value) && pattern.test(value);
}

function isMatchingRecord(record) {
  const pattern = docPattern();
  return Boolean(pattern && pattern.test(String((record && record.doc_type) || '')));
}

function inferUniqueHandoffs(input) {
  const messages = newBusinessMessages(input).filter((message) => isHandoffDirective(message.text));
  const candidates = (input.in_flight || []).filter(isMatchingRecord);
  // THE SAFETY CONDITION: exactly one candidate, or we say nothing.
  if (!messages.length || candidates.length !== 1) return [];
  const message = messages[messages.length - 1];
  const evidenceId = String(message.msg_id || message.id || '').trim();
  if (!evidenceId) return [];
  return [{
    record_id: String(candidates[0].record_id),
    // Same shape the model must return, so the caller resolves timestamps identically for
    // both sources rather than special-casing this one.
    evidence_msg_ids: [evidenceId],
    evidence: 'new BUSINESS directive uniquely matched the sole eligible record of that type',
  }];
}

module.exports = { DOC_KEYWORDS, inferUniqueHandoffs, isHandoffDirective };
