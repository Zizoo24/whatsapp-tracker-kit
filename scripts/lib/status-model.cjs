'use strict';
// status-model.cjs — SEAM. observations -> durable milestone OCCURRENCES -> projected status.
//
// ============================================================================
// THIS IS ONE OF THE FILES YOU ADAPT PER DEPLOYMENT. See docs/PORTING.md.
// ============================================================================
//
// THE THREE-LAYER BOUNDARY:
//
//   the model     reports OBSERVATIONS   ("payment landed here", "final sent here")
//   this file     records MILESTONES     (durable, evidence-bound facts about the past)
//   this file     projects STATUS        (a pure function of those facts)
//
// MILESTONES, NOT A MEMORYLESS REDUCER (this cost a regression — GUARDS #25). A reducer that
// maps the newest observation to a stage has no memory, so it completed unpaid work and then
// forgot completed work once the delivery aged out of the evidence window. Status is a fold
// over history; milestones are that history, compressed to one occurrence per fact.
//
// AN OCCURRENCE IS { at, seq, message_id } — NOT a bare timestamp (GUARDS #28). Validation
// orders evidence by the mirror's rowid because two messages routinely share a timestamp;
// storing only `at` threw that ordering away, so a revision requested in the SAME SECOND as
// the delivery projected as "done" and the customer's correction request vanished. `seq` is
// the deterministic tiebreak, and `message_id` gives every stored fact provenance for free.
//
// MALFORMED STATE FAILS CLOSED (GUARDS #29). This column is declared machine-readable truth.
// Unreadable non-blank truth must never degrade to "there was no history" — that is the same
// fail-open class already removed from the LID and store reads.

// ---- Stages (DOMAIN: rename freely) ---------------------------------------------------
const STAGES = [
  'confirmed_unpaid', // committed, money not in       -> chase payment
  'paid',             // money in, work not started    -> assign / start
  'translating',      // work underway (by anyone)     -> finish / deliver
  'revision',         // delivered, changes requested  -> fix
  'done',             // paid AND delivered            -> terminal
];

// TERMINAL-DEAD states: the record ended without completing. They must be REPRESENTABLE,
// never deleted — "cancelled means delete the row" silently destroyed every record of a
// refunded order.
const DEAD_STAGES = ['cancelled', 'refunded'];

const VALID_STATUS = new Set([...STAGES, ...DEAD_STAGES]);
const STATUS_RANK = Object.fromEntries([...STAGES, ...DEAD_STAGES].map((n, i) => [n, i]));
const TERMINAL_STATUS = new Set(['done', ...DEAD_STAGES]);

// ---- Observations (what the MODEL is allowed to say) ----------------------------------
// Each is a claim about evidence, never about state. Every observation writes exactly one
// milestone. Keys are the stored milestone names.
const OBSERVATION_MILESTONE = Object.freeze({
  order_committed: 'committed',
  payment_received: 'paid',
  work_started: 'work_started',
  draft_sent: 'draft_sent',
  final_delivered: 'final_delivered',
  revision_requested: 'revision',
  order_cancelled: 'cancelled',
  payment_refunded: 'refunded',
});

const OBSERVATIONS = Object.keys(OBSERVATION_MILESTONE);
const MILESTONES = [...new Set(Object.values(OBSERVATION_MILESTONE))];

// STRUCTURAL GUARD (GUARDS #11): only records at or beyond this point may be seen by the
// counterparty/handoff pass. We routinely forward a document to a counterparty JUST TO GET
// A PRICE QUOTE before the customer has committed or paid, so a quote-check must never be
// visible as a handoff candidate. Do NOT widen this to the committed-but-unpaid stage.
const HANDOFF_ELIGIBLE = new Set(['paid', 'translating', 'revision']);

// Non-status fields an extraction pass may write. An allowlist, so a hallucinated key can
// never reach the store.
const RECORD_FIELDS = [
  'client_name', 'doc_type', 'language_pair', 'price', 'delivery_time', 'summary',
];

// Thrown when stored milestone state is present but unreadable. Callers MUST treat this as
// a hard stop: abort the write, keep the cursor, alert. Never as "no history".
class MilestoneStateError extends Error {}

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';

