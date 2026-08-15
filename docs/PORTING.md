# Porting guide — adapting the kit

Split the kit into **core invariants** (do not change; they are the correctness of the
system) and **business modules** (change, or delete entirely).

> v1.0 of this guide claimed "only three seams; everything else ports unchanged." That was
> overconfident — `counterparty.cjs` is itself a deployment seam, and payments, groups and
> attribution are all business-specific. The honest split is below.

## Porting to ANOTHER TRANSLATION BUSINESS

If the target business is also document/translation services, **most of the "domain" layer
is an asset, not scaffolding to replace.** The prompts encode hard-won behaviour that is
industry-wide, not company-specific: quotes and per-document jobs, language pairs, payment
screenshots where the processor has no read API, the draft-versus-certified-final
distinction, repeat orders in one long thread, and forwarding a document to a translator for
a *price quote* versus a real handoff.

Expect the deployment-specific surface to be small:

```
.env                  new WhatsApp number/session, store endpoint + secret,
                      alert destination, timezone, model credentials
counterparty config   their translators/vendors, and any vendor GROUP chats
attribution map       their URLs -> short CTA refs
payment module        their processor (or delete it)
translation rules     ONLY where their workflow genuinely differs
```

Compare their operating process against `prompts/customer-rules.txt` **line by line** and
change only real differences. Two blocks that do need checking: the UAE-specific
**LANGUAGE DIRECTION** rules (delete or rewrite if they are not doing UAE certified work),
and the **draft → stamped final** workflow, which not every provider follows.

For a different industry entirely, treat the prompts as a worked example and rewrite them
against `prompts/TEMPLATE-NOTES.md`.

---

## Core invariants — port unchanged

Change these only with a specific reason and a test.

| File | Invariant |
|---|---|
| `scripts/lib/message-cursor.cjs` | ingestion-order cursor, frozen per pass. **Never revert to timestamps.** |
| `scripts/lib/run-lock.cjs` | atomic acquire, owner-checked release, stale reaping |
| `scripts/lib/client-result.cjs` | fail-closed validation, evidence binding, stable id minting |
| `scripts/tracker-prep.cjs` | `new_messages` never truncated; boundary chunking; fail-closed reads |
| `scripts/tracker-apply.cjs` | guarded derivation at the sole automated writer |
| `scripts/bridge-keepalive.cjs` | transport only — never a writer |
| `src/sheet.js` | upsert by key, non-empty merge, no guard in the store layer |

---

## Business modules — adapt or delete

### 1. The extraction contract — `prompts/*.txt`

What the model looks for. **Read `prompts/TEMPLATE-NOTES.md`**: it marks every paragraph
STRUCTURAL (encodes a production incident) or DOMAIN (rewrite).

The model emits **observations**, never a status. Keep that boundary — it is what makes the
"customer said Done" and "a draft is not delivery" failures structurally impossible instead
of prompt-discouraged.

### 2. The lifecycle model — `scripts/lib/status-model.cjs`

Rename stages and observations. Keep three things:

- **Status is a stage, not an owner.** Who does the work is a column.
- **Status is projected from milestones** by `projectStatus`, never set by a lane — there is
  exactly one lifecycle write route (GUARDS #34).
- **`HANDOFF_ELIGIBLE` excludes your committed-but-not-started stage**, or a quote-check
  reads as a handoff (GUARDS #11).

Worked example — a support-ticket tracker:

```js
const STAGES = ['reported', 'triaged', 'in_progress', 'awaiting_customer', 'resolved'];
const DEAD_STAGES = ['duplicate', 'wont_fix'];
// Each observation writes ONE durable milestone occurrence {at, seq, message_id}.
const OBSERVATION_MILESTONE = {
  ticket_raised:    'raised',
  triaged:          'triaged',
  work_started:     'work_started',
  info_requested:   'info_requested',
  fix_shipped:      'shipped',
  reopened:         'reopened',
  marked_duplicate: 'duplicate',
};

// Status is a PURE PROJECTION of those facts, in one ordered function. Put your commercial
// rules here — this is where "cannot be resolved before it was triaged" lives.
function projectStatus(m) {
  if (m.duplicate) return 'duplicate';
  if (!m.triaged) return 'reported';
  if (m.reopened && (!m.shipped || compareOccurrence(m.reopened, m.shipped) > 0)) return 'in_progress';
  if (m.shipped) return 'resolved';
  if (m.info_requested) return 'awaiting_customer';
  return 'in_progress';
}
const HANDOFF_ELIGIBLE = new Set(['triaged', 'in_progress']); // never 'reported'
```

Then rename `client_name → reporter`, `doc_type → issue` in `RECORD_FIELDS`, the Apps Script
`SHEETS.Records`, and the prompts — **all together**.

### 3. The store schema — `apps-script/Code.gs` → `SHEETS`

`{key, sortCol, headers, merge}` per tab.

- **A column must appear in BOTH `headers` and `merge`.** The update path iterates `merge`,
  so a column only in `headers` is created and then never populated on any existing row.
- `logged_at` / `updated_at` are server-set; keep them out of `merge`.

After changing headers: re-run `setupHeaders()` → `applyStatusFormatting()` →
`makeAllValidationsWarnOnly()`.

### 4. Counterparties — `scripts/lib/counterparty.cjs` *(delete if you don't outsource)*

If nobody else touches the work, empty both maps and the whole pass goes quiet. If you DO
outsource, register every number **and** any group chats — an unregistered group is invisible
to the scan and its work gets credited to someone else (GUARDS #6).

### 5. Payments — `src/payments.js`, `src/reconcile.js`, `cli.js` *(delete if not needed)*

An append-only payment log. Deliberately does **not** match payments to records. Leave
`STRIPE_KEY` blank to disable, or delete the three files.

### 6. Deterministic handoff heuristic — `counterparty-heuristic.cjs` *(off by default)*

A domain example. `DOC_KEYWORDS` is empty, so it returns nothing until you fill it in.

### 7. Attribution *(recommended for a new website — not shipped)*

Build this in from the start if you control the site. Put an explicit token in the prefilled
WhatsApp CTA rather than inferring the landing page from timing:

```
https://wa.me/<number>?text=Hi%2C%20I%20need%20help%20with%20my%20document%20%5Bref%3ASVC07%5D
```

The customer's own first message then names the page. In prep, map `SVC07 → /service-page/`
deterministically and stamp `entry_page` on newly committed records. **The model must never
guess it.** A blank means "no token in that thread" (saved contact, walk-in, typed number) —
never "no traffic", and never a licence to infer from timing.

That turns the tracker into an attribution chain a generic CRM cannot give you:

```
organic landing page -> WhatsApp conversation -> committed order -> lifecycle -> outcome
```

---

## Swapping the store entirely

`src/sheet.js` is the whole interface. Point it at a Postgres/SQLite upsert; nothing upstream
changes. Preserve three behaviours:

1. **Upsert by key** — idempotent retry depends on it.
2. **Non-empty merge by default** — an empty field must never erase a populated cell.
3. **No transition guard in the store layer** — it belongs at the writer, because the store
   API is also the repair path (GUARDS #13).

Eventually, separate **writer** credentials (read + upsert + heartbeat) from **admin**
credentials (delete). The routine lane never needs deletion authority.

---

## Swapping the message source

Anything mirroring messages into a queryable store works — Telegram, Slack, SMS, email.
Prep requires:

| Requirement | Why |
|---|---|
| a **monotonic ingestion order** (not send time) | the cursor — see GUARDS #12 and #23 |
| a stable per-message **id** | evidence citation and validation |
| a **direction** flag (ours vs theirs) | nearly every lifecycle rule depends on it |
| a **conversation key** mappable to a stable party id | grouping and the counterparty registry |

No rowid equivalent? Add one: `INTEGER PRIMARY KEY AUTOINCREMENT` on insert into your own
mirror table. **Do not fall back to timestamps.**

---

## Swapping the model runtime

Set `TRACKER_AGENT_PROVIDERS=command` and point `TRACKER_AGENT_COMMAND` /
`TRACKER_AGENT_ARGS_JSON` at any process that reads a prompt on stdin and writes JSON to
stdout. List several providers for automatic failover.

---

## Deployment checklist

- [ ] `.env` filled; `.env` and `agent-token.env` gitignored
- [ ] Ingress chosen deliberately — read [INGRESS.md](INGRESS.md) before building the bridge
- [ ] Store deployed; `SHEET_SECRET` + `WATCHDOG_EMAIL` script properties set
- [ ] `setupHeaders` → `applyFilterAndSort` → `applyStatusFormatting` → `makeAllValidationsWarnOnly` run
- [ ] Seams adapted **together** (prompt, lifecycle model, schema agree)
- [ ] Unused modules deleted (counterparty / payments / heuristic)
- [ ] `node --test` passes after your changes
- [ ] `node scripts/tracker-prep.cjs` inspected by hand before any model call
- [ ] One full `tracker-watch.cjs` run verified end to end
- [ ] `TRACKER_TIMEZONE` set (dates otherwise render in UTC)
- [ ] Long-lived model token in `agent-token.env`, **no leading whitespace**
- [ ] Scheduler installed; battery flags `false`; boot/logon trigger present
- [ ] `watchdogTestEmail()` run — the alert channel is **proven**, not assumed
- [ ] Deliberately break something (rename a prompt file) and confirm you get alerted
