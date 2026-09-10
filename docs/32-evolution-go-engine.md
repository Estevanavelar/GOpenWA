# 32 — Evolution Go Engine

How OpenWA runs WhatsApp through an external Evolution Go service, and what had to change in this
repository to make that work.

This document is written for whoever maintains this fork. It records the adaptations, the reasons
behind them, and — more usefully — the places where this engine is **worse** than the two built-in
ones, so nobody rediscovers them as bugs.

---

## 32.1 The shape of the thing

The two built-in engines run the WhatsApp protocol **in this process**: whatsapp-web.js drives a
headless Chromium, Baileys drives a WebSocket. Evolution Go is different in kind. It is a separate
service (Go, using `whatsmeow`) that owns the WhatsApp connection, the credentials and the message
store. Our adapter is an **HTTP client** to it.

```
┌────────────────────┐   HTTP (apikey)     ┌──────────────────────┐
│  OpenWA            │ ──────────────────► │  Evolution Go        │
│  evolution-go      │                     │  (own container)     │
│  adapter           │ ◄────────────────── │                      │
│                    │   webhook (JSON)    │  whatsmeow ──► WA    │
│  ingress route     │                     │                      │
│  media host        │ ◄── fetches media   │  PostgreSQL (auth)   │
└────────────────────┘     by signed URL   └──────────────────────┘
```

Three consequences follow, and they explain most of what is unusual below:

1. **Capability is bounded by someone else's API.** The service exposes 91 operations; the engine
   interface has 112 methods. 41 have no counterpart and answer **501** rather than an empty value.
2. **Events arrive over HTTP, not over a socket.** The service POSTs them; there is no stream to
   subscribe to, so the gateway needs an inbound route and the service needs to know where it is.
3. **Media to send must be a URL.** There is no base64 field anywhere in the service's contract, so
   bytes have to be hosted before a send can name them.

---

## 32.2 The files