// Compare timestamps as INSTANTS. String comparison is wrong here: the mirror writes
// '2026-07-08 09:21:01+04:00' while other layers write ISO 'Z' form, and lexically the
// former looks larger even when it is the same or an earlier instant.
function tsToEpoch(value) {
  if (isBlank(value)) return null;
  let t = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2} /.test(t)) t = t.replace(' ', 'T');
  if (!/(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(t)) t += 'Z';
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Order two occurrences: timestamp first, ingestion `seq` as the deterministic tiebreak.
 * Returns >0 if `a` is later, <0 if earlier, 0 if genuinely indistinguishable.
 */
function compareOccurrence(a, b) {
  const ea = a ? tsToEpoch(a.at) : null;
  const eb = b ? tsToEpoch(b.at) : null;
  if (ea === null && eb === null) return 0;
  if (ea === null) return -1;
  if (eb === null) return 1;
  if (ea !== eb) return ea > eb ? 1 : -1;
  const sa = Number.isFinite(Number(a.seq)) ? Number(a.seq) : null;
  const sb = Number.isFinite(Number(b.seq)) ? Number(b.seq) : null;
  if (sa === null || sb === null || sa === sb) return 0;
  return sa > sb ? 1 : -1;
}

function normalizeOccurrence(value, milestone) {
  // Tolerate a bare timestamp (the v1.2.0 shape) so an early store upgrades in place.
  if (typeof value === 'string' || typeof value === 'number') {
    const at = String(value).trim();
    if (!at) return null;
    if (tsToEpoch(at) === null) {
      throw new MilestoneStateError(`milestone ${milestone} has an unparseable timestamp: ${at}`);
    }
    return { at, seq: null, message_id: '' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MilestoneStateError(`milestone ${milestone} is not an occurrence object`);
  }
  const at = String(value.at || '').trim();
  if (!at || tsToEpoch(at) === null) {
    throw new MilestoneStateError(`milestone ${milestone} has no usable timestamp`);
  }
  const seq = Number.isFinite(Number(value.seq)) ? Number(value.seq) : null;
  return { at, seq, message_id: String(value.message_id || '') };
}

/**
 * Parse stored milestone state. Blank is a legitimately new record and yields {}.
 * Non-blank but unreadable THROWS — see MilestoneStateError.
 */
function parseMilestones(raw) {
  if (raw === null || raw === undefined) return {};
  let source = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return {};
    try {
      source = JSON.parse(text);
    } catch (e) {
      throw new MilestoneStateError('stored milestone state is not valid JSON: ' + e.message);
    }
  }
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new MilestoneStateError('stored milestone state is not an object');
  }
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (isBlank(value)) continue;
    if (!MILESTONES.includes(key)) {
      throw new MilestoneStateError('stored milestone state has an unknown key: ' + key);
    }
    out[key] = normalizeOccurrence(value, key);
  }
  return out;
}

/**
 * Merge new observations into stored milestones. Milestones only ever ACCUMULATE — they are
 * facts about the past, and forgetting one caused the Day-2 amnesia bug.
 *
 * LATEST WINS per milestone type, ordered by (at, seq). That is what makes a repeated
 * revision cycle project correctly: deliver -> revise -> deliver again advances the
 * `final_delivered` occurrence past `revision`, returning the record to "done".
 *
 * Pure: no clock, no I/O. Throws MilestoneStateError if the stored state is unreadable.
 */
