---
name: whatsapp-tracker
description: Build, operate, diagnose, and extend a WhatsApp→spreadsheet pipeline that turns a live WhatsApp conversation stream into one durable row per real business record (order, ticket, lead, booking). Use for initial setup in a new environment, for "the sheet is stale / not updating", for bridge and ingestion faults, for status-model or schema changes, and for evidence-backed manual corrections. Portable — every machine-specific value is configuration.
---

# WhatsApp → Sheet tracker

A local pipeline that watches a WhatsApp account and keeps a spreadsheet at **one row
per real business record**, using exactly one LLM judgment step surrounded by
deterministic code.

This kit is the **portable distillation** of a system that ran in production for months.
Its guards are not defensive programming — each one is a real incident that cost real
money. Port the guards, not just the happy path. See [docs/GUARDS.md](docs/GUARDS.md).

---

## 0. The one-paragraph architecture

> A message stream → a periodic deterministic scan bounded by an **ingestion-order cursor**
> → **one LLM judgment call per changed conversation** → deterministic **validation and a
> lifecycle reducer** → an idempotent **upsert keyed by a stable record id**.

**Golden rule:** deterministic I/O lives in scripts; the *only* judgment step is the
headless LLM call. Scripts = mechanism and compliance. LLM = reasoning. SQLite +
cursor state = memory.

**The model reports OBSERVATIONS → code records MILESTONES → status is a PROJECTION.**

The model never emits a status. It emits evidence-backed observations (`payment_received`,
`draft_sent`, `final_delivered`), each of which writes a durable timestamped milestone, and
`projectStatus()` derives the stage from those accumulated facts.

Two failure classes become structurally impossible rather than prompt-discouraged: a customer
typing "Done" (meaning *they paid*) cannot complete a record, and a draft cannot either.
A third — the one that killed a naive observation→status reducer — needs the milestones:
**work delivered before payment stays in the chase-payment stage, and completes automatically
when payment later arrives**, even though the delivery evidence is by then old context.

The model still does the hard part: which record this belongs to, whether the customer really
committed, whether this image is a receipt or the source document, draft or final.

---

## 1. The five moving parts

Swap any implementation; keep the roles.

| # | Part | This kit's implementation | Swappable with |
|---|---|---|---|
| 1 | **Ingress + local mirror** | `whatsapp-bridge` (Go, whatsmeow) writing SQLite | any client that mirrors messages to a queryable DB |
| 2 | **Cursor** | `tracker-state.json` `{lastRowid}` over `messages.rowid` | any monotonic per-source ingestion cursor |
| 3 | **Prep → LLM → apply** | `tracker-prep.cjs` / provider chain / `tracker-apply.cjs` | any deterministic-around-a-model shape |
| 4 | **Durable store + gated write API** | Google Sheet behind an Apps Script `doPost` | Postgres/SQLite table with an upsert |
| 5 | **Scheduler** | Windows Task Scheduler (or systemd timers) | cron, launchd, any OS-level scheduler |

Full detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## 2. The ingestion cursor is the load-bearing correctness fix

**Never revert this to a timestamp watermark.**

`messages` is a rowid table and **rowid order ≠ timestamp order**: 20 inversions in the last
4,000 messages, worst ~6 days late. A timestamp watermark makes a late-arriving message with
an old timestamp **unreachable forever** — not a patchable bug but a whole outage blind-spot
class. Ingestion-order cursors close it.

**Cardinal rule:** *never advance a cursor over a message you did not show the LLM.*
Every silent-data-loss bug this system has had has that shape — including one caused by a
**context-truncation cap** (GUARDS #23), which is why prep emits `new_messages` (never
truncated) separately from `context` (capped), and lowers the ingestion boundary rather than
dropping evidence when a delta is too large.

`scripts/lib/message-cursor.cjs` is ported verbatim. Treat it as frozen.

---

## 3. Setup in a new environment

Prerequisites: **Node ≥ 22.5** (for built-in `node:sqlite` and `fetch` — no `npm install`).

```bash
git clone <this kit> whatsapp-tracker && cd whatsapp-tracker
cp .env.example .env          # fill in the values below
node --test                   # sanity
```

1. **Choose your ingress — read [docs/INGRESS.md](docs/INGRESS.md) FIRST.** If WhatsApp
   Business App *Coexistence* fits your workflow, you can drop the bridge, the keepalive
   lane, LID mapping and the Go toolchain entirely. If you need group chats or history from
   before onboarding, use the bridge: see [bridge/README.md](bridge/README.md), and apply the
   `/api/health` patch (the supervisor *requires* it).
2. **Deploy the store backend.** Paste `apps-script/Code.gs` into the Sheet's Apps
   Script editor, set the `SHEET_SECRET` and `WATCHDOG_EMAIL` Script Properties, run
   `setupHeaders()` then `applyFilterAndSort()` then `applyStatusFormatting()` then
   `makeAllValidationsWarnOnly()`, deploy as a Web App (Execute as Me / Anyone), and
   put the `/exec` URL in `.env` as `SHEET_WEBHOOK_URL`.
3. **Adapt the seams** — see §4. Do this *before* the first real run.
4. **Authenticate a model provider.** For Claude Code, `claude setup-token` gives a
   long-lived token; put it on ONE line in `agent-token.env`. A normal login token
   expires ~daily and a headless subprocess **cannot refresh it** — see GUARDS #12.
5. **Verify the whole chain manually before scheduling:**
   ```bash
   node scripts/tracker-prep.cjs      # writes .tracker-work/
   # inspect .tracker-work/manifest.json and one chat_*.json by hand
   node scripts/tracker-watch.cjs     # full tick: prep → LLM → apply
   ```
6. **Schedule it.** `ops/windows/install-tasks.ps1` (dry-run by default; `-Execute` to
   install) or `ops/linux/` systemd units.

---

## 4. Core invariants vs. business modules

Full guide: [docs/PORTING.md](docs/PORTING.md).

**Core invariants — port unchanged.** The ingestion cursor, the run lock, fail-closed
validation and evidence binding, the never-truncate-new-evidence rule, the guarded
derivation at the writer, transport-only keepalive, and the store client's upsert/merge
semantics. These *are* the correctness of the system.

**Business modules — adapt or delete:**

1. **Extraction contract** (`prompts/*.txt`) — prompts are **data, not code**, behind a
   fail-closed `loadPrompt()`, so a garbled prompt can never crash the lane.
   `prompts/TEMPLATE-NOTES.md` marks each paragraph STRUCTURAL or DOMAIN.
