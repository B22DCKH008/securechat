# BE1 handoff

Implementation date: 2026-11-09. Fresh evidence and limits are tracked in
[verification](verification-be1.md) and the [project plan](PROJECT_PLAN.md).

## BE2 acceptance checklist — updated 2026-11-12

This is a handoff for continued integration. BE2/FE1 acceptance is pending;
the complete team weekly gates and production readiness are not certified.

BE1 checks on 2026-11-12: 17 Windows unit cases, vet/module/OpenAPI validation,
and Linux race with 17 unit + 20 real PostgreSQL/Kafka integration cases PASS.
The two rebuilt runtime images also pass health/readiness and access-log marker
checks. Actual Kafka outage + backend restart + recovery PASS: five unique
messages, one receipt, backlog 6 to 0; both gateways ready afterward. BE1 is ready
to hand off for integration with the P1 consumer issue below explicitly open.
See [verification](verification-be1.md) for exact evidence and remaining limits;
these backend checks do not prove real Signal encryption/decryption.

| Item | Owner | Acceptance evidence required |
| --- | --- | --- |
| Auth/session contract | BE2 + FE1 | REST and WS reject revoked/expired sessions; reconnect and sync after serialized refresh; dev-login stays disabled |
| Ciphertext/frame limits | BE1 + BE2 | 65,536 decoded bytes accepted over WS and REST; 65,537 rejected without persistence; oversized transport message closes with 1009 |
| Durable send and replay | BE1 + BE2 | Retry retains message/seq/event identity; consumer and client dedupe at-least-once events; accepted is distinct from delivered/read |
| Late receipts | BE2 + FE1 | Preserve independent message/receipt cursors; old-message read ACK remains visible after advancing message cursor |
| DLQ/offset failure (open P1) | BE2 | Broker failure while publishing poison event must not advance source offset past failure; recovery/restart replays and eventually reaches DLQ |
| Realtime/system follow-up | BE2 | Connection-scoped presence expiry, consumer lag, reconnect/rebalance, bounded queues and system load evidence |
| Signal/client privacy | FE1, BE2 supports key integration | Real encrypt/decrypt and key/session handling; complete plaintext-marker inspection (SC1/SC2/SC7/KF12) |

Suggested review order: [OpenAPI](../backend/api/openapi.yaml),
[WS protocol](api/websocket-protocol.md),
[event schemas](../backend/api/events/message_accepted.v1.json),
`internal/service/messaging`, `internal/outbox`, then shared
`cmd/server`, `internal/gateway` and `internal/delivery`.

Migrations 000002 (auth) and 000003 (receipt feed) are forward additions;
000001 is unchanged. Stop old receipt writers before migration 000003: mixed
writers do not maintain the new receipt change feed. Do not run a down migration
or remove volumes as a handoff step.

## Payload and logging limits

`WS_MAX_MESSAGE_BYTES` retains its existing meaning as the decoded ciphertext
limit shared by REST and WS (default 65,536). New `WS_MAX_FRAME_BYTES` bounds the
entire inbound WS JSON message (default 131,072), including base64, protocolMeta,
ref and framing. Startup requires at least
`4 * ceil(WS_MAX_MESSAGE_BYTES / 3) + 8192` frame bytes; increase both settings
together for a larger payload. The reserve covers bounded metadata/IDs and a
normal correlation ref; arbitrary extra fields, padding or an oversized ref
still count toward the frame limit. Protocol metadata remains limited to 4 KiB;
REST request bodies remain limited to 1 MiB.

Oversized ciphertext within a valid frame returns WS `error.code=invalid` and
keeps the socket usable; exceeding the complete WS message budget closes with
1009. Client WS libraries must also allow incoming `message` frames larger than
the base64 ciphertext plus the event envelope (a 128 KiB read limit accommodates
the default payload). Preserve these distinct limits in BE2 wiring.

Go integration points: `gateway.Options.MaxFrameBytes` replaces the ambiguous
`MaxMessageBytes` option. `messaging.New` still receives the decoded ciphertext
budget. `gateway.TokenVerifier.Verify(context.Context, string)` returns
`auth.Principal`; use the session-aware `auth.Service`, not the JWT-only issuer,
for gateway authentication and periodic revocation checks.

Access log `path` now records a method-specific route template, e.g.
`/v1/conversations/{id}/messages`, or `unmatched` for rejected/unclassified
requests. Raw identifiers, queries and bodies are omitted. Methodless routes
use the safe fallback; future routes should retain method-specific patterns.

## Open BE2 blocker: DLQ replay (KF5/KF6/KF11)

`internal/delivery/kafka_consumer.go` currently ignores `sendToDLQ` failure and
still adds the record to the commit batch. A subsequent `CommitRecords` can
advance beyond the poison event. PostgreSQL messages remain durable, but the
failed event is lost from the intended DLQ workflow. This consumer fix is owned
by BE2 and is not included in the BE1 changes.

BE2 reproduction/acceptance procedure, in an isolated test topic and group:

1. Put a poison event with a valid envelope/eventId but invalid typed payload
   before another event in the same source partition. Also exercise malformed
   envelopes (no usable eventId).
2. Make DLQ publishing fail (injected producer failure or denied DLQ write) while
   source polling/committing remains available. Assert the committed offset does
   not pass the poison event, including after a later poll on that partition.
3. Restore DLQ publishing without restarting the process: assert replay reaches
   DLQ. Repeat with a consumer restart and verify the following event is handled.
4. Check `delivery.Router` dedupe: it currently remembers an eventId before
   typed payload validation. A replay must not turn a previously failed poison
   event into a dedupe success and incorrectly allow a commit.
