# Prompt template notes — what to keep, what to rewrite

**SEAM 1.** The prompts are the extraction contract. This file marks every paragraph
**STRUCTURAL** (port verbatim — it encodes a production incident, and deleting it
re-opens that bug) or **DOMAIN** (rewrite for your business).

Prompts are **data, not code**. They live in `.txt` behind a fail-closed `loadPrompt()`,
so an editing mistake can garble a prompt — caught by validation — but can never crash the
lane. In the source system these lived in JS template literals and a stray backtick
SyntaxError'd the whole watcher for three silent ticks.

---

## `customer-rules.txt`

| Block | Class | Why |
|---|---|---|
| Input/output JSON schema | **STRUCTURAL** | Must match `scripts/lib/client-result.cjs` exactly. Change both together or every result is rejected. |
| "YOU DO NOT DECIDE THE STATUS" | **STRUCTURAL — the central boundary** | The model emits **observations**; code derives state. Enforced by validation, which rejects any record carrying a `status`. This is what makes the "Done" and draft traps structurally impossible rather than prompt-discouraged. |
| THE OBSERVATION VOCABULARY | **DOMAIN names, STRUCTURAL shape** | Rename to your events, but keep every entry a concrete, checkable occurrence — never a state. Must match `OBSERVATION_STAGE` in `status-model.cjs` exactly. |
| IDENTITY CONTRACT | **STRUCTURAL** | The `kind: new/update` + `order_anchor_id` split is what makes ids stable and repeat customers safe. |
| "COMMITMENT" definition | **STRUCTURAL shape, DOMAIN examples** | Keep "an affirmative reply AFTER a concrete quote"; swap phrasings for your customers' idioms. **Keep the negative list** — the "polite acknowledgment" trap shipped 8 phantom rows in one run. |
| Never reuse a terminal id | **STRUCTURAL** | Enforced in code too. The prompt must agree, or every later order gets rejected. |
| EVIDENCE BINDING | **STRUCTURAL — the single most valuable block** | One chat holds many records from one customer. "A file delivered BEFORE a later order was quoted belongs to the EARLIER order; same calendar day proves nothing." Without it the model attributes work to the wrong record. |
| "Customer words are not observations about our work" | **STRUCTURAL** | A customer typing "Done" means *they paid* → `payment_received`, never `final_delivered`. |
| DRAFT vs FINAL | **STRUCTURAL shape, DOMAIN signals** | Nearly every business has a two-send workflow (draft → final, quote → invoice, staging → live). Keep the tie-break: **when unclear, emit the earlier observation.** An unfinished record costs a follow-up; a falsely-complete one means you stop chasing real work. |
| PAYMENT PROOF / screenshot rule | **STRUCTURAL** | Where a payment method has no read API, customers prove payment with a screenshot. The ordering test is the whole rule: an image **after** our payment link is a receipt; **before** it, it is the work item. |
| LANGUAGE DIRECTION | **DOMAIN — delete it** | Wholly specific to bilingual translation. Replace with your own "field the model reliably gets wrong" block, or remove. |
| FIELDS paragraph | **STRUCTURAL shape, DOMAIN specifics** | Keep "multiple items under one quote = ONE record" and the empty-result instruction. Swap the price format. |

## `counterparty-rules.txt`

| Block | Class | Why |
|---|---|---|
| Output schema (`updates` + `reviews`) | **STRUCTURAL** | Two channels on purpose: `updates` writes, `reviews` only flags. |
| "Only in_flight orders" | **STRUCTURAL** | Backed by the code-side eligibility filter in `tracker-prep.cjs`. Belt and braces — keep both. |
| Quote-request ≠ handoff | **STRUCTURAL** | Forwarding a document for pricing looks identical to a handoff. This is the "Abeer bug" (GUARDS #11). |
| "Identifiable IN THIS CHAT" | **STRUCTURAL** | Stops attribution to the wrong counterparty when several are active. A real job was credited to a party whose chat never contained the files. |
| Cancellation → review, never a write | **STRUCTURAL** | Second-hand cancellation evidence must never trigger an irreversible delete. |
| Multi-job reference rules | **DOMAIN examples** | Keep the principle (an explicit business-side reference that maps to eligible work); swap the examples. |

---

## Changing a prompt safely

1. **Never** put a backtick or `${` in a prompt if you ever inline it into JS.
2. Test **offline against a real conversation** before it goes live. Build the input JSON
   the same way `tracker-prep.cjs` does and pipe `RULES + JSON` to your provider directly.
   Do **not** run `tracker-prep.cjs` to test — it wipes a live tick's work directory.
3. Verify the output still passes `validateAndNormalizeClientResult`. A prompt change that
   drifts from the schema turns every tick into a deferral, which looks like an outage.
4. Keep `prompts/` and `scripts/lib/status-model.cjs` in sync. **Every observation type the
   prompt can emit must exist in `OBSERVATION_STAGE`**, or validation rejects the whole
   chat's result. That rejection is loud and deferred — which is the intended behaviour, but
   it looks like an outage if you shipped the mismatch.
5. Never re-introduce a `status` field to the prompt. Validation rejects it on purpose; the
   reducer owns state.
