# ml/ — Message & URL risk models (FE/AI 2)

> **Trạng thái:** chỉ có khung thư mục + contract. Chưa có code model (team sẽ phát triển).
> Nguyên tắc bắt buộc: **inference chạy trên client** (AI13), **không gửi plaintext ra server
> hay AI API bên ngoài** (AI23), model lỗi ⇒ UI báo "AI không khả dụng", không bao giờ ngầm định "an toàn" (AI22, AI24).

## Cấu trúc

```
ml/
├── configs/            # labels.yaml (AI3), train/eval configs, threshold đã chọn (AI25)
├── data/
│   ├── raw/            # dữ liệu gốc – KHÔNG commit (xem .gitignore); ghi nguồn + license ở data/SOURCES.md (AI1)
│   ├── interim/        # sau cleaning
│   ├── processed/      # feature-ready
│   └── splits/         # train/val/test cố định, có seed + hash (AI7)
├── notebooks/          # EDA, phân tích FP/FN (AI9, AI10) – không chứa logic production
├── src/securechat_ml/
│   ├── data/           # load + clean, pipeline tái lập (AI2)
│   ├── features/       # tokenizer / URL lexical features
│   ├── models/message/ # phishing/scam/spam detector (AI4)
│   ├── models/url/     # malicious URL detector (AI5)
│   ├── evaluation/     # P/R/F1, confusion matrix, baseline comparison (AI6, AI8)
│   └── export/         # export ONNX + parity check Python vs onnxruntime-web (AI14, AI16)
├── models/artifacts/   # file .onnx đã export + model_card.md + version (AI17) – không commit binary lớn
├── reports/            # evaluation report, figures, latency/resource (AI18–AI21)
├── scripts/            # CLI: prepare_data, train, evaluate, export
└── tests/              # test pipeline + parity test
```

## Contract với frontend (AI15)

Xem `frontend/src/ai/contract.ts` và `configs/labels.yaml`. Mọi thay đổi label/threshold
phải cập nhật **cả hai** file và bump `modelVersion`.

## Checklist bàn giao

| ID | Việc | Vị trí dự kiến |
|---|---|---|
| AI1–AI3 | Dataset, nguồn, license, label definition | `data/SOURCES.md`, `configs/labels.yaml` |
| AI4–AI6 | 2 model + baseline | `src/securechat_ml/models/*` |
| AI7–AI10 | Split độc lập, metrics, FP/FN analysis | `evaluation/`, `reports/` |
| AI11 | Ít nhất 1 tối ưu có số đo (quantize/prune/distill) | `export/`, `reports/optimization.md` |
| AI12 | Giới hạn model, ngôn ngữ hỗ trợ | `models/artifacts/model_card.md` |
| AI14, AI16 | ONNX export + parity | `export/` |
| AI18–AI21, AI26 | Cold/warm latency, CPU/RAM, size, AI ON/OFF, browser test | `reports/performance.md` |
