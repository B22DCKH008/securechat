# SecureChat: phân hệ frontend (React và TypeScript)

Ứng dụng chat 1:1 chạy trên trình duyệt. Ứng dụng gửi và nhận tin qua backend Go (REST và WebSocket), mã hóa đầu cuối qua giao diện `CryptoProvider`, và phân tích rủi ro của tin nhắn và URL ngay trên thiết bị (TF-IDF kết hợp LR cho tin nhắn; LR, GBDT hoặc RF cho URL) bằng TypeScript và onnxruntime-web. Nội dung tin nhắn dạng rõ không rời khỏi trình duyệt.

## Trạng thái hiện tại

Toàn bộ luồng chạy được và có kiểm thử, nhưng còn ba hạn chế, nêu chi tiết ở mục 7:

1. Mã hóa đầu cuối đang dùng bản mô phỏng (mock), chưa mã hóa thật.
2. Model AI trong kho là model demo, số đo không có ý nghĩa, cho đến khi có dữ liệu thật.
3. Chưa chạy thử với backend thật.

## 1. Chạy ứng dụng

```bash
cd frontend
npm install
npm run dev                     # http://localhost:5173, proxy /v1 và /ws tới backend :8081
```

Yêu cầu Node từ 22.12 trở lên. Model demo đã được commit trong `public/models/` nên sau khi clone có thể chạy ngay. Các tệp `.mjs` và `.wasm` của onnxruntime-web được Vite nạp trực tiếp từ `node_modules` (`src/ai/runtime/ortAssets.ts`, dùng `import ... ?url`), không cần sao chép thủ công.

Backend chạy bằng docker-compose ở thư mục gốc của kho (xem `backend/`). Địa chỉ backend đổi bằng biến `VITE_BACKEND`, ví dụ `VITE_BACKEND=http://host:port npm run dev`. Để thử, đăng ký hai tài khoản (mật khẩu tối thiểu 12 ký tự) ở hai trình duyệt hoặc hai profile khác nhau. Backend chưa có API tìm người dùng nên cần nhập UUID của nhau ở màn hình danh sách hội thoại (màn hình có hiển thị sẵn "ID của bạn").

| Lệnh | Chức năng |
|---|---|
| `npm test` | Chạy 160 test; có thêm 8 test trên model thật, tự bỏ qua khi chưa có `ai-real` |
| `npm run typecheck` | `tsc --noEmit` ở chế độ strict |
| `npm run build` | Kiểm tra kiểu và build bản production vào `dist/` |
| `npm run models:sync [-- --demo]` | Sao chép model đã huấn luyện từ `ml/` sang `public/models` cùng fixtures đối chiếu |
| `npm run format`, `npm run format:check` | Prettier (cấu hình trong `.prettierrc`, dùng nháy đơn) |

Biến môi trường (tệp `.env`, không bắt buộc): `VITE_API_URL`, `VITE_WS_URL` (mặc định cùng origin), `VITE_E2EE=mock|signal`, `VITE_AI_TIMEOUT_MS`.

## 2. Cấu trúc mã nguồn

```
src/
  main.tsx, app/         App và định tuyến, services.ts (singleton api/analyzer), session.ts (gom dịch vụ theo người dùng), settings.ts
  pages/                 LoginPage, ChatListPage, ChatRoomPage, BenchPage (/bench)
  components/
    chat/                MessageList, MessageBubble (trạng thái gửi), Composer (kiểm tra AI trước khi gửi)
    warnings/            RiskBanner, SendWarningDialog, E2eeBanner, AiStatus, riskText (nội dung cảnh báo)
  features/
    auth/                authStore (zustand), validation (khớp ràng buộc của backend)
    messages/            chatService.ts (điều phối), model.ts (hàm thuần), hooks.ts
  crypto/                types (CryptoProvider), mockProvider, signalProvider (chưa cài đặt), index (factory)
  transport/             protocol.ts (khung WebSocket, không sửa), ws.ts, rest.ts, tokenManager.ts, backoff.ts, limits.ts, types.ts
  storage/               types, memory, indexedDb (idb), index (openStorage)
  ai/
    contract.ts          Giao diện chung với ml/ (ba nhãn: benign, scam, spam)
    features/            text.ts, url.ts, pyCompat.ts: bản TypeScript của featurizer Python, phải khớp từng bit
    runtime/             messageModel, urlModel, modelLoader, engine, worker (và Engine), analyzer, manifest
    rules/sensitive.ts   Luật regex: thẻ (Luhn), CCCD, OTP, mật khẩu, số tài khoản, khóa riêng
    risk.ts              Gộp luật, model tin nhắn và model URL thành kết quả cho một tin
    bench/               runBench (p50, p95, p99, cold-load) và mẫu đo
  lib/                   emitter, serialQueue, base64, uuid
public/models/           Model và manifest (được commit)
tests/fixtures/ai-demo/  Fixtures từ model demo, để test chạy được khi chưa huấn luyện
scripts/sync-models.mjs
```

