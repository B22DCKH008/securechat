# Metadata server vẫn thấy (SC6)

| Dữ liệu | Nơi lưu | Vì sao cần |
|---|---|---|
| userId, username | `users` | auth, routing |
| password hash | `users.password_hash` | xác thực mật khẩu; không lưu mật khẩu gốc |
| session/device/family IDs, token hash, expiry/revocation | `auth_sessions` | refresh rotation, logout; không lưu refresh token gốc |
| conversation membership | `conversation_members` | SC5 authorization |
| messageId, seq, senderId, createdAt | `messages`, Kafka | ordering, sync, dedupe |
| ciphertext length | `messages`, Kafka | (lộ gián tiếp độ dài message) |
| protocolMeta (Signal message type, deviceId, registrationId) | `messages`, Kafka | client cần để decrypt |
| delivered/read timestamps | `message_receipts`, Kafka | RS6 |
| receiptSeq, message/state/timestamp | `receipt_changes` | đồng bộ ACK đến muộn bằng cursor độc lập |
| online status, instance | Redis (TTL) | routing/presence |
| IP, thời điểm kết nối | (không log mặc định) | — |

TODO: padding ciphertext? sealed sender? → ghi là hướng phát triển.
