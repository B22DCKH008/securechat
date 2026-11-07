# Requirement traceability (backend)

Trạng thái: ✅ đã có code chạy được · 🟡 có khung/một phần · ⬜ TODO (chưa làm) · 🧪 experiment (cần đo)

Owner: **BE1** = Backend Core + data · **BE2** = Realtime + Signal support · **FE1** = Frontend + E2EE · **AI** = ML.

## A. Messaging, delivery, consistency
| ID | Trạng thái | Code | Ghi chú / việc còn lại |
|---|---|---|---|
| RS1 | ✅ | `service/messaging.Send`, `gateway/handler.go` | ACK chỉ trả sau commit; client retry cùng `clientMessageId` |
| RS2 | ✅ | `uq_messages_sender_client_id`, `store.InsertMessage` ON CONFLICT | Đã xử lý race 2 request trùng đồng thời (rollback → đọc lại) |
| RS3 | ✅ | `messages` table + `POST /v1/sync` | |
| RS4 | ✅ | `store.MessagesAfter`, `Service.Sync` | ⬜ BE1: batch query (LATERAL) nếu benchmark cần |
| RS5 | ✅ | `store.NextSeq` (row lock), `uq_messages_conv_seq` | |
| RS6 | ✅ | `domain.DeliveryState`, `message_receipts`, frame `accepted`/`receipt` | |
| RS7 | ✅ | row lock + unique constraints | 🧪 test 2 instance × N writers (tests/integration) |
| RS8 | ✅ | `GET /v1/conversations/{id}/messages?before_seq=` | keyset pagination |
| RS9 | ⬜ | `devices` table | BE2+FE1: per-device ciphertext |
| RS10 | ⬜ | | BONUS |

## B. WebSocket, routing, presence
| ID | Trạng thái | Code | Ghi chú |
|---|---|---|---|
| RS11 | ✅ | `gateway.Handler.ServeHTTP` (JWT trước khi upgrade) | ⬜ token qua subprotocol thay vì query |
| RS12 | ✅ | `presence.Registry` (Redis HASH) | |
| RS13 | ✅ | consumer group = INSTANCE_ID, `delivery.Router` | Đã chạy thử gw-A → gw-B |
| RS14 | 🟡 | ping/pong `conn.writeLoop`, TTL refresh | ⬜ TTL theo từng connection |
| RS15 | 🟡 | server gửi frame `resync` khi connect | ⬜ FE1: backoff+jitter client |
| RS16 | 🧪 | `bench/k6/reconnect_storm.js` | |
| RS17/18 | ✅ | bounded `send` chan, đóng slow consumer | 🧪 đo queue growth |
| RS19/40 | ✅ basic | `ratelimit.Limiter`, `WS_MAX_CONNS_PER_USER` | |
| RS20 | ✅ | heartbeat timeout → close + unregister | |

## C/E. Scaling, reliability
| ID | Trạng thái | Code | Ghi chú |
|---|---|---|---|
| RS21/22/24/26/28 | 🧪 | `bench/`, metrics | |
| RS23 | 🟡 | `POSTGRES_MAX_CONNS` | đo |
| RS25 | ✅ | index `(conversation_id, seq)` | |
| RS27 | ✅ | `conversations.last_seq` | 🧪 hot conversation |
| RS29 | 🟡 | graceful shutdown đóng WS; Kafka group riêng | ⬜ dọn presence của instance chết |
| RS36 | ✅ | relay backoff + full jitter | ⬜ chat.retry |
| RS37 | ✅ | error `internal` → "retry with same clientMessageId" | |
| RS38/39 | ✅ | readiness chỉ cần Postgres; Redis fail-open | 🧪 EXP |
| RS41/42 | 🟡 | bounded queues | load shedding BONUS |
| RS43 | 🧪 | | |

## F. E2EE & security
| ID | Trạng thái | Code | Ghi chú |
|---|---|---|---|
| SC1/SC2 | 🟡 | `service/keys`, `prekey_bundles`, `one_time_prekeys` | server chỉ lưu public key; ⬜ FE1 tích hợp thư viện; ⬜ identity key change |
| SC3 | ✅ (server) | sync trả ciphertext + protocolMeta | |
| SC5 | ✅ | `store.IsMember` trên mọi đường | |
| SC6/SC8 | 🟡 | `docs/security/*` | điền nội dung |
| SC7 | 🟡 | `logger` redaction, `scripts/scan-plaintext.sh` | |
| SC9 | ⬜ | | FE1 |

## J. Kafka pipeline
| ID | Trạng thái | Code |
|---|---|---|
| KF1 | ✅ | message + outbox cùng tx (`Service.Send`, `Acknowledge`) |
| KF2 | ✅ | `outbox.Relay` (poll theo id, `pg_try_advisory_lock`, mark sau ack) |
| KF3 | ✅ | `platform/kafka.NewProducer` acks=all + idempotent |
| KF4 | ✅ | key = conversationId; client order theo seq |
| KF5 | ✅ | `delivery.Dedupe` theo eventId (+ client dedupe) |
| KF6 | ✅ | `CommitRecords` sau khi xử lý batch |
| KF7 | ✅ / 🧪 | group riêng mỗi instance; đo read amplification |
| KF8 | ✅ | đã thử: Kafka down → vẫn accepted, backlog tăng, tự drain |
| KF9 | ⬜ | consumer lag metric (kadm hoặc kafka-exporter) |
| KF10 | 🟡 | static membership `KAFKA_STATIC_MEMBERSHIP` |
| KF11 | 🟡 | DLQ cho poison event ✅; chat.retry ⬜ |
| KF12 | 🟡 | retention ngắn trong `create-topics.sh`; scan script |
| KF13 | ✅ | `events.Envelope` + JSON schema `api/events/` |
| KF14 | ✅ | `deploy/kafka/create-topics.sh` (RF=1, không HA) |
| KF15 | ✅ | `PurgePublishedOutbox` mỗi phút |
| KF16 | 🟡 | `DELIVERY_TRANSPORT`, `RedisSubscriber` ✅; Redis publisher ⬜ |
| KF17 | 🟡 | payload `recipients[]` sẵn cho group |

## I. Infra / observability
| ID | Trạng thái | Code |
|---|---|---|
| INF1 | ✅ | `docker-compose.yml` |
| INF2 | ✅ | `internal/config`, `.env.example`, `migrations/` |
| INF3 | ✅ | `internal/logger` redaction, request log không in query |
| INF4 | 🟡 | `internal/metrics` (thiếu consumer lag) |
| INF5 | 🧪 | |
| INF6 | ✅ | Kafka KRaft 1 broker + init script |