5. Keep other partitions progressing, preserve source order within the blocked
   partition, and commit only completed work. Merely removing one record from a
   commit batch is insufficient if a later offset in that partition is committed.
   A skipped in-memory fetched record also needs explicit retry/seek handling.

Retain evidence for DLQ duplicates (at-least-once is expected), offset position,
recovery and later-message delivery. Also resolve transient-handler retry;
`chat.retry` is still TODO. `DELIVERY_TRANSPORT=redis` has a subscriber but no
relay publisher, so use `kafka`; Redis fallback is not operational.

## Authentication

`POST /v1/auth/register` and `/login` accept `username`, `password` and optional
integer `deviceId` (default 1). Registration creates that device. Login accepts
only an existing device; enrolling another device needs a separate agreed flow.
Username is case-sensitive ASCII letters/digits/underscore, 3–32 characters.
Passwords are 12–1024 UTF-8 bytes, hashed using a domain-separated SHA-256 digest
and bcrypt cost 12. Only the hash is persisted. Passwordless dev accounts are
not claimed through registration or silently assigned a password.

Response: `{userId, deviceId, accessToken, refreshToken, expiresAt}`. Access tokens
default to 15 minutes. Refresh tokens expire after 30 days; the database stores
only their SHA-256 hashes. `/refresh` consumes `{refreshToken}` exactly once.
Refresh rotates the session and invalidates the preceding access token. Reusing
a consumed refresh token revokes the entire family, including a concurrent
refresh winner. Clients must serialize refresh and atomically replace tokens.

`POST /v1/auth/logout` requires the bearer access token and revokes its family.
REST and WS handshake validate the current session. Active WS connections
revalidate on every incoming text frame and heartbeat; logout/expiry closes
idle sockets by the next heartbeat. Requests already admitted can finish.
Clients reconnect and run sync after refreshing credentials.

`AUTH_DEV_LOGIN_ENABLED` defaults to false. Dev tokens are accepted only when
explicitly enabled. Authentication responses use `Cache-Control: no-store`.
Auth operations have basic IP/username limits and bounded password hashing.
The existing Redis limiter fails open on Redis outage; this is a known limit,
not a production brute-force protection guarantee.

## Messaging and receipt contract

Existing REST paths, camelCase fields, user-level ciphertext, event types and
topic keys remain. `clientMessageId` is unique per sender. Reusing it with a
different conversation, ciphertext, protocolMeta or clientCreatedAt returns HTTP
409 / WS `idempotency_conflict`. Object key order and JSON numeric formatting do
not create false conflicts (PostgreSQL JSONB comparison). Client timestamps are
normalized to microsecond precision for PostgreSQL round trips.

Only a non-sender conversation member can send delivered/read receipts. Read
implies delivered and never moves backward. Repeated ACKs emit no additional
outbox event. Acceptance does not imply broker publication or recipient receipt.

`POST /v1/sync` adds `receiptCursors: {conversationId: lastReceiptSeq}` alongside
the existing message `cursors`. Each returned conversation adds `receipts`,
`nextReceiptCursor`, and `hasMoreReceipts`. The two cursors are independent: a
read ACK for an old message can arrive after the message cursor has advanced.
Clients persist receipt state and its cursor together; receiving a realtime
receipt alone must not skip unseen earlier revisions in the durable feed.
Merge receipt states monotonically and dedupe with conversationId/receiptSeq.
Clients without receiptCursors get a bounded replay from zero.

Message pages are bounded by row count and approximately 1 MiB serialized payload
per conversation. Limits are 1–200, with omitted/zero sync limit defaulting to 50.
Unknown or unauthorized conversation cursors return forbidden. History uses
numeric before_seq keyset pagination. Multiple conversations still incur
per-conversation DB queries; no performance claim is made for huge inboxes.

Kafka receipt payloads add optional `receiptSeq`, preserving event version 1.
Message and receipt events are at-least-once; consumers/clients still dedupe.
The relay serializes publishing and marks only after ACK, on its lock session.
Loss of that session cancels in-flight publishing; an ambiguous result can be
replayed with the same eventId. Global head retries can delay other conversations.

## Running checks

From the inner `securechat` directory:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
# Replace JWT_SECRET with a random secret of at least 32 bytes; example is rejected.
docker compose -p securechat-be1 up -d --build
docker compose -p securechat-be1 -f docker-compose.yml -f compose.test.yml run --rm be1-test
./scripts/verify-be1.ps1 -Project securechat-be1
```

Host ports can be overridden in `.env`. The local verification environment uses
25432/26379/29094 for PostgreSQL/Redis/Kafka and 28081/28082 for gateways:

```powershell
./scripts/verify-be1.ps1 -Project securechat-be1 -BaseA http://localhost:28081 -BaseB http://localhost:28082
cd backend
$env:POSTGRES_DSN='postgres://securechat:securechat@localhost:25432/securechat?sslmode=disable'
go run ./cmd/dbbench -out ../docs/experiments/be1-db.json
```

The outage script stops only the named Compose project's Kafka and restarts
backend-a. Its finally block restores Kafka. It keeps fixture accounts/messages
as verification evidence and never removes database volumes. Use it against a
dedicated local project. Database benchmarks create and drop a generated private
schema; they do not benchmark the user's existing tables.

## Remaining coordination

BE2 owns consumer lag, retry/DLQ, presence refinements, reconnect storm and system
load tests. FE1 owns Signal interoperability, local key/session storage, sender
self-copy, gap detection, UI and real plaintext leakage verification. No backend
test using opaque fixture bytes proves client-side encryption. Multi-device
ciphertext and signed cursors from ChatE2e need an explicit contract decision.
