# BE2 verification — 2026-11-21

Scope: BE2 work on branch `be2` on top of `596600a` (BE1 merge). Contract and
semantics are in the [BE2 handoff](be2-handoff.md). These results cover the
tested backend scenarios only; they do not establish real Signal E2EE, client
AI or the complete team weekly gates.

Environment: Linux 6.14 host, 4 vCPU, 7.7 GiB RAM (another unrelated Compose
project was running and was not touched). Go 1.27.3 in `golang:1.27.3` with
`GOMAXPROCS=2 GOFLAGS=-p=1 GOMEMLIMIT=256MiB`. Dedicated Compose project
`securechat-be2`: PostgreSQL 16.16, Redis 7.4.12, Kafka 3.8.0 KRaft single
broker (RF=1, no HA), host ports 25432/26379/29094/28081/28082 on loopback.
No volumes were deleted.

## Results

| Check | Result |
| --- | --- |
| `go vet ./...` and `go vet -tags=integration ./...` | PASS |
| `gofmt -l .` | clean |
| `go test -count=1 ./...` (unit) | PASS |
| Linux race + real PostgreSQL/Kafka/Redis (`compose.test.yml`) | PASS, exit 0: **49 top-level cases (26 unit + 23 integration)**, 0 failed, 0 skipped, 0 data races; integration package 188.1 s |
| Runtime images | `backend-a`/`backend-b` built with the pinned Dockerfile; both `/readyz` ready, `/healthz` ok |
| k6 cross-instance send (sender on gw-A, recipient on gw-B), 5 VUs, 30 s | 1,320 sent / 1,320 delivered, **0 missing, 0 duplicate, 0 send errors** |
| k6 reconnect storm, 50 VUs, no jitter, gw-B | 50/50 upgraded and received `resync` |
| Runtime poison event in `chat.messages` | one DLQ copy per instance group (2 total), lag returned to 0, payload absent from logs |

[Test case list](experiments/be2-test-summary-2026-11-21.json),
[raw race/integration log](experiments/be2-race-integration-2026-11-21.log),
[k6 send summary](experiments/be2-k6-send-cross-5vu-2026-11-21.json),
[k6 storm summary](experiments/be2-k6-storm-50vu-2026-11-21.json).

### New BE2 cases

Unit (`internal/delivery`, `internal/config`), using an in-memory partition
model with fetch position, `SetOffsets` rewind and committed offsets:
`TestDLQFailureKeepsPoisonOffsetAndReplays`,
`TestRestartAfterDLQFailureReplaysFromCommit`,
`TestTransientWithoutRetryTopicBlocksInPlace`,
`TestTransientGoesThroughRetryTopicThenDLQ`, `TestRetryPublishFailureBlocksSource`,
`TestRetryDelayBounds`, `TestWithHeadersDoesNotAliasSource`,
`TestRunAllowsRebalanceOnExit`, `TestRetryLagAndPresenceConfiguration`.

Integration on the real broker/Redis:

- `TestDLQOutageDoesNotCommitPastPoison` — isolated topics and group. Poison
  (valid eventId, invalid payload), a later good event and a malformed envelope
  in partition 0, a good event in partition 1. With DLQ publishing failing:
  partition 1 commits, partition 0 stays at offset 0 across repeated replays.
  DLQ restored without restart: both bad records reach the DLQ, partition 0
  commits to 3, the later good event is pushed. Then a second poison while the
  DLQ fails, consumer stopped and restarted after recovery: committed stays at 3
  before restart, replay reaches the DLQ, the following event is pushed once.
  Finally three records produced while stopped give `MeasureLag` = 3.
- `TestPresencePerConnectionTTLAndInstanceCleanup` — 1 s TTL: an idle
  connection expires while a heartbeating one and another instance's entry
  remain; `CleanupInstance` removes only its own entry; `Refresh` recreates a
  missing entry.
- `TestRedisTransportPublisherToSubscriber` — relay-side `RedisPublisher` →
  `RedisSubscriber` → `Router`, one push despite repeated publishes.

### Runtime measurements (indicative only)

Send run: `k6 run -e BASE_A=http://127.0.0.1:28081 -e BASE_B=http://127.0.0.1:28082
-e VUS=5 -e DURATION=30s -e MSGS=10 -e GAP_MS=100 bench/k6/send_messages.js`
(`grafana/k6:0.54.0`, host network, 256-byte opaque payload).

| Metric | p50 | p90 | p95 | max |
| --- | --- | --- | --- | --- |
| `ws_accept_latency` (send → server-accepted) | 33 ms | 88 ms | 113 ms | 469 ms |
| `ws_e2e_latency` (send → `message` frame on gw-B) | 163 ms | 307 ms | 393 ms | 1 s |
| Reconnect storm connect → `resync` (50 VUs) | 49.5 ms | 131 ms | 140 ms | 146 ms |

