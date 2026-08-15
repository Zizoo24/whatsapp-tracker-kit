# The event ledger — the v2 design (documented, not shipped)

The source system was mid-migration from the row-upsert pipeline in this kit to an
**append-only event ledger**. The design is recorded here because it is the right answer to
problems the simple pipeline genuinely has — but the half-finished cutover scripts are
**deliberately not shipped**. Landing a partial cutover in a fresh environment is worse
than not landing it at all.

**Build the simple pipeline first.** Graduate when you actually need replay, provenance, or
durable operator corrections.

---

## What the simple pipeline cannot do

| Limitation | Consequence |
|---|---|
| The row **is** the truth | you cannot reconstruct how a record reached its state |
| A correction is an overwrite | no provenance; the next extraction may undo it |
| One global cursor | one wedged chat holds up every chat |
| The monotonic guard blocks downgrades only | a **false promotion** is permanent (GUARDS #13/#14) |
| No replay | a logic fix cannot be applied retroactively |

---

## The core idea

**`deal_events` is append-only truth. The row table is a deterministic, replayable
projection.** Rebuilding the projection from the event log must produce byte-identical
output — which forces one hard constraint:

> **The fold function must be pure.** No wall clock, no I/O, no randomness. Its only time
> sources are `event.created_at` and `event.evidence_max_ts`.

If the fold read a clock, a rebuild would produce a different projection than the live run
did, and replay would be worthless. In the source system a test enforced purity by
stripping comments and scanning the remaining code for clock access.

---

## Schema sketch

```sql
CREATE TABLE deal_events (
  event_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         TEXT,                 -- NULL only for chat-scoped observations
  subject_phone   TEXT NOT NULL,
  event_type      TEXT NOT NULL CHECK(event_type IN (
                    'deal_created','fields_asserted','payment_received','work_started',
                    'handed_off','delivered','revision_requested','order_cancelled',
                    'payment_refunded','status_asserted','deal_voided',
                    'operator_correction','needs_review','review_resolved',
                    'backfill_snapshot','reconcile_flag')),
  payload_json    TEXT NOT NULL,
  actor           TEXT NOT NULL CHECK(actor IN (
                    'llm_client_pass','llm_vendor_pass','stripe_reconcile',
                    'operator_cli','migration_backfill','nightly_reconciler')),
  confidence      TEXT CHECK(confidence IN ('high','low')),
  evidence_msg_ids TEXT,
  evidence_max_ts TEXT,
  source_chat_jid TEXT,
  tick_id         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  dedup_key       TEXT NOT NULL UNIQUE,
  -- Fail closed: an event with no task_id is only legal for chat-scoped observations.
  CHECK (task_id IS NOT NULL
         OR (event_type IN ('needs_review','review_resolved','reconcile_flag')
             AND source_chat_jid IS NOT NULL))
);

-- Per-chat cursors: one wedged chat can no longer hold up the others.
CREATE TABLE chat_cursors (
  chat_jid TEXT PRIMARY KEY, phone TEXT,
  last_rowid INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  quarantined_until TEXT, last_error TEXT, updated_at TEXT
);
```

---

## The fold rules

Every rule below maps to an incident in [GUARDS.md](GUARDS.md).

**R0 — status is a function of `event_type`, never of a model payload.**
`payment_received` → paid; `delivered` → done. An LLM actor including a `status` key at all
is a hard rejection. This is the strongest version of "the model reports observations, the
system decides state" — it makes GUARDS #14 (a customer's "Done" read as the terminal
stage) structurally impossible rather than prompt-discouraged.

**R1 — monotonic status for LLM actors.** No backward move, with one exemption: a
post-delivery revision is real and carries its own distinct evidence. An unrankable legacy
status is not guessed at — it flags for a human.

