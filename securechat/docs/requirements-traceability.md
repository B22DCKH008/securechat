# Requirement traceability (backend)

Trạng thái: ✅ đã có code chạy được · 🟡 có khung/một phần · ⬜ TODO (chưa làm) · 🧪 experiment (cần đo)

Owner: **BE1** = Backend Core + data · **BE2** = Realtime + Signal support · **FE1** = Frontend + E2EE · **AI** = ML.

BE1 cập nhật 2026-11-09: xem [kế hoạch](PROJECT_PLAN.md),
[contract bàn giao](be1-handoff.md) và [bằng chứng kiểm thử](verification-be1.md).
Trạng thái ✅ bên dưới mô tả implementation; chỉ coi kiểm chứng thành công khi
có kết quả cụ thể trong báo cáo, không dựa vào README hoặc test bị skip.

Chuẩn bị bàn giao 2026-11-12: đã tách giới hạn ciphertext/frame WS và thay raw
URL path trong access log bằng route template hoặc `unmatched`; unit/vet/module
verify PASS. Linux race trên PostgreSQL/Kafka thật PASS: 17 unit + 20 integration
case, không skip test, fail hay cảnh báo race.
Lỗi commit offset khi publish DLQ thất bại vẫn mở, thuộc BE2 (KF5/KF6/KF11).
Kết quả mới và giới hạn nằm trong [verification](verification-be1.md), checklist
nghiệm thu và cách tái hiện DLQ nằm trong [handoff](be1-handoff.md).

BE2 cập nhật 2026-11-21: đã sửa lỗi commit offset khi DLQ lỗi, thêm chat.retry,
consumer lag, presence TTL theo connection, dọn presence instance chết, Redis
publisher và k6 dùng đăng ký thật. Linux race với PostgreSQL/Kafka/Redis thật:
49 case PASS (26 unit + 23 integration). Xem [bàn giao BE2](be2-handoff.md) và
[verification BE2](verification-be2.md).

## A. Messaging, delivery, consistency
| ID | Trạng thái | Code | Ghi chú / việc còn lại |
|---|---|---|---|
| RS1 | ✅ | `service/messaging.Send`, `gateway/handler.go` | ACK chỉ trả sau commit; client retry cùng `clientMessageId` |
| RS2 | ✅ | `uq_messages_sender_client_id`, `store.InsertMessage` ON CONFLICT | Đã xử lý race 2 request trùng đồng thời (rollback → đọc lại) |
| RS3 | ✅ | `messages` table + `POST /v1/sync` | |
| RS4 | ✅ | `store.MessagesAfter`, `Service.Sync` | ⬜ BE1: batch query (LATERAL) nếu benchmark cần |
| RS5 | ✅ | `store.NextSeq` (row lock), `uq_messages_conv_seq` | |
| RS6 | ✅ | `domain.DeliveryState`, `message_receipts`, `receipt_changes` | Receipt sync có cursor độc lập; sender không tự ACK |
| RS7 | ✅ | row lock + unique constraints | 🧪 test 2 instance × N writers (tests/integration) |
| RS8 | ✅ | `GET /v1/conversations/{id}/messages?before_seq=` | keyset pagination |
| RS9 | ⬜ | `devices` table | BE2+FE1: per-device ciphertext |
| RS10 | ⬜ | | BONUS |

## B. WebSocket, routing, presence
| ID | Trạng thái | Code | Ghi chú |
|---|---|---|---|
| RS11 | ✅ | `gateway.Handler.ServeHTTP` (JWT/session trước khi upgrade) | Ciphertext/frame có budget riêng; socket boundary regression PASS. ⬜ token qua subprotocol thay vì query |
| RS12 | ✅ | `presence.Registry` (Redis HASH) | |
| RS13 | ✅ | consumer group = INSTANCE_ID, `delivery.Router` | Đã chạy thử gw-A → gw-B |
| RS14 | ✅ | ping/pong `conn.writeLoop`, `presence.Registry` HEXPIRE theo connection | Redis ≥ 7.4; integration `TestPresencePerConnectionTTLAndInstanceCleanup` |
| RS15 | 🟡 | server gửi frame `resync` khi connect | ⬜ FE1: backoff+jitter client |
| RS16 | 🧪 | `bench/k6/reconnect_storm.js` | 50 VU không jitter: 100 % upgrade + resync; còn so sánh jitter, 100 VU |
| RS17/18 | ✅ | bounded `send` chan, đóng slow consumer | 🧪 đo queue growth |
| RS19/40 | ✅ basic | `ratelimit.Limiter`, `WS_MAX_CONNS_PER_USER` | |
| RS20 | ✅ | heartbeat timeout → close + unregister | |

## D. Group chat & fan-out