| File                                                 | Role                                                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/adapters/evolution-go.adapter.ts`            | The 112-method interface. Thin: normalises arguments, delegates, maps results back. Every unsupported method is a one-line refusal via a single helper. |
| `engine/adapters/evolution-go-client.ts`             | Transport. Two credential levels, per-call deadlines, and the error classification (403 vs 503 vs "not found").                                         |
| `engine/adapters/evolution-go-instance.ts`           | One session ↔ one remote instance. Creation, adoption, deletion, and the persisted id/token.                                                            |
| `engine/adapters/evolution-go-message-mapper.ts`     | Webhook payload → neutral `IncomingMessage`. Also maps history sync batches.                                                                            |
| `engine/adapters/evolution-go-events.ts`             | Remote event name → the right engine callback.                                                                                                          |
| `engine/adapters/evolution-go-ingress.controller.ts` | The public route the service POSTs to.                                                                                                                  |
| `engine/adapters/evolution-go-media-host.ts`         | Persists outbound bytes and mints a signed, expiring URL.                                                                                               |
| `engine/adapters/evolution-go-media.controller.ts`   | Serves those bytes to the service.                                                                                                                      |
| `engine/adapters/evolution-go-media-sweeper.ts`      | Evicts expired blobs on a timer.                                                                                                                        |
| `engine/builtin/evolution-go/index.ts`               | The plugin: registers, validates config, constructs adapters.                                                                                           |
| `evolution-go/`                                      | The engine's own deployment (compose, env example, runbook).                                                                                            |

---

## 32.3 Adaptations made to this repository

These are the places where the gateway itself had to change, as opposed to code that is purely
additive.

### 32.3.1 Ids are normalised at the boundary

The service speaks what the wire speaks: `@s.whatsapp.net`, sometimes with a `:device` suffix, and
`@lid` privacy ids. This gateway's contract forbids `@s.whatsapp.net` and any `:device` suffix.

Everything crossing the boundary is therefore translated, in both directions, in one place. The
phone number is not a field on the instance record — it lives **inside the JID**, device suffix and
all — so `markReady` parses it out of `jid` rather than reading a `phone` property that does not
exist. The profile name is not there either; it comes from `/instance/status` as `Name`.

### 32.3.2 Sends are confirmed by id, not by status code

The service answers **HTTP 200 with an empty `data.Info.ID`** when WhatsApp refused the message —
unknown number, no account, a refused reach-out. A caller that trusts the status code marks a
message SENT that never left. `readSendResult` is the single place that decides, and a missing id
is an error.

### 32.3.3 Two credential levels, and getting them wrong is silent

Instance-scoped routes authenticate with the **instance token**; management routes authenticate with
the **global key**. Using the wrong one answers 401.

That is not always loud. `/instance/info/{id}` is admin-scoped, and the profile read that uses it is
best-effort — so presenting the instance token there produces a session that connects perfectly with
**no number and no name**, and nothing in the logs says why.

### 32.3.4 Readiness is reconciled, not awaited

The service emits `Connected` / `PairSuccess` on a **transition**. A gateway that restarts against
an instance which is still linked never receives one — the event has already happened. Waiting for
it leaves the session stuck at `initializing` forever while the phone shows it as connected, and the
liveness watchdog then declares it dead and starts a reconnect loop that can never converge, because
every new adapter waits for the same event that will never be sent again.

`initialize()` therefore **reads** the current connection state after connecting and adopts it.

### 32.3.5 Media is hosted, not inlined

Described in 32.1. The gateway stores the bytes through `StorageService` and publishes them at a
signed URL whose token carries the session, storage key, expiry, mimetype and filename. The service
fetches it from inside its own send call, which is synchronous — so a short TTL is safe and the
sweep can be aggressive.

A caller-supplied `http(s)` URL is passed straight through: nothing is copied for the common case.

### 32.3.6 The inbound route is public, and that is a deliberate trade

The engine's webhook is **unsigned** — no HMAC, no signature header. The route is therefore
`@Public` and carries its own credential in the path, compared in constant time. An unset secret
refuses everything rather than accepting everything.

This is mitigation, not authentication. A forged inbound message is indistinguishable from a real one
downstream, so this route is expected to stay on the internal network.

Events the gateway ignores are answered **200 with a reason**, never an error: the service retries a
non-2xx webhook five times, so answering an unroutable event with a failure loops forever.

### 32.3.7 The chat list is derived from stored messages

The service has **no chat-list route**. See 32.4. The dashboard's Chats page is therefore fed from
the gateway's own `messages` table, in `SessionService.getChats`, as a fallback that runs **only**
when the engine reports the capability as missing. Any other failure still propagates, so an
unreachable engine cannot hide behind a stale local list.

Fields nothing tracks locally — unread count, pin, mute, archive — come back `false` rather than as a
guess.

### 32.3.8 History rows carry the chat name

The live persistence path derived a row's `chatName` from the message's contact; the history path
did not. A chat known only from a backfill therefore rendered as its raw JID in the chat list —
which is the exact case history exists to fix. The history projector now derives it the same way, and
the mapper supplies the conversation's name when the sender has no push name.

### 32.3.10 The chat transcript is derived from stored messages

The service has no route to read a chat's messages either, so `getChatHistory` answered 501 and the
dashboard's conversation view was empty — the same shape of problem as the chat list, and fixed the
same way: on a missing capability, and only then, the transcript is rebuilt from the `messages`
table, newest first to match the engine contract.

The reconstruction is lossy by nature — the gateway serves what it stored, and fields it never kept
are absent rather than invented. Media comes from the row when the caller asks for it; nothing is
downloaded, because there is no fetch to perform and therefore no download budget to ration.

### 32.3.11 Marking a chat read resolves its own message ids

`POST /message/markread` requires the message-id array, and the operation the dashboard performs —
"mark this conversation read" — supplies none. The adapter refuses that call deliberately, because a
chat-wide read is not something the remote endpoint can express.

Refusing turned out to be the wrong end of the trade: it left a visible action in the UI permanently
broken. The gateway already knows the chat's messages, so it resolves the most recent ids from the
store and acknowledges those. Engines that can mark a whole chat in one call are unaffected — the
call shape they receive is unchanged.

### 32.3.9 Both JSON conventions are read

The service marshals the same structs two ways: **Go field names** (PascalCase) on the webhook, and
**json tags** (camelCase) on REST. Reading only one spelling makes a working deployment look empty.
The mapper reads both, everywhere.

---

## 32.4 What this engine cannot do

Forty-one of the 112 interface methods answer **501**. These are properties of the remote contract,
not gaps in the adapter — no wiring here can serve them. Full list in
[29 — Engine Capability Matrix](./29-engine-capability-matrix.md); the ones that matter in practice:

| Missing                                                                          | Impact                                               | Workaround                                                                                             |
| -------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `getChats`                                                                       | No native chat list.                                 | Derived from stored messages (32.3.7).                                                                 |
| `getChatHistory`                                                                 | No message-history read.                             | Served from stored messages, newest first (32.3.10). Pre-connection history still needs a sync (32.5). |
| `getCatalog`, `getProducts`, `sendProduct`, `sendCatalog`                        | No WhatsApp Business catalog at all.                 | None.                                                                                                  |
| `getContactStatuses`, `getContactStatus`, `deleteStatus`                         | Statuses can be posted, never read back or deleted.  | None.                                                                                                  |
| `getGroupMembershipRequests`, `approve…`, `reject…`                              | No join-approval workflow.                           | None.                                                                                                  |
| `forwardMessage`, `starMessage`, `votePoll`                                      | No forward, star or poll-vote.                       | None.                                                                                                  |
| `pinMessage`, `unpinMessage`, `getMessageReactions`                              | No per-message pin; reactions are sent but not read. | None.                                                                                                  |
| `markUnread`                                                                     | Marking a chat **un**read has no route.              | None. `sendSeen` works either way — see 32.3.11.                                                       |
| `deleteChannel`, `muteChannel`, `demoteChannelAdmin`, `transferChannelOwnership` | Newsletter administration.                           | None.                                                                                                  |
| `upsertContact`, `deleteContact`                                                 | Contacts are read-only (block/unblock works).        | None.                                                                                                  |

### 32.4.1 Supported, but the service marks them broken upstream

The service's own router carries `// TODO: not working` on `/chat/pin`, `/chat/unpin`,
`/chat/archive`, `/chat/unarchive`, `/chat/mute` and `/chat/unmute`, while its published
documentation presents them as working. The adapter wires them faithfully; they are listed as
`supported` because it calls the documented endpoint, not because the call is known to take effect.

