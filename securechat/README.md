# SecureChat

Chat 1:1 E2EE (Signal Protocol ở client) + 2 model AI on-device + Kafka event pipeline (transactional outbox).
Backend: **Go** · PostgreSQL (source of truth) · Kafka KRaft 1 broker (durable event log) · Redis (presence / rate limit).

> Repo này là **khung ~30%**: phần backend core đã chạy được end-to-end; phần còn lại được đánh dấu
> `TODO(BE1|BE2|FE1|AI, <ID>)` trong code và theo dõi ở [`docs/requirements-traceability.md`](docs/requirements-traceability.md).
> Chưa có code model AI — chỉ có cấu trúc thư mục và contract.

## Chạy nhanh

```bash
cd backend && go mod tidy && cd ..   # lần đầu: sinh go.sum rồi commit
cp .env.example .env          # đổi JWT_SECRET
docker compose up -d --build  # postgres, migrate, redis, kafka, kafka-init, backend-a(:8081), backend-b(:8082)
curl localhost:8081/healthz
```

Thử nhanh bằng REST:

```bash
A=$(curl -s -XPOST localhost:8081/v1/auth/dev-login -d '{"username":"alice"}')
B=$(curl -s -XPOST localhost:8082/v1/auth/dev-login -d '{"username":"bob"}')
# tạo conversation, gửi ciphertext, sync… xem backend/api/openapi.yaml
```

WebSocket: `ws://localhost:8081/ws?access_token=<JWT>` — giao thức ở [`docs/api/websocket-protocol.md`](docs/api/websocket-protocol.md).
Metrics Prometheus: `/metrics` (bật Prometheus: `docker compose --profile observability up -d`).

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

```bash
make test               # unit tests
make lint
make test-integration   # khi stack đang chạy
```

Quy ước: mọi TODO ghi `TODO(<owner>, <requirement-id>)`. Không log ciphertext/plaintext/token; không đổi nghĩa field event cũ, chỉ thêm field.