2. **Lifecycle model** (`scripts/lib/status-model.cjs`) — stages, observations, and the
   reducer. Keep: status is a stage not an owner; transitions are explicit via
   the projection (`projectStatus`), never a status set by any lane (GUARDS #34);
   `HANDOFF_ELIGIBLE` excludes your committed-but-unstarted stage (GUARDS #11).
3. **Store schema** (`apps-script/Code.gs` → `SHEETS`) — a column must appear in **both**
   `headers` and `merge`, or it is created and then never populated.
4. **Counterparties** (`counterparty.cjs`) — delete if you don't outsource.
5. **Payments** (`src/payments.js`, `reconcile.js`, `cli.js`) — delete if not needed.
6. **Attribution** — recommended for a new site; see PORTING §7.

---

## 5. Repository map

```
SKILL.md                     this file — the agent front door
README.md                    human install guide
config.js                    .env loader + config defaults
cli.js                       payment reconciliation entry point

scripts/
  tracker-prep.cjs           DETERMINISTIC: cursor → new_messages + context per chat
  tracker-watch.cjs          the tick: supervise → prep → LLM → apply
  tracker-apply.cjs          DETERMINISTIC: reduce observations → guarded upsert
  tracker-admin.cjs          the agent lane's correction tool (snapshot/validate/apply)
  bridge-keepalive.cjs       TRANSPORT ONLY: keeps the socket alive. Never a writer.
  lib/
    message-cursor.cjs       the ingestion cursor. FROZEN — port verbatim.
    run-lock.cjs             atomic, owner-checked, stale-reaping run lock.
    status-model.cjs         lifecycle model + observation reducer + transition guard.
    client-result.cjs        fail-closed validation + stable record-id minting.
    agent-provider.cjs       provider chain (claude | codex | any command).
    bridge-supervisor.cjs    health-probe supervision + restart budget + escalation.
    result-merge.cjs         records the counterparty lane's contribution.
    counterparty.cjs         SEAM — the vendor/counterparty registry.
    counterparty-heuristic.cjs  optional deterministic fallback (domain example, OFF).
    sheet-normalize.cjs      comparison scaffolding for the agent lane (not on the tick path).
    alert.cjs                debounced self-alert over the message channel.

src/                         sheet.js, payments.js, reconcile.js, state.js
test/                        node --test: guard behaviour + lane boundaries
apps-script/Code.gs          SEAM 3 — the store backend + cloud watchdog
prompts/                     SEAM 1 — the extraction contract
ops/windows/ | ops/linux/    schedulers
bridge/                      the /api/health patch + build notes
agents/tracker-operator.md   the agent lane (corrections, audits, deep judgment)
docs/                        ARCHITECTURE, GUARDS, PORTING, LEDGER-ARCHITECTURE
```

`npm test` runs the suite. Four of its assertions are **architectural boundaries** that
fail the moment someone erodes them: the keepalive naming any webhook action but
`heartbeat`, status derivation appearing in the store API, the run lock moving inside the
wiped work directory, or a live SQLite read losing its finite timeout.

---

## 6. Two lanes — and never both writing at once

**Automated lane** (`tracker-watch.cjs`, every ~3 min): routine extraction. Owns the
cursor and the run lock.

**Agent lane** ([agents/tracker-operator.md](agents/tracker-operator.md)): corrections,
audits, ambiguity, post-outage recovery. An agent reads the conversation and decides;
deterministic tooling does snapshot / validate / backup / write / readback.

> **Both lanes take the same `.tracker-lock`.** `tracker-admin apply` acquires the writer
> lock, so a scheduled tick cannot overlap a correction — safety is enforced, not advised.
> Stopping the scheduled task is still tidier for a long investigation session.

**Transport is separate from semantics.** `bridge-keepalive.cjs` keeps the socket alive
and does nothing else. In the source system the self-heal lived *inside* the watcher, so
retiring the watcher silently removed the only thing keeping the socket open →
**66 hours of zero ingestion**. Messages were not merely unprocessed; they never reached
the machine. A test pins that this file names no webhook action but `heartbeat`.

---

## 7. Diagnostic routine — "the sheet seems behind"

Read-only, in order. **Never run `tracker-prep.cjs` while a tick is live** — it wipes the
work dir.

```bash
# 1 bridge alive and healthy (health is independent of message activity — a quiet
#   account is HEALTHY; never infer connection state from the newest row)
curl -fsS http://127.0.0.1:8080/api/health

# 2 newest mirrored message  (ALWAYS open the live DB readOnly WITH a finite timeout —
#   without one, node:sqlite HANGS on the bridge's live writes)
node --no-warnings=ExperimentalWarning -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.env.WHATSAPP_DB_PATH,{readOnly:true,timeout:5000});console.log(d.prepare('SELECT MAX(rowid) rowid, MAX(timestamp) ts FROM messages').get())"

# 3 cursor — compare lastRowid to the bridge's MAX(rowid)
cat tracker-state.json

# 4 recent activity
tail -20 watch.log
```

**Interpretation.** `lastRowid` == bridge `MAX(rowid)` → fully synced, done. A gap plus a
manifest with active chats and a last log line of `activity:` with no `apply` yet → a tick
is mid-run; **wait, don't poke**. A gap plus repeated `ABORT` / `prep FAILED` → wedged;
investigate that specific chat.

---

## 8. Failure model

- Any chat that fails extraction twice → the run **applies its successful chats** but
  **keeps the cursor** (`--keep-cursor`), so the failed messages stay queued. Upsert by
  record id is idempotent, so re-extraction just updates rows.
- A missing or empty prompt file **halts the tick before any state is touched** and
  alerts the operator.
- Two alert channels, covering different outage shapes:
  - **Self-message via the bridge** — laptop up, pipeline broken. Fast, no cloud
    dependency. Debounced per key.
  - **Cloud watchdog (Apps Script, 15-min trigger)** — laptop off/asleep, when the local
    lane cannot fire at all. Reads the heartbeat every lane posts. Each poster owns its
    own property; one shared slot let each lane erase the other's alarm.

---

## 9. Hard rules

- **Payment keys are READ-ONLY.** This system is TRACKING ONLY. Never message a
  counterparty, never create or modify a payment or link, never write a payment link
  into the store.
- **Never commit `.env`, `agent-token.env`, or any `*.db`.** Keep them gitignored.
- **Never poke a running pipeline** (no manual prep mid-tick).
- **Every store-wide mutation carries a row-scope guard** so history rows aren't
  clobbered (GUARDS #7).
- **Test bridge/binary changes off the live bridge.** Keep a `.bak` before swapping.
- **Status is derived, never set.** Exactly one lifecycle write route: observations (or
  operator fact-corrections) → milestones → `projectStatus`. The store API stays a dumb
  upsert, because it is also the correction path (GUARDS #13, #34).

---

## 10. What is deliberately NOT shipped

The source system was mid-migration to an **append-only event ledger** (events are truth;
the row table is a replayable projection). That design is documented in
[docs/LEDGER-ARCHITECTURE.md](docs/LEDGER-ARCHITECTURE.md) — including the pure
`foldEvent` guard rules and the content- vs occurrence-addressed dedup distinction, which
is worth reading before you build a v2 — but its half-finished cutover scripts are not
shipped. Shipping a partial cutover into a fresh environment is worse than not shipping it.

Build the simple pipeline first. Graduate to the ledger only when you need replay,
provenance, and durable operator corrections.
