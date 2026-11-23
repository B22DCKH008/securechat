# BE2 handoff — realtime, Kafka consumer, presence

Started 2026-11-21 on branch `be2`, continuing from the [BE1 handoff](be1-handoff.md).
Owner: BE/Protocol 2. Fresh evidence and remaining limits are in
[verification-be2](verification-be2.md). Local BE2 results do not establish any
complete team weekly gate.

No existing REST path, camelCase JSON field, integer device ID or Kafka
topic/key changed meaning. The consumer/presence work added configuration,
metrics and Kafka record headers. Group chat (2026-11-22, section below) added
REST paths, optional JSON fields and MessageAccepted `schemaVersion` 2 fields;
1-1 requests and events are unchanged apart from the version number and the
additive `kind` field on stored messages.

## Status of the BE1 → BE2 checklist

| Item from BE1 handoff | State | Evidence / note |
| --- | --- | --- |
| DLQ/offset failure (open P1), KF5/KF6/KF11 | DONE (fixed) | Unit + real-broker case `TestDLQOutageDoesNotCommitPastPoison`: no commit past a poison event while DLQ publishing fails, replay after recovery without restart and after a consumer restart, later event in the same partition handled, other partition progresses |
| Dedupe remembered eventId before validation | DONE (fixed) | `Router.Handle` remembers the eventId only after typed payload validation and push; failed events are not turned into dedupe successes |
| `chat.retry` TODO | DONE (SHOULD) | Transient handler failures are copied to `chat.retry`, re-handled after exponential backoff with jitter, then `chat.dlq` after `KAFKA_RETRY_MAX_ATTEMPTS` |
| Consumer lag (KF9/INF4) | DONE (metric) | `securechat_kafka_consumer_lag{group,topic}` via kadm; real-broker lag assertion in the P1 case |
| Connection-scoped presence expiry (RS14) and dead-instance cleanup (RS29) | DONE | Per-connection field TTL (Redis 7.4 `HEXPIRE`) and instance index cleanup; real-Redis case |
| `DELIVERY_TRANSPORT=redis` had no publisher (KF16) | DONE (experiment path) | Relay uses `RedisPublisher`; real-Redis publisher → subscriber → router case. Still non-durable by design |
| k6 scripts used disabled dev-login | DONE | Scripts register real accounts; measure accepted/e2e latency, missing/duplicate |
| Auth/session, frame limits, late receipts contracts | Unchanged, still need FE1 acceptance | Existing BE1 regression cases still PASS |
| Signal/client privacy | FE1 | Not addressed by backend work |

## Consumer offset and DLQ semantics (KF5, KF6, KF11)

`internal/delivery/kafka_consumer.go` processes each fetched partition in order:

1. Successful handling (pushed to local sockets, or recipient not on this
   instance) completes a record.
2. A `PermanentError` (malformed envelope, invalid typed payload) completes only
   after the copy to `chat.dlq` is acknowledged by the broker.
3. Any other error completes only after a copy to `chat.retry` is acknowledged.
   With retry disabled (empty topic) the record is not completed.
4. The first record that does not complete **stops that partition**: it and
   every later record of that partition are left uncommitted, the fetch position
   is rewound with `SetOffsets` to the failed offset and the poll loop backs off
   (200 ms doubling to 10 s, jittered). Other partitions keep committing.
5. Only the contiguous completed prefix per partition is passed to
   `CommitRecords`. Consumers use `BlockRebalanceOnPoll`, so a rebalance cannot
   interleave with the commit/rewind decision; `AllowRebalance` is called after
   every poll, including on exit (otherwise `Close` blocks forever).

DLQ/retry copies keep key (conversationId) and value unchanged and add headers:
`dlq.sourceTopic`, `dlq.reason` (`permanent` | `retries_exhausted`), and for
retries `retry.group`, `retry.attempt`, `retry.notBefore` (unix ms). The free-text
`dlq.error` header from the previous code was replaced by a reason category so
decoder messages cannot copy payload fragments into headers.

At-least-once still applies: a DLQ or retry copy can be duplicated if the
process stops after the broker ACK but before the source commit. Investigation
tooling must dedupe DLQ records by `eventId`.

### Retry topic

`chat.retry` is shared by all instances. Each instance runs a second consumer
group `<KAFKA_CONSUMER_GROUP>.retry` that skips records whose `retry.group` is
not its own (and commits them). Delay for attempt *n* is
`min(base·2^(n-1), max)` with full jitter in the upper half, bounded by
`KAFKA_RETRY_MAX_DELAY` even for skewed headers. A record retried through
`chat.retry` can be pushed after later events of the same conversation; clients
already order by `seq` and sync on gaps (KF4). Today `Router` has no transient
failure source (pushes are non-blocking), so the path is exercised by unit tests
with an injected handler; it exists for future handlers.

