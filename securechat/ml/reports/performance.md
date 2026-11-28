# Browser Performance Benchmark (AI18–AI21)

## 1. Cấu hình đo
- **Model version:** `msg-4e3322-4842a0` (TF-IDF char/word n-gram + Logistic Regression, `max_features = 5000`)
- **Artifact size:** `288.3 KB` (`message_model.json`) + `1.8 KB` (`message_rules.json`)
- **Frontend production bundle:** `75.99 KB` gzip JS + `1.21 KB` gzip CSS
- **Environment:** `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36`
- **Parity Python ↔ TypeScript:** `max_abs_prob_diff = 1.373e-8` (14 fixture chuẩn hóa/phân tích/dự đoán, ngưỡng cho phép `1e-5`)

## 2. Kết quả đo trên trình duyệt (`/bench`)
| Chỉ số | Giá trị đo | Ghi chú |
| :--- | :---: | :--- |
| **App initial cold start (topbar)** | `33.5 ms` | Lần nạp đầu tiên khi mở trang |
| **Bench cold start (fetch + parse + 1st inference)** | `17.20 ms` | Đo tách riêng trong `/bench` |
| **Warm inference p50 (300 runs)** | `0.100 ms` | Trung vị độ trễ mỗi tin nhắn |
| **Warm inference mean (300 runs)** | `0.099 ms` | Trung bình trên 300 lượt |
| **Warm inference p95 (300 runs)** | `0.200 ms` | Phân vị 95 |
| **Warm inference p99 (300 runs)** | `0.700 ms` | Phân vị 99 |
| **JS Heap used (Chromium)** | `12.37 MB` | Bộ nhớ thực thi trên trình duyệt |

## 3. Kiểm tra hành vi an toàn (AI22–AI26)
- Plaintext chỉ được xử lý cục bộ trên trình duyệt, không gửi lên máy chủ.
- Có nút bật/tắt AI bảo vệ trực tiếp trên giao diện (`Bật AI bảo vệ`).
- Khi AI tắt, chưa khởi tạo hoặc gặp lỗi, giao diện hiển thị trạng thái `unavailable` / `error`, không bao giờ trả kết quả "an toàn".