# Upgrading an existing tracker to the milestone model

**A new deployment needs none of this.** Start from an empty store and the milestone model is
simply how the tracker works. This page is only for a store that already holds rows written
before milestones existed.

---

## Why a blank milestone cell is not "no history"

From v1.2 the authoritative state of a record is its **milestones**, and `status` is a
projection of them. A row written by an earlier version has a real lifecycle status and an
**empty** milestones cell — its history is real but unrecorded.

Projecting from an empty set silently rewrites that history. Concretely:

```
stored:    status = done,  milestones = (blank)
new msg:   the customer asks for a change
observed:  revision_requested

merge:     {} + revision           ->  { revision: ... }
project:   no `paid` fact present  ->  confirmed_unpaid     ← WRONG
```

A completed, paid, delivered order silently becomes "chase payment". The evidence for `paid`
and `final_delivered` exists in WhatsApp, but not in a form the projection can see.

**So the automated lane refuses to touch such a row.** `tracker-apply` aborts with:

```
ABORT: <record_id> has status "done" but no milestones — this row predates the
milestone model. Run the backfill before the automated lane may write to it.
```

It keeps the cursor and exits non-zero, so nothing is lost and nothing is silently rewritten.
That is deliberate: fail closed, exactly like every other authoritative read (GUARDS #24).

---

## Choosing a backfill strategy

**Do not fabricate timestamps from a status.** A synthesised `paid_at` is indistinguishable
from an observed one afterwards, and every later projection inherits the guess.

### Option A — reconstruct from WhatsApp history (best, and usually feasible)

The conversation is still in the mirror. For each legacy row, read that customer's chat and
identify the messages that actually prove each milestone, then write them with real evidence:

```bash
node scripts/tracker-admin.cjs snapshot --phone 971500000000 --output /tmp/snap.json
```

Proposal:

```json
{ "corrections": [{
  "record_id": "971500000000_2026-06-02#ab12cd34",
  "milestone_ops": { "set": {
    "committed":       { "at": "2026-06-02T09:14:00+04:00", "seq": 40311, "message_id": "3EB0..." },
    "paid":            { "at": "2026-06-02T10:02:00+04:00", "seq": 40329, "message_id": "3EB0..." },
    "final_delivered": { "at": "2026-06-03T16:40:00+04:00", "seq": 40598, "message_id": "3EB0..." }
  } },
  "note": "backfill from chat history; message ids cited"
}] }
```

```bash
node scripts/tracker-admin.cjs apply --snapshot /tmp/snap.json --proposal /tmp/prop.json --dry-run
node scripts/tracker-admin.cjs apply --snapshot /tmp/snap.json --proposal /tmp/prop.json \
  --confirm APPROVED --agent claude
```

The tool re-projects the status from the facts you set and verifies the readback, so a
backfilled row is indistinguishable from one the pipeline built itself.

This is a good task for the agent lane: it is exactly the evidence-reading judgment the model
is for, with deterministic tooling doing the write.

### Option B — an explicit legacy baseline (when history is gone)

If the chat no longer exists — an archived thread, a customer who deleted it — record the
milestone as a **baseline** rather than a pretended observation. Use the date the row itself
carries, and say so in the note:

```json
{ "corrections": [{
  "record_id": "971500000000_2026-06-02#ab12cd34",
  "milestone_ops": { "set": {
    "paid":            { "at": "2026-06-02T00:00:00+04:00", "message_id": "legacy-baseline" },
    "final_delivered": { "at": "2026-06-02T00:00:00+04:00", "message_id": "legacy-baseline" }
  } },
  "note": "LEGACY BASELINE — chat history unavailable; times are the row's source_date, not observed"
}] }
```

`message_id: "legacy-baseline"` makes every synthesised fact greppable forever. Omitting
`seq` is correct here — there was no ingestion event.

### Option C — leave terminal rows alone

A `done`, `cancelled` or `refunded` record that will never receive another message needs no
backfill. The gate only fires when the automated lane actually tries to write to it. Backfill
on demand: if a customer resurfaces, migrate that row then.

For most stores this makes the job far smaller than it first looks — only **open** records
plus any that see new traffic actually need work.

---

## Suggested order

1. **Deploy the schema first.** Run `setupHeaders()` to add the `milestones` column. Existing
   rows keep working until the lane tries to write to them.
2. **Migrate open records** (anything not terminal) using Option A.
3. **Let the gate find the rest.** Run normally; when a legacy row blocks, migrate that one.
4. **Watch for the abort in `watch.log`.** A blocked record keeps the cursor, so a backlog of
   blocks means the lane is not advancing — do not leave it running for days unattended.

---

## Verifying a migrated row

```bash
node scripts/tracker-admin.cjs inspect --record 971500000000_2026-06-02#ab12cd34
```

Confirm the projected `status` matches what you know to be true. If it does not, the
milestones are wrong — fix the **facts**, never the status (GUARDS #32).