## Consumer lag (KF9, INF4)

Each instance exports, every `KAFKA_LAG_INTERVAL` (default 15 s, 0 disables):
`securechat_kafka_consumer_lag{group="gw-A",topic="chat.messages"}` = log end
offset − committed offset, summed over partitions. Partitions **without** a
committed offset are excluded (a start-from-latest group never commits an idle
partition, and its retained history is not lag). Errors increment
`securechat_kafka_consumer_lag_errors_total`. Also new:
`securechat_delivery_dlq_publish_failed_total`,
`securechat_delivery_events_retried_total`,
`securechat_delivery_partition_blocked_total`,
`securechat_presence_errors_total{op}`. `securechat_delivery_events_dlq_total`
now counts only acknowledged DLQ copies.

## Presence (RS12, RS14, RS20, RS29)

Requires Redis ≥ 7.4 (Compose uses `redis:7.4-alpine`).

```
HASH presence:user:<userId>        field <connId> = <instanceId>, per-field TTL
SET  presence:instance:<instanceId> member "<userId>|<connId>"
```

- Register sets the field, its TTL, the key TTL and the instance index.
- Every WebSocket heartbeat refreshes **that connection's** field TTL
  (`gateway.Presence.Refresh(ctx, userID, connID)` — interface change inside
  BE2-owned gateway wiring). A missing field (e.g. Redis restart) is recreated.
- `CleanupInstance` deletes the fields this instance registered, only where the
  value still equals its instance ID (Lua compare-and-delete). The server calls
  it on startup (bounded 3 s) and after graceful shutdown.
- `PRESENCE_TTL` must exceed `WS_PING_INTERVAL + WS_PONG_TIMEOUT` (startup check).
- Presence is advisory: failures are counted and logged; delivery still uses the
  Kafka broadcast and PostgreSQL sync. No public presence API exists yet; exposing
  it needs an authorization decision (contacts only) with FE1.

## Redis transport (KF16, EXP13)

`DELIVERY_TRANSPORT=redis` now makes the relay publish the unchanged envelope to
a Redis channel named after the topic (`chat.messages`, `chat.receipts`) and
every instance subscribes. The outbox row is marked published after Redis
accepts the PUBLISH, so instances that are down miss realtime delivery and
recover only through `POST /v1/sync`. It is a comparison mode, not a fallback
with Kafka-equivalent durability. Retry/DLQ/lag do not apply in this mode.

## Load scripts (EXP1/EXP2/EXP3/EXP5/EXP11)

`bench/k6/lib.js` registers real accounts (retrying on HTTP 429 auth limits).
`send_messages.js` pairs a sender on `BASE_A` with a recipient on `BASE_B`,
measures `ws_accept_latency`, `ws_e2e_latency`, `ws_sent/ws_delivered`, and fails
thresholds on any `ws_missing`, `ws_duplicate` or `ws_send_errors`.
`reconnect_storm.js` measures `ws_connect_success` and connect-to-`resync`
latency with optional `JITTER_S`. Scripts need k6 ≥ 0.52 (`k6/experimental/websockets`,
`k6/timers`); the verification run used `grafana/k6:0.54.0`. Payloads are opaque
fixture bytes and measure transport, not Signal encryption.

## Configuration added

| Variable | Default | Meaning |
| --- | --- | --- |
| `KAFKA_RETRY_MAX_ATTEMPTS` | 5 | Retry copies before DLQ |
| `KAFKA_RETRY_BASE_DELAY` | 500ms | First retry delay |
| `KAFKA_RETRY_MAX_DELAY` | 30s | Delay cap (≤ 5m) |
| `KAFKA_LAG_INTERVAL` | 15s | Lag metric refresh, 0 disables |

New dependency: `github.com/twmb/franz-go/pkg/kadm v1.19.0` (requires
franz-go v1.22.0/kmsg v1.14.0, so existing pinned versions are unchanged).

## Group chat — pairwise fan-out (RS31, RS34, KF17), 2026-11-22

Decision (user, 2026-11-22): **pairwise fan-out**. The client encrypts one
Signal ciphertext per member with its existing 1:1 session; the server stores
opaque copies. No Sender Keys, no server-side group key.

Migration `000004_group_chat` (forward only):

