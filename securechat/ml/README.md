# SecureChat: phân hệ ml (huấn luyện, đánh giá, xuất model)

Thư mục `ml/` chứa mã huấn luyện, đánh giá và xuất hai mô hình chạy trên thiết bị người dùng: mô hình phát hiện tin nhắn lừa đảo và spam bằng tiếng Việt, và mô hình phát hiện URL độc hại. Toàn bộ quy trình chạy được trên dữ liệu demo để kiểm tra đường ống. Khi có dữ liệu thật, đặt các tệp vào `data/raw/` rồi chạy lại các lệnh ở mục 3.

Số đo trên dữ liệu demo không có ý nghĩa thống kê (ít mẫu, sinh theo khuôn) và không được dùng làm kết quả báo cáo. Đầu ra của chế độ demo nằm riêng tại `data/splits/demo/`, `models/demo_artifacts/` và `reports/demo/`.

## 1. Cài đặt và chạy thử

Yêu cầu Python từ 3.10 đến 3.12. Các bản mới hơn có thể chưa có gói biên dịch sẵn cho `onnxruntime` và `skl2onnx`. Không bắt buộc phải cài `make`.

Trên Windows (PowerShell), tại thư mục `ml/`:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1          # nếu bị chặn: Set-ExecutionPolicy -Scope Process Bypass
pip install -r requirements.txt
pip install -e .                       # cho phép gọi python -m securechat_ml.cli mà không đặt PYTHONPATH
python -m pytest -q                    # kết quả mong đợi: 93 passed
python -m securechat_ml.cli demo-all   # chạy toàn bộ đường ống trên dữ liệu demo
python -m securechat_ml.cli demo-clean # xóa đầu ra demo
```

Trên Linux, macOS hoặc WSL, dùng `source .venv/bin/activate` để kích hoạt môi trường ảo, hoặc dùng `make test`, `make demo`, `make demo-clean`.

Cú pháp chung của các lệnh là `python -m securechat_ml.cli [--demo] <lệnh>`. Tham số `--demo` đặt trước tên lệnh để dùng dữ liệu demo. Nếu chưa chạy `pip install -e .` thì đặt biến môi trường `PYTHONPATH=src`. Mỗi lệnh in kết quả dạng JSON; số liệu chi tiết nằm trong `reports/*.json`.

Nếu tiếng Việt hiển thị lỗi font trên Windows, đặt `$env:PYTHONUTF8=1`. Tệp CSV lưu từ Excel (có BOM) vẫn đọc được, nhưng nên lưu theo định dạng "CSV UTF-8".

## 2. Dữ liệu đầu vào

### 2.1. Tin nhắn

Tệp `data/raw/messages_train_pool.csv` dùng cho huấn luyện và validation, gồm cả dữ liệu thật và dữ liệu tổng hợp:

| Cột | Bắt buộc | Ghi chú |
|---|---|---|
| `text` | Có | Nội dung tin nhắn |
| `label` | Có | `benign`, `spam` hoặc `scam` (xem `configs/labels.yaml`) |
| `source` | Không | `real` hoặc `synthetic`, mặc định `unknown` |
| `group` | Không | Mã kịch bản hoặc mẫu tin; các tin cùng `group` luôn nằm trong cùng một tập |
| `lang` | Không | Mặc định `vi` |

Nguồn tin nhắn thật hiện dùng là bộ SMS tiếng Việt ghi tại `data/SOURCES.md`. Bộ này chỉ có hai nhãn (0 và 1) và toàn tin SMS, nên được chuyển sang định dạng trên bằng `scripts/import_vi_sms.py`:

```powershell
git clone https://github.com/trannguyenthaituan251209/vietnamese_sms_dataset data/raw/vietnamese_sms_dataset
python scripts/import_vi_sms.py --src data/raw/vietnamese_sms_dataset/full_dataset.csv --out data/raw/messages_vi_sms.csv
python scripts/build_message_pool.py messages_vi_sms.csv    # thêm các tệp khác (tin chat tổng hợp) vào cuối danh sách
```

Script loại tin trùng, gộp khoảng trắng, gán nhãn theo luật rồi thay các token ẩn danh bằng giá trị giả theo ngữ cảnh (số điện thoại sau "thuê bao", đầu số sau "gửi", số tài khoản sau "STK", năm trong số hiệu văn bản...). Giá trị sinh cố định theo `message_id` nên chạy lại cho cùng kết quả. Luật gán nhãn, theo thứ tự ưu tiên:

| Luật | Điều kiện | Nhãn |
|---|---|---|
| `label1` | Nhãn gốc 1 | `scam` |
| `tag_qc` | Nhãn gốc 0 và có tag `[QC]` hoặc `(QC)` | `spam` |
| `giao_dich_otp` | Có OTP, mã xác thực, số dư, biến động, mã vận đơn | `benign` |
| `thong_bao` | Thông báo dịch vụ hoặc quy định (cập nhật thông tin thuê bao, định danh, lịch khám, giao hàng) | `benign` |
| `tu_khoa_qc` | Từ khóa khuyến mại (ưu đãi, giảm, miễn phí, tặng, đăng ký, soạn ... gửi, data, mua) | `spam` |
| `mac_dinh` | Các tin còn lại | `benign` |

Ranh giới giữa quảng cáo và thông báo dịch vụ không rõ ràng nên nhãn `spam` và `benign` của bộ này có nhiễu. Script ghi mẫu phân tầng theo luật vào `data/interim/vi_sms_review.csv` (cột `check` để điền) và thống kê vào `reports/vi_sms_import.json`. Nhãn nào sai thì ghi vào tệp `overrides.csv` (cột `message_id,label`) rồi chạy lại với `--overrides overrides.csv`.

Tệp `data/raw/messages_handlabeled.csv` là tập test, do người thực hiện tự gán nhãn, không sinh bằng AI. Các cột gồm `text`, `label` và tùy chọn `hard`, `note`. Giá trị `hard=1` đánh dấu các ca khó (không dấu, teencode, tin hợp lệ có hình thức giống lừa đảo); các ca này được báo cáo riêng ở tập `test_hard`. Quy cách viết và gán nhãn nằm trong `data/LABELING_GUIDE.md`.

### 2.2. URL

PhiUSIIL: tệp `data/raw/PhiUSIIL_Phishing_URL_Dataset.csv` (UCI, mã 967), sử dụng hai cột `URL` và `label`. Trong bộ này `label` bằng 1 là URL hợp lệ và bằng 0 là phishing; bộ nạp dữ liệu đã đảo lại theo quy ước nội bộ (1 là phishing).

PhishVN v3.1.0 (Mendeley Data, bản 4): ba tệp `splits/url_{train,val,test}.csv` được đặt dưới `data/raw/phishvn/` và gộp bằng lệnh `python scripts/merge_phishvn_splits.py` thành `data/raw/phishvn/phishvn.csv` (có thêm cột `split`). Các cột được sử dụng là `url`, `label` (`phishing` hoặc `benign`), `tier` (`gold`, `silver`, `bronze`) và `split`. Bộ nạp tự dò tên cột. Nếu không khớp, bộ nạp báo lỗi kèm danh sách cột thực tế; khi đó chỉnh mục `phishvn:` trong `configs/url.yaml` (`url_col`, `label_col`, `tier_col`, `split_col`) và tên tệp ở `files.phishvn`.

Nguồn và giấy phép của từng bộ dữ liệu được ghi tại `data/SOURCES.md`.

## 3. Quy trình xử lý

| Bước | Lệnh | Đầu vào | Đầu ra |
|---|---|---|---|
| 0 | `validate-messages --file data/raw/messages_train_pool.csv` | CSV tin nhắn | Báo cáo lỗi, thoát với mã 1 nếu có lỗi |
| 1 | `prepare-messages` | `data/raw/messages_train_pool.csv`, `messages_handlabeled.csv` | `data/splits/messages/{train,val,test,test_hard}.csv` và `split_manifest.json` |
| 2 | `train-message` | Các tập đã chia | `models/artifacts/message/`, `reports/message_metrics.json` |
| 3 | `sweep-message` | Các tập đã chia | `reports/optimization_message.json` (AI11: kích thước, F1 và độ trễ theo `max_features`) |
| 4 | `prepare-urls` | PhiUSIIL và PhishVN | `data/splits/urls/{train,val_in,test_in,val_cross,test_cross}.csv` và `split_manifest.json` |
| 5 | `train-url` | Các tập đã chia | `models/artifacts/url/models.joblib`, `reports/url_metrics.json` |
| 6 | `export-message`, `export-url` | Model đã huấn luyện | Tệp JSON hoặc ONNX và fixtures đối chiếu |
| 7 | `parity` | Model đã huấn luyện | `reports/parity_python.json` (Python tự đối chiếu với bản xuất) |

## 4. Quy tắc chống rò rỉ dữ liệu

Các quy tắc sau được kiểm tra trong `tests/test_leakage.py`.

- Các tin nhắn gần giống nhau (độ tương đồng cosine từ 0.85 trở lên) hoặc cùng `group` được gom thành một nhóm và không bị tách sang tập khác.
- Tin trong tập train gần giống tin của tập test gán tay bị loại khỏi train.
- Dữ liệu `synthetic` không được đưa vào test. Dữ liệu này chỉ vào validation khi thiếu tin `real`, và `split_manifest.json` ghi cảnh báo trong trường hợp đó.
- URL được chia theo tên miền đăng ký (`registered_domain`). Mọi tên miền xuất hiện ở val hoặc test đều bị loại khỏi train. Tầng `bronze` không được đưa vào test chéo miền.
- TF-IDF chỉ được `fit` trên tập train. Ngưỡng quyết định được chọn trên validation, còn test chỉ đo một lần tại ngưỡng đó.
- Đặc trưng `is_https` không được dùng vì phản ánh cách thu thập dữ liệu. Đặc trưng `has_www` được loại qua `features.exclude`.

## 5. Tiêu chí chọn ngưỡng và đánh giá đạt hay không đạt

Các tiêu chí được khai báo trong `configs/*.yaml` trước khi xem kết quả đo. Giá trị cuối cùng do nhóm thực hiện quyết định.

- Tin nhắn: precision không thấp hơn 0.90 tại recall không thấp hơn 0.80 trên tập test gán tay.
- URL: recall không thấp hơn 0.90 tại FPR không quá 1% trên `test_cross` (PhishVN tầng gold và silver). Báo cáo kèm khoảng tin cậy 95% theo bootstrap, ma trận nhầm lẫn và PR-AUC. Nếu không đạt, kết quả vẫn được báo cáo đúng như đo được và trường `meets_bar...` nhận giá trị `false`.
- Chọn model URL: chọn model đơn giản nhất (theo thứ tự khai báo trong `models:`) đạt tiêu chí trên validation, tức `val_cross`, hoặc `val_in` nếu `val_cross` chỉ có một lớp. Tập `test_cross` không tham gia việc chọn mà chỉ dùng để xác nhận. Nếu model do validation chọn không đạt trên test thì `selected_model` nhận giá trị `null` (frontend dùng LR và đặt `meetsBar=false`), còn `validation_selected_model` vẫn ghi model đã chọn trên validation.
- Với PhishVN v3.1.0, tập `val_cross` theo tầng gold và silver chỉ có khoảng 24 mẫu phishing. Trong trường hợp này có thể nới riêng validation bằng `phishvn.val_tiers` (ví dụ thêm `bronze`). Tùy chọn này chỉ dùng cho việc chọn ngưỡng và chọn model; `test_cross` luôn chỉ gồm gold và silver. Lựa chọn này cần được nêu rõ trong báo cáo.

## 6. Đối chiếu Python và TypeScript (AI16)

Client không chạy Python, vì vậy các lệnh `export-*` tạo ra các tệp sau trong `models/artifacts/`:

| Tệp | Mục đích |
|---|---|
| `message/message_model.json` | Từ vựng, idf, hệ số, hệ số chặn, ngưỡng và tham số featurizer để TypeScript tự tính TF-IDF và LR |
| `message/message_rules.json` | Luật regex (mức 0) |
| `message/message_parity_fixtures.json` | Ca kiểm tra: `normalize` (chuỗi khớp tuyệt đối), `analyze` (danh sách feature khớp tuyệt đối), `predict` (sai số không quá 1e-5) |
| `url/url_spec.json` | Hằng số và danh sách feature URL |
| `url/url_lr.json` | Mô hình LR dạng JSON |
| `url/url_gbdt.onnx`, `url/url_rf.onnx` | Mô hình cây, chạy bằng onnxruntime-web (WASM) khi được chọn |
| `url/url_parity_fixtures.json` | `allFeatures` (sai số không quá 1e-9), `probabilities` (LR không quá 1e-6, ONNX không quá 1e-4) |

Phía TypeScript (`frontend/src/ai/features`) cài đặt lại `normalizeText`, `analyze` và `extractUrlFeatures` giống hệt `src/securechat_ml/features/{text,url}.py`, và được kiểm tra bằng các fixtures ở bảng trên. Các điểm dễ gây sai lệch gồm: `String.prototype.normalize('NFD')`, phép đổi `đ` thành `d`, regex `[0-9]{6,}`, char n-gram có đệm khoảng trắng (`char_wb`), thứ tự và độ dài vector feature URL, và việc tự phân tích URL thay cho `new URL`.

Mức khớp của xác suất được đánh giá cùng với mức trùng quyết định (`decision_agreement`). Hàm `robust_threshold` đặt ngưỡng vào giữa hai điểm số liền kề để quyết định không bị đổi do khác biệt giữa float32 và float64.

Khi mô hình quá hạn hoặc lỗi, runtime trả trạng thái `unavailable` và không bao giờ trả kết quả "an toàn". Kết quả phân tích chỉ nằm ở client, không gửi lên máy chủ.

## 7. Cấu trúc thư mục

```
configs/            labels.yaml, message.yaml, url.yaml, rules.yaml
data/               raw/ (dữ liệu đầu vào), splits/, demo/, SOURCES.md, SYNTHETIC_SPEC.md, LABELING_GUIDE.md
scripts/            merge_phishvn_splits.py, url_char_ngram_experiment.py, import_vi_sms.py, build_message_pool.py
src/securechat_ml/  config, features/{text,url}, data/{splits,messages,urls,vi_sms,demo},
                    models/{message,url}, evaluation/metrics, export/{message_json,url_export,parity}, cli
tests/              features, leakage, metrics và pipeline, group split, quy tắc chọn model URL, chuyển bộ SMS
reports/            kết quả đo
```

## 8. Giới hạn đã biết

- `HistGradientBoostingClassifier` không xuất được sang ONNX với skl2onnx 1.20 và numpy 2.x, nên model GBDT dùng `GradientBoostingClassifier`.
- PhiUSIIL chỉ được dùng ở mức chuỗi URL; các cột đặc trưng tính sẵn của bộ này không được sử dụng.
- Tên miền đăng ký (`registered_domain`) được xác định theo cách đơn giản, nên các nền tảng cho thuê tên miền con (ví dụ vercel.app, weebly.com) bị tính chung thành một tên miền.
- Phần URL hợp lệ của PhishVN chủ yếu là tên miền `.gov.vn`. Tỷ lệ báo nhầm trên các liên kết thực tế trong tin nhắn có thể cao hơn số đo trên `test_cross`.
- Trên dữ liệu hiện có, cả ba model URL (LR, GBDT, RF) đều không đạt tiêu chí recall 0.90 tại FPR 1% trên `test_cross` (xem `reports/url_metrics.json`). Thí nghiệm bổ sung với char n-gram không đạt điều kiện đã đặt trước để chuyển sang frontend (xem `reports/url_char_ngram_experiment.txt`).
- Tin nhắn thật hiện chỉ gồm SMS (nhà mạng, ngân hàng, đầu số quảng cáo, tin lừa đảo), không có tin trò chuyện thường ngày. Model huấn luyện chỉ trên bộ này có nguy cơ gắn nhãn rủi ro cho tin chat; cần bổ sung tin `benign` kiểu chat (tổng hợp theo `SYNTHETIC_SPEC.md`, `source=synthetic`) và đánh giá trên tập test gán tay kiểu chat.
- Nhãn `spam` và `benign` của bộ SMS được gán bằng luật nên có nhiễu; chưa đo tỷ lệ sai. Validation lấy từ tin `real` nên cũng chỉ gồm SMS, do đó số đo trên validation không đại diện cho tin chat.
- Chưa có số đo độ trễ và bộ nhớ trên trình duyệt ở thiết bị thật. Trang `/bench` của frontend dùng cho việc này.
- Các phương án nâng cấp mô hình tin nhắn (e5, PhoBERT, chưng cất tri thức) chưa được thực hiện. Chỉ cân nhắc khi baseline TF-IDF kết hợp LR không đạt tiêu chí và còn ít nhất ba ngày.

## 9. Danh mục đầu ra theo yêu cầu

| Mã | Nội dung | Vị trí |
|---|---|---|
| AI1 đến AI3 | Dữ liệu, nguồn, giấy phép, định nghĩa nhãn | `data/SOURCES.md`, `configs/labels.yaml` |
| AI4 đến AI6 | Hai model và baseline | `src/securechat_ml/models/` |
| AI7 đến AI10 | Chia tập độc lập, độ đo, phân tích FP/FN | `src/securechat_ml/evaluation/`, `reports/` |
| AI11 | Tối ưu có số đo (quantize, prune hoặc distill), tối thiểu một phương án | `src/securechat_ml/export/`, `reports/optimization_message.json` |
| AI12 | Giới hạn mô hình, ngôn ngữ hỗ trợ | `models/artifacts/model_card.md` (dự kiến) |
| AI14, AI16 | Xuất ONNX và đối chiếu | `src/securechat_ml/export/` |
| AI18 đến AI21, AI26 | Độ trễ cold/warm, CPU/RAM, kích thước, bật/tắt AI, kiểm tra trên trình duyệt | `reports/performance.md` (dự kiến) |