function mergeMilestones(existing, observations = []) {
  const milestones = parseMilestones(existing);
  const applied = [];
  const refused = [];

  for (const raw of observations) {
    const type = typeof raw === 'string' ? raw : String((raw && raw.type) || '');
    const key = OBSERVATION_MILESTONE[type];
    if (!key) { refused.push({ observation: type, reason: 'unknown_observation' }); continue; }

    const at = String((raw && (raw.at || raw.ts)) || '').trim();
    // An observation with no resolvable evidence timestamp cannot be ordered against
    // anything, so it is refused rather than stored unorderable. Deterministic code resolves
    // `at`/`seq` from the cited message — the model never supplies them.
    if (!at || tsToEpoch(at) === null) {
      refused.push({ observation: type, reason: 'missing_or_unparseable_timestamp' });
      continue;
    }
    const candidate = {
      at,
      seq: Number.isFinite(Number(raw && raw.seq)) ? Number(raw.seq) : null,
      message_id: String((raw && (raw.message_id || (raw.evidence_msg_ids || [])[0])) || ''),
    };
    if (!milestones[key] || compareOccurrence(candidate, milestones[key]) > 0) {
      milestones[key] = candidate;
      applied.push({ observation: type, milestone: key, at: candidate.at, seq: candidate.seq });
    } else {
      refused.push({ observation: type, reason: 'older_than_stored_occurrence' });
    }
  }

  return { milestones, applied, refused };
}

/**
 * Project a status from milestones. PURE — the single authority on a record's stage, and the
 * only place the commercial ordering rules live.
 *
 * ORDER MATTERS. Each clause is a business rule:
 *   refunded/cancelled  terminal-dead outcomes win over everything.
 *   NOT paid            unpaid is unpaid EVEN IF DELIVERED — the next action is still
 *                       "chase payment". This clause is why milestones exist (GUARDS #25).
 *   revision            a revision AFTER the latest delivery reopens the work. Compared by
 *                       (at, seq), so a same-second revision is not swallowed (GUARDS #28).
 *   delivered           paid AND delivered = done.
 *   started             work underway (a draft counts as underway, never as finished).
 *   otherwise           paid, waiting to start.
 */
function projectStatus(milestones) {
  const m = parseMilestones(milestones);
  if (m.refunded) return 'refunded';
  if (m.cancelled) return 'cancelled';
  if (!m.paid) return 'confirmed_unpaid';
  if (m.revision && (!m.final_delivered || compareOccurrence(m.revision, m.final_delivered) > 0)) {
    return 'revision';
  }
  if (m.final_delivered) return 'done';
  if (m.work_started || m.draft_sent) return 'translating';
  return 'paid';
}

/**
 * Whether an AUTOMATED lane may move `current` -> `next`.
 *
 * With milestone projection the monotonic guard is largely IMPLICIT — milestones only
 * accumulate, so a stale re-read cannot walk a record backwards. This remains the explicit
 * gate for refusing to reopen a terminal record.
 *
 * An operator correction does NOT pass through here: a human corrects the underlying FACTS
 * (see tracker-admin milestone_ops), and the status re-projects from them.
 */
function canAutomatedTransition(current, next) {
  if (!VALID_STATUS.has(next)) return { allowed: false, reason: 'invalid_target:' + next };
  if (isBlank(current)) return { allowed: true, reason: 'creation' };
  if (!VALID_STATUS.has(current)) return { allowed: false, reason: 'unrankable_current:' + current };
  if (current === next) return { allowed: false, reason: 'no_op' };
  if (DEAD_STAGES.includes(current)) {
    return current === 'cancelled' && next === 'refunded'
      ? { allowed: true, reason: 'cancelled_to_refunded' }
      : { allowed: false, reason: 'terminal_dead:' + current };
  }
  if (current === 'done') {
    return ['revision', 'cancelled', 'refunded'].includes(next)
      ? { allowed: true, reason: 'post_completion' }
      : { allowed: false, reason: 'cannot_reopen_completed:' + next };
  }
  if (STATUS_RANK[next] > STATUS_RANK[current]) return { allowed: true, reason: 'forward' };
  if (DEAD_STAGES.includes(next)) return { allowed: true, reason: 'terminal_dead' };
  return { allowed: false, reason: 'downgrade_refused:' + current + '->' + next };
}

module.exports = {
  DEAD_STAGES,
  HANDOFF_ELIGIBLE,
  MILESTONES,
  MilestoneStateError,
  OBSERVATIONS,
  OBSERVATION_MILESTONE,
  RECORD_FIELDS,
  STAGES,
  STATUS_RANK,
  TERMINAL_STATUS,
  VALID_STATUS,
  canAutomatedTransition,
  compareOccurrence,
  mergeMilestones,
  parseMilestones,
  projectStatus,
  tsToEpoch,
};