| Change | Purpose |
| --- | --- |
| `conversations.title`, `created_by` | group metadata |
| `conversation_members.role` (`owner`/`member`, one owner per group), `joined_seq` | permissions, history visibility |
| `messages.kind` (`message`/`system`), `system_event` JSONB | membership changes take a seq |
| `message_recipients(message_id, recipient_id, device_id, ciphertext, protocol_meta)` | one copy per recipient; `messages.ciphertext` is empty for groups |
| `conversation_departures(conversation_id, user_id, left_seq, left_at)` | removed users' sync learns why |

REST (all authenticated):

| Path | Rule |
| --- | --- |
| `POST /v1/conversations/group` `{title, memberUserIds}` | caller = owner; ≤ 32 members incl. owner; seq 1 = `group_created` |
| `GET /v1/conversations/{id}/members` | members only; the list a client encrypts for |
| `POST /v1/conversations/{id}/members` `{userIds}` | owner only; existing members ignored (no-op if none new) |
| `DELETE /v1/conversations/{id}/members/{userId}` | owner removes; anyone removes itself (leave); owner leaving promotes the earliest member |
| `PATCH /v1/conversations/{id}` `{title}` | owner only |

Send (`POST .../messages` and WS `send`): groups send `ciphertexts:
[{recipientId, deviceId?, ciphertext, protocolMeta?}]` instead of
`ciphertext`. Inside the same transaction that allocates the seq (conversation
row lock, which every membership change also takes), the server requires
exactly one copy for every current member except the sender; otherwise
`409 membership_changed` / WS `error.code=membership_changed` and nothing is
stored or sequenced. Sending `ciphertext` to a group or `ciphertexts` to a
direct conversation is `400`. The sum of copies plus their `protocolMeta`
(≤ 1024 B each) is bounded by `WS_MAX_MESSAGE_BYTES`, so a group send fits the
existing WS frame budget and stays far below Kafka's record limit. Idempotent
retries compare the copies too (JSONB-equal metadata).

Reading:

- History/sync return each reader **its own copy** in `ciphertext`/
  `protocolMeta`. The sender's own group messages come back with an empty
  ciphertext (the client keeps its own plaintext locally, as in 1:1).
- A member added later sees `seq > joinedSeq`, starting with the
  `members_added` message that announces it; receipts for earlier messages are
  hidden from it and it cannot acknowledge them.
- Membership changes are `kind:"system"` messages with `system: {type, actorId,
  userIds?, title?, newOwnerId?}` and their own seq, so cursor sync stays
  gapless. They carry no ciphertext and accept no receipts.
- A removed/departed user loses server-side access at once (history, send,
  receipts). It is still a recipient of the `member_removed`/`member_left`
  event. A later `POST /v1/sync` with its old cursor returns the group in
  `left: [{conversationId, leftSeq, leftAt}]` instead of failing; a cursor for
  a conversation the user never belonged to is still 403.
- If the last member leaves, the system message is stored without an outbox
  event (a recipientless event would be a consumer poison record).

Kafka / gateway: `MessageAccepted` (now `schemaVersion: 2`) gains additive
`kind`, `system` and `ciphertexts`. The router pushes each recipient a frame in
which `ciphertext`/`protocolMeta` are replaced by its own copy and `ciphertexts`
is removed, so a socket never receives other members' copies. A group copy
without recipient/ciphertext is a `PermanentError` (DLQ). New metric
`securechat_group_fanout_recipients`.

Lock order (deadlock avoidance): member row(s) → conversation row. Send,
Acknowledge, add and rename lock the caller's member row then the conversation;
remove locks all member rows (sorted) first because owner promotion updates
another member's row.

Not done / next decisions:

- Multi-device: one copy per recipient (`device_id` stored, PK is
  `(message_id, recipient_id)`); RS9/SC4 still need a joint decision.
- Sender Keys (RS35), admin roles, invite links and a large-group fan-out
  benchmark (RS33, k6) are not implemented.
- Receipts are still pushed in realtime only to the message sender; other
  members see them through sync.
- Per-user rate limits do not yet weigh group size (RS30).

## Remaining work and coordination

- FE1: client reconnect with backoff + full jitter, `resync` handling, gap sync,
  real Signal sessions, plaintext marker inspection (SC1/SC2/SC7/KF12).
- BE2 next: WS token through a subprotocol instead of query string (RS11),
  per-user token-bucket limits (RS30), routing by user/partition comparison (KF7),
  multi-instance k6 runs at 50/100 VUs and EXP12 with live WebSocket recipients
  on a machine with enough memory.
- Multi-device ciphertext (RS9/SC4) still needs a joint contract decision.
- FE1 for groups: member list → session per member → N copies; handle
  `membership_changed`, `kind:"system"` messages and sync `left`.
