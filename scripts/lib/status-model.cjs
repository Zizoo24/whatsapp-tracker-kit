'use strict';
// status-model.cjs — SEAM 2. The lifecycle model AND its deterministic reducer.
//
// ============================================================================
// THIS IS ONE OF THE FILES YOU ADAPT PER DEPLOYMENT. See docs/PORTING.md.
// ============================================================================
//
// THE CENTRAL BOUNDARY: the model reports OBSERVATIONS. Code derives STATE.
//
// The model never emits a status. It emits evidence-backed observations ("payment
// received here", "final delivered here") and this file maps them to a stage. That single
// move deletes a whole class of failure that prompt engineering could only ever discourage:
//
//   - A customer typing "Done" (meaning "I paid") cannot become the terminal stage,
//     because the only observation it supports is `payment_received`.
//   - A draft cannot complete a record, because `draft_sent` maps to the in-progress
//     stage. It is structurally incapable of meaning "finished".
//
// The model still does the genuinely hard work — WHICH record does this message belong to,
// did the customer actually commit, is this image a receipt or the source document, is this
// a draft or the final. Code must not try to guess those. But "what stage does a confirmed
// payment imply" is mechanically definable, so it belongs here.
//
// TWO RULES THAT SURVIVE ANY DOMAIN:
//
// RULE A — STATUS IS A PURE LIFECYCLE STAGE. Status answers "WHERE is this record". It
//   never answers "WHO is doing the work" — that is a separate COLUMN. Collapsing the two
//   axes meant a counterparty stamp could overwrite a real stage, and a price-quote forward
//   looked identical to a real handoff. See docs/GUARDS.md #10 and #11.
//
// RULE B — TRANSITIONS ARE EXPLICIT, NOT A RANK COMPARISON. Rank alone gets the common
//   case right and the important case wrong: a post-delivery revision is a legitimate
//   BACKWARD move, and a naive `rank(next) < rank(current)` guard silently refuses it.
//   That exact mismatch shipped in v1 — the validator accepted `done -> revision` while the
//   writer discarded it. Use canAutomatedTransition(). See docs/GUARDS.md #22.

// ---- Stages (DOMAIN: rename freely) ---------------------------------------------------
// Ordered lifecycle. Index = rank. Rank is still used for ordering and reporting, but it
// is NEVER the sole authority on whether a move is legal.
const STAGES = [
  'confirmed_unpaid', // committed, money not in       -> chase payment
  'paid',             // money in, work not started    -> assign / start
  'translating',      // work underway (by anyone)     -> finish / deliver
  'revision',         // delivered, changes requested  -> fix
  'done',             // completed successfully        -> terminal
];

// TERMINAL-DEAD states: the record ended without completing. They must be REPRESENTABLE,
// never deleted — "cancelled means delete the row" silently destroyed every record of a
// refunded order.
const DEAD_STAGES = ['cancelled', 'refunded'];

const VALID_STATUS = new Set([...STAGES, ...DEAD_STAGES]);
const STATUS_RANK = Object.fromEntries([...STAGES, ...DEAD_STAGES].map((n, i) => [n, i]));
const TERMINAL_STATUS = new Set(['done', ...DEAD_STAGES]);

// ---- Observations (what the MODEL is allowed to say) ----------------------------------
// Each observation is a claim about evidence, not a claim about state. Rename these with
// your stages, but keep the shape: every observation must name a concrete, checkable event.
//
// `draft_sent` deliberately maps to the in-progress stage, NOT to completion. That is the
// draft-vs-final rule (GUARDS #17) made structural instead of advisory.
const OBSERVATION_STAGE = Object.freeze({
  order_committed: 'confirmed_unpaid',
  payment_received: 'paid',
  work_started: 'translating',
  draft_sent: 'translating',
  final_delivered: 'done',
  revision_requested: 'revision',
  order_cancelled: 'cancelled',
  payment_refunded: 'refunded',
});

const OBSERVATIONS = Object.keys(OBSERVATION_STAGE);

// Observations that may legally move a COMPLETED record. Everything else is forward-only.
// A post-delivery revision, a late cancellation, and a refund are all real; a stale
// re-reading of an old payment is not.
const POST_COMPLETION_OBSERVATIONS = new Set([
  'revision_requested', 'order_cancelled', 'payment_refunded',
]);

// The only transitions out of a terminal status, and only on fresh evidence.
const TERMINAL_TRANSITIONS = {
  done: new Set(['revision', 'cancelled', 'refunded']),
  cancelled: new Set(['refunded']),
  refunded: new Set(),
};

