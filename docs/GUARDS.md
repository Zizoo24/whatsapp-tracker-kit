# The guards — every one is a production incident

Read this before changing anything. These are not defensive-programming habits; each one
is a specific failure that reached real data. **Port the guards, not just the happy path.**

The numbering follows the original incident log, so it is stable to cite in code comments.

---

## #1 — A dead bridge looks exactly like a quiet day (52h silent outage)

The ingress process died. Downstream, "zero new messages" is indistinguishable from
"nobody wrote today". Nothing alerted for 52 hours.

**Guard:** supervise the **process**, never infer liveness from the data.
`bridge-supervisor.cjs` probes the process and relaunches from the cached session.

---

## #2 — The connected-but-stale zombie

Worse than dead: the process alive, its REST port answering, the socket silently dead, the
database frozen. Every naive "is it running?" check passed.

**Guard:** an **explicit health signal** (`/api/health` → `connected && logged_in`), never
message age. But note the inverse trap, which is why the rule is stated so strictly: a
genuinely quiet account with an age-based trigger gets its session churned all day. So
message age is carried **only** as an alerting metric and is **never** a restart trigger.

---

## #3 — App-based schedulers stall silently

A desktop-app "routine" only fires while the app is open, and it stalls on an unattended
permission prompt.

**Guard:** anything real-time or reactive runs on the **OS scheduler + a headless CLI**,
never an in-app automation rail. Report-only jobs may live in an app; writers may not.

---

## #4 — A spreadsheet dropdown hard-rejected every write

A data-validation dropdown on the status column held a stale value list and **hard-rejected**
the pipeline's writes. Every apply failed and the store silently froze — including after
the original outage was fixed, so the fix looked like it hadn't worked.

**Guard:** `makeAllValidationsWarnOnly()` sweeps **every** column and rebuilds each rule
with `allowInvalid: true`. No store-side UI rule can ever hard-block an automated write
again. Re-run it after anyone edits validation by hand.

---

## #5 — A free-text field became `46186`

`delivery_time` holds free text ("within 24 hours", "Monday 9am"). A value that *looked*
like a date got auto-converted into a bare serial number on write — meaningless to a human.

**Guard:** `fixFreeTextFormat()` forces those columns to Plain Text, so no future write can
be silently mangled regardless of the string.

---

## #6 — A counterparty chat was parsed as a customer order

A new subcontractor was not in the registry, so their coordination chat was extracted as a
customer order — inventing a "customer" from a name **we** had typed to them.

**Guard:** the counterparty registry (`counterparty.cjs`). Registering the number is the
whole fix. Also register **group** chats: the active-chat scan excludes `@g.us`, so an
unregistered group counterparty is fully invisible, and its work gets credited to whoever
*is* registered.

---

## #7 — A store-wide mutation flipped 21 history rows

A migration filter missing the row-scope guard hit frozen historical rows.

**Guard:** **every** store-wide mutation carries a row-scope guard (here: phone non-empty
AND not a registered counterparty). This applies to conditional formatting too — see the
`$E2<>""` term in `applyStatusFormatting()`.

---

## #8 — A console window flashed every 3 minutes

The task ran the `.bat` directly under an Interactive principal.

**Guard:** route through `silent-run.vbs` (hidden window, waits, propagates the real exit
code). This was reverted once while chasing orphaned processes and the window came
straight back. **Never put either task on a bare `cmd.exe`.**

---

## #9 — The reconciliation boundary re-fetch

`created[gte]` is inclusive, so the newest charge is re-fetched every run.

**Not a bug** — idempotent via upsert-by-id, and deliberately chosen: `gt` would skip a
charge created in the same second as the watermark. Documented so nobody "fixes" it.

---

## #10 — The counterparty pass overwrote a completed record

In a single run, the counterparty pass stamped an in-progress status onto a record the
customer pass had already marked complete. Three finished records got stuck showing as
needing attention.

