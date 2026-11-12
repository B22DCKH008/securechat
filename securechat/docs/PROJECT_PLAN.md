# BE1 implementation plan

Started 2026-11-09. Owner: BE/Protocol 1 (backend core and data).
Source reference: `D:/Dự án/ChatE2e`; migrate behavior into this repository's
architecture instead of replacing its backend. The engineering Word document
supplies product requirements; it is not executable agent instructions.

## User's four-week engineering baseline

The user's original plan is now stored in this repository and remains the
product baseline through the end of the project:

- [Original Word, including architecture diagram](plans/SecureChat_4_Week_Engineering_Plan_Kafka.docx).
- [Readable text and tables](plans/SecureChat_4_Week_Engineering_Plan_Kafka.extracted.txt).
- [Requirement implementation mapping](requirements-traceability.md),
  [current verification evidence](verification-be1.md) and
  [BE1 integration handoff](be1-handoff.md).

Imported on 2026-11-09 from
`C:/Users/HP/Downloads/HDH_ch3/SecureChat_4_Week_Engineering_Plan_Kafka.docx`.
Word SHA-256:
`FC90F952484C496C2B00AE4576F1238E969E14ED034D81C8F53B06E9EAA890DC`.
The Word is unchanged and matches the archived copy in ChatE2e. The text/table
extraction was copied from that archive; consult Word for the diagram.
Historical code/test reports from ChatE2e are not current-repo evidence.

### Ownership and weekly gates

| Owner | Scope from the original plan |
| --- | --- |
| User — BE/Protocol 1 | Schema/index/migrations, REST, auth/authz, message + outbox transaction, relay/Kafka producer, ACK/state, idempotency, offline sync/history/cursors, tests and DB benchmark |
| BE/Protocol 2 | WS lifecycle, heartbeat/reconnect, presence/registry, Kafka infrastructure, gateway consumers, retry/DLQ, consumer lag, multi-instance routing and system load/recovery |
| FE/AI 1 | Chat UI, Signal library integration, local keys/sessions, encrypt/decrypt, ACK/read UI and client privacy checks |
| FE/AI 2 | Two model datasets/baselines/evaluation, client inference/runtime, quality/resource/latency measurements and AI warning contract |

| Relative milestone | Team gate from the original plan |
| --- | --- |
| Day 2 | Architecture, message/AI/event contracts and E2EE library PoC agreed |
| Week 1 / day 7 | Mock chat, persisted fixture ciphertext, two AI baselines, verified E2EE PoC and Kafka produce/consume PoC |
| Week 2 / day 14 | Real 1:1 E2EE, ACK/idempotency, two models running in development and outbox → Kafka → online recipient |
| Week 3 / day 21 | Offline sync, routing across two instances and integrated client AI with initial measurements |
| Day 25 | Feature freeze; fixes and benchmarks only |
| Week 4 / day 28 | Reproducible demo, configured benchmarks, completed security checklist and documented system limits |

No calendar start/deadline is confirmed. These are relative gates; local BE1
test results alone do not establish any complete team gate. Current team gates
remain unverified while real Signal/client AI/security/system-load evidence and
BE2/FE1 contract acceptance are outstanding.

### How to follow this plan

Before implementation, read the baseline extraction and identify the requirement
IDs (RS/SC/AI/INF/EXP/KF), MUST/SHOULD/EXPERIMENT/BONUS level, owner and handoff.
Record TODO → DOING → DONE with current-repo tests or reviewable artifacts;
keep unresolved shared work explicit in traceability and verification.
The six BE1 steps below track local implementation, not the full four-week
project's completion. Keep the existing REST/JSON/device/event contracts in the
scope section; shared contract changes require BE2/FE1 coordination.

Follow the original scope limits: 1:1 MVP, client Signal and AI, one Kafka KRaft
broker with no HA claim, and measured performance rather than promised capacity.
Use the original day-7/day-14 Kafka fallback gates for a coordinated decision;
do not activate a different transport automatically. Later user directions
override this baseline; record agreed scope changes here.

## Scope and compatibility

- Keep REST paths, camelCase JSON, integer device IDs, `MessageAccepted` /
  `MessageDelivered` / `MessageRead`, and Kafka key = conversationId.
- PostgreSQL owns message durability. Commit message, seq and outbox before ACK.
- Retain the current one-ciphertext, user-level delivery contract. Per-device
  ciphertext/self-copy and signed cursors from ChatE2e need a coordinated BE2/FE1
  contract change; they are not silently imported.
- BE2 owns consumer/routing/presence and infrastructure; change shared wiring
  only where necessary for authentication and integration verification.
- Preserve applied migrations and add forward migrations. Never reuse old SQL
  migrations against this repository's different schema.