Two further quirks of that group:

- **`mute` is hard-coded to one hour.** The duration is not a parameter — the service ignores any
  other value. A caller asking for eight hours gets one, silently.
- `GET /group/myall` is documented upstream as not working, so `getGroups` uses `GET /group/list`.

---

## 32.5 History sync

The only source of pre-connection history is the service's `HistorySync` event, gated by the
`HISTORY_SYNC` subscription token. **It is pushed once, when a device is newly linked.**

That single fact drives the subscription default: a deployment that omits `HISTORY_SYNC` never
receives history at all, and there is no second chance. The default list therefore includes it, along
with `READ_RECEIPT` (without which an outgoing message never advances past "sent") and
`CHAT_PRESENCE` (the other party typing).

Received batches go to `onHistoryMessages`, which is deliberately **not** `onMessage`: these
messages predate the live session, so consumers persist them for the chat view and must not dispatch
them. Replaying a week-old message through the normal path would fire webhooks and hooks for
something that is not happening.

### 32.5.1 The explicit trigger is unreliable

`POST /chat/history-sync` exists and is documented, but in practice it fails against chats this
device has never exchanged signal messages with:

```
error history sync request: failed to encrypt peer message for …@s.whatsapp.net:
can't encrypt message for device: no signal session established with …:0
```

The request has to be encrypted to the recipient's device, which requires an established Signal
session. Do not promise an operator that history can be pulled on demand for an arbitrary chat.

