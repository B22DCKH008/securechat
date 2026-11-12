# BE1 verification — latest handoff work 2026-11-12

This report concerns this repository, after adapting behavior from ChatE2e.
It does not reuse the old project's passing tests as evidence. Backend source
uses Go 1.27.3; the final dependency set is pinned by go.mod/go.sum.

## BE2 handoff preparation on 2026-11-12

BE1 fixes are implemented for the two P2 findings below. The P1 consumer
DLQ/offset issue remains open under BE2 ownership. See the
[handoff checklist and reproduction](be1-handoff.md).

- RS1/RS11/INF2: keep `WS_MAX_MESSAGE_BYTES=65536` for decoded ciphertext; use
  `WS_MAX_FRAME_BYTES=131072` for inbound WS JSON. Startup rejects a frame budget
  below base64 payload plus 8192 bytes. Wire the distinct budgets in server and
  gateway; no REST path, camelCase payload, integer device ID or Kafka event
  schema changes.
- INF3/SC7: access log `path` is a registered method-specific route template or
  `unmatched`, including 404/405, escaped paths and redirects. Never log the raw
  request path/query/body. CONNECT-generated raw redirect patterns also use
  the safe fallback. This scoped fix does not prove end-to-end client privacy.
- Before the fix, the six new log cases reproduced the marker exposure and the
  WS diagnostic reproduced close code 1009. Final socket regression sends a
  JSON `send` object and verifies the independent payload/frame boundaries.

Fresh Windows Go 1.27.3 checks (bounded Go settings from AGENTS):

| Check | Status |
| --- | --- |
| `go test -count=1 -json ./...` | PASS; 17 top-level unit cases, plus six log subcases |
| `go vet ./...` | PASS |
| `go mod verify` | PASS; all modules verified |
| OpenAPI structure (`openapi-spec-validator`, existing external QA dependencies) | PASS |
| Linux race + real DB/Kafka integration | PASS, exit 0; 37 top-level cases (17 unit + 20 integration), no skipped tests/failures/race warnings; integration package 138.446 s |

[Structured handoff test report](experiments/be1-handoff-tests-2026-11-12.json)
records the exact command, cases, durations and backend source SHA-256
`3dc78b4cff6f550147f21428b113eef3fc10bc74be2e5ef49a25343ee60b81ff`.
Hash algorithm matches the DB benchmark (relative Go/SQL/module paths and raw
contents). Raw unit/race/build logs are local gitignored `.log` files under
`docs/experiments`. Package-level `skip` for directories without test files is
not a skipped test; all 37 real test cases passed.

Both runtime images built successfully, sequentially, with the pinned Go 1.27.3
Dockerfile. [Fresh runtime smoke](experiments/be1-handoff-runtime-2026-11-12.json)
records image IDs/nonroot user and PASS for health/readiness on 28081/28082.
Requests containing a synthetic marker in a matched path, an unknown path and
query were checked against each container's access logs: marker absent,
registered template and `unmatched` fallback present. This validates deployed
access logging, not the complete client privacy checklist. Historical runtime
statements in the older sections below refer to 2026-11-09.

[Fresh actual outage/restart/recovery](experiments/be1-outage-2026-11-12.json)
PASS: Kafka stopped in `securechat-be1`, backend-a restarted while it was down,
five unique messages accepted and recovered through sync/history, retries kept
message IDs, and one read receipt remained durable. Backlog went from 6 to 0.
Recovery verification took 23.4467373 seconds including the broker start command
and final assertions; this is not an isolated drain-time or throughput result.
Command from the inner application directory:

```powershell
./scripts/verify-be1.ps1 -Project securechat-be1 -BaseA http://localhost:28081 -BaseB http://localhost:28082 -Report docs/experiments/be1-outage-2026-11-12.json
```

Final probes: both 28081 and 28082 return `ready`; backend-a/backend-b,
PostgreSQL, Redis and Kafka are running. Migrations remain version 3,
`dirty=false`; zero `be1_`/`bench_` schemas remain. Volumes were preserved;
only this dedicated project's backend/Kafka services were temporarily stopped
for build resource relief and the outage experiment. The legacy project was
not changed. `git diff --check` PASS (only existing line-ending notices).

