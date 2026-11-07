# frontend/ — React + TypeScript client (FE/AI 1 + FE/AI 2)

> **Trạng thái:** khung thư mục + contract (`src/ai/contract.ts`, `src/transport/protocol.ts`).
> Khởi tạo project: `npm create vite@latest . -- --template react-ts` rồi giữ nguyên cấu trúc dưới.

```
src/
├── app/                 # routing, providers
├── pages/               # Login, ChatList, ChatRoom
├── components/chat/     # MessageList, Composer, StatusTicks (accepted/delivered/read – RS6)
├── components/warnings/ # RiskWarning, AIUnavailableBadge (AI24)
├── features/            # auth / conversations / messages state
├── crypto/              # Signal Protocol library wrapper – KHÔNG tự viết crypto (SC1); key store local (SC2); decrypt-fail UX (SC9)
├── transport/           # WS client: reconnect + backoff + jitter (RS15, RS36), seq gap → sync (KF4), dedupe by messageId (KF5)
├── storage/             # IndexedDB: sessions, keys, per-conversation cursor
├── ai/
│   ├── contract.ts      # interface chung với ml/
│   ├── runtime/         # onnxruntime-web loader/caching/versioning (AI14, AI17)
│   └── rules/           # rule-based sensitive-data checks trước khi gửi (doc §3.1 bước 2)
└── lib/
public/models/           # file .onnx được serve tĩnh
```

## Luồng gửi (doc §3.1)
1. plaintext → `ai/rules` + `ai/runtime` → cảnh báo nếu nghi ngờ
2. người dùng xác nhận → `crypto.encrypt` → `transport.send({clientMessageId, ciphertext, …})`
3. đợi frame `accepted`; timeout ⇒ **retry với cùng clientMessageId** (RS37)
