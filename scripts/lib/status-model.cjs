'use strict';
// status-model.cjs — SEAM. The lifecycle model: observations -> durable milestones -> status.
//
// ============================================================================
// THIS IS ONE OF THE FILES YOU ADAPT PER DEPLOYMENT. See docs/PORTING.md.
// ============================================================================
//
// THE THREE-LAYER BOUNDARY:
//
//   the model     reports OBSERVATIONS   ("payment landed here", "final sent here")
//   this file     records MILESTONES     (durable timestamped facts about the past)
//   this file     projects STATUS        (a pure function of the milestones)
//
// WHY MILESTONES AND NOT A DIRECT OBSERVATION->STATUS REDUCER (this cost a regression):
//
// A reducer that maps the NEWEST observation to a stage has no memory. Two real translation
// scenarios break it:
//
//   1. WORK DELIVERED BEFORE PAYMENT. A customer commits, we deliver early, they have not
//      paid. A forward-ranked reducer sees `final_delivered` and concludes "done". But the
//      next commercial action is still CHASE PAYMENT. Unpaid is unpaid even when delivered.
//
//   2. THE DAY-2 AMNESIA. Day 1: committed and delivered, unpaid. Day 2: payment arrives.
//      By then the delivery is old context and can no longer be cited as fresh evidence, so
//      a memoryless reducer sees only `payment_received` and lands on "paid" — silently
//      forgetting that the job was already finished.
//
// Milestones fix both because they are FACTS THAT PERSIST. Status is then a projection, not
// an accumulation of guesses. This is the event-ledger insight without the ledger: eight
// timestamps in one column, not an event store.

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
// milestone.
const OBSERVATION_MILESTONE = Object.freeze({
  order_committed: 'committed_at',
  payment_received: 'paid_at',
  work_started: 'work_started_at',
  draft_sent: 'draft_sent_at',
  final_delivered: 'final_delivered_at',
  revision_requested: 'revision_requested_at',
  order_cancelled: 'cancelled_at',
  payment_refunded: 'refunded_at',
});

const OBSERVATIONS = Object.keys(OBSERVATION_MILESTONE);
const MILESTONES = Object.values(OBSERVATION_MILESTONE);

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

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';

// Compare two timestamps as instants. String comparison is WRONG here: the mirror writes
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

const laterTs = (a, b) => {
  const ea = tsToEpoch(a);
  const eb = tsToEpoch(b);
  if (ea === null) return b;
  if (eb === null) return a;
  return eb > ea ? b : a;
};

function parseMilestones(raw) {
  let source = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return {};
    try { source = JSON.parse(raw); } catch { return {}; }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const out = {};
  for (const key of MILESTONES) if (!isBlank(source[key])) out[key] = String(source[key]);
  return out;
}

/**
 * Merge new observations into the stored milestones. Milestones only ever ACCUMULATE —
 * they are facts about the past, and forgetting one is what caused the Day-2 amnesia bug.
 *
 * LATEST WINS per milestone. That is what makes a second revision cycle work:
 * deliver -> revise -> deliver again advances `final_delivered_at` past
 * `revision_requested_at`, so the projection returns to "done".
 *
 * Pure: no clock, no I/O.
 */
function mergeMilestones(existing, observations = []) {
  const milestones = parseMilestones(existing);
  const applied = [];
  const refused = [];

  for (const raw of observations) {
    const type = typeof raw === 'string' ? raw : String((raw && raw.type) || '');
    const key = OBSERVATION_MILESTONE[type];
    if (!key) { refused.push({ observation: type, reason: 'unknown_observation' }); continue; }
    // An observation with no usable timestamp still proves the event happened; fall back to
    // a sentinel so the fact is not lost. Ordering-sensitive projections handle blanks.
    const at = (raw && raw.at) || (raw && raw.ts) || '';
    if (isBlank(at)) { refused.push({ observation: type, reason: 'missing_timestamp' }); continue; }
    milestones[key] = laterTs(milestones[key], String(at));
    applied.push({ observation: type, milestone: key, at: milestones[key] });
  }

  return { milestones, applied, refused };
}

/**
 * Project a status from milestones. PURE — this is the single authority on what a record's
 * stage is, and the only place the business ordering rules live.
 *
 * ORDER MATTERS. Each clause below is a commercial rule:
 *   refunded/cancelled  terminal-dead outcomes win over everything.
 *   NOT paid            unpaid is unpaid EVEN IF DELIVERED — the next action is still
 *                       "chase payment". This clause is the whole reason milestones exist.
 *   revision            a revision requested AFTER the latest delivery reopens the work.
 *   delivered           paid AND delivered = done.
 *   started             work underway (a draft counts as underway, never as finished).
 *   otherwise           paid, waiting to start.
 */
function projectStatus(milestones) {
  const m = parseMilestones(milestones);
  if (m.refunded_at) return 'refunded';
  if (m.cancelled_at) return 'cancelled';

  // THE RULE THE OBSERVATION REDUCER LOST: delivery does not complete an unpaid record.
  if (!m.paid_at) return 'confirmed_unpaid';

  const delivered = tsToEpoch(m.final_delivered_at);
  const revised = tsToEpoch(m.revision_requested_at);
  if (revised !== null && (delivered === null || revised > delivered)) return 'revision';
  if (delivered !== null) return 'done';
  if (m.work_started_at || m.draft_sent_at) return 'translating';
  return 'paid';
}

/**
 * Whether an AUTOMATED lane may move `current` -> `next`.
 *
 * With milestone projection the monotonic guard is largely IMPLICIT — milestones only
 * accumulate, so a stale re-read cannot walk a record backwards. This remains as the
 * explicit gate for lanes that supply a status directly (the counterparty pass) and for
 * refusing to reopen a terminal record.
 *
 * An operator correction does NOT pass through here: a human may set any valid status,
 * which is exactly why this guard lives at the writer and never in the store API.
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
  OBSERVATIONS,
  OBSERVATION_MILESTONE,
  RECORD_FIELDS,
  STAGES,
  STATUS_RANK,
  TERMINAL_STATUS,
  VALID_STATUS,
  canAutomatedTransition,
  mergeMilestones,
  parseMilestones,
  projectStatus,
  tsToEpoch,
};
