# WebSocket protocol

Endpoint: `GET /ws?access_token=<JWT>` (xác thực trước khi upgrade). Mỗi frame là JSON:

```json
{ "type": "...", "ref": "client-correlation-id", "payload": { } }
```

## Client → server
| type | payload | Phản hồi |
|---|---|---|
| `send` | `{clientMessageId, conversationId, ciphertext(base64), protocolMeta, clientCreatedAt?}` | `accepted` (cùng `ref`) hoặc `error` |
| `ack` | `{messageId, state: "delivered"\|"read"}` | không có (lỗi → `error`) |
| `ping` | – | `pong` |

## Server → client
| type | Khi nào |
|---|---|
| `resync` | ngay sau khi kết nối, hoặc khi server yêu cầu → client gọi `POST /v1/sync` với cursor |
| `accepted` | message đã commit PostgreSQL. `duplicate=true` nếu là retry |
| `message` | payload = `MessageAccepted` event (ciphertext). Dedupe theo `messageId`, sắp theo `seq`; thấy gap → sync |
| `receipt` | delivered/read của message mình gửi |
| `error` | `code`: `rate_limited`, `forbidden`, `not_found`, `invalid`, `bad_frame`, `internal` (→ retry cùng clientMessageId) |

## Đóng kết nối
| Close code | Ý nghĩa | Client nên |
|---|---|---|
| 1001 GoingAway | server shutdown | reconnect (backoff+jitter) rồi sync |
| 1008 PolicyViolation | slow consumer / heartbeat timeout | reconnect rồi sync |
| 1013 TryAgainLater | quá số kết nối/user | đóng tab thừa |