## 3. Luồng xử lý tin nhắn

### 3.1. Gửi tin

Luồng bắt đầu từ `Composer` và gọi `ChatService.sendText`:

1. `assessRisk(outgoing)` kết hợp luật nhạy cảm, model tin nhắn và model cho từng URL. Nếu có cảnh báo, ứng dụng hỏi lại người dùng ("Sửa lại" hoặc "Vẫn gửi"). Khi AI lỗi hoặc quá hạn, việc gửi tin không bị chặn.
2. `crypto.encrypt` mã hóa tin, sau đó tin được lưu cục bộ (`status: sending`, kèm ciphertext) trước khi gửi qua WebSocket (`send`). Nếu WebSocket rớt hoặc quá hạn, tin được gửi qua REST với cùng `clientMessageId`.
3. Khi nhận `accepted`, ứng dụng ghi `messageId` và `seq`, đồng thời xóa ciphertext đang chờ. Khi lỗi mạng, tin chuyển sang `failed`; người dùng có nút "Thử lại" và tin tự gửi lại khi kết nối được khôi phục.

### 3.2. Nhận tin

Tin từ WebSocket (`message`) vào hàng đợi tuần tự theo hội thoại và được khử trùng theo `messageId`. Tin chỉ được nhận khi `seq` bằng `cursor + 1`; nếu `seq` lớn hơn thì ứng dụng gọi `POST /v1/sync`. Sau đó tin được giải mã, lưu, gửi ack `delivered`, rồi AI phân tích ở chế độ nền và cập nhật cảnh báo. Mỗi lần kết nối (hoặc kết nối lại) đều chạy đồng bộ, sau đó gửi lại các tin còn chờ.

## 4. Các ràng buộc cần giữ

Vi phạm các ràng buộc sau được xem là lỗi.

- Gửi lại luôn dùng đúng `clientMessageId` và đúng ciphertext đã lưu; nếu payload khác, backend trả về 409.
- `seq` phải liền mạch theo từng hội thoại; khi thiếu thì đồng bộ, không bỏ qua. Cursor chỉ tiến theo các tin đã xử lý (với backend, `nextCursor` là `seq` cuối của trang).
- Refresh token xoay vòng và chỉ dùng một lần; dùng lại sẽ thu hồi cả phiên. Vì vậy `TokenManager` chạy refresh theo kiểu single-flight, thay token nguyên tử, và chỉ thử lại đúng một lần khi nhận 401.
- Trạng thái receipt đơn điệu (`sent`, `delivered`, `read`), và `receiptSeq` có cursor riêng.
- Khi AI lỗi, quá hạn hoặc bị tắt thì `status` khác `ok`, và giao diện hiển thị "AI chưa kiểm tra được". Giao diện không bao giờ hiển thị "an toàn".
- Chỉ lưu và ghi log loại dữ liệu nhạy cảm phát hiện được, không lưu giá trị.

## 5. Model AI

Thư mục `ml/` huấn luyện và xuất model; frontend chỉ nạp model. Quy trình:

```bash
# trong ml/: huấn luyện và xuất model (xem ml/README.md), sau đó
cd frontend && npm run models:sync    # lấy từ ml/models/artifacts
```

Script này sao chép model và `manifest.json` vào `public/models/`, đồng thời sao chép fixtures đối chiếu vào `tests/fixtures/ai-real/`. Cả hai nhóm tệp đều được commit để sau khi clone có thể chạy ngay. Model hiện có là model demo (`manifest.json` có `demo: true` và giao diện hiển thị "mô hình DEMO"); sau khi huấn luyện bằng dữ liệu thật, chạy lệnh trên rồi commit đè.

Tệp WASM của onnxruntime-web (khoảng 15 MB) nằm trong `dist/assets/` khi build, và trình duyệt chỉ tải khi model URL được chọn là ONNX. Không đặt tệp WASM vào `public/`: ở chế độ `npm run dev`, Vite không cho import tệp nằm trong `public/`, khiến AI không chạy mà không có thông báo lỗi. Nếu chưa có model URL nào đạt ngưỡng chất lượng, manifest ghi `meetsBar: false` và ứng dụng dùng LR.

### 5.1. Đối chiếu Python và TypeScript

Nếu `normalizeText`, bộ tách từ hoặc feature URL lệch dù chỉ một ký tự, model sẽ cho kết quả sai mà không báo lỗi, nên việc đối chiếu là điều kiện bắt buộc. Việc đối chiếu yêu cầu `normalize` và `analyze` khớp tuyệt đối, xác suất sai lệch không quá 1e-5 đến 1e-9, ONNX sai lệch không quá 1e-4, và chạy cả onnxruntime-web thật trong Node. Có hai nhóm kiểm thử:

- `tests/ai/{text,url,onnx}.parity.test.ts` chạy trên fixtures demo (`tests/fixtures/ai-demo/`), luôn được chạy và bảo vệ mã featurizer TypeScript.
- `tests/ai/real.parity.test.ts` chạy trên model thật (`tests/fixtures/ai-real/`, do `models:sync` tạo). Test này tự bỏ qua khi chưa có `ai-real`, nên việc `npm test` đạt khi chưa có model thật chưa chứng minh được model thật khớp. Sau khi đồng bộ model thật, test này phải chạy (không còn ở trạng thái "skipped") và đạt. Test cũng kiểm tra `public/models` đúng là bộ model đã kiểm tra, không lẫn model demo hoặc bản cũ.

Khi sửa featurizer ở một phía thì phải sửa phía còn lại và sinh lại fixtures.

### 5.2. Đo hiệu năng

Mở trang `/bench` (không cần đăng nhập) trên thiết bị cấu hình yếu hoặc điện thoại thật, chọn "Chạy đo" và tải về tệp JSON. Giá trị p95 kém nhất được dùng để chốt thời gian chờ tối đa. Giá trị hiện tại `DEFAULT_AI_TIMEOUT_MS = 1500` chỉ là điểm xuất phát; giá trị cuối cùng được ghi vào `labels.yaml` ở mục `runtime.timeout_ms`.

## 6. Kiểm thử

`npm test` chạy toàn bộ bộ kiểm thử bằng Vitest, và `npm run typecheck` kiểm tra kiểu ở chế độ strict. Các kiểm thử của lớp transport dùng WebSocket và `fetch` giả lập nên không cần backend.

## 7. Giới hạn đã biết

1. Mã hóa đầu cuối đang là bản mô phỏng. `MockCryptoProvider` chỉ bọc UTF-8 và đánh dấu `scheme: mock-v0`; giao diện hiển thị biểu ngữ cảnh báo màu đỏ. `SignalCryptoProvider` chưa được cài đặt và ném lỗi rõ ràng khi gọi. Cần thực hiện thử nghiệm khả thi để chọn thư viện Signal chạy được trong trình duyệt (ứng viên là `@privacyresearch/libsignal-protocol-typescript`, giấy phép GPL-3.0, chưa xác minh việc bảo trì và kiểm toán); xem ghi chú đầu tệp `crypto/signalProvider.ts`. Dự án không tự cài đặt thuật toán mật mã.
2. Model AI là model demo, số đo không có ý nghĩa và không được dùng trong báo cáo. Dữ liệu tin nhắn tiếng Việt thật chưa được thu thập.
3. Chưa chạy thử với backend thật. Hợp đồng giao tiếp được đối chiếu với `openapi.yaml` và mã Go; transport được kiểm thử bằng WebSocket và `fetch` giả lập. Cần chạy thử bằng hai trình duyệt với docker-compose.
4. Nội dung tin nhắn dạng rõ được lưu trong IndexedDB mà không mã hóa, nên người có quyền truy cập máy hoặc khai thác được XSS đều đọc được. Mã hóa dữ liệu lưu cục bộ cần khóa sinh từ mật khẩu và chưa được thực hiện. Đăng xuất sẽ xóa dữ liệu cục bộ.
5. Refresh token nằm ở `sessionStorage` nên mất khi đóng tab. Nếu cần ghi nhớ đăng nhập, đổi `WebStorageTokenStore` sang `localStorage`, với đánh đổi là XSS có thể đọc được token.
6. Ứng dụng giả định `deviceId` của người nhận là 1 (mỗi người một thiết bị); `deviceId` của người gửi được đọc từ `protocolMeta.deviceId` nếu có.
7. Tin do chính người dùng gửi từ thiết bị khác không đọc lại được, vì mỗi tin chỉ có một ciphertext cho người nhận; ứng dụng hiển thị nội dung thay thế.
8. Lịch sử cũ (`GET .../messages?before_seq`) chưa được dùng, vì Signal không giải mã lại được tin đã qua ratchet; ứng dụng chỉ đồng bộ tin mới.
9. Chưa có chức năng tìm người dùng (backend chưa có API). Ứng dụng chỉ hỗ trợ chat 1:1, tiếng Việt và ba nhãn (nhãn phishing được gộp vào scam).
10. `listMessages` đọc toàn bộ hội thoại vào RAM. Cách này đủ cho đồ án; hội thoại rất lớn cần phân trang theo chỉ mục.