BE1 is ready for integration handoff with the two scoped P2 fixes verified.
The BE2 P1 DLQ/offset/dedupe workflow still blocks complete pipeline acceptance;
peer contract acceptance, real Signal, client AI and system-load gates remain
open. The passing outage script does not exercise failed DLQ publishing.

Fresh regression cases: `TestWebSocketBudgetConfiguration`,
`TestWebSocketCiphertextAndFrameBudgets`,
`TestAccessLogOmitsClientPathQueryAndBody`, and integration
`TestWebSocketLargeCiphertextPersistsAndRetriesOverREST`. The socket test checks
65,536 accepted, 65,537 invalid while keeping the connection usable, and a
131,073-byte JSON message rejected with 1009. The integration case additionally
checks intact ciphertext in PostgreSQL and no extra message/seq/outbox on REST
retry or oversized WS/REST rejection.

The 2026-11-09 benchmark and vulnerability scan are retained as dated reports;
they were not rerun for these fixes, which change neither DB queries/indexes nor
dependencies. Complete Signal/client AI/security/load gates remain unverified.

## Follow-up review on 2026-11-09

Historical finding snapshot: the WS budget and raw-path P2 findings are addressed
by the 2026-11-12 changes above; the DLQ P1 remains open.

The implementation covers the BE1 work scheduled across weeks 1–4, but the
following review reopens integration/security issues. Earlier PASS results cover
their tested scenarios and do not establish that the code has no defects.
Frontend and ML remain scaffolds/contracts; real Signal E2EE, client AI and the
whole-team weekly gates are not established by the backend fixtures.

Fresh checks used the existing Go binary at
`D:/Dự án/ChatE2e/.tools/go1.27.3/go/bin/go.exe` (Go 1.27.3 windows/amd64), with
`GOMAXPROCS=2`, `GOFLAGS=-p=1`, `GOMEMLIMIT=256MiB`, from `backend`:

- `go test -count=1 ./...`: PASS for the ordinary unit suite. This command
  excludes integration-tagged tests and is not an integration pass.
- `go vet ./...`: PASS.
- Backend source hash at that review, using the DB benchmark's path/content algorithm,
  is `07e177509d6da99c538ef6cebfa534aaedee76cd5b7aa4b28b988a9ebecc6126`, identical
  to the retained Linux integration report.
- Docker's Linux daemon was unavailable during that review. No fresh DB/Kafka integration,
  Linux race, outage experiment or runtime readiness check was run in this review.
  The runtime/container results below describe the earlier recorded run.
- Two temporary diagnostic tests ran with `go test -count=1 -run '^TestReview'
  -v ./internal/httpapi`: both PASS in confirming the defects described below.
  The diagnostic file was removed after the run; application code was unchanged.

| Priority | Finding and impact | Evidence / ownership |
| --- | --- | --- |
| P1 | Consumer commits source offsets even when DLQ publishing fails. The failed record is still appended to `handled`; a successful subsequent source-offset commit prevents normal replay to that group. This loses the poison record from the intended DLQ workflow; it does not delete the PostgreSQL message. | Static review: `internal/delivery/kafka_consumer.go`, `Run` and `sendToDLQ`. No live Kafka reproduction in this review. BE2 owns the fix; propagate the DLQ error and preserve replay, including dedupe state and later offsets in the same partition. |
| P2 | Service ciphertext limit and WS frame limit use the same 65,536-byte setting. Base64 and JSON framing make a service-valid payload exceed the WS read limit. Large sends work through REST but close WS with code 1009 before reaching messaging. | Local diagnostic: `SendCommand.Validate` accepts a 65,536-byte payload; its actual `gateway.EncodeFrame` output is 87,539 bytes; a real local WS connection with the configured read limit closes with 1009. Shared BE1/BE2 wiring in `cmd/server/main.go` and `internal/gateway/handler.go`; define separate payload/frame budgets. |
| P2 | Access logging retains arbitrary client-controlled URL path text, including rejected routes. Sensitive text accidentally put in a path is persisted despite sensitive-field redaction. This is a confirmed logging exposure, not proof that a correctly encrypted chat message leaks. | Local diagnostic: `/v1/conversations/REVIEW_SYNTHETIC_SECRET/messages` to a 404 handler still leaves the marker in the JSON access log. `internal/httpapi/router.go`, `requestLogger`; log a matched route template or safe fallback rather than the raw path. BE1/shared security work (INF3/SC7). |

