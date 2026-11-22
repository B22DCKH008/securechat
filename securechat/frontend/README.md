# frontend/ — React + TypeScript client (FE/AI)

Ứng dụng chat 1:1 chạy trên trình duyệt: gửi/nhận qua backend Go (REST + WebSocket), mã hóa đầu-cuối qua một
giao diện `CryptoProvider`, và **phân tích rủi ro tin nhắn/URL ngay trên thiết bị** (TF-IDF+LR cho tin nhắn,
LR/GBDT/RF cho URL) bằng TypeScript + onnxruntime-web. Plaintext không bao giờ rời trình duyệt.

> **Trạng thái (bộ khung):** toàn bộ luồng chạy được và có test, nhưng ba thứ còn là chỗ cắm, xem
> [Giới hạn đã biết](#giới-hạn-đã-biết): (1) E2EE đang là **mock, không mã hóa thật**; (2) model AI trong repo
> chỉ là **demo** (số đo vô nghĩa) cho tới khi có dữ liệu thật; (3) chưa chạy thử với backend thật.

## Chạy

```bash
cd frontend
npm install
npm run dev                     # http://localhost:5173, proxy /v1 và /ws tới backend :8081
```

Cần Node ≥ 22.12. Model (demo) đã được commit sẵn trong `public/models/`, nên clone về là chạy được. File `.mjs/.wasm` của
onnxruntime-web được Vite nạp thẳng từ `node_modules` (`src/ai/runtime/ortAssets.ts`, import `?url`): không cần chép tay.

Backend: chạy docker-compose ở repo gốc (xem `backend/`). Đổi địa chỉ: `VITE_BACKEND=http://host:port npm run dev`.
Đăng ký tài khoản (mật khẩu ≥ 12 ký tự) ở hai trình duyệt/profile khác nhau; backend chưa có API tìm người
dùng nên **dán UUID của nhau** ở màn hình danh sách (hiển thị sẵn "ID của bạn").

| Lệnh                              | Việc                                                                |
| --------------------------------- | ------------------------------------------------------------------- |
| `npm test`                        | 160 test + 8 test model thật (tự skip nếu chưa có `ai-real`)        |
| `npm run typecheck`               | `tsc --noEmit` (strict)                                             |
| `npm run build`                   | typecheck + build production vào `dist/`                            |
| `npm run models:sync [-- --demo]` | chép model đã train từ `ml/` sang `public/models` + fixtures parity |
| `npm run format` / `format:check` | Prettier (`.prettierrc`: singleQuote)                               |

Biến môi trường (`.env`, tùy chọn): `VITE_API_URL`, `VITE_WS_URL` (mặc định cùng origin),
`VITE_E2EE=mock|signal`, `VITE_AI_TIMEOUT_MS`.

## Cấu trúc

```
src/
├── main.tsx, app/         # App + routing, services.ts (singleton api/analyzer), session.ts (gom dịch vụ theo người dùng), settings.ts
├── pages/                 # LoginPage, ChatListPage, ChatRoomPage, BenchPage (/bench)
├── components/
│   ├── chat/              # MessageList, MessageBubble (trạng thái gửi), Composer (kiểm tra AI trước khi gửi)
│   └── warnings/          # RiskBanner, SendWarningDialog, E2eeBanner, AiStatus, riskText (câu chữ cảnh báo)
├── features/
│   ├── auth/              # authStore (zustand), validation (khớp ràng buộc backend)
│   └── messages/          # chatService.ts (điều phối), model.ts (hàm thuần), hooks.ts
├── crypto/                # types (CryptoProvider), mockProvider, signalProvider (STUB), index (factory)
├── transport/             # protocol.ts (khung WS, KHÔNG sửa), ws.ts, rest.ts, tokenManager.ts, backoff.ts, limits.ts, types.ts
├── storage/               # types, memory, indexedDb (idb), index (openStorage)
├── ai/
│   ├── contract.ts        # interface chung với ml/ (3 nhãn: benign | scam | spam)
│   ├── features/          # text.ts, url.ts, pyCompat.ts: bản TS của featurizer Python (phải khớp từng bit)
│   ├── runtime/           # messageModel, urlModel, modelLoader, engine, worker(+Engine), analyzer, manifest
│   ├── rules/sensitive.ts # luật regex: thẻ (Luhn), CCCD, OTP, mật khẩu, STK, khóa riêng
│   ├── risk.ts            # gộp luật + model tin nhắn + model URL cho một tin
│   └── bench/             # runBench (p50/p95/p99, cold-load) + mẫu đo
└── lib/                   # emitter, serialQueue, base64, uuid
public/models/             # model + manifest (ĐƯỢC commit)
tests/fixtures/ai-demo/    # fixtures từ model demo, để test chạy không cần train
scripts/sync-models.mjs
```

## Luồng

**Gửi** (`Composer` → `ChatService.sendText`):

1. `assessRisk(outgoing)`: luật nhạy cảm + model tin nhắn + model từng URL. Có cảnh báo → hỏi lại ("Sửa lại" / "Vẫn gửi"); AI lỗi/quá hạn **không chặn** việc gửi.
2. `crypto.encrypt` → lưu local (`status: sending`, kèm ciphertext) **trước khi** gửi → WS `send`, rớt/timeout thì REST (cùng `clientMessageId`).
3. `accepted` → ghi `messageId`/`seq`, xóa ciphertext chờ. Lỗi mạng → `failed` (có nút Thử lại, tự gửi lại khi kết nối lại).

**Nhận**: WS `message` → hàng đợi tuần tự theo hội thoại → khử trùng theo `messageId` → `seq == cursor+1` mới nhận,
cao hơn thì `POST /v1/sync` → giải mã → lưu → ack `delivered` → AI phân tích nền → cập nhật cảnh báo.
Mỗi lần kết nối (lại) đều chạy sync, rồi gửi lại tin còn chờ.

### Bất biến phải giữ (vi phạm = bug)

- Gửi lại luôn dùng **đúng `clientMessageId` + đúng ciphertext đã lưu** (khác payload → backend trả 409).
- `seq` liền mạch theo hội thoại; hụt thì sync, không bỏ qua. Cursor chỉ tiến theo tin đã xử lý (backend: `nextCursor` = seq cuối trang).
- Refresh token **xoay vòng, dùng một lần; dùng lại sẽ thu hồi cả phiên** → `TokenManager` refresh single-flight, thay token nguyên tử, 401 chỉ thử lại đúng một lần.
- Receipt đơn điệu (`sent < delivered < read`), `receiptSeq` có cursor riêng.
- AI lỗi/quá hạn/tắt ⇒ `status` khác `ok` ⇒ UI nói "AI chưa kiểm tra được". **Không bao giờ** hiện "an toàn".
- Chỉ lưu/ghi log **loại** dữ liệu nhạy cảm phát hiện được, không lưu giá trị.

## Model AI

`ml/` train và export; frontend chỉ nạp:

```bash
# trong ml/: huấn luyện + export (xem ml/README.md) rồi
cd frontend && npm run models:sync    # lấy ml/models/artifacts
```

Script chép model + `manifest.json` vào `public/models/` và fixtures parity vào `tests/fixtures/ai-real/`; **cả hai được commit** để
clone về chạy được ngay. Model hiện có là **demo** (`manifest.json` có `demo: true`, UI hiện "mô hình DEMO"); sau khi train thật,
chạy lệnh trên rồi commit đè. WASM của onnxruntime-web (~15 MB) nằm trong `dist/assets/` khi build; trình duyệt chỉ tải khi model URL là ONNX.
**Không đặt file WASM vào `public/`**: ở `npm run dev` Vite không cho import file trong `public/`, AI sẽ im lặng không chạy được.
Nếu chưa model URL nào đạt ngưỡng chất lượng, manifest ghi `meetsBar: false` và dùng LR (báo trung thực, không giấu).

**Parity Python↔TS** là điều kiện sống còn: nếu `normalizeText`/tokenizer/URL features lệch dù một ký tự thì model cho kết quả sai
_một cách im lặng_. Parity được kiểm ở hai chỗ (normalize/analyze khớp tuyệt đối, xác suất ≤ 1e-5…1e-9, ONNX ≤ 1e-4,
chạy cả onnxruntime-web thật trong Node):

- `tests/ai/{text,url,onnx}.parity.test.ts` — trên fixtures **demo** (`tests/fixtures/ai-demo/`), luôn chạy; bảo vệ code featurizer TS.
- `tests/ai/real.parity.test.ts` — trên model **thật** (`tests/fixtures/ai-real/`, do `models:sync` tạo). **Tự bỏ qua khi chưa có
  `ai-real`**, nên `npm test` xanh lúc này _chưa_ chứng minh model thật khớp. Sau khi sync model thật, test này phải chạy (không còn "skipped")
  và pass; nó cũng kiểm `public/models` đúng là bộ đã kiểm (không lẫn demo, không bản cũ).

Sửa featurizer ở một phía thì phải sửa phía kia và sinh lại fixtures.

**Đo hiệu năng:** mở `/bench` (không cần đăng nhập) trên **máy yếu/điện thoại thật**, bấm "Chạy đo", tải JSON.
Dùng số p95 tệ nhất để chốt timeout (hiện `DEFAULT_AI_TIMEOUT_MS = 1500` chỉ là điểm xuất phát, ghi vào `labels.yaml: runtime.timeout_ms`).

## Giới hạn đã biết

1. **E2EE là mock.** `MockCryptoProvider` chỉ bọc UTF-8, đánh dấu `scheme: mock-v0`; UI hiện banner đỏ. `SignalCryptoProvider` là stub ném lỗi rõ ràng.
   Cần **PoC go/no-go** chọn thư viện Signal chạy trong browser (ứng viên `@privacyresearch/libsignal-protocol-typescript`: GPL-3.0, chưa xác minh bảo trì/kiểm toán) — xem ghi chú đầu `crypto/signalProvider.ts`. Không tự viết crypto.
2. **Model demo.** Số đo của model demo vô nghĩa; đừng đưa vào báo cáo. Cần dữ liệu tiếng Việt thật (đã hoãn).
3. **Chưa thử với backend thật.** Hợp đồng được đối chiếu với `openapi.yaml` + mã Go; transport được test bằng WebSocket/fetch giả. Cần chạy thử hai trình duyệt với docker-compose.
4. **Plaintext lưu IndexedDB không mã hóa** (ai có máy/XSS đều đọc được). Mã hóa at-rest cần khóa từ mật khẩu — chưa làm. Đăng xuất xóa dữ liệu cục bộ.
5. **Refresh token ở `sessionStorage`** (mất khi đóng tab). Đổi `WebStorageTokenStore` sang localStorage nếu muốn ghi nhớ đăng nhập — đánh đổi: XSS đọc được.
6. Giả định `deviceId` của người nhận = 1 (một thiết bị/người); deviceId người gửi đọc từ `protocolMeta.deviceId` nếu có.
7. Tin do chính mình gửi từ thiết bị khác không đọc lại được (mỗi tin chỉ có một ciphertext cho người nhận); hiển thị placeholder.
8. Lịch sử cũ (`GET .../messages?before_seq`) chưa dùng: Signal không giải mã lại được tin đã qua ratchet; chỉ đồng bộ tin mới.
9. Chưa có tìm người dùng (backend chưa có API), chỉ 1:1, tiếng Việt, 3 nhãn (phishing gộp vào scam).
10. `listMessages` đọc cả hội thoại vào RAM — đủ cho đồ án; hội thoại rất lớn cần phân trang theo index.
