# Security checklist (SC7, KF12, INF3) — điền kết quả + bằng chứng

| # | Kiểm tra | Cách | Kết quả | Bằng chứng |
|---|---|---|---|---|
| 1 | Không có plaintext trong `messages`, `outbox` | `scripts/scan-plaintext.sh MARKER` | ☐ | |
| 2 | Không có plaintext trong Kafka topics | như trên | ☐ | |
| 3 | Không có plaintext trong Redis | như trên | ☐ | |
| 4 | Logs không chứa ciphertext/token/plaintext | như trên + review `logger` | ☐ | |
| 5 | Network payload chỉ có ciphertext | DevTools/HAR | ☐ | |
| 6 | Private key không rời client | review code `frontend/src/crypto` | ☐ | |
| 7 | Non-member không đọc/gửi được | integration test | ☐ | |
| 8 | AI không gọi dịch vụ ngoài | DevTools network khi AI ON | ☐ | |
| 9 | Kafka retention ngắn đã cấu hình | `make kafka-topics` | ☐ | |
| 10 | `AUTH_DEV_LOGIN_ENABLED=false` khi demo "production" | `.env` | ☐ | |