**R2 — handoff eligibility.** `handed_off` is refused unless the record is already in an
eligible stage (GUARDS #11).

**R3 — a terminal customer status beats a counterparty stamp** (GUARDS #10).

**R4 — operator corrections are sticky but not eternal.** An operator-set field is
protected from LLM overwrite, *but* newer evidence (`evidence_max_ts` **after** the
correction time) may still advance it. Otherwise a single correction freezes a record
forever.

**R5 — client-pass scoping.** A client-pass event whose subject phone ≠ the record's phone
is refused. Deliberately **not** applied to counterparty-pass events: those legitimately
arrive from a *different* chat and target a customer's record — applying R5 there would
silently kill the entire handoff lane.

Plus: **low confidence flags for review and mutates nothing else**, and voiding requires a
non-LLM actor.

### Timestamp normalisation is load-bearing

Three formats coexist: `'2026-07-08 09:21:01+04:00'` (bridge, local offset),
`'2026-07-08 05:21:01'` (SQLite `datetime('now')`, UTC, no offset), and ISO
`'2026-07-05T20:00:00.000Z'`. Compared **as strings**, the first is "greater" than the
second even though they are the *same instant* — which would let a stale LLM event beat a
newer operator correction under R4. Normalise to epoch before every comparison, using
`Date.parse` only (it reads no clock, preserving fold purity).

---

## Dedup: content- vs occurrence-addressed

This distinction is **not cosmetic** — getting it wrong silently swallows the correction path.

**Content-addressed** (`llm_*`, `stripe_reconcile`, `migration_backfill`):
`sha1(scope | event_type | canonicalJson(payload) | sorted evidence ids)`. Re-extracting the
same evidence must be an idempotent no-op — a history sync re-stores messages with fresh
rowids, and reconciliation boundaries are inclusive.

**Occurrence-addressed** (`operator_cli`, `nightly_reconciler`):
`sha1(actor | tick_id | seq)`. A second correction **must land**. Content-addressing it
would make the insert silently swallow the blessed correction: the operator fixes a row,
nothing happens, and no error is raised.

**Canonical JSON is required** for content-addressing: two programs (the live appender and
the replayer) must produce byte-identical keys from the same logical payload, and
`JSON.stringify` key order follows insertion order. Sort keys, drop null/undefined, reject
`Date`/`BigInt`/non-finite numbers rather than coercing them.

> **Never use `INSERT OR IGNORE`.** It silently skips rows violating **any** constraint —
> UNIQUE, NOT NULL, *and CHECK* — which would defeat the fail-closed CHECK above and
> re-create the exact silent-drop class the ledger exists to eliminate. Use
> `ON CONFLICT(dedup_key) DO NOTHING`, which narrows suppression to the dedup key alone: a
> re-derived identical event is a no-op, while a malformed one still throws.

---

## Projection to the store

Double-gated (an explicit mode flag **and** a push flag), capability-probed before any
write, writes authoritative blanks via `clear_fields`, deletes voided records, **reads back
every field**, and only then clears `sheet_dirty`. A store failure leaves local truth dirty
and retryable.

Note the measured reason `clear_fields` beat `replaceEmpty`: 40 of 60 records had no
`client_name` in the ledger while the store held the real name. Blanket blanking would have
erased data the ledger simply never learned.

---

## Migrating safely

The sequencing lesson is the most transferable part: the first attempt started burn-in
**before** the projector, the correction path, live instrumentation, and rollback existed.

1. **Shadow mode first** — hard-refuse store writes; compute what the ledger *would* say.
2. **Track diffs as durable state** with first-seen / last-seen / resolution, not as a log.
   A mismatch must not age out.
3. **Adjudicate explicitly.** Only "ledger is right" is non-blocking; "store is right",
   "tie", and unadjudicated all block cutover.
4. **A writer interlock** so the two writers can never both own the store.
5. **Dry-run-first cutover and rollback scripts**, with verified backups.
6. **Then** burn in: several consecutive zero-blocker runs *after* the final code change.

Also amend the parity contract honestly: independently generated summary **prose** should
not block a migration, while identity, commercial fields, status, and counterparty stay
strict. Write the amendment down — a silent weakening is how parity theatre starts.