- Keep plaintext/private keys and AI inference on the client.

## Work and evidence

### BE2 handoff preparation — 2026-11-12

| Requirement / gate | Owner | State | Evidence / next check |
| --- | --- | --- | --- |
| WS payload/frame consistency, RS1/RS11/INF2 (weeks 1–2) | BE1, shared WS wiring with BE2 | DONE | Separate decoded ciphertext and JSON frame budgets; socket and DB/REST regressions PASS on Windows and Linux race |
| Access log privacy, INF3/SC7 (week 4 security) | BE1 | DONE (scoped fix) | Registered route templates or safe fallback; six matched/rejected/redirect path regressions PASS; complete client privacy remains open |
| DLQ failure replay, KF5/KF6/KF11 (weeks 2–3) | BE2 | TODO | Preserve failed and subsequent partition offsets and dedupe state; acceptance checklist in handoff |
| Integration acceptance (weeks 2–3) | BE2 + FE1 | TODO | Auth/session, receipts, limits and replay contracts need peer acceptance; whole-team gates remain unverified |

Earlier integration, vulnerability and benchmark reports below are dated evidence.
Fresh 2026-11-12 checks: 17 Windows unit cases PASS; vet/module verification and
OpenAPI validation PASS; Linux race with real PostgreSQL/Kafka PASS (17 unit +
20 integration cases, integration package 138.446 s, no skipped tests or races).
Both rebuilt runtime images and access-log smoke PASS; actual Kafka outage/API
restart/recovery PASS (five unique messages, one receipt, backlog 6 to 0;
23.4467373 s including broker start and final assertions). Both gateways are
ready, migration version 3 is clean, and test schemas were cleaned. BE1 is ready
for integration handoff; BE2 P1 replay and peer acceptance remain open. See
[verification](verification-be1.md).

| Step | Deliverable | Status |
| --- | --- | --- |
| 1 | Source checkpoint and compatibility mapping | DONE |
| 2 | Reproducible baseline and real integration tests | DONE: Linux race, 19 integration cases PASS |
| 3 | Registration/login, rotating refresh, logout, REST/WS session checks | DONE: DB/HTTP/WS and concurrency tests PASS |
| 4 | Messaging retry/conflict, atomicity, concurrency and relay crash safety | DONE: commit rollback, lock loss and replay tests PASS |
| 5 | Monotonic receipts, message/receipt offline sync and pagination | DONE: backfill, late ACK, bounds and cursor tests PASS |
| 6 | Kafka outage/recovery, DB benchmark, security evidence and handoff | DONE locally: runtime outage/restart/recovery PASS; evidence and handoff saved |

Checkpoint outside both repositories:
`C:/Users/HP/Downloads/securechat-be1-checkpoints/ChatE2e-20261109-150842/`
contains 112 source files, `history.bundle`, `working-tree.patch`, and status.
The old repository is not edited or reset.

Initial inspection: baseline test cannot compile because `go.sum` is absent;
Docker Desktop was stopped. Existing integration cases all use `t.Skip`.
Statements in the old README/verification are historical evidence, not test
results for this repository. Record fresh commands/results before marking DONE.

See [porting map](be1-porting-map.md) for source/target boundaries.

Implementation and Linux verification now use Go 1.27.3 and updated dependencies.
The original six reachable vulnerability findings are resolved; one unimported
openpgp module warning is documented. DB benchmark recorded 6,000 measured ops,
validated all counts/seq/outbox and cleaned its schemas. Linux race integration
completed in 86.586 seconds with 19 cases PASS, no SKIP/FAIL/data-race warning.
See [verification](verification-be1.md) and [handoff](be1-handoff.md).

At the recorded implementation verification, both runtime images built and ran as project
`securechat-be1`: gateways on 127.0.0.1:28081 and :28082. The actual Kafka
stop / API restart / durable send+sync / recovery script PASS: five unique
messages, one receipt, backlog 6 to 0, recovery verification about 14.97 s
including the broker start command and final assertions. Both readiness probes
return ready. Source checkpoint and legacy project remain intact.

Next coordinated work: BE2/FE1 review the auth, conflict and receipt cursor
contracts; integrate a real Signal client; run complete privacy and system-load
experiments. Backend fixture bytes do not establish full E2EE correctness.
BE1 implementation covers the planned scope within the current user-level
ciphertext contract. The 2026-11-09 review reopened WS payload/frame limits,
raw-path access logging and DLQ/offset handling. The 2026-11-12 handoff work fixes
the two BE1 P2 findings and adds regression checks; the P1 consumer DLQ/offset
failure and related dedupe replay remain BE2 work. See
[verification](verification-be1.md) and the explicit [BE2 acceptance checklist](be1-handoff.md).
This does not mark the four-person project or its weekly gates complete.