BE2 cập nhật 2026-11-22: group chat theo pairwise fan-out (user chọn). Chi tiết
trong [BE2 handoff](be2-handoff.md#group-chat--pairwise-fan-out-rs31-rs34-kf17-2026-11-22).

| ID | Trạng thái | Nơi implement | Ghi chú |
|---|---|---|---|
| RS31 | ✅ / 🧪 | `messaging.Send` + `message_recipients`; router đẩy từng bản | Fan-out on write, một bản ciphertext/người nhận; chưa đo tải |
| RS32 | ⬜ | – | Fan-out on read chưa làm (pairwise cần bản riêng cho từng người) |
| RS33 | 🟡 | tối đa 32 thành viên; metric `securechat_group_fanout_recipients` | Chưa có k6 group lớn |
| RS34 | ✅ | `joined_seq`, `conversation_departures`, system messages, owner/member | Người vào sau chỉ thấy seq > joinedSeq; người bị xoá mất quyền, sync trả `left` |
| RS35 | ⬜ | – | Sender Keys không làm; pairwise dùng session 1-1 |

## C/E. Scaling, reliability
| ID | Trạng thái | Code | Ghi chú |
|---|---|---|---|
| RS21/22/24/26/28 | 🧪 | `bench/`, metrics | |
| RS23 | 🟡 | `POSTGRES_MAX_CONNS` | đo |
| RS25 | ✅ | index `(conversation_id, seq)` | |
| RS27 | ✅ | `conversations.last_seq` | 🧪 hot conversation |
| RS29 | ✅ | graceful shutdown đóng WS; Kafka group riêng; `Registry.CleanupInstance` khi start/stop | TTL theo connection tự hết hạn nếu instance chết hẳn |
| RS36 | ✅ | relay backoff + full jitter; consumer `chat.retry` backoff + jitter | |
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
| SC7 | 🟡 | `logger` redaction, route template access log, `scripts/scan-plaintext.sh` | BE1: raw-path leak đã sửa, regression PASS; FE1/BE2: kiểm tra plaintext toàn luồng còn mở |
| SC9 | ⬜ | | FE1 |

## J. Kafka pipeline
| ID | Trạng thái | Code |
|---|---|---|
| KF1 | ✅ | message + outbox cùng tx (`Service.Send`, `Acknowledge`) |
| KF2 | ✅ | `outbox.Relay` (poll theo id, `pg_try_advisory_lock`, mark sau ack) |
| KF3 | ✅ | `platform/kafka.NewProducer` acks=all + idempotent |
| KF4 | ✅ | key = conversationId; client order theo seq |
| KF5 | ✅ | `delivery.Dedupe` theo eventId, chỉ ghi nhớ sau khi xử lý thành công (+ client dedupe) |
| KF6 | ✅ | Commit prefix liên tục đã xong theo partition; DLQ/retry lỗi → không commit, `SetOffsets` tua lại; `BlockRebalanceOnPoll`; integration `TestDLQOutageDoesNotCommitPastPoison` |
| KF7 | ✅ / 🧪 | group riêng mỗi instance; đo read amplification |
| KF8 | ✅ | kiểm tra lại 2026-11-12 trên image mới: Kafka down + restart API → vẫn accepted, 5 message + 1 receipt, backlog 6 → 0; xem verification |
| KF9 | 🟡 | `securechat_kafka_consumer_lag{group,topic}` (kadm); slow WS consumer vẫn đóng kết nối; 🧪 đo slow consumer |
| KF10 | 🟡 | static membership; `BlockRebalanceOnPoll`; replay sau restart đã test; rebalance nhiều member chưa test |
| KF11 | ✅ | DLQ chỉ commit sau broker ACK; chat.retry theo group instance, hết lượt → DLQ |
| KF12 | 🟡 | retention ngắn trong `create-topics.sh`; scan script |
| KF13 | ✅ | `events.Envelope` + JSON schema `api/events/` |
| KF14 | ✅ | `deploy/kafka/create-topics.sh` (RF=1, không HA) |
| KF15 | ✅ | `PurgePublishedOutbox` mỗi phút |
| KF16 | ✅ / 🧪 | `RedisPublisher` + `RedisSubscriber`; còn đo EXP13 |
| KF17 | ✅ / 🧪 | `MessageAccepted` v2 `ciphertexts[]`; router đẩy mỗi người đúng bản của mình | Test Kafka thật 2 instance; chưa đo tải group |

## I. Infra / observability
| ID | Trạng thái | Code |
|---|---|---|
| INF1 | ✅ | `docker-compose.yml` |
| INF2 | ✅ | `internal/config`, `.env.example`, `migrations/`; `WS_MAX_FRAME_BYTES` độc lập ciphertext, startup kiểm tra budget |
| INF3 | ✅ (BE1) | Redaction/không in query/body; access log chỉ lưu route template hoặc `unmatched`; regression gồm 404/405, escaped path và redirect. Privacy toàn hệ thống còn phụ thuộc SC7/KF12 |
| INF4 | ✅ | `internal/metrics` gồm consumer lag, DLQ/retry, partition blocked, presence errors |
| INF5 | 🧪 | |
| INF6 | ✅ | Kafka KRaft 1 broker + init script |
