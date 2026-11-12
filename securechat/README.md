# SecureChat

Chat 1:1 E2EE (Signal Protocol ở client) + 2 model AI on-device + Kafka event pipeline (transactional outbox).
Backend: **Go** · PostgreSQL (source of truth) · Kafka KRaft 1 broker (durable event log) · Redis (presence / rate limit).

Kế hoạch gốc áp dụng đến hết dự án: [Word bốn tuần](docs/plans/SecureChat_4_Week_Engineering_Plan_Kafka.docx)
và [bản trích nội dung/bảng](docs/plans/SecureChat_4_Week_Engineering_Plan_Kafka.extracted.txt).
Phân công, mốc nghiệm thu và cách theo dõi tại [PROJECT_PLAN.md](docs/PROJECT_PLAN.md).

Phần BE1 đã được triển khai và kiểm chứng để bàn giao tích hợp BE2; lỗi consumer
DLQ/offset thuộc BE2 vẫn mở. Xem
[kế hoạch](docs/PROJECT_PLAN.md), [contract bàn giao](docs/be1-handoff.md) và
[kết quả kiểm chứng](docs/verification-be1.md). Frontend/AI hiện vẫn là khung và contract.

## Chạy nhanh

```bash
cp -n .env.example .env       # chỉ tạo lần đầu; đổi JWT_SECRET
docker compose up -d --build  # postgres, migrate, redis, kafka, kafka-init, backend-a(:8081), backend-b(:8082)
curl localhost:8081/healthz
```

Thử nhanh bằng REST:

```bash
A=$(curl -s -H 'Content-Type: application/json' -XPOST localhost:8081/v1/auth/register -d '{"username":"alice","password":"local-password-alice"}')
B=$(curl -s -H 'Content-Type: application/json' -XPOST localhost:8082/v1/auth/register -d '{"username":"bob","password":"local-password-bob"}')
# tạo conversation, gửi ciphertext, sync… xem backend/api/openapi.yaml
```

WebSocket: `ws://localhost:8081/ws?access_token=<JWT>` — giao thức ở [`docs/api/websocket-protocol.md`](docs/api/websocket-protocol.md).
Metrics Prometheus: `/metrics` (bật Prometheus: `docker compose --profile observability up -d`).

`JWT_SECRET` mẫu bị từ chối khi khởi động; cần thay bằng secret ngẫu nhiên ít nhất
32 byte. Dev-login mặc định tắt. Auth có refresh token xoay vòng và logout/revocation;
client cần đọc [contract auth/sync](docs/be1-handoff.md) trước khi tích hợp.

Giới hạn mặc định: ciphertext sau giải base64 64 KiB (`WS_MAX_MESSAGE_BYTES`),
toàn bộ WS JSON 128 KiB (`WS_MAX_FRAME_BYTES`). Checklist bàn giao và lỗi
DLQ/offset còn mở thuộc BE2 nằm trong [handoff](docs/be1-handoff.md).

## Cấu trúc

```
securechat/
├── backend/                     # Go module (BE1 + BE2)
│   ├── cmd/server/              # main: REST + WS gateway + Kafka consumer + outbox relay
│   ├── internal/
│   │   ├── config/              # env vars (INF2)
│   │   ├── domain/              # types, errors, delivery states
│   │   ├── events/              # Kafka envelope + payloads (KF13)
│   │   ├── store/               # PostgreSQL repositories (messages, outbox, keys…)
│   │   ├── service/messaging/   # send/ack/sync/history – message+outbox cùng tx (KF1)
│   │   ├── service/keys/        # Signal PUBLIC pre-key directory (SC2)
│   │   ├── outbox/              # relay polling + advisory lock (KF2, KF3, KF15)
│   │   ├── delivery/            # Kafka consumer, Redis subscriber, router, dedupe (KF5–KF7, KF11, KF16)
│   │   ├── gateway/             # WebSocket hub/conn/protocol, heartbeat, backpressure (RS11–RS20)
│   │   ├── presence/            # Redis connection registry (RS12)
│   │   ├── ratelimit/           # Redis fixed-window, fail-open (RS19, RS40)
│   │   ├── auth/                # JWT + middleware
│   │   ├── httpapi/             # REST handlers
│   │   ├── metrics/  logger/    # Prometheus, slog JSON có redaction (INF3, INF4)
│   │   └── platform/{postgres,kafka}/
│   ├── migrations/              # golang-migrate SQL
│   ├── api/                     # openapi.yaml + JSON schema event Kafka
│   └── tests/integration/       # test theo ID requirement (build tag `integration`)
├── frontend/                    # React/TS (FE1 + AI) – khung + contract types
├── ml/                          # dataset, training, eval, export ONNX (AI) – khung, chưa có code
├── bench/k6/                    # load test (EXP1, EXP2, EXP5)
├── deploy/                      # kafka create-topics.sh, prometheus.yml
├── scripts/scan-plaintext.sh    # SC7 / KF12 kiểm tra rò rỉ plaintext
├── docs/                        # architecture, API, ADR, security, experiments, traceability
├── docker-compose.yml  Makefile  .env.example
```

## Đã kiểm chứng
- Idempotent send (cùng `clientMessageId` → `duplicate:true`, cùng seq), membership 403, sync theo cursor, history keyset, receipts idempotent.
- Kafka down: send vẫn `accepted`, outbox backlog tăng, relay backoff + jitter; Kafka lên lại → backlog tự drain về 0 (KF8 / EXP12).
- Hai instance: Alice ở gw-A gửi, Bob ở gw-B nhận frame `message` qua Kafka; chỉ một relay leader (RS13, KF2, KF7).

## Phát triển

Backend dùng Go 1.27.3; Docker đã khóa cùng phiên bản. Máy ít RAM nên đặt
`GOMAXPROCS=2`, `GOFLAGS=-p=1`, `GOMEMLIMIT=256MiB` khi chạy Go trên host.

```bash
make test               # unit tests
make lint
make test-integration   # khi stack đang chạy
```

Quy ước: mọi TODO ghi `TODO(<owner>, <requirement-id>)`. Không log ciphertext/plaintext/token; không đổi nghĩa field event cũ, chỉ thêm field.