**Guard:** `mergeCounterpartyUpdate()` — a terminal status from the pass that **owns**
completion always beats a side-channel stamp. Cross-pass precedence must be explicit.

---

## #11 — A quote-check misread as a handoff, on an uncommitted record

Two bugs at once: (a) the extractor turned a bare price quote — the customer had replied
"Alright" while still gathering documents — into a committed order; (b) the counterparty
pass then stamped it as handed over, because we had forwarded her documents to a
subcontractor **to get a price**.

**Guards, three layers:**
1. **Status is a stage, not an owner.** `with_<vendor>` was removed as a status entirely;
   the counterparty became a column.
2. **Structural eligibility** — `HANDOFF_ELIGIBLE` in code, applied in `tracker-prep.cjs`,
   so the counterparty pass never even *sees* an uncommitted record. A quote-check
   therefore cannot look like a handoff no matter what the model concludes.
3. **A stricter commitment definition** in the prompt (see #16).

The lesson: when the model keeps making a mistake, **remove the input that makes the
mistake possible** rather than adding another prompt sentence.

---

## #12 — Headless auth expired → the whole lane died silently

The headless model call used a normal subscription OAuth token, which expires roughly
daily and **a headless subprocess cannot refresh**. Every call returned 401, extraction
aborted, the cursor froze, and the store silently stopped updating — while the bridge, the
scheduler, and the machine all looked perfectly healthy.

**Symptom to recognise:** the cursor sits hours behind the newest mirrored message while
the bridge itself is fine.

**Guards:**
- Use a **long-lived token** (`claude setup-token`) in `agent-token.env`.
- `agent-provider.cjs` detects `authFailed` distinctly from other failures, so the alert
  says "log in again" rather than "the model returned junk".
- **Gotcha that cost an hour:** a stray **leading space** in the token file still 401s.
  Check with `head -c 11 agent-token.env` before blaming anything else.

### The outage blind spot (the reason for the cursor rule)

An outage doesn't only *delay* extraction. Any state change that happens **during** the
dead window and lands at or before the frozen cursor is **permanently missed** — once the
lane recovers and the cursor advances past those messages, they are never re-read.

Real case: an order was delivered to the customer *inside* the 401 window, right at the
frozen cursor. It sat at the wrong status until a human noticed.

**Recovery action after any multi-hour outage:** scan non-terminal records for a missed
completion. Do not trust the cursor to have caught up — it advanced past the gap by
definition. Watch for false positives in repeat-customer threads: match the delivery to
that specific record's date and document, not just "we sent a file".

---

## #13 — A completed record silently reverted when the customer ordered again

The extractor re-emits **every** historical record on each run. An old, delivered order
shows only its payment in the messages, so the model re-emits it at the earlier stage. The
store's upsert had no downgrade guard, so the moment a repeat customer sent *any* message,
the whole thread was re-extracted and a finished record walked backwards.

**Guard:** the **monotonic lifecycle guard** in `tracker-apply.cjs`. Before the upsert, read
current statuses; for any row whose incoming status ranks **below** the current one, delete
the `status` key so the non-empty merge leaves the advanced stage intact while every other
field still refreshes.

### Placement is the whole lesson

The same guard was briefly added to the store API as "defense in depth". **That was wrong
and was removed.** The API is *also* the correction path: fixing a wrongly-set terminal
status requires posting a backward move, which an API-layer guard would refuse — blocking
exactly the write the operator needs.

> Guard the sole automated writer (the thing that re-emits stale reads).
> Keep the API a dumb, honest upsert.

Note the guard blocks **downgrades only**, so a false *promotion* is permanent and must be
fixed by an explicit correction — which is why #14 matters so much.

---

## #14 — A brand-new record marked complete on arrival

A new order was created straight into the terminal status. Ground truth: quoted 20:53,
paid 21:26, nothing ever delivered. Two failures, both from one long repeat-customer thread
holding six orders:

- the customer typed **"Done"** at 21:26 meaning *"I completed the payment"* — read as the
  terminal stage;
- we had delivered three files earlier that day belonging to the **previous** order, and
  the model attributed them to the new one because they shared a calendar day.

**Guards** (all in `prompts/customer-rules.txt`, all marked STRUCTURAL):
- an **EVIDENCE BINDING** block: each record owns only the messages from its own quote to
  the next record's quote; a file delivered *before* a later record was quoted belongs to
  the **earlier** one; **same calendar day proves nothing**;
- completion requires **us** sending the final artifact for **that** record, **after**
  **that** record's payment;
- the explicit trap: **a customer typing "Done" means THEY paid — never the record stage.**

Combined with #13 this is nasty: the monotonic guard makes a *false* completion permanent.

---

## #15 — A prompt edit crashed the watcher for three silent ticks

The prompts lived in JS template literals. A live edit inserted a backtick → SyntaxError →
the whole lane died silently.

**Guards:**
- **Prompts are data, not code** — `prompts/*.txt` behind a fail-closed `loadPrompt()`. A
  garbled prompt yields bad extractions (caught by validation); it can never crash the lane.
- A missing or empty prompt **halts the tick before any state is touched** and alerts.
- `node --check` preflight in the runner, alerting once per breakage streak.

---

## #16 — Eight phantom records in one run

A looser commitment definition let quote-shaped conversations become committed records: a
quote with no reply after it, a "yes" answering a *different* question, and a declined
negotiation all produced rows.

**Guard:** the commitment definition now requires a customer message sent **after** the
concrete quote that instructs proceeding, plus an explicit **no-row list**.

> When in doubt, **no row**. A missed lead costs a follow-up; a phantom record costs the
> operator chasing money nobody ever committed.

---

## #17 — A draft counted as delivery

The workflow sends a file **twice**: a draft to review, then the final certified file. The
model read the draft as completion, so unfinished work stopped being chased.

**Guard:** the DRAFT vs FINAL block, and the tie-break — **when unclear, prefer the earlier
stage.** Most businesses have some two-send shape; find yours and encode it.

---

## #18 — 66 hours of zero ingestion (the transport/semantics split)

The bridge self-heal lived **inside** the extraction watcher. Retiring the watcher silently
removed the only thing keeping the socket open. The bridge died, the machine rebooted, and
nothing brought it back. Messages were not merely unprocessed — **they never reached the
machine.** Recovery only worked because the provider's offline queue happened to still hold
them, which is finite and undocumented.

**Guard:** transport is its **own lane** (`bridge-keepalive.cjs`) on its own schedule, with
a hard boundary: no prep, no model, no store write, no cursor. Plus a **logon/boot trigger**
— repetition alone never covers a boot.

---

## #19 — The restart budget was a fiction

The budget lived in one lane's private state file while another lane called the same
supervisor every 3 minutes. A crash-looping bridge was relaunched forever while the log
claimed "pausing restarts".

**Guard:** the budget lives in a **shared marker** inside the supervisor, so every caller is
bound. Plus a separate escalation clock for *alive-but-unhealthy*, because the restart
cooldown means that path can never trip the 3-in-30 budget on its own.

---

## #20 — One heartbeat slot, two posters

Both lanes wrote the same Script Property, last-writer-wins. The keepalive's crash-loop
alarm was overwritten by the watcher's empty error within minutes; the 15-minute watchdog
sampled the alarm only by luck.

**Guard:** **per-poster** heartbeat properties; the watchdog reads them all. Freshness comes
from the newest beat of any poster (a machine-level fact); the error signal is the **worst**
any poster reported, so a healthy lane can never mask a broken one.

---

## #21 — Two normalizers drifted apart

The writer and the auditor each grew their own date normalizer and disagreed by one day in
the evening timezone window. The auditor reported a mismatch on every affected record — 8
of its first 10 findings — and adjudicating them would have made "zero findings"
permanently unreachable.

**Guard:** **one** `sheet-normalize.cjs`, used by everything that compares store values.

---

---

## #22 — The validator and the writer disagreed about a legal transition

**Found by external audit of v1 of this kit.** The lifecycle contract explicitly allowed
`done → revision` (a real post-delivery correction), and validation accepted it. But the
writer compared ranks — `revision` is 3, `done` is 4 — classified it as a downgrade, and
**silently deleted the status**. So a legitimate revision was accepted by one layer and
discarded by the next.

Both layers were individually "correct". The **contract between them** was broken, and every
unit test passed because none crossed the boundary.

**Guards:**
- `canAutomatedTransition(current, next, observation)` replaces the raw rank comparison. Rank
  still orders the stages; it is no longer the sole authority on legality.
- `test/integration-lifecycle.test.cjs` runs real validated output through the writer's real
  derivation. **A passing unit suite is not evidence that two layers agree.**

---

## #23 — Context truncation silently defeated the rowid cursor

**Found by external audit of v1.** Prep emitted one `conversation` array sorted by
`(timestamp, rowid)`; the watcher kept only the newest N entries. But a message can be newly
**ingested** with an **old send timestamp** — that is the entire reason the cursor is a rowid
(see #12). Such a message sorts toward the front, gets truncated away, and the run then
advances the cursor **past its rowid**.

That is a direct violation of the cardinal rule — *never advance a cursor over a message you
did not show the model* — reintroduced by a performance cap, in the very system built to
prevent it.

**Guards:**
- Prep emits **`new_messages`** (every message in the rowid delta, never truncated) and
  **`context`** (older messages, capped). Only context may be trimmed, because context can
  never justify a write.
- If a chat's delta exceeds the budget, prep **lowers the ingestion boundary** for the pass
  and records the processed ceiling in the manifest. The cursor advances only to what was
  actually processed; the remainder arrives next tick.
- The watcher **aborts** rather than truncating an oversized delta.

---

## #24 — Authoritative reads failed open

**Found by external audit of v1.** Three reads logged their failure and continued:

| Read | Consequence of continuing |
|---|---|
| the `@lid` map | chats keyed by `@lid` resolve to no phone, vanish from the manifest — and the global cursor advances past them anyway |
| existing store rows | every established record looks brand new, so the model re-creates records that already exist |
| the writer's current-status pre-read | v1 said *"proceeding without it"* and wrote blind, disabling the one guard protecting completed records |

Each turns a **transient** error into **permanent** corruption. The third is the sharpest:
the guard was disabled exactly when the information needed to enforce it was missing.

**Guard:** all three now **fail closed** — abort, keep the cursor, retry next tick. Fail-open
is only ever acceptable for genuinely optional signals (alerts, heartbeats), never for
anything the correctness of a write depends on.

---

---

## #25 — A memoryless status reducer forgot that work was already delivered

**Found by external audit of v1.1 — a regression introduced by v1.1's own fix.** Moving the
model to observations was right; deriving status from the *newest observation* was not.

Two real scenarios broke:

1. **Delivered before payment.** Customer commits, we deliver early, they have not paid. The
   reducer saw `final_delivered`, took the forward-ranked move, and reported **done** — so
   the operator stopped chasing money they had never received. The original model was
   explicit that **unpaid is unpaid even if delivered early**; the rewrite silently dropped
   that rule.
2. **Day-2 amnesia.** Day 1: committed and delivered, unpaid → `confirmed_unpaid`. Day 2:
   payment lands. By then the delivery is *old context* and cannot be cited as fresh evidence
   (correctly — see #12), so the reducer saw only `payment_received` and landed on **paid**,
   forgetting the job was finished.

The root cause is that a status is a **fold over history**, while the reducer only had the
present.

**Guard:** observations now write **durable milestones** — `committed_at`, `paid_at`,
`work_started_at`, `draft_sent_at`, `final_delivered_at`, `revision_requested_at`,
`cancelled_at`, `refunded_at` — stored in one JSON column. Status becomes a **pure
projection** of those facts, with the commercial rules in one ordered function:

```
refunded_at                        -> refunded
cancelled_at                       -> cancelled
NOT paid_at                        -> confirmed_unpaid   <- the rule that was lost
revision_at after latest delivery  -> revision
final_delivered_at                 -> done
work_started_at or draft_sent_at   -> translating
otherwise                          -> paid
```

This is the event-ledger insight without the ledger. It also makes the monotonic guard
**implicit**: milestones only accumulate, so a stale re-read cannot walk a record backwards.

**Meta-lesson:** when a rewrite deletes a failure class, check what *invariants* the old code
was also carrying. Here the removed `STATUS_RANK` comparison had been quietly enforcing "you
cannot be done before you are paid."

---

## #26 — Minute-truncated timestamps could not order same-minute evidence

**Found by external audit of v1.1.** Prep truncated message timestamps to the minute while
validation ordered observations by that timestamp. A payment confirmation and a file send
routinely land in the same minute, and their order decides paid-versus-delivered.

**Guard:** prep carries the **full timestamp plus the mirror's rowid as `seq`**, and
validation sorts on `seq` — exact ingestion order — falling back to the timestamp only for
hand-built fixtures.

---

## #27 — The correction tool advised a lock instead of taking it

**Found by external audit of v1.1.** `tracker-admin` told the operator to stop the scheduled
writer and wait for `.tracker-lock` to clear, but never acquired that lock itself. A tick
firing mid-apply would produce exactly the split-brain the instruction warned about.

Its readback-failure message also claimed rows were *"restored from"* the backup. **Nothing
was restored** — a backup had merely been taken beforehand. A false rollback claim is worse
than no rollback: it stops the operator investigating a store now in an unknown state.

**Guards:** `apply` acquires the **same** `.tracker-lock` (so the watcher skips its tick
automatically — safety enforced, not advised), and the failure message now states plainly
that no automatic rollback was performed and points at the backup.

---

---

## #28 — Storage threw away the ordering validation had just established

**Found by external audit of v1.2.0.** Validation ordered observations by the mirror's
ingestion `seq` — correctly, because two messages routinely share a timestamp. But milestones
were stored as **bare timestamps**, so `seq` was discarded at the moment of persistence.

The projection then compared `revision > delivered` on timestamps alone. A revision requested
in the **same second** as the delivery compared equal, the clause was false, and the record
projected as **done** — the customer's correction request silently vanished.

**Guard:** a milestone is an **occurrence** `{ at, seq, message_id }`, and `compareOccurrence`
orders by timestamp then `seq`. Provenance comes along for free: every stored fact names the
message that proved it.

**Meta-lesson:** an invariant established upstream must be *representable* downstream.
Precision that storage cannot express is precision you do not have.

---

## #29 — Malformed authoritative state degraded to "no history"

**Found by external audit of v1.2.0.** `parseMilestones` caught a JSON error and returned
`{}`. Since milestones are *declared machine truth*, a corrupted cell therefore read as "this
record has no history" — and the next write would confidently rebuild it from nothing,
destroying the real state.

This is the same fail-open class already removed from the LID and store reads (#24),
reintroduced on the field that had just been made authoritative.

**Guard:** `MilestoneStateError`. Blank is a legitimately new record; **non-blank but
unreadable is a hard stop** — abort the write, keep the cursor, alert. Repair is possible only
through an explicit `milestone_ops.replace`, so nobody accidentally builds on unreadable state.

---

## #30 — Two lanes wrote two rows for one record in one tick

**Found by external audit of v1.2.0.** The customer pass and the counterparty pass could each
produce an update for the **same `record_id`** in a single tick. Both were merged against the
same pre-run snapshot and written as **two separate rows**. The store merges by key and takes
the later non-empty cell, so the second `milestones` value **overwrote** the first — one
lane's facts destroyed by the other.

The unit tests verified that the counterparty update was appended, and never ran the appended
result through the writer. The bug lived precisely in the gap between them.

**Guard:** **exactly one outgoing write per `record_id` per tick.** `tracker-apply` aggregates
every lane's contribution by id, unions the observations, orders once, merges once, projects
once. Plus an integration test spanning customer → counterparty → aggregation → writer.

---

## #31 — A pre-milestone row would have been silently rewritten

**Found by external audit of v1.2.0.** Rows written before milestones existed carry a real
status and an empty milestones cell. Projecting from empty rewrites their history: a completed
order whose customer requests a revision projects to `confirmed_unpaid`, because no `paid`
fact exists to find.

**Guard:** a **migration gate**. A row with a non-empty status and blank milestones blocks the
automated lane, which keeps the cursor and reports the record. Blank never means "there was no
history". Backfill procedure: [MIGRATION.md](MIGRATION.md).

---

## #32 — The correction tool edited the projection instead of the truth

**Found by external audit of v1.2.0.** Once milestones became authoritative, `tracker-admin`
was still correcting `status` — and did not carry `milestones` in its snapshot, concurrency
check, backup or readback.

Two failures follow. A status correction **looks** successful and then vanishes: the next
observation re-projects from unchanged milestones. And a **false milestone cannot be removed
at all** — if a wrong `paid` fact caused the bad status, no correction could reach it.

**Guard:** operators correct **facts**. `milestone_ops` (`set` / `clear` / `replace`) is the
correction path; setting `status` directly is refused with an explanation. `milestones` is now
covered by the snapshot, the optimistic concurrency check, the backup and the readback.

**Meta-lesson:** declaring a representation authoritative is a claim every write path must
honour. A correction path that edits a derived view is a correction that does not exist.

---

---

## #33 — Mixed-precision ordering was guessed instead of refused

A v1.2.0 milestone carries no `seq`. Compared against a fresh occurrence at the **exact same
timestamp**, the order is genuinely unknowable — and it decides whether a customer's
correction request is honoured or discarded.

Worse than guessing: `Number(null)` is `0` and `Number.isFinite(0)` is `true`, so the naive
read sorted an unknown-order legacy fact as the **earliest possible event**.

**Guard:** `seqOf` treats absence as `null`, and `orderingIsAmbiguous` detects the tie.
`projectStatus` **throws** rather than pick, naming the milestone to migrate.

---

## #34 — A dormant status-authority bypass survived the milestone cutover

`tracker-apply` still collected a lane-supplied `status` into `directStatus` and could write
it without touching a milestone, guarded by `canAutomatedTransition`/`STATUS_RANK`. No
producer fed it — the validator rejects a model-emitted status, and the counterparty lane
emits `work_started` — so it was an unused route **around** the thing just declared
authoritative.

**Guard:** deleted. Exactly one lifecycle write route:
`observations / operator fact-corrections → milestones → projectStatus`. Leaving a legacy
bypass "just in case" contradicts the authority model and invites a future caller.

---

## #35 — Obsolete cross-pass suppression discarded true facts

`result-merge` still refused the whole counterparty contribution when the customer pass
emitted a "terminal" observation. That belonged to the direct-status era (#10). Two things
made it wrong: `final_delivered` is no longer terminal by itself (delivery while unpaid keeps
the record in chase-payment), and the single-write aggregator plus projection already resolve
ordering safely.

So an ordinary early-delivery job silently lost "Vendor A did this work" — a true historical
fact, worth keeping even on a cancelled order.

**Guard:** the suppression is deleted. The lifecycle decision happens in exactly one place.

---

## #36 — A derived column drifted from the fact it derives from

`Records.paid_at` was populated from `milestones.paid` but never **cleared** when that fact
went away. Clearing a false payment left a row reading `confirmed_unpaid` **and** `paid at X`
— and prep feeds `paid_at` back to the model as authoritative context.

**Guard:** `paid_at` is explicitly a projection. Every write sets it *or* clears it alongside
the milestone. A derived value must be written by the same code path that owns its source.

---

## #37 — Reviews carried a lighter evidence burden than writes

The counterparty prompt required `evidence_msg_ids` for both updates and reviews, but only
updates were checked. A review citing an old or hallucinated id could raise a false
cancellation alarm about a live order.

**Guard:** reviews resolve their cited ids against the same new-message set. Unresolvable →
logged and dropped, no alert. An alert is an effect; effects need evidence.

---

## #38 — The correction path trusted assertions the automated path verifies

`milestone_ops.set` accepted `{at, seq, message_id}` as three independent claims. The
automated lane never works that way: the model cites a message **id** and deterministic code
resolves the timestamp and ingestion position from the mirror.

**Guard:** corrections cite `evidence_msg_id`; the tool looks it up, verifies it belongs to
that record's conversation, and takes the real values. A fact with no message evidence must
declare `source: "operator_baseline"` and is labelled as such forever.

**Meta-lesson:** the effect boundary should independently verify whatever it *can* verify,
rather than trusting the caller — including when the caller is an agent you wrote.

---

## #39 — Config read before config was loaded

`tracker-prep` read its budgets at module scope, before `loadConfig()` had loaded `.env`. The
scheduled lane worked because the watcher loads `.env` in the parent and prep inherits it;
running `npm run prep` by hand silently used the defaults.

"Works scheduled, differs manually" makes a bug impossible to reproduce by hand — the worst
property an operational tool can have.

**Guard:** budgets come from `loadConfig()` inside `main()`, and prep now enforces the
required relationship (`TRACKER_MAX_MSGS >= TRACKER_MAX_NEW_MSGS`) at startup.

---

## The meta-lessons

1. **Never advance a cursor over a message you did not show the model.** Every
   silent-data-loss bug has this shape.
2. **The pipeline running ≠ the pipeline working.** Alert on outcomes, not on execution.
3. **When the model keeps making a mistake, remove the input that makes it possible.**
   A structural filter beats another prompt sentence.
4. **Guard at the writer, not at the API** — the API is also the repair path.
5. **A silent drop is the worst outcome.** Prefer a loud deferral over a quiet skip: fail
   closed, keep the cursor, retry.
6. **Test alert channels.** An alarm whose send permission has never been exercised is
   decoration.
7. **Test the contract BETWEEN layers, not just each layer.** #22 hid behind a fully green
   unit suite because no test crossed the seam.
8. **Fail open only for optional signals.** Alerts and heartbeats may degrade. Anything a
   write's correctness depends on must fail closed (#24).
9. **A performance cap can silently break a correctness invariant.** #23 was a truncation
   added for cost that quietly re-opened the data-loss class the cursor exists to close.
   When adding a limit, ask what it is allowed to drop.
10. **Let code decide what code can decide.** Moving status derivation out of the model
    (observations → milestones → projection) deleted a whole class of prompt-only
    safeguards. Ask the model only what genuinely requires reading comprehension.
11. **State is a fold over history, not a function of the latest event.** #25 is what
    happens when a lifecycle is derived from the newest observation instead of the durable
    facts. If a rule depends on something that happened last week, the system must still
    know it happened.
12. **A rewrite inherits invariants it never names.** #25's removed rank comparison had been
    quietly enforcing "you cannot be done before you are paid." Before deleting a guard,
    list everything it was accidentally protecting.
13. **Never claim a recovery action you did not perform.** #27's "rows restored" message
    would have sent an operator away from a store in an unknown state.
14. **Whatever you declare authoritative, every path must respect.** #29, #30 and #32 are one
    failure wearing three hats: malformed truth degrading to empty, two writers producing
    competing truth, and a correction path editing a projection instead of the truth.
15. **Precision must survive storage.** #28 — ordering established in validation and thrown
    away at persistence is ordering you never had.
16. **Test the gap between components, not just the components.** #30 lived exactly where two
    green unit tests met.
