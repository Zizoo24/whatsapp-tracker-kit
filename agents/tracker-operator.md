# Tracker operator — the correction and audit reference

**This is a reference, not a separate agent.** Load it into whichever agent is already
helping the operator when the task is a correction, an audit, a stale-tracker complaint, or
post-outage recovery. There is no need for a permanent second agent: one lead agent plus the
tracker skill covers setup, investigation, catch-up and repair.

Operate as an **evidence-led** reader. You reason about record identity and lifecycle from
the conversation; `scripts/tracker-admin.cjs` performs every write. You are the semantic
authority for corrections, ambiguity, and deep audits — the automated lane is not.

---

## The concurrency rule — read this first

The automated extraction lane and this lane **do not share a lock**. Before any write:

```powershell
Disable-ScheduledTask tracker-watch      # or: systemctl --user stop tracker-watch.timer
# wait for .tracker-lock to disappear
# ... apply ...
Enable-ScheduledTask tracker-watch
```

Two writers on one store is a split-brain that costs a day of reconciliation. Never skip
this because the change "is small".

---

## Order of authority

1. An explicit operator statement about the exact record.
2. **New** messages in the customer chat.
3. New, **uniquely linkable** messages in a registered counterparty chat.
4. Existing store state as prior context.
5. Historical messages as context **only** — never as fresh write evidence.

A lower source never overturns a higher one.

---

## Record identity

A record begins at a **commitment**, not at an inquiry or a quote. A polite acknowledgment
of a quote — "ok", "alright", "thanks", "noted" — is **not** a commitment on its own,
especially while the customer is still gathering documents. That trap shipped a phantom
record in production, and a later audit found eight more in a single run.

Cite the commitment message as `order_anchor_id`; validation mints the immutable id
`PHONE_YYYY-MM-DD#HASH`. **Never hand-edit a minted id.**

Every later commitment is a **new** record — including when the same customer returns in
the same chat, an earlier record is already terminal, both start on the same calendar day,
or the work resembles the earlier record. Use `update` only when the evidence belongs to
the **same real-world record**.

> When in doubt, **no row**. A missed lead costs a follow-up; a phantom record costs the
> operator chasing money nobody committed.

---

## Lifecycle judgment

- Do **not** infer payment from a delivered file, or delivery from a payment receipt.
  An agent-created terminal status requires **both**; an explicit operator correction may
  override missing chat evidence, but must carry a note.
- A **draft is not delivery.** Completion requires the subsequent final artifact. When
  genuinely unclear, prefer the **earlier** stage.
- **Payment proof is usually a customer action, not our words.** After we send a payment
  link, a customer image or a "done"/"paid"/"sent" — with no reported trouble — is payment.
  An image sent **before** the link is the work item, not a receipt. The ordering is the
  entire rule.
- A counterparty may quote a **different (lower)** figure in their chat: that is their
  cost, **not** the customer price. The price field is always customer-facing.

---

## Workflow

1. **Snapshot fresh.** Use a phone filter when the operator names one record or customer;
   otherwise take the whole active lookback.
2. **Check health before reasoning** — bridge healthy, newest mirrored message, store row
   count. If the bridge was just relaunched, wait and snapshot again. Reasoning over a
   stale mirror produces confident wrong answers.
3. **Review each active chat against every existing row for that party.** Identify
   commitment, payment, work, delivery, revision, cancellation, and refund evidence.
4. **Treat each later commitment as a new record**, even in the same chat on the same date.
   Never reuse a terminal id.
5. **Review counterparty chats separately.** A quote request is **not** a handoff. Link
   counterparty evidence only to a uniquely identifiable eligible record.
6. **Write a proposal and validate it.** Do not hand-edit anything validation minted.
7. **Show the exact before/after rows and the supporting evidence.** A request to fix,
   catch up, reconcile, or investigate a stale tracker **counts as approval** for
   high-confidence, evidence-backed additions and lifecycle advances — continue through a
   verified apply without a second approval stop.

   **Ask first only for:** ambiguity, row deletion or voiding, field clearing, a status
   reversal, or a fact not established by evidence.
8. **Apply, then report success only on a verified readback.** If the store call fails
   after local state commits, do **not** claim success — retry from a fresh snapshot.
9. **If confidence is low, or two records could match the same evidence, stop at the
   proposal and ask one focused question.** Do not guess.

---

## Post-outage recovery

An outage does not only *delay* extraction. Any state change during the dead window that
lands at or before the frozen cursor is **permanently missed** — the cursor advanced past
it by definition.

After any multi-hour gap:

1. List every **non-terminal** record.
2. For each, read the chat **after** its last known event.
3. Flag any where we clearly delivered the final artifact after payment.
4. **Watch for false positives in repeat-customer threads** — match the delivery to that
   specific record's date and document, not merely "we sent a file".

Do **not** reset the cursor or fall back to timestamp catch-up. Ingestion order is what
makes old-timestamp messages restored after a sleep visible at all.

---

## Hard rules

- **Never write the store directly.** Go through the tool so every write gets a backup,
  an optimistic concurrency check, and a readback.
- **An empty inferred value never erases a populated cell.** Clear a field only through an
  explicit correction with a note.
- **Never message a customer or counterparty.** This system is tracking-only, and the
  `/api/send` endpoint exists solely for operator self-alerts.
- **Do not turn a stale-tracker request into a diagnosis-only answer** when a validated,
  high-confidence catch-up is available. Apply it and report the verified row.

---

## The tool

`scripts/tracker-admin.cjs`. It contains no classification logic and calls no model — you
decide what is true, it performs the write safely.

```bash
# 1. Snapshot (add --phone DIGITS to scope to one customer)
node scripts/tracker-admin.cjs snapshot --output /tmp/snap.json

# 2. Write a proposal, then see the exact before/after
node scripts/tracker-admin.cjs validate --snapshot /tmp/snap.json --proposal /tmp/prop.json
node scripts/tracker-admin.cjs apply --snapshot /tmp/snap.json --proposal /tmp/prop.json --dry-run

# 3. Apply (only after stopping the automated lane)
node scripts/tracker-admin.cjs apply --snapshot /tmp/snap.json --proposal /tmp/prop.json \
  --confirm APPROVED --agent claude

# Inspect one record before and after
node scripts/tracker-admin.cjs inspect --record RECORD_ID
```

Proposal shape — `note` is mandatory, and a JSON `null` clears a field:

```json
{ "corrections": [
  { "record_id": "971500000000_2026-08-15#ab12cd34",
    "fields": { "status": "done", "counterparty": null },
    "note": "operator delivered this directly; confirmed in chat 2026-08-15" } ] }
```

The tool enforces the four properties that make an agent write safe: a **fresh snapshot**
(>60 min is refused), an **optimistic concurrency check** (any row changed since the snapshot
aborts), a **backup** of every affected row before mutating, and a **field-by-field readback**
after writing. **Report success only when it returns `readback_verified: true`.**

Note that an operator correction may move a record **backwards** — that is allowed here and
forbidden to the automated lane, which is exactly why the transition guard lives at the
writer and not in the store API.
