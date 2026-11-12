# BE1 porting map

| Capability | ChatE2e source | SecureChat target | Adaptation |
| --- | --- | --- | --- |
| Auth and sessions | internal/auth/{service,token,sessions}.go | internal/auth, httpapi | Keep JWT library and user UUID; device ID is integer, JSON camelCase; password/session logic adapted |
| Durable send and retry | internal/messaging/service.go | internal/service/messaging, store | Keep existing REST/WS contract; detect changed payload on reused clientMessageId |
| Relay / producer | internal/relay, kafkaproducer | internal/outbox, platform/kafka | Keep event schema and existing metrics; single dedicated lock session, bounded publishing, replay-safe marking |
| Delivered/read | internal/messaging/receipts.go | service/messaging, store/receipts | User-level state stays monotonic; durable receipt change cursor is additive |
| History / sync | internal/messaging/{history,cursor}.go | service/messaging, store, httpapi | Keep numeric per-conversation message cursor; separately checkpoint receipt revisions |
| Correctness tests | tests/integration | tests/integration | Rewrite against new migrations/contracts; actual DB/HTTP/Kafka required |
| Database benchmark | cmd/dbbench | cmd/dbbench | Reseed isolated temporary schema; compare keyset/offset, verify counts/order and report environment |

## Interface decisions

Existing frontend transport types and gateway consumers remain the compatibility
reference. Registration, login, refresh and logout are additive endpoints.
Session-backed JWTs use the existing issuer and add session/device claims.
Dev tokens are accepted only when AUTH_DEV_LOGIN_ENABLED is explicitly true.
Existing users created through dev-login do not gain a password implicitly.

Multi-device encryption, sender self-copy and signed cursors from the source repo
are deferred pending BE2/FE1 agreement; the current user-level ciphertext API
does not promise decryption from another device. Client Signal interoperability,
plaintext leakage across the real encrypted path, cross-instance correctness and
system load results need separate evidence.
