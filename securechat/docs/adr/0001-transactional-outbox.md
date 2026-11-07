# ADR 0001 — Transactional outbox với relay polling tự viết

**Trạng thái:** Accepted (tuần 1)

## Bối cảnh
Cần đẩy realtime qua Kafka nhưng PostgreSQL là source of truth. Ghi DB rồi publish Kafka bằng hai bước độc lập (dual-write) có thể làm mất event hoặc phát event cho message không tồn tại.

## Quyết định
- Ghi `messages` + `outbox` trong **một transaction**.
- Relay polling đọc `outbox` theo `id`, publish (acks=all, idempotent producer), chỉ set `published_at` sau broker ack.
- Chỉ một relay active nhờ `pg_try_advisory_lock`.
- Consumer dedupe theo `eventId`; client dedupe theo `messageId`/`seq`.

## Phương án đã cân nhắc
- **Debezium/Kafka Connect (CDC):** ít code hơn nhưng thêm thành phần vận hành — ngoài scope MVP (doc §9).
- **Redis Streams:** đơn giản hơn nhưng không phải mục tiêu học Kafka; giữ Redis Pub/Sub làm transport so sánh (KF16).

## Hệ quả
- At-least-once → bắt buộc idempotent ở consumer + client.
- Latency thêm ≈ poll interval (`RELAY_POLL_INTERVAL`) — đo ở EXP11.
- Phải dọn bảng outbox (KF15).
