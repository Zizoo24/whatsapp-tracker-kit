'use strict';
// status-model.cjs — SEAM 2. The lifecycle model lives HERE and nowhere else.
//
// ============================================================================
// THIS IS ONE OF THE THREE FILES YOU ADAPT PER DEPLOYMENT. See docs/PORTING.md.
// ============================================================================
//
// The DOMAIN below is a translation-order business. Replace the stage NAMES with yours.
// Do NOT replace the two structural rules — both were paid for in production:
//
// RULE A — STATUS IS A PURE LIFECYCLE STAGE.
//   Status answers "WHERE is this record in its lifecycle". It NEVER answers
//   "WHO is doing the work" — that is a separate COLUMN. The source system originally
//   had statuses like `with_vendor_a` / `with_vendor_b`; collapsing the two axes meant a
//   counterparty stamp could overwrite a real lifecycle stage, and a mere price-quote
//   forward looked identical to a real handoff. See docs/GUARDS.md #10 and #11.
//
// RULE B — RANK IS MONOTONIC, AND THE GUARD LIVES AT THE WRITER.
//   The extractor re-emits historical records every run. An old, completed record shows
//   only its payment in the messages, so the model re-emits it at an EARLIER stage. With
//   no rank, a repeat customer sending any message walks a finished record backwards.
//   Enforce the rank at the SOLE AUTOMATED WRITER (tracker-apply.cjs), never in the store
//   API: the API is also the CORRECTION path, and fixing a wrongly-set terminal status
//   requires posting a backward move that an API-layer guard would refuse.
//   See docs/GUARDS.md #13.

// Ordered lifecycle stages. Index = rank. Two poles + the middles between them.
const STAGES = [
  'confirmed_unpaid', // committed, money not in         -> chase payment
  'paid',             // money in, work not started      -> assign / start
  'translating',      // work underway (by anyone)       -> finish / deliver
  'revision',         // delivered, changes requested    -> fix
  'done',             // completed successfully          -> nothing (terminal)
];

// TERMINAL-DEAD states. Ends of the road where the record did NOT complete. They must be
// REPRESENTABLE, not deleted — the source system's original "cancelled = delete the row"
// rule silently lost every record of a refunded order.
const DEAD_STAGES = ['cancelled', 'refunded'];

const VALID_STATUS = new Set([...STAGES, ...DEAD_STAGES]);

const STATUS_RANK = Object.fromEntries(
  [...STAGES, ...DEAD_STAGES].map((name, index) => [name, index])
);

// Statuses from which no automated lane may move the record.
const TERMINAL_STATUS = new Set(['done', ...DEAD_STAGES]);

// The ONLY transitions allowed out of a terminal status, and only on fresh evidence.
// A genuine post-delivery correction is real; everything else must be a NEW record.
const TERMINAL_TRANSITIONS = {
  done: new Set(['revision', 'cancelled', 'refunded']),
  cancelled: new Set(['refunded']),
  refunded: new Set(),
};

// STRUCTURAL GUARD (docs/GUARDS.md #11 — the "quote-check" bug).
// Only records at or beyond this point may be seen by the counterparty/handoff pass.
// We routinely forward a document to a counterparty JUST TO GET A PRICE QUOTE before the
// customer has committed or paid. Restricting the handoff pass to advanced stages means a
// quote-check can never be misread as a real handoff. Do not widen this set to include
// your "committed but unpaid" stage.
const HANDOFF_ELIGIBLE = new Set(['paid', 'translating', 'revision']);

// Non-status fields an extraction pass may write. An allowlist, so a hallucinated key
// can never reach the store.
const RECORD_FIELDS = [
  'client_name', 'doc_type', 'language_pair', 'price', 'delivery_time', 'summary',
];

module.exports = {
  DEAD_STAGES,
  HANDOFF_ELIGIBLE,
  RECORD_FIELDS,
  STAGES,
  STATUS_RANK,
  TERMINAL_STATUS,
  TERMINAL_TRANSITIONS,
  VALID_STATUS,
};
