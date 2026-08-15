# Choosing your WhatsApp ingress

**Decide this before you build anything.** It determines whether you need a bridge process,
a keepalive lane, session supervision, LID mapping, and a Go toolchain — or none of them.

v1 of this kit asserted that a Web-session bridge was **required**, because the official
Cloud API cannot see messages the business sends from its own phone. That reasoning was
right about plain Cloud API and is now **incomplete**: WhatsApp Business App **Coexistence**
changes the answer for many new deployments.

---

## The requirement that drives everything

The tracker needs **both sides** of every conversation.

Most lifecycle evidence is **business-side**: the quote, the payment link, the draft, the
final delivery. A feed carrying only inbound customer messages cannot tell paid from
delivered, and the entire lifecycle model collapses. So the real question is:

> **Can this ingress show me the messages my team sends from their own phone?**

---

## Option A — Cloud API with Coexistence *(prefer when it fits)*

Coexistence lets one number stay connected to the WhatsApp Business app **and** the Cloud
API. Crucially, providers expose **`smb_message_echoes`** — webhooks carrying messages the
business sends **from the Business app** after onboarding. That closes the exact gap that
forced the bridge.

Architecture, if it fits:

```
WhatsApp Business App + Cloud API (Coexistence)
        ↓ inbound webhooks + business-app echoes
   small HTTPS ingest endpoint
        ↓
   message store with a monotonic ingest_seq
        ↓
   tracker (prep → model → apply)
```

**What you delete:** the QR/session bridge, the keepalive lane, the `/api/health` patch, the
bridge supervisor and restart budget, LID mapping, and the CGO/Go build. That is a
substantial reduction in moving parts and failure modes.

**Verify before committing** — these are the known constraints, and they change:

- **Device coverage.** Messages sent from some companion devices may not generate an echo
  webhook. If your team works from an unsupported desktop client, you will silently lose
  business-side evidence — the worst possible failure for this system.
- **Groups.** Group messaging support is limited or unavailable for Coexistence users at the
  time of writing. **If your workflow depends on group chats, this option is out.**
- **Onboarding history.** Echoes begin at onboarding; expect little or no backfill.

Check your provider's current documentation rather than trusting this page — this area moves
quickly.

---

## Option B — the local bridge *(the fallback, and still fully supported)*

A Go/whatsmeow process holding a live WhatsApp Web session, mirroring to local SQLite. See
[../bridge/README.md](../bridge/README.md).

**Choose it when:** you need group chats, your team uses an unsupported device, you need
history from before onboarding, you cannot onboard to a BSP, or you want zero third-party
dependency.

**Accept:** session/QR management, a keepalive lane, the `/api/health` patch, LID mapping,
and a C toolchain unless you migrate to pure-Go SQLite.

---

## Decision table

| Your situation | Ingress |
|---|---|
| Team works in the Business app on supported devices, no group workflow | **A — Coexistence** |
| Orders are coordinated in WhatsApp **groups** | **B — bridge** |
| Unsupported companion/desktop client in daily use | **B — bridge** |
| Need conversation history from before onboarding | **B — bridge** |
| No BSP account and no appetite for one | **B — bridge** |
| Unsure | **Test A on one number for a week**, confirm business-side echoes actually arrive for every device your team uses, then decide |

---

## What stays identical either way

The ingress is a **module**, not the architecture. Everything downstream is unchanged:

```
<ingress>  →  message store  →  monotonic cursor  →  deterministic prep
           →  ONE model call  →  validation  →  reducer  →  idempotent upsert
```

Prep needs only four things from any source: a **monotonic ingestion order** (not send time),
a stable **message id**, a **direction** flag, and a **conversation key**. If Coexistence
gives you those via webhooks, assign your own `ingest_seq` on insert and the rest of the kit
works untouched.

**Do not** substitute webhook delivery order or message timestamps for an ingestion cursor.
Retries and out-of-order delivery reintroduce exactly the class of loss GUARDS #12 and #23
describe.
