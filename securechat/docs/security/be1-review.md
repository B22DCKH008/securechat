# Backend security review

Review date: 2026-11-09. Scope: ported BE1 implementation. This is not a review
of a working Signal client or a production deployment.

## Assets and trust boundaries

Plaintext, private keys and Signal sessions belong on the client. The server
stores ciphertext, public key bundles and metadata. REST/WS callers control all
request bodies and must not choose the authenticated sender ID. PostgreSQL is
the durable source of truth; Kafka delivery, Redis presence and rate limits do
not establish recipient delivery or authorization.

Accounts now also store a password hash. Sessions store a hashed random refresh
token, family/device/user IDs, expiry and revocation time. Access JWTs carry user,
device and session identifiers and are verified against the database. Server/DB
operators can read membership, ciphertext lengths, timestamps, public keys and
delivery state. E2EE cannot protect a compromised client endpoint.

## Controls implemented

- Real credentials, bounded bcrypt work, high-entropy refresh tokens, rotation
  replay detection, family locking, logout and session checks on REST/WS.
- JWT algorithm/issuer/expiry validation, example-secret rejection and dev-token
  gating. Auth responses are not cacheable.
- Membership checks on send/history/sync/ACK; sender identity comes from auth.
  Only recipients establish delivered/read. Key upload is scoped to the current
  authenticated device for session tokens.
- JSON byte limits, unknown/trailing-field rejection on REST, metadata object
  validation and bounded ciphertext/page sizes.
- Message/seq/outbox and receipt/revision/outbox transactions. Deferred COMMIT
  failures must not return accepted. Retry payload changes produce conflict.
- At-least-once relay, dedicated lock-session lifecycle, bounded publish and
  heartbeat cancellation on lock loss. Replay retains event identity.
- Logs avoid bodies, request queries and raw broker failure details. Redaction
  covers camelCase access/refresh tokens and stored password/token hashes.
- Handoff fixes on 2026-11-12 replace raw access-log paths with method-specific
  route templates or `unmatched`, including rejected routes and redirects.
  Decoded ciphertext (64 KiB default) and inbound WS JSON (128 KiB default) now
  have separate budgets; startup rejects incompatible settings. Fresh evidence
  is tracked in the dated handoff section of verification.
- Host ports bind loopback; Kafka logs use the mounted durable directory. The
  development Kafka broker has replication factor 1 and provides no HA.

## Limits and follow-up

TLS termination, broker/database ACLs, secret rotation and production abuse
protection remain deployment work. Redis rate limiting still fails open; bounded
password hashing limits concurrent CPU work but does not replace account lockout
or a distributed auth policy. Revocation checks happen at admission and on WS
heartbeats/frames; an already admitted request can complete.

The current contract routes one ciphertext per user. It does not implement full
per-device Signal delivery, sender self-copy or identity-key-change notifications.
Clients must decide what public protocol metadata may contain. Backend storage
cannot determine whether arbitrary submitted bytes are actually encrypted.

Fixture tests and log redaction checks do not prove SC7/KF12 end-to-end plaintext
privacy. That requires a real Signal client, network capture and DB/Redis/Kafka/
log inspection with an original plaintext marker. Consumer lag, retry/DLQ and
system overload experiments remain shared/BE2 work.

Open P1 for BE2: failed DLQ publication can still be followed by source-offset
commit; router dedupe can also remember an event before payload validation.
See [handoff acceptance procedure](../be1-handoff.md#open-be2-blocker-dlq-replay-kf5kf6kf11).
These failures do not delete PostgreSQL messages, but prevent certification of
the Kafka DLQ/replay workflow until BE2 resolves and verifies them.

Current dependency scan and test evidence are linked from
[verification](../verification-be1.md); do not infer success from this checklist.
