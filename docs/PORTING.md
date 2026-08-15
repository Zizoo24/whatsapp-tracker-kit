# Porting guide — adapting the kit to your domain

The pipeline, the cursor, the guards, and the ops layer port **unchanged**. Three seams
carry all the domain knowledge.

---

## Seam 1 — the extraction contract (`prompts/*.txt`)

Rewrite what the model is told to look for. **Read `prompts/TEMPLATE-NOTES.md` first** — it
marks every paragraph STRUCTURAL (port verbatim; it encodes a production incident) or
DOMAIN (rewrite).

Roughly: the identity contract, evidence binding, the "customer words are not stages" trap,
the draft-vs-final rule, and the payment-proof ordering rule are **structural**. The status
names, the language-direction block, and the example phrasings are **domain**.

---

## Seam 2 — the lifecycle model (`scripts/lib/status-model.cjs`)

Rename the stages. Keep two invariants:

- **Status is a pure lifecycle STAGE.** *Who* does the work is a **column**, never a status.
- **Rank is monotonic**, and the guard lives at the writer, never the API.

Also review `HANDOFF_ELIGIBLE`: it must exclude your "committed but not yet paid/started"
stage, or a quote-check gets misread as a handoff (GUARDS #11).

### Worked example — a support-ticket tracker

```js
const STAGES = ['reported', 'triaged', 'in_progress', 'awaiting_customer', 'resolved'];
const DEAD_STAGES = ['duplicate', 'wont_fix'];
const HANDOFF_ELIGIBLE = new Set(['triaged', 'in_progress']); // never 'reported'
```

Then rename `client_name → reporter`, `doc_type → issue_summary` in `RECORD_FIELDS`, the
Apps Script `SHEETS.Records`, and the prompts — **all three together**.

---

## Seam 3 — the store schema (`apps-script/Code.gs` → `SHEETS`)

`{key, sortCol, headers, merge}` per tab.

- `key` is the upsert identity — must match what `client-result.cjs` mints.
- **A column must appear in BOTH `headers` and `merge`.** The update path iterates `merge`,
  so a column listed only in `headers` is created and then never populated on any existing
  row. It stays silently blank forever.
- `logged_at` / `updated_at` are server-set and must **not** be in `merge`.

After changing headers: re-run `setupHeaders()`, then `applyStatusFormatting()` (the colour
formulas resolve column letters from the header row), then `makeAllValidationsWarnOnly()`.

---

## Swapping the store entirely

`src/sheet.js` is the whole interface: `appendRows`, `fetchRows`, `deleteRows`,
`fetchCapabilities`, `postHeartbeat`. Point them at a Postgres/SQLite upsert and nothing
upstream changes. Preserve three behaviours:

1. **Upsert by key**, never blind insert — idempotent retry depends on it.
2. **Non-empty merge by default** — an empty field must never erase a populated cell.
3. **No monotonic guard in the store layer** — it belongs at the writer (GUARDS #13).

---

## Swapping the message source

Anything that mirrors messages into a queryable store works — Telegram, Slack, SMS, email.
`tracker-prep.cjs` needs:

| Requirement | Why |
|---|---|
| a **monotonic ingestion order** (not send time) | the cursor; see GUARDS/ARCHITECTURE |
| a stable per-message **id** | evidence citation and validation |
| a **direction** flag (ours vs theirs) | almost every lifecycle rule depends on it |
| a **conversation key** and a way to map it to a stable party id | grouping and the counterparty registry |

If the source has no rowid-equivalent, add one: an `INTEGER PRIMARY KEY AUTOINCREMENT` on
insert into your own mirror table. **Do not fall back to timestamps.**

---

## Swapping the model runtime

Set `TRACKER_AGENT_PROVIDERS=command` and point `TRACKER_AGENT_COMMAND` /
`TRACKER_AGENT_ARGS_JSON` at any process that reads a prompt on **stdin** and writes the
result to **stdout**. List several providers to get automatic failover.

Whatever you use must return **JSON only**. `extractJson` tolerates code fences and
surrounding prose, but a chatty model wastes retries.

---

## Optional extension points (not shipped)

**Entry-page attribution.** The source system appended a token to every web CTA's prefilled
message, so the customer's own first message named the page they came from — turning the
tracker into a conversion-attribution source. Deliberately omitted here: it is a cross-repo
dependency on a specific website. To add it, stamp the token in `tracker-apply.cjs` **after**
verifying the store schema can retain it, and treat a blank as "no token in that thread",
never "no traffic" — and never infer the page from timing.

**The event ledger.** See [LEDGER-ARCHITECTURE.md](LEDGER-ARCHITECTURE.md). Build the simple
pipeline first.

---

## Checklist for a new deployment

- [ ] `.env` filled; `.env` and `agent-token.env` gitignored
- [ ] Bridge built **with the `/api/health` patch**; `curl` returns `ok:true`
- [ ] Apps Script deployed; `SHEET_SECRET` + `WATCHDOG_EMAIL` script properties set
- [ ] `setupHeaders` → `applyFilterAndSort` → `applyStatusFormatting` → `makeAllValidationsWarnOnly` run
- [ ] Seams 1–3 adapted **together** (prompt, status model, schema agree)
- [ ] `node scripts/tracker-prep.cjs` inspected by hand before any model call
- [ ] One full `tracker-watch.cjs` run verified end to end
- [ ] `TRACKER_TIMEZONE` set (dates otherwise render in UTC)
- [ ] Long-lived model token in `agent-token.env`, **no leading whitespace**
- [ ] Scheduler installed; battery flags verified `false`; boot/logon trigger present
- [ ] `watchdogTestEmail()` run — the alert channel is **proven**, not assumed
- [ ] Deliberately break something (rename a prompt file) and confirm you get alerted