Other known open work remains: per-connection presence expiry, consumer lag,
retry/rebalance/load experiments, Signal/client privacy verification and contract
acceptance. `DELIVERY_TRANSPORT=redis` has only a subscriber, with no matching
relay publisher (`cmd/server/main.go` TODO); it is not an operational fallback.

## Completed checks

Plan import on 2026-11-09: the original four-week Word plan and its archived
text/table extraction are stored under [plans](plans/). The Word SHA-256 matches
the archived original:
`FC90F952484C496C2B00AE4576F1238E969E14ED034D81C8F53B06E9EAA890DC`.
README, AGENTS and PROJECT_PLAN now point to this local baseline. This was a
documentation-only update; the runtime checks below were not rerun for it.
Word ZIP integrity, byte-identical extraction copy and all 30 local links in
the affected Markdown documents checked PASS.
Whole-team weekly gates remain unverified as explained in PROJECT_PLAN.

| Check | Result |
| --- | --- |
| Source checkpoint | 112 source files, full history bundle and working-tree patch outside both repositories |
| Go unit suite on Windows Go 1.27.3 | PASS, including JWT, configuration, JSON boundaries and log redaction |
| go vet / go build / go mod verify | PASS; all modules verified |
| OpenAPI and Kafka JSON Schema structure | PASS using openapi-spec-validator/jsonschema in an external QA dependency folder |
| Source vulnerability scan, govulncheck v1.9.0 / Go 1.27.3 | Exit 0; 0 symbol findings, 0 imported-package findings, 1 unimported module warning |
| Database benchmark on final dependencies | PASS; 6,000 measured operations, page/order/count/seq/outbox checks; disposable schemas cleaned |
| Linux race and real DB/Kafka integration | PASS, exit 0; 19 integration cases, no SKIP/FAIL/data-race warning; integration package 86.586 s |
| Runtime image build and two containers | PASS; both ready on 127.0.0.1:28081 and :28082 |
| Real Kafka stop / backend restart / recovery | PASS, five unique messages + one receipt; backlog 6 to 0 |

The initial unit command could not compile because go.sum was absent. An early
parallel Windows build exhausted memory; subsequent builds use GOMAXPROCS=2,
GOFLAGS=-p=1 and bounded Go heap. An initial integration pass found two fixture
errors (an idle test socket not answering pings, and Kafka timeout below its
minimum); both were fixed and the two cases reran PASS. An early Linux cold
build was stopped to upgrade dependencies; it is not a passing race result.
The first cold runtime readiness poll timed out; subsequent direct probes and
the actual API restart during Kafka outage passed. Final probes return ready
for both gateways.

[Structured test results](experiments/be1-test-summary.json) retain all 33 passing
cases (14 unit and 19 integration), durations and the verified backend source
hash. No generated be1/bench schema remained after the run. Full build/race logs
are local gitignored files under docs/experiments.

## Security evidence

[Before scan](security/be1-2026-11-09/govulncheck-before.txt) reported six reachable
findings. [After scan](security/be1-2026-11-09/govulncheck-after.txt) reports none
at symbol or imported-package level. Relevant upgrades include JWT 5.2.2,
pgx 5.11.0, go-redis 9.22.0, franz-go 1.22.2, compress 1.20.3, x/text 0.42.0
and x/crypto 0.57.0. Go 1.27.3 is used for the runtime and scanner.

