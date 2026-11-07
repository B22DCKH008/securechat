# Architecture overview

```
 Client (React)                      Backend instance gw-A / gw-B (Go, cmd/server)
 ┌───────────────────┐   WS/REST   ┌──────────────────────────────────────────────┐
 │ AI rules + ONNX   │────────────►│ httpapi / gateway ──► service/messaging       │
 │ Signal encrypt    │◄────────────│     ▲                    │ 1 tx: message+seq  │
 └───────────────────┘   push      │     │                    ▼       + outbox row │
                                   │ delivery.Router     PostgreSQL (source of truth)
                                   │     ▲                    │                    │
                                   │ KafkaConsumer        outbox.Relay (1 leader, │
                                   │ (group = INSTANCE_ID)    advisory lock)       │
                                   └─────┼────────────────────┼────────────────────┘
                                         │      Kafka         ▼
                                         └──── chat.messages / chat.receipts ◄────
                         Redis: presence registry, rate limit (ephemeral, fail-open)
```

## Code map (`backend/`)
| Package | Vai trò |
|---|---|
| `cmd/server` | wiring, graceful shutdown |
| `internal/config` | env vars |
| `internal/domain` | types + errors |
| `internal/events` | Kafka envelope/payload contract |
| `internal/store` | SQL repositories (DBTX) |
| `internal/service/messaging` | send / ack / sync / history |
| `internal/service/keys` | Signal public pre-key directory |
| `internal/outbox` | polling relay |
| `internal/delivery` | Kafka consumer, Redis subscriber, router, dedupe |
| `internal/gateway` | WS hub, connection, protocol |
| `internal/presence`, `internal/ratelimit` | Redis helpers |
| `internal/httpapi` | REST handlers |
| `internal/metrics`, `internal/logger` | observability |

## Trust boundaries
- Plaintext và private key chỉ tồn tại trên client.
- Server (Postgres, Redis, Kafka, logs) chỉ thấy: user ids, conversation membership, seq, timestamps, kích thước ciphertext, protocolMeta, IP. → ghi đầy đủ trong `docs/security/metadata.md` (SC6).

Xem quyết định thiết kế trong `docs/adr/`.