End-to-end includes the relay poll interval (100 ms), producer linger and the
broadcast consumer path. These numbers come from one short run on a shared
laptop-class host with both instances, Kafka, PostgreSQL and Redis on the same
machine. They are not capacity claims and not a one- vs two-instance comparison
(EXP2), which still needs equal-load runs at 10/50/100 VUs.

## Issues found and fixed during verification

1. **Shutdown hang (introduced in this work, fixed before the final run).**
   With `BlockRebalanceOnPoll`, `Run` returned on context cancellation without
   `AllowRebalance`, so `Client.Close` → `LeaveGroup` blocked forever. The first
   integration attempt hung in test cleanup. Fixed with a deferred
   `AllowRebalance`; regression `TestRunAllowsRebalanceOnExit`.
2. **Integration fixture**: committed-offset queries right after broker start
   can return `COORDINATOR_NOT_AVAILABLE`; the BE2 helper retries.
3. **Suite timeout**: on this host the unchanged BE1 cases are slower (bcrypt
   cost 12 under `-race`), so `-timeout=180s` (later 300s) aborted the package.
   `compose.test.yml` now uses `-timeout=900s` and also waits for Redis.
4. **BE1 test race** (`TestRelaySeesLateCommittedOutbox`): the recording publisher
   counts a record before the relay marks it; cancelling immediately after the
   second publish could legitimately abort that mark, and the test then failed.
   Relay/store code is unchanged; the test now waits for the mark. Flagged to
   BE1 as a test-only change.
5. **k6 Origin**: `WS_ALLOWED_ORIGINS=localhost:*` rejects the portless
   `Origin: http://localhost` (HTTP 403). Scripts now send
   `http://localhost:5173` (override with `-e ORIGIN=`). FE1 dev servers must
   use an origin that matches the pattern.

## Group chat (2026-11-22)

Pairwise fan-out backend (see [handoff](be2-handoff.md#group-chat--pairwise-fan-out-rs31-rs34-kf17-2026-11-22)),
same host and `securechat-be2` Compose project, no volumes deleted.

| Check | Result |
| --- | --- |
| `gofmt -l .`, `go vet ./...`, `go vet -tags=integration ./...` | clean / PASS |
| Linux race + real PostgreSQL/Kafka/Redis (`compose.test.yml`, full suite) | PASS, exit 0: **57 top-level cases** (49 previous + 8 new), 0 failed, 0 skipped, 0 data races; integration package 199.7 s |

[Raw log](experiments/be2-group-race-integration-2026-11-22.log).

New cases:

- Unit: `TestGroupSendValidation`, `TestValidGroupTitle`,
  `TestRouterGroupPushesEachRecipientOnlyItsCopy` (also asserts a frame does not
  contain another member's copy), `TestRouterSystemEventGoesToAllRecipients`,
  `TestRouterGroupCopyWithoutCiphertextIsPermanent`.
- `TestGroupLifecycleVisibilityAndFanoutContract` (real PostgreSQL): create,
  per-recipient outbox event, missing/extra recipient → `membership_changed` with
  no row and no seq consumed, wrong ciphertext form → invalid, idempotent retry
  with reordered copies and JSONB-equal metadata, changed copy → conflict, each
  reader's history copy (sender empty), owner-only add/remove/rename, late member
  sees only seq > joinedSeq and its receipts are filtered, removed member loses
  access and sync reports `left`, owner promotion, last leave emits no event,
  gapless seq, direct conversations reject group operations.
- `TestGroupConcurrentSendAndMembershipChange`: 20 concurrent sends against 20
  add/remove operations; every accepted message has copies for exactly the
  members at its seq, no deadlock, gapless seq.
- `TestGroupFanoutAcrossInstancesOverKafka`: two gateways, real Kafka consumers
  and relay; group created over REST, `group_created` pushed to both members,
  WS group send accepted, bob (gw-B) and carol (gw-A) each receive only their
  own copy, stale member list → `membership_changed` frame, removal pushed to the
  removed member, its sync returns `left`, history 403, non-owner remove/rename 403.

Not measured: group fan-out load (RS33, k6), Sender Keys (RS35), multi-device
copies, FE1 client encryption.

## Not verified here

- EXP12 with live WebSocket recipients during a Kafka stop/start (the BE1
  PowerShell outage script was not run; `pwsh` is not installed on this host).
- One- vs two-instance comparison, 50/100 VU send load, slow-consumer queue growth,
  and backend restart during load.
- Rebalance with more than one member per group (each group has one member by
  design; `BlockRebalanceOnPoll` is exercised only through restart/close).
- Signal encryption, client reconnect/backoff and plaintext inspection (FE1).
