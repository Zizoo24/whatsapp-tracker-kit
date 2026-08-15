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
