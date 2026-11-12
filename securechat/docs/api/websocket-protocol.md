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
| `error` | `code`: `rate_limited`, `forbidden`, `not_found`, `invalid`, `bad_frame`, `bad_payload`, `unknown_type`, `idempotency_conflict`, `internal` (→ retry cùng clientMessageId) |

## Giới hạn payload và frame

`WS_MAX_MESSAGE_BYTES=65536` giới hạn ciphertext sau khi giải base64, dùng chung
cho REST và WS. `WS_MAX_FRAME_BYTES=131072` giới hạn toàn bộ message JSON gửi vào
WS, gồm base64, protocolMeta, ref và envelope. Cấu hình frame phải đủ
`4 * ceil(WS_MAX_MESSAGE_BYTES / 3) + 8192`; server từ chối khởi động nếu nhỏ hơn.
`protocolMeta` tối đa 4096 byte. Ciphertext quá giới hạn nhưng frame còn hợp lệ
trả `error.code=invalid` và giữ kết nối. Frame quá lớn đóng kết nối với code 1009.
Client cũng cần đặt read limit đủ nhận frame `message` chứa base64 và envelope
(128 KiB đáp ứng payload mặc định).

Session được kiểm tra lúc handshake, mỗi text frame và heartbeat. Refresh phải
chạy tuần tự; sau refresh reconnect với token mới rồi gọi sync. Receipt cursor
độc lập message cursor; xem [contract bàn giao](../be1-handoff.md).

## Đóng kết nối
| Close code | Ý nghĩa | Client nên |
|---|---|---|
| 1001 GoingAway | server shutdown | reconnect (backoff+jitter) rồi sync |
| 1008 PolicyViolation | slow consumer / heartbeat timeout / session hết hạn hoặc bị thu hồi | refresh hoặc login nếu cần, reconnect rồi sync |
| 1009 MessageTooBig | toàn bộ message JSON vượt frame budget | giảm kích thước frame trước khi retry; dùng cùng clientMessageId nếu chưa rõ kết quả |
| 1013 TryAgainLater | quá số kết nối/user | đóng tab thừa |