The remaining warning is GO-2026-5932 in x/crypto/openpgp. The application imports
bcrypt, not openpgp; scanner output confirms no imported-package/call finding.
This is documented rather than described as a completely warning-free scan.
Primary advisories are linked in the retained scanner reports, including
[JWT](https://pkg.go.dev/vuln/GO-2025-3553) and
[pgx](https://pkg.go.dev/vuln/GO-2026-5004).

See [backend security review](security/be1-review.md) for implemented controls
and the boundaries of this verification.

## Database benchmark

[Raw report](experiments/be1-db-2026-11-09.json) records Go/OS/PostgreSQL version,
source SHA-256, EXPLAIN ANALYZE plans and all rounds. Command, from backend:

```powershell
$env:POSTGRES_DSN='postgres://securechat:securechat@localhost:25432/securechat?sslmode=disable'
go run ./cmd/dbbench -out ../docs/experiments/be1-db-2026-11-09.json
```

Fixture: 1,000 and 10,000 seed messages, 256-byte opaque payloads, 50 rows/page,
three offsets, three rounds and 100 measured queries per round, plus five
warmups per scenario. Query order alternates across rounds. Real service sends
use one and four workers into one hot conversation, 200 sends/configuration/round.
There are 3,600 measured reads and 2,400 measured sends, all checked for correctness.

| Seed rows | Keyset p50 range ms | Offset p50 range ms | Hot send p95 range ms |
| --- | --- | --- | --- |
| 1,000 | 1.067–2.491 | 1.123–2.165 | 19.740–61.120 |
| 10,000 | 1.038–1.455 | 1.071–3.749 | 14.420–104.392 |

Ranges span different offsets/worker configurations and rounds, not confidence
intervals or a single aggregate percentile. The deep 10,000-row keyset plan used
uq_messages_conv_seq (execution 0.042 ms); the offset fixture took 26.349 ms in
its one EXPLAIN run. These plan times are distinct from client-observed query
percentiles. Small-table plans can choose scans/sorts; no index is forced.

Environment: Windows host with approximately 4 GB RAM, Docker Linux VM limited
to approximately 1.74 GiB, PostgreSQL 16.15, Go 1.27.3, two Go execution threads.
These local DB/service measurements exclude HTTP, Signal, Kafka consume/push,
multi-instance scaling and AI. They do not establish production capacity.

## Integration and rollout boundaries

[Actual outage report](experiments/be1-outage-2026-11-09.json): Kafka was stopped
in the dedicated securechat-be1 project and backend-a restarted while it was
down. Five messages were accepted, each retry returned the same message ID,
offline sync returned all five and a recipient read receipt remained durable.
Backlog reached six. Starting Kafka drained it to zero; history retained five
unique IDs and sender sync recovered the late read receipt. Verification elapsed
14.9707392 seconds from before the broker start command through final assertions;
this is not a precise isolated drain-time or throughput benchmark.

Final stack: PostgreSQL 25432, Redis 26379, Kafka 29094, gateways 28081/28082,
all host binds loopback. JWT secret is random in the gitignored local .env and
dev-login is disabled. Kafka log files were verified in the mounted
/var/lib/kafka/data directory. No legacy ChatE2e volumes were removed or changed.
Migrations report version 3, dirty=false.

The suite uses generated isolated PostgreSQL schemas, actual SQL migrations and
real HTTP/WS sockets. Cross-instance routing uses two in-process gateway servers
with independent Kafka consumer groups. A network-unreachable Kafka producer
tests durable acceptance and recovery without stopping another project's broker.
Relay tests inject lost ACK/cancel-before-mark and terminate the actual advisory
lock session. The cancel window is not an OS process-crash proof.

Migrations 000002 and 000003 are forward additions; initial migration 000001 is
unchanged. Receipt migration snapshots existing state without creating old
Kafka events. Stop old receipt writers during migration; mixed-version writers
cannot populate the new receipt change feed correctly.

Outstanding shared evidence: real Signal encryption/decryption, plaintext marker
inspection across the complete client path, consumer lag, reconnect storm,
system capacity and BE2/FE1 contract acceptance. See [handoff](be1-handoff.md).
