# The ingress bridge

The pipeline needs a process that holds a live WhatsApp session and **mirrors messages
into a local SQLite database** you can query read-only on a schedule. This kit is built
against [`lharries/whatsapp-mcp`](https://github.com/lharries/whatsapp-mcp) —
`whatsapp-bridge/`, a Go binary using [whatsmeow](https://github.com/tulir/whatsmeow).

**The binary is deliberately not bundled.** Build it yourself: a prebuilt binary holding
your WhatsApp session is not something to pass around, and the upstream project moves.

---

## Why a bridge at all, and not the official API

The WhatsApp Business Cloud API **cannot see messages the operator SENDS** from their own
phone or WhatsApp Web. A tracker built on it is blind to half of every conversation —
which is fatal here, because most lifecycle evidence is *business-side*: the quote, the
payment link, the delivered file. A bridge that holds a real Web session sees both
directions.

---

## Required patch: `/api/health`

**`scripts/lib/bridge-supervisor.cjs` requires a `/api/health` endpoint that upstream does
not have.** Without it, `health()` returns `reachable: false` on every tick and the
supervisor restarts a perfectly healthy bridge on a loop.

Add this handler in `startRESTServer` in `whatsapp-bridge/main.go`, alongside the existing
`/api/send` and `/api/download`:

```go
// Health is intentionally independent of message activity. A quiet account is
// healthy; supervisors must never infer connection state from the newest row.
http.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodGet {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }
    connected := client != nil && client.IsConnected()
    loggedIn := client != nil && client.IsLoggedIn()
    w.Header().Set("Content-Type", "application/json")
    if !connected || !loggedIn {
        w.WriteHeader(http.StatusServiceUnavailable)
    }
    _ = json.NewEncoder(w).Encode(map[string]bool{
        "ok":        connected && loggedIn,
        "connected": connected,
        "logged_in": loggedIn,
    })
})
```

That comment is the whole design argument. Before this endpoint existed, supervision had
to guess from message age — which meant a genuinely quiet day looked exactly like a dead
socket, and the bridge got its session churned all afternoon. `connected && logged_in` is
an explicit fact; message age is an inference. Never restart on an inference.

**Verify after building:**

```bash
curl -fsS http://127.0.0.1:8080/api/health
# {"connected":true,"logged_in":true,"ok":true}
```

---

## Building

```bash
git clone https://github.com/lharries/whatsapp-mcp
cd whatsapp-mcp/whatsapp-bridge
# apply the /api/health patch above
go build -trimpath -o whatsapp-bridge .
./whatsapp-bridge          # first run prints a QR — scan via WhatsApp > Linked devices
```

### The CGO trap

Upstream uses `github.com/mattn/go-sqlite3`, which is **CGO** — so building needs a C
compiler. On Windows that means MSYS2 UCRT64 or equivalent, and on a machine without one
you simply cannot rebuild the bridge, which blocks every fix that needs a code change.

**Strongly recommended:** migrate to pure-Go [`modernc.org/sqlite`](https://pkg.go.dev/modernc.org/sqlite)
so the compiler dependency disappears permanently. Otherwise keep a working toolchain
documented next to the build script — discovering the gap during an outage is the worst
possible time.

```powershell
# Windows, with MSYS2 UCRT64 present
$env:CGO_ENABLED = '1'
$env:CC = 'C:\msys64\ucrt64\bin\gcc.exe'
go test ./...
go build -trimpath -o whatsapp-bridge.candidate.exe .
```

**Never hot-swap an untested build over a running bridge** — that caused an outage once.
Build to a `.candidate` name, keep a `.bak` of the working binary, test, then swap.

---

## What the bridge writes

Two SQLite files under `store/`:

| File | Contents | Used for |
|---|---|---|
| `messages.db` | `messages` table: `rowid, id, chat_jid, timestamp, is_from_me, media_type, filename, content` | the ingestion cursor and all conversation reads |
| `whatsapp.db` | whatsmeow session state, incl. `whatsmeow_lid_map` (`lid` ↔ `pn`) | resolving a phone number to its chat |

### Two gotchas that will cost you a day each

**1. Chats are keyed by `@lid`, not by phone.** Modern WhatsApp addresses chats as
`<lid>@lid` rather than `<phone>@s.whatsapp.net`. Look up only the phone JID and an active
chat is simply *invisible* — no error, just no data. `tracker-prep.cjs` resolves both rails
via `whatsmeow_lid_map` and queries them together, because one contact's history can span
both.

**2. Always open the live DB `{ readOnly: true, timeout: 5000 }`.** Without a **finite**
timeout, `node:sqlite` blocks indefinitely on the bridge's live writes — the tick never
returns, the lock is held, and the lane wedges silently. Every read in this kit passes it.

---

## Local REST API

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/health` | GET | supervision (**the patch above**) |
| `/api/send` | POST | `{Recipient, Message}` — used ONLY for operator self-alerts |
| `/api/download` | POST | media retrieval |

`/api/send` exists in this system for **alerts to the operator only**. The tracker must
never message a customer or counterparty — see the hard rules in `SKILL.md`.