// STRUCTURAL GUARD (GUARDS #11): only records at or beyond this point may be seen by the
// counterparty/handoff pass. We routinely forward a document to a counterparty JUST TO GET
// A PRICE QUOTE before the customer has committed or paid, so a quote-check must never be
// visible as a handoff candidate. Do NOT widen this to include the committed-but-unpaid
// stage.
const HANDOFF_ELIGIBLE = new Set(['paid', 'translating', 'revision']);

// Non-status fields an extraction pass may write. An allowlist, so a hallucinated key can
// never reach the store.
const RECORD_FIELDS = [
  'client_name', 'doc_type', 'language_pair', 'price', 'delivery_time', 'summary',
];

/**
 * Decide whether an AUTOMATED lane may move `current` -> `next`.
 *
 * Replaces the raw rank comparison that produced the v1 validator/writer mismatch.
 * Returns { allowed, reason } so callers can log WHY a move was refused — a silent refusal
 * is indistinguishable from a bug.
 *
 * An operator correction does NOT go through here: a human may set any valid status,
 * which is exactly why this guard must live at the automated writer and never in the
 * store API (the API is also the repair path — GUARDS #13).
 */
function canAutomatedTransition(current, next, observation = null) {
  if (!VALID_STATUS.has(next)) return { allowed: false, reason: 'invalid_target:' + next };
  // Creation: nothing to move from.
  if (current == null || current === '') return { allowed: true, reason: 'creation' };
  if (!VALID_STATUS.has(current)) {
    // A legacy or hand-typed status we cannot reason about. Refuse rather than guess —
    // and surface it, because a human needs to look.
    return { allowed: false, reason: 'unrankable_current:' + current };
  }
  if (current === next) return { allowed: false, reason: 'no_op' };

  if (TERMINAL_STATUS.has(current)) {
    if (!TERMINAL_TRANSITIONS[current].has(next)) {
      return { allowed: false, reason: 'terminal_transition_forbidden:' + current + '->' + next };
    }
    // A terminal record may only be moved by an observation that genuinely implies it.
    if (observation && !POST_COMPLETION_OBSERVATIONS.has(observation)) {
      return { allowed: false, reason: 'observation_cannot_reopen:' + observation };
    }
    return { allowed: true, reason: 'terminal_transition_allowed' };
  }

  // Non-terminal: forward moves are fine; a terminal-dead outcome may arrive at any time.
  if (STATUS_RANK[next] > STATUS_RANK[current]) return { allowed: true, reason: 'forward' };
  if (DEAD_STAGES.includes(next)) return { allowed: true, reason: 'terminal_dead' };

  // THE GUARD THAT MATTERS (GUARDS #13): the extractor re-emits historical records every
  // run, so a stale re-read tries to walk a record backwards. Refuse.
  return { allowed: false, reason: 'downgrade_refused:' + current + '->' + next };
}

/**
 * Derive a status from the current status plus the observations this run produced.
 *
 * Pure: no clock, no I/O. Observations are applied in the order given (callers pass them in
 * evidence order), so a record that is committed, paid and delivered within one delta walks
 * the whole lifecycle in a single pass.
 *
 * Returns { status, applied[], refused[] } — refusals are data, not silence, so the caller
 * can log exactly which evidence was declined and why.
 */
function reduceObservations(currentStatus, observations = []) {
  let status = currentStatus == null || currentStatus === '' ? null : String(currentStatus).trim();
  const applied = [];
  const refused = [];

  for (const raw of observations) {
    const type = typeof raw === 'string' ? raw : String(raw && raw.type || '');
    const target = OBSERVATION_STAGE[type];
    if (!target) {
      refused.push({ observation: type, reason: 'unknown_observation' });
      continue;
    }
    const verdict = canAutomatedTransition(status, target, type);
    if (verdict.allowed) {
      status = target;
      applied.push({ observation: type, status: target });
    } else {
      refused.push({ observation: type, reason: verdict.reason });
    }
  }

  return { status, applied, refused };
}

module.exports = {
  DEAD_STAGES,
  HANDOFF_ELIGIBLE,
  OBSERVATIONS,
  OBSERVATION_STAGE,
  POST_COMPLETION_OBSERVATIONS,
  RECORD_FIELDS,
  STAGES,
  STATUS_RANK,
  TERMINAL_STATUS,
  TERMINAL_TRANSITIONS,
  VALID_STATUS,
  canAutomatedTransition,
  reduceObservations,
};
