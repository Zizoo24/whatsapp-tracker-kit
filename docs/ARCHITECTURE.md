# Architecture

## The shape

```
WhatsApp (the operator's phone + Web session)
   │  the official Cloud API cannot see messages the operator SENDS -> a bridge is required
   ▼
whatsapp-bridge  (Go/whatsmeow, holds a live Web session)
   └─> SQLite: messages.db  (+ whatsapp.db for the lid->phone map)
   ▼
Scheduler, every ~3 min, 24/7, app-independent
   └─> tracker-watch.cjs
         1. supervise the bridge      (explicit /api/health probe, budgeted restarts)
         2. tracker-prep.cjs          DETERMINISTIC: rowid delta -> dump changed chats
         3. ONE model call per chat   THE ONLY JUDGMENT STEP
         4. tracker-apply.cjs         DETERMINISTIC: validate -> guard -> upsert -> advance cursor
   ▼
Store backend (secret-gated upsert)
   ▼
The spreadsheet — one row per real record

Parallel lane, every ~5 min + at boot:
   bridge-keepalive.cjs  -> TRANSPORT ONLY. Keeps the socket alive. Never a writer.

Parallel lane, every ~30 min (optional):
   cli.js reconcile      -> READ-ONLY payment log

Cloud, every 15 min:
   watchdogCheck()       -> emails when heartbeats stop (covers "the host is off")
```

**Golden rule:** deterministic I/O lives in scripts; the only judgment step is the headless
model call. **Scripts = mechanism and compliance. Model = reasoning. SQLite + cursor state
= memory.**

---

## The five moving parts

### 1. Ingress + local mirror

A process holding the live session, mirroring messages into a **local database you can
query cheaply, read-only, on a schedule**. This is the load-bearing choice: everything
downstream assumes it can re-read history at will.

Two properties that matter more than the implementation:
- **Read-only with a finite busy timeout.** Without a finite timeout the reader blocks
  forever on the writer's live writes.
- **A stable, monotonic insertion order** you can page through. See part 2.

### 2. The cursor

`tracker-state.json` holds `{lastRowid}` — the newest **ingestion position** already
processed. The scan looks only above it, and it advances **only on a successful apply**,
which is what makes the whole pipeline resumable and idempotent.

**It is a rowid, not a timestamp, and that is not a style choice.** rowid order ≠ timestamp
order: 20 inversions in the last 4,000 messages in the source system, worst ~6 days late. A
timestamp watermark makes a late-arriving message with an old timestamp **unreachable
forever**. rowid is *local ingestion order*, so a message restored after a sleep is still
above the cursor and still gets seen.

Each pass is **frozen at `maxRowid`**, so messages arriving while the model reasons stay
above the boundary for the next pass rather than being silently skipped.

**The residual hazard is inherent:** a state change occurring while the cursor is frozen and
landing *below* it is never re-read. Any deployment needs a post-outage re-scan story —
see GUARDS #12.

### 3. Deterministic prep + apply, one model in the middle

- **prep** (pure code): find chats with new ingested rows; dump each to JSON with its full
  conversation **and** the existing store rows for that counterparty, so the model
  reconciles against authoritative state instead of re-deriving history.
- **the model** (the only judgment step): messages → structured records.
- **apply** (pure code): validate, enforce the monotonic guard, upsert, advance the cursor.

Keep the model boundary **thin**. Everything around it is deterministic and testable, which
is what makes the failures debuggable.

**Two passes, not one.** The customer pass owns the lifecycle. A separate counterparty pass
owns only "who is doing the work", because that evidence lives in a *different chat*.
Cross-pass precedence is explicit (`result-merge.cjs`).

### 4. Durable store + secret-gated write API

Upsert keyed by a stable record id, secret in the POST body **never** the URL. The store
holds a **lifecycle status** plus dimensions that are *not* status — "who does the work" is
a column, because collapsing those axes caused GUARDS #11.

The merge is **non-empty-only by default**: an empty field never erases a populated cell.
Clearing requires either explicit `clear_fields` (precise, preferred) or the blunt
`replaceEmpty` flag.

### 5. Scheduler

OS-level and app-independent, every few minutes, 24/7 — so a tick fires with no editor,
terminal, or app open. Must run **on battery** and **at boot**, both of which have caused
real outages when misconfigured.

---

## Why the lanes are separate

| Lane | Owns | Must never |
|---|---|---|
| **Transport** (`bridge-keepalive`) | the socket staying alive | interpret, write records, touch the cursor |
| **Extraction** (`tracker-watch`) | routine semantics, the cursor, the run lock | run concurrently with the agent lane |
| **Agent** (`agents/tracker-operator.md`) | corrections, audits, ambiguity, recovery | write without disabling the extraction lane first |
| **Payments** (`cli.js reconcile`) | the payment log | set a record's status |

WHO INTERPRETS conversations and WHO KEEPS THE SOCKET OPEN are different responsibilities
with different lifecycles. Fusing them caused a 66-hour outage (GUARDS #18).

---

## Failure model

Fail **closed**, and prefer a loud deferral over a quiet skip.

| Failure | Response |
|---|---|
| A chat fails extraction twice per provider | apply the successful chats, **keep the cursor**, retry next tick |
| Prompt file missing/empty | halt **before** touching state, alert |
| Store write fails | keep the cursor, alert, exit non-zero |
| Model auth fails | distinct `agent_auth_failed` signal → an actionable alert |
| Bridge unhealthy | budgeted restart; persistent failure escalates via heartbeat |
| Host asleep/off | no local lane can fire — the **cloud watchdog** covers this |

Two alert channels, because neither covers both shapes: the **self-message** needs the local
bridge (so it cannot report a dead bridge), and the **cloud watchdog** cannot see anything
except the absence of a heartbeat.

---

## What is deliberately simple

- **No queue.** The cursor plus idempotent upsert is a queue with fewer failure modes.
- **No daemon.** Short-lived scheduled processes cannot leak, wedge, or drift; the OS
  restarts them for free.
- **No ORM, no dependencies.** Node ≥22.5 built-ins only (`node:sqlite`, `fetch`), so there
  is no `npm install` step to break in three months.
- **No payment↔record matching.** It was tried, it was unsafe, it was removed — see
  `src/reconcile.js`.
