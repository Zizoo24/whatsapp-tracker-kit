# Acceptance — proving it against the real boundary

The test suite proves the deterministic machinery. **It cannot prove two things**, and both
need a human to set up once:

| Gap | Why local tests cannot reach it |
|---|---|
| **The real store** | `test/acceptance.test.cjs` drives the real validator, aggregator and projection — but against a *store double* that replicates what `Code.gs` says it does. Cell coercion, `clear_fields` on a live deployment, `setupHeaders()` adding a column to an existing sheet, and locking under genuinely concurrent processes are all untested. |
| **The prompts** | No model call happens in `npm test`. A prompt can contradict itself and every test still passes — v1.2.2 shipped exactly that. |

Until both pass, treat any tag as **unproven for deployment**, however green the suite is.

---

## 1. Semantic fixtures (the prompt contract)

Checks what code tests cannot: that the prompts actually produce the rules they claim. Six
fixtures, each pinning a real incident.

```bash
cp .env.example .env          # set TRACKER_AGENT_PROVIDERS and the model CLI path
npm run eval                  # all six — costs real model calls
npm run eval -- --only 01     # just the early-delivery rule
```

| Fixture | The rule it pins | Guard |
|---|---|---|
| 01 early delivery before payment | `final_delivered` is reported even when unpaid; projects to `confirmed_unpaid` | #25 |
| 02 customer says "Done" | maps to `payment_received`, never `final_delivered` | #14 |
| 03 draft vs final | a draft keeps the record in progress | #17 |
| 04 repeat customer | a later order is a NEW record, never a reused terminal id | #13 |
| 05 same-second correction | the revision is still reported | #28 |
| 06 quote vs handoff | forwarding for a price is not a handoff | #11 |

**A failure here is a PROMPT defect, not a code defect.** Fix `prompts/*.txt` and re-run.
Fixture 01 is the load-bearing one: if it fails, the milestone model's whole reason for
existing is not reaching the model.

`npm test` separately checks the fixtures stay attached to the live vocabulary — a fixture
citing a renamed observation fails loudly rather than silently testing nothing.

---

## 2. Live store acceptance (the real Sheet)

**Use a scratch Sheet and a separate deployment. Never point this at production** — it writes
and clears rows.

### Setup (once)

1. Create a **new, empty** Google Sheet.
2. Extensions → Apps Script, paste `apps-script/Code.gs`.
3. Project Settings → Script Properties → add `SHEET_SECRET` (a long random string).
4. Run `setupHeaders()`, then `applyFilterAndSort()`, `applyStatusFormatting()`,
   `makeAllValidationsWarnOnly()`.
5. Deploy → Web app → *Execute as me*, *Anyone*. Copy the `/exec` URL.
6. Put the URL and secret in `.env` as `SHEET_WEBHOOK_URL` / `SHEET_SECRET`.

### Confirm the deployment matches the local source

```bash
node -e "import('./config.js').then(async ({loadConfig}) => {
  const { fetchCapabilities } = await import('./src/sheet.js');
  console.log(await fetchCapabilities(loadConfig()));
})"
```

Expect `clearFields: true`. **`paid_at` clearing depends on it** — without it, clearing a
false payment leaves the derived column stale, which is GUARDS #36/#40 returning through the
store layer.

### The scenarios to walk

Each is already covered against the double in `test/acceptance.test.cjs`; the point here is to
watch the **real sheet** after each step.

1. commitment → `confirmed_unpaid`
2. payment → `paid`, `paid_at` populated
3. same-tick customer event + counterparty handoff → **one row**, both milestone facts, counterparty set
4. **final delivered before payment → stays `confirmed_unpaid`** (the headline rule)
5. later payment → `done`, without re-citing the old delivery
6. same-second delivery then revision → `revision`
7. revised final → `done`
8. counterparty work fact survives a same-tick cancellation → status `cancelled`, `work_started` still present
9. clear a false `paid` milestone via `tracker-admin` → status `confirmed_unpaid` **and `paid_at` blank**
10. corrupt the `milestones` cell by hand → the tick refuses to write, cursor kept
11. a row with a status and blank milestones → migration block, no rewrite
12. run `tracker-admin apply` while the watcher ticks → the shared lock refuses one of them
13. re-run a tick after a kept cursor → no duplicate row
14. a counterparty cancellation review citing an unresolvable id → **no alert**

Verify #9 and #10 by reading the sheet directly, not just the tool's output — they are the two
that depend on store behaviour rather than pipeline logic.

### What to record

For each: the row **before**, the command, and the row **after**. A scenario that "looks right"
in the tool's stdout but wrong in the sheet is exactly the class of defect this run exists to
catch.

---

## Only then

If both pass, the tag is a reasonable deployment baseline. If either fails, the failure is
worth more than another static audit round — it is the first evidence from outside the
codebase's own assumptions.
