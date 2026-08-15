# whatsapp-tracker-kit

Turn a live WhatsApp conversation stream into **one durable row per real business record**
— order, ticket, lead, booking — using exactly one LLM judgment step surrounded by
deterministic code.

> A message stream → a deterministic scan bounded by an **ingestion-order cursor** → **one
> model call per changed conversation** → deterministic **validation** → durable
> **milestones** → a **projected** lifecycle → an idempotent **upsert by stable record id**.
>
> **The model reports observations. Code records facts. Status is derived from the facts.**

This is the portable distillation of a system that ran in production for months. Its guards
are not defensive-programming habits — **each one is an incident that reached real data**.
[docs/GUARDS.md](docs/GUARDS.md) is the most valuable file here.

---

## Why this exists

Off-the-shelf CRMs cannot see your WhatsApp, and the official Business Cloud API **cannot
see messages you send** from your own phone — which is fatal, because most lifecycle
evidence is business-side: the quote, the payment link, the delivered file. Meanwhile
"just ask an LLM to read the chat" fails differently: it re-reads history every run,
re-emits finished records at earlier stages, invents records from polite acknowledgments,
and attributes one customer's delivery to another's order.

This kit is the boring machinery that makes the LLM step safe.

---

## Requirements

- **Node ≥ 22.5** — uses built-in `node:sqlite` and `fetch`. **No `npm install`.**
- A **WhatsApp bridge** mirroring messages to local SQLite ([bridge/README.md](bridge/README.md)).
- A **Google Sheet** (or any store — `src/sheet.js` is the entire interface).
- A **model CLI** — Claude Code, Codex, or any stdin→stdout command.

---

## Quick start

```bash
cp .env.example .env        # fill it in
npm run check               # syntax preflight

# 1. Inspect what would be sent to the model — BEFORE any model call
node scripts/tracker-prep.cjs
cat .tracker-work/manifest.json

# 2. One full tick: supervise -> prep -> model -> apply
node scripts/tracker-watch.cjs

# 3. Schedule it (dry-run by default)
powershell -File ops/windows/install-tasks.ps1          # -Execute to install
#   or: see ops/linux/README.md
```

Full setup, including the store backend and the three seams you must adapt, is in
[SKILL.md](SKILL.md) §3–4.

---

## Documentation

| File | Read it when |
|---|---|
| **[SKILL.md](SKILL.md)** | **start here** — the agent front door, setup, diagnostics |
| [docs/INGRESS.md](docs/INGRESS.md) | **before building anything** — bridge vs. official Coexistence |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | you want the five moving parts and the failure model |
| [docs/GUARDS.md](docs/GUARDS.md) | **before changing anything** — 42 production incidents |
| [docs/PORTING.md](docs/PORTING.md) | core invariants vs. business modules; the checklist |
| [docs/MIGRATION.md](docs/MIGRATION.md) | **upgrading an existing store** to the milestone model |
| [docs/LEDGER-ARCHITECTURE.md](docs/LEDGER-ARCHITECTURE.md) | you need replay, provenance, durable corrections |
| [prompts/TEMPLATE-NOTES.md](prompts/TEMPLATE-NOTES.md) | editing prompts — what is structural vs domain |
| [bridge/README.md](bridge/README.md) | building the bridge; the required `/api/health` patch |
| [agents/tracker-operator.md](agents/tracker-operator.md) | corrections and audits (a reference, not a second agent) |

---

## What to change

**Core invariants port unchanged** — the cursor, the run lock, fail-closed validation,
never truncating new evidence, the guarded writer, transport-only keepalive.

**Business modules you adapt or delete:** the prompts, the lifecycle model, the store
schema, counterparties, payments, attribution. Change the first three **together** — they
must agree or records are dropped. See [docs/PORTING.md](docs/PORTING.md).

---

## Six things that will bite you

1. **Never revert the cursor to a timestamp.** Ingestion order ≠ timestamp order (20
   inversions per 4,000 messages, worst ~6 days late). A timestamp watermark makes
   late-arriving messages **unreachable forever**.
2. **Never truncate new evidence.** A context cap that trims a merged, timestamp-sorted
   array will silently drop a newly ingested old-timestamp message while the cursor advances
   past it — defeating the cursor with a performance optimisation (GUARDS #23).
3. **Authoritative reads fail closed.** The lid map, the store read, and the writer's
   pre-read all abort rather than continue; each fail-open turns a transient error into
   permanent corruption (GUARDS #24).
4. **Always open the live SQLite `{readOnly: true, timeout: 5000}`.** Without a *finite*
   timeout, `node:sqlite` hangs on the bridge's live writes and the lane wedges.
5. **Use a long-lived model token.** A normal login token expires ~daily and a headless
   subprocess cannot refresh it: silent 401s, frozen cursor, everything *looks* healthy.
   (A stray leading space in the token file also 401s.)
6. **Status is derived, never set.** One lifecycle write route: observations (or operator
   fact-corrections) → milestones → `projectStatus`. Correcting a *status* is a fix the next
   observation erases; correct the **milestone** instead (GUARDS #32, #34).

---

## Hard rules

- Payment keys are **READ-ONLY**. This system is **tracking only**: it never messages a
  customer, never creates or modifies a payment, never writes a payment link.
- Never commit `.env`, `agent-token.env`, or any `*.db` — they hold secrets and real
  conversation content. `.tracker-work/` holds raw conversations and is gitignored too.
- Both writers take the same `.tracker-lock`, so a correction and a scheduled tick cannot
  overlap. Stopping the scheduled task is still tidier for a long investigation session.

---

## License

Adapt freely. The bridge is a separate upstream project with its own license — see
[bridge/README.md](bridge/README.md).
