# SecureChat – `ml/` (huấn luyện, đánh giá, xuất model)

Khung huấn luyện cho 2 model chạy **trên thiết bị** (client): phát hiện tin nhắn lừa đảo/spam (tiếng Việt) và URL độc hại.
Toàn bộ pipeline chạy được ngay trên **dữ liệu demo** để thử đường ống; khi có dữ liệu thật chỉ cần thả file vào `data/raw/`.

> Số đo trên dữ liệu demo **vô nghĩa** (ít, sinh theo khuôn). Không dùng làm kết quả trong báo cáo.

## Cài đặt & chạy thử

Cần Python 3.10–3.12 (bản quá mới có thể chưa có wheel cho `onnxruntime`/`skl2onnx`). Không cần `make`.

**Windows (PowerShell)** – trong thư mục `ml/`:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1          # nếu bị chặn: Set-ExecutionPolicy -Scope Process Bypass
pip install -r requirements.txt
pip install -e .                       # để gọi `python -m securechat_ml.cli` mà không cần đặt PYTHONPATH
python -m pytest -q                    # kỳ vọng: 30 passed
python -m securechat_ml.cli demo-all   # cả đường ống trên dữ liệu demo
python -m securechat_ml.cli demo-clean # xóa đầu ra demo
```

**Linux/macOS/WSL**: như trên với `source .venv/bin/activate`; hoặc dùng `make test`, `make demo`, `make demo-clean`.

Mọi lệnh khác: `python -m securechat_ml.cli [--demo] <lệnh>` (xem bảng dưới). Nếu thấy lỗi font tiếng Việt: `$env:PYTHONUTF8=1`.
File CSV lưu từ Excel (có BOM) đọc được; nên lưu dạng "CSV UTF-8".

> Số đo trên dữ liệu demo **vô nghĩa** (ít, sinh theo khuôn). Không dùng làm kết quả trong báo cáo.
> Đầu ra demo nằm ở `data/splits/demo/`, `models/demo_artifacts/`, `reports/demo/` (tách hẳn khỏi dữ liệu thật).

## Luồng làm việc với dữ liệu thật

| Bước | Lệnh                                                        | Đọc                                                            | Ghi                                                                                  |
| ---- | ----------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 0    | `validate-messages --file data/raw/messages_train_pool.csv` | CSV tin nhắn                                                   | in báo cáo lỗi (exit 1 nếu có lỗi)                                                   |
| 1    | `prepare-messages`                                          | `data/raw/messages_train_pool.csv`, `messages_handlabeled.csv` | `data/splits/messages/{train,val,test,test_hard}.csv` + `split_manifest.json`        |
| 2    | `train-message`                                             | splits                                                         | `models/artifacts/message/`, `reports/message_metrics.json`                          |
| 3    | `sweep-message`                                             | splits                                                         | `reports/optimization_message.json` (AI11: kích thước/F1/độ trễ theo `max_features`) |
| 4    | `prepare-urls`                                              | PhiUSIIL + PhishVN                                             | `data/splits/urls/{train,val_in,test_in,val_cross,test_cross}.csv`                   |
| 5    | `train-url`                                                 | splits                                                         | `models/artifacts/url/models.joblib`, `reports/url_metrics.json`                     |
| 6    | `export-message`, `export-url`                              | artifacts                                                      | JSON/ONNX + fixtures parity                                                          |
| 7    | `parity`                                                    | artifacts                                                      | `reports/parity_python.json` (Python tự đối chiếu bản export)                        |

Chạy: `python -m securechat_ml.cli <lệnh>` (thêm `--demo` trước tên lệnh để dùng dữ liệu demo; chưa `pip install -e .` thì đặt `PYTHONPATH=src`). Mỗi lệnh in JSON; đọc thêm `reports/*.json`.

## Định dạng dữ liệu

**`data/raw/messages_train_pool.csv`** (train/validation; real + synthetic):

| cột      | bắt buộc | ghi chú                                                          |
| -------- | -------- | ---------------------------------------------------------------- |
| `text`   | ✔        | nội dung tin                                                     |
| `label`  | ✔        | `benign` \| `spam` \| `scam` (xem `configs/labels.yaml`)         |
| `source` |          | `real` \| `synthetic` (mặc định `unknown`)                       |
| `group`  |          | id template/kịch bản; các tin cùng `group` luôn nằm cùng một tập |
| `lang`   |          | mặc định `vi`                                                    |

**`data/raw/messages_handlabeled.csv`** = TEST, **bạn tự gán nhãn tay**, không sinh bằng AI: `text,label[,hard,note]`. `hard=1` cho ca khó (không dấu, teencode, tin hợp lệ trông giống lừa đảo…) → báo cáo riêng ở `test_hard`.

**URL**: `data/raw/PhiUSIIL_Phishing_URL_Dataset.csv` (UCI id 967; cột `URL`,`label`; **label 1 = hợp lệ, 0 = phishing**, loader đã đảo) và `data/raw/phishvn/<file>.csv`.
PhishVN: **schema chưa được kiểm tra** – loader tự dò cột `url / label / label_confidence (gold|silver|bronze) / split`; nếu sai sẽ báo lỗi kèm danh sách cột thật → sửa `phishvn:` trong `configs/url.yaml` (`url_col`, `label_col`, `tier_col`, `split_col`) và tên file ở `files.phishvn`. Nguồn & giấy phép: xem `data/SOURCES.md`.

## Quy tắc chống leakage (được test trong `tests/test_leakage.py`)

- Tin nhắn gần giống nhau (cosine ≥ 0.85) hoặc cùng `group` → cùng nhóm → không bị tách sang tập khác.
- Tin train gần giống tin **test gán tay** bị loại khỏi train.
- Dữ liệu `synthetic` **không bao giờ** vào test; chỉ vào validation khi thiếu tin `real` (có cảnh báo trong manifest).
- URL: chia theo **domain đăng ký** (`registered_domain`); mọi domain xuất hiện ở val/test bị loại khỏi train; tầng `bronze` không vào test chéo miền.
- TF-IDF chỉ `fit` trên train; ngưỡng chọn trên **validation**, test chỉ đo một lần ở ngưỡng đó.
- URL: không dùng `is_https` (artefact thu thập); `has_www` có thể loại qua `features.exclude`.

## Chọn ngưỡng & đạt/không đạt

Đặt trong `configs/*.yaml` **trước khi xem kết quả** (đây là đề xuất, nhóm chốt):

- Tin nhắn: precision ≥ 0.90 tại recall ≥ 0.80 trên test gán tay.
- URL: recall ≥ 0.90 tại FPR ≤ 1% trên `test_cross` (PhishVN gold/silver).
  Báo cáo có CI 95% bootstrap, ma trận nhầm lẫn, PR-AUC; nếu không đạt thì báo cáo trung thực (`meets_bar... = false`).

## Hợp đồng parity Python ↔ TypeScript (AI16)

Client **không** chạy Python. `export-*` tạo ra:

| File (trong `models/artifacts/...`)    | Dùng cho                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `message/message_model.json`           | vocab, idf, coef, intercept, ngưỡng, thông số featurizer → TS tự tính TF-IDF + LR                                        |
| `message/message_rules.json`           | luật regex (Nấc 0)                                                                                                       |
| `message/message_parity_fixtures.json` | ca kiểm tra: `normalize` (chuỗi khớp tuyệt đối), `analyze` (danh sách feature khớp tuyệt đối), `predict` (sai số ≤ 1e-5) |
| `url/url_spec.json`                    | hằng số + danh sách feature URL                                                                                          |
| `url/url_lr.json`                      | LR dạng JSON (TS tự tính)                                                                                                |
| `url/url_gbdt.onnx`, `url_rf.onnx`     | tree model chạy bằng onnxruntime-web (WASM) nếu được chọn                                                                |
| `url/url_parity_fixtures.json`         | `allFeatures` (≤ 1e-9), `probabilities` (LR ≤ 1e-6, ONNX ≤ 1e-4)                                                         |

Việc cần làm phía TS (chưa có trong gói này): cài đặt `normalizeText`, `analyze`, `extractUrlFeatures` **giống hệt** `src/securechat_ml/features/{text,url}.py`, rồi viết test đọc các fixtures ở trên. Lưu ý các điểm dễ lệch: `String.prototype.normalize('NFD')`, `đ→d`, regex `[0-9]{6,}`, char n-gram có đệm khoảng trắng (`char_wb`), thứ tự/độ dài feature URL, parse URL tự viết (không dùng `new URL`). Tin cậy `decision_agreement` thay vì xác suất tuyệt đối: ngưỡng đã được `robust_threshold` đẩy vào giữa hai điểm số liền kề để tránh lật quyết định do float32/float64.

Runtime: timeout/lỗi → trạng thái `unavailable`, **không bao giờ** trả "safe". Kết quả AI chỉ ở client, không gửi lên server.

## Cấu trúc

```
configs/   labels.yaml, message.yaml, url.yaml, rules.yaml
data/      raw/ (bạn thả dữ liệu) · splits/ · demo/ · SOURCES.md · SYNTHETIC_SPEC.md
src/securechat_ml/  config · features/{text,url} · data/{splits,messages,urls,demo}
                    models/{message,url} · evaluation/metrics · export/{message_json,url_export,parity} · cli
tests/     features · leakage · metrics + pipeline
```

## Giới hạn đã biết

- `HistGradientBoosting` **không** xuất ONNX được với skl2onnx 1.20 + numpy 2.5 → dùng `GradientBoostingClassifier` (`gbdt`).
- PhishVN schema chưa kiểm chứng; PhiUSIIL dùng riêng chuỗi URL (không dùng các cột đặc trưng sẵn có của bộ này).
- Chưa có bản TS của featurizer; chưa có benchmark trên trình duyệt (độ trễ, bộ nhớ) – cần đo trên thiết bị thật.
- Nấc 2–3 (e5, PhoBERT, distillation) chưa làm; chỉ cân nhắc khi baseline TF-IDF+LR không đạt ngưỡng và còn ≥ 3 ngày.

## Checklist bàn giao

| ID              | Việc                                                      | Vị trí dự kiến                           |
| --------------- | --------------------------------------------------------- | ---------------------------------------- |
| AI1–AI3         | Dataset, nguồn, license, label definition                 | `data/SOURCES.md`, `configs/labels.yaml` |
| AI4–AI6         | 2 model + baseline                                        | `src/securechat_ml/models/*`             |
| AI7–AI10        | Split độc lập, metrics, FP/FN analysis                    | `evaluation/`, `reports/`                |
| AI11            | Ít nhất 1 tối ưu có số đo (quantize/prune/distill)        | `export/`, `reports/optimization.md`     |
| AI12            | Giới hạn model, ngôn ngữ hỗ trợ                           | `models/artifacts/model_card.md`         |
| AI14, AI16      | ONNX export + parity                                      | `export/`                                |
| AI18–AI21, AI26 | Cold/warm latency, CPU/RAM, size, AI ON/OFF, browser test | `reports/performance.md`                 |