**Practical consequence:** a session that was paired _before_ `HISTORY_SYNC` was subscribed has
missed its window. Re-linking the device is what triggers a fresh initial sync.

---

## 32.6 Events

Subscription tokens are SCREAMING_SNAKE and are **not** the same strings as the emitted event names.
Subscribing to `MESSAGE` is what makes `Message` arrive.

| Emitted event                    | Engine callback                   | Notes                                                                                                   |
| -------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `Message`                        | `onMessage` / `onMessageCreate`   | Split on `Info.IsFromMe`.                                                                               |
| `SendMessage`                    | `onMessageCreate`                 | Echo of our own send.                                                                                   |
| `Receipt`                        | `onMessageAck`                    | Carries a **`MessageIDs` array** and a `Type` — a different shape from a receipt embedded in a message. |
| `Connected`                      | `onReady`                         | Payload is `{status, jid, pushName}`.                                                                   |
| `Disconnected`, `ConnectFailure` | `onDisconnected`                  |                                                                                                         |
| `LoggedOut`                      | `onError` **or** `onDisconnected` | See below.                                                                                              |
| `TemporaryBan`                   | `onAccountRestriction`            | WhatsApp's own restriction notice.                                                                      |
| `QRCode`                         | `onQRCode`                        | The name is `QRCode`, not `QrCode` — the sibling integration's guess. Both are accepted.                |
| `QRTimeout`                      | —                                 | The code expired unscanned. **Not** a failure.                                                          |
| `HistorySync`                    | `onHistoryMessages`               | See 32.5.                                                                                               |
| `ChatPresence`                   | `onPresenceUpdate`                | Composing / recording.                                                                                  |
| `Group`                          | `onGroupEvent`                    |                                                                                                         |
| `Call`                           | `onCall` / `onCallOutcome`        |                                                                                                         |

### 32.6.1 `LoggedOut` means two different things

It fires both when the account was genuinely unlinked **and** when a never-scanned QR expires and the
service gives up. Only the session's own history can tell them apart: a session that has a phone
number was linked at some point, so that one is terminal; one that never reached `ready` merely
expired, and reporting it as "the account was logged out" would be a false alarm that strands a
session needing only a new QR.

---

## 32.7 Deployment

See [`evolution-go/docs/RUNBOOK.md`](../evolution-go/docs/RUNBOOK.md) for the operational detail.
The two settings that are easy to get wrong:

- **`EVOLUTION_GO_CALLBACK_BASE_URL`** must be an address the **engine container** can resolve. A
  loopback value resolves to the engine itself, so the webhook and every media send fail while the
  send still answers 200.
- **`WEBHOOK_FILES=true`** is required for inbound media. Without it the service sends a media
  message as a **descriptor only** — mimetype, size, keys — and the gateway has nothing to serve, so
  every image or audio click answers 404. The cost is payload size: the webhook body grows by the
  base64 of each attachment, bounded by the gateway's `BODY_SIZE_LIMIT`.
- **`NODE_ID`** should be pinned. It defaults to the container hostname, which changes on every
  recreate — and a stale claim then blocks `start` for up to `SESSION_LEASE_TTL_MS`.

Pairing `AUTO_START_SESSIONS=true` with a pinned `NODE_ID` means a container restart brings linked
sessions back without manual intervention.

---

## 32.8 Trade-offs worth stating plainly

- **Ban risk does not improve.** `whatsmeow` is the same family as Baileys — a direct multi-device
  protocol client, not a browser. The gateway README is explicit that whatsapp-web.js carries the
  lowest risk precisely because Chromium looks like real WhatsApp Web traffic. What this engine buys
  is **resource density**, not account safety.
- **The gateway is no longer self-contained.** It now depends on a reachable service, its own
  database, and its licence. Pin the image by digest; a silent update has already changed this
  service's contract once.
- **Coverage is lower than either built-in engine** (71 of 112 methods, against 100 for Baileys and
  99 for whatsapp-web.js). Choose it for the operational profile, and check 32.4 first.
