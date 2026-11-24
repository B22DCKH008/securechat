# Model card: hai model phát hiện rủi ro chạy trên thiết bị

Tài liệu này mô tả hai model của SecureChat: model phân loại tin nhắn tiếng Việt (`benign`, `spam`, `scam`) và model phân loại URL (`benign`, `malicious`). Tài liệu ghi nguồn dữ liệu, cách đo, kết quả đã có và giới hạn (AI12). Ô ghi "/" là thông tin chưa có; các ô này được điền khi có kết quả, không được suy đoán. Quy trình tái lập nằm ở `README.md`, nguồn và giấy phép dữ liệu ở `data/SOURCES.md`.

## 1. Mục đích và phạm vi sử dụng

Hai model chạy hoàn toàn trên thiết bị người dùng. Nội dung tin nhắn và URL không được gửi tới máy chủ hay dịch vụ AI bên ngoài. Kết quả chỉ dùng để hiện cảnh báo trước khi gửi hoặc khi nhận tin; model không chặn tin và không thay đổi nội dung tin.

Giao diện có ba mức: `warn` (có dấu hiệu rủi ro), `unknown` (AI tắt, lỗi, quá hạn hoặc chưa nạp được model) và `none` (đã quét, không thấy dấu hiệu). Mức `none` không có nghĩa là an toàn, và mức `unknown` không bao giờ được hiển thị như an toàn.

Ngoài phạm vi: tin nhắn không phải tiếng Việt, ảnh và mã QR, tệp đính kèm, nội dung trang web phía sau URL, và việc đánh giá người gửi.

## 2. Model tin nhắn

**Nhãn.** `benign` là hội thoại bình thường, kể cả tin ngân hàng hoặc nhà mạng thật không yêu cầu hành động nguy hiểm. `spam` là quảng cáo, khuyến mại, tin hàng loạt không mời, không nhằm chiếm đoạt tiền hoặc thông tin. `scam` là lừa đảo, kể cả phishing (giả mạo để lấy OTP, mật khẩu, yêu cầu chuyển tiền, đầu tư hoặc việc nhẹ lương cao giả, trúng thưởng giả, giả công an hoặc ngân hàng). Phishing được gộp vào `scam`. Định nghĩa đầy đủ ở `configs/labels.yaml`.

**Kiến trúc.** Chuẩn hóa văn bản (chữ thường, bỏ dấu và đổi `đ` thành `d`, thay URL bằng token `urltoken` và số dài bằng token `bignum`), TF-IDF trên n-gram ký tự 2 đến 5 (có đệm khoảng trắng) kết hợp n-gram từ 1 đến 2, `sublinear_tf`, `min_df=2`, tối đa 50.000 đặc trưng, rồi hồi quy logistic đa lớp (`C=4`, `class_weight=balanced`). Điểm rủi ro là 1 trừ xác suất `benign`; cảnh báo khi điểm này không thấp hơn ngưỡng. Model được xuất thành JSON và TypeScript tự tính lại TF-IDF và hồi quy, nên không cần runtime ONNX cho model này. Bỏ dấu giúp model chịu được tin không dấu và tin viết tắt, đổi lại mất một phần thông tin do dấu mang.

**Dữ liệu huấn luyện.** Nguồn thật là bộ SMS tiếng Việt công khai (`data/SOURCES.md`, mục 4): 2.991 tin, còn 2.577 tin sau khi loại 24 tin tiếng Anh, 388 tin trùng và 2 tin có nhãn mâu thuẫn, gồm 1.099 `spam`, 767 `benign`, 711 `scam`. Bộ gốc chỉ có hai nhãn (0 và 1); ba nhãn của dự án được suy ra bằng luật (`src/securechat_ml/data/vi_sms.py`), có tệp sửa tay (`data/vi_sms_overrides.csv`, 8 dòng); 14 tin có thông tin cá nhân đã được che trước khi lưu. Lần xem lại đầu tiên với 150 tin cho thấy luật sai ở 8 tin (ước tính khoảng 6%, mẫu nhỏ nên khoảng tin cậy rộng); sau đó đã xem lại thêm 50 tin và sửa luật theo các lỗi tìm được (chi tiết ở `README.md`, phần về bộ SMS). Phần dữ liệu chat tổng hợp (`data/SYNTHETIC_SPEC.md`): /.

**Dữ liệu đánh giá.** Tập test do người thực hiện tự viết và tự gán nhãn (`messages_handlabeled.csv`), không sinh bằng AI, không sao chép từ bộ SMS; quy cách ở `data/LABELING_GUIDE.md`. Trạng thái: chưa viết. Tập validation lấy từ tin thật của bộ SMS, tách theo nhóm tin gần giống nhau. Tin tổng hợp không bao giờ vào test.

**Tiêu chí đạt** (đặt trước khi xem kết quả): với nhóm rủi ro (`spam` và `scam` gộp, so với `benign`), precision không thấp hơn 0,90 và recall không thấp hơn 0,80 trên tập test gán tay. Ngưỡng cảnh báo chọn trên validation: recall lớn nhất với precision không thấp hơn 0,90.

**Kết quả.** Chưa huấn luyện trên dữ liệu thật; các số dưới đây điền sau khi tập test được khóa.

| Chỉ số trên tập test gán tay | Giá trị |
|---|---|
| Precision, recall, F1 theo từng nhãn | / |
| Precision và recall của nhóm rủi ro (`spam` và `scam`) tại ngưỡng đã chọn | / |
| Ma trận nhầm lẫn | / |
| Kết quả riêng trên tập khó (`test_hard`) | / |
| Khoảng tin cậy 95% (bootstrap) | / |
| Đạt hay không đạt tiêu chí | / |

## 3. Model URL

**Đặc trưng.** 26 đặc trưng thuần cú pháp tính từ chuỗi URL: độ dài các phần, số dấu chấm, gạch ngang, chữ số, ký tự đặc biệt, độ sâu đường dẫn, host là IP, cổng lạ, punycode, đuôi tên miền đáng ngờ, entropy, từ khóa đáng ngờ, dịch vụ rút gọn link, tên thương hiệu trong tên miền phụ hoặc đường dẫn. Phần giao thức (http, https) được cắt bỏ trước khi đo nên không có đặc trưng `is_https`; đặc trưng `has_www` vẫn được tính nhưng bị loại khỏi model vì phản ánh cách thu thập dữ liệu hơn là bản chất URL. Model không dùng WHOIS, danh sách đen, nội dung trang hay lịch sử truy cập.

**Dữ liệu.** PhiUSIIL (UCI, 235.795 URL) cho phần trong miền và PhishVN v3.1.0 (36.261 URL sau khi loại trùng, có nhãn tầng tin cậy `gold`, `silver`, `bronze` và thời điểm) cho phần chéo miền. Chia theo tên miền đăng ký; mọi tên miền có ở validation hoặc test đều bị loại khỏi train. Kích thước từng tập: `data/splits/urls/split_manifest.json`.

**Tiêu chí đạt** (đặt trước khi xem kết quả): recall không thấp hơn 0,90 tại FPR không quá 1% trên `test_cross` (PhishVN, tầng `gold` và `silver`). Ngưỡng của từng model chọn trên `val_cross` (gồm cả tầng `bronze`) sao cho FPR không quá 1%.

**Kết quả chéo miền** (`test_cross`: 4.311 URL, 486 phishing; khoảng tin cậy 95% theo bootstrap cho recall):

| Model | Ngưỡng | Precision | Recall (khoảng tin cậy) | F1 | FPR | PR-AUC |
|---|---|---|---|---|---|---|
| LR (đang dùng trên client) | 0,9282 | 0,585 | 0,099 (0,074 đến 0,125) | 0,169 | 0,0089 | 0,362 |
| GBDT | 0,8055 | 0,667 | 0,144 (0,114 đến 0,174) | 0,237 | 0,0092 | 0,552 |
| RF | 0,7482 | 0,714 | 0,185 (0,152 đến 0,223) | 0,294 | 0,0094 | 0,570 |

**Kết quả trong miền** (`test_in`: 23.175 URL, 9.694 phishing, cùng phân bố với tập huấn luyện), cùng ngưỡng như trên:

| Model | Ngưỡng | Precision | Recall (khoảng tin cậy) | F1 | FPR | PR-AUC |
|---|---|---|---|---|---|---|
| LR (đang dùng trên client) | 0,9282 | 0,994 | 0,604 (0,594 đến 0,614) | 0,752 | 0,0025 | 0,898 |
| GBDT | 0,8055 | 0,994 | 0,680 (0,671 đến 0,690) | 0,808 | 0,0028 | 0,910 |
| RF | 0,7482 | 0,989 | 0,692 (0,683 đến 0,701) | 0,814 | 0,0055 | 0,912 |

**Kết luận.** Không model nào đạt tiêu chí chéo miền: recall tại FPR 1% chỉ từ 0,10 (LR) đến 0,19 (RF), trong khi trong miền đạt khoảng 0,60 đến 0,70. Chênh lệch này cho thấy đặc trưng cú pháp học từ PhiUSIIL không chuyển tốt sang URL của PhishVN. Trường `selected_model` trong `reports/url_metrics.json` vì vậy là `null`; ứng dụng dùng LR vì nhỏ nhất (1,6 KB) và cùng ngưỡng với bản đã đo, đặt `meetsBar=false` trong `manifest.json`, và giao diện không được trình bày kết quả của model này như một bộ lọc đáng tin. Với LR tại ngưỡng đã chọn, trên `test_cross` có 48 URL phishing được bắt, 438 bị bỏ sót và 34 URL hợp lệ bị cảnh báo nhầm.

**Thử cải thiện.** Thêm đặc trưng n-gram ký tự (50.000 từ vựng, n-gram 3 đến 5, LR) cho recall tại FPR 1% trên validation là 0,225 và trên `test_cross` là 0,128. Quy tắc đặt trước là chỉ tiếp tục nếu validation đạt từ 0,40, nên hướng này không được chọn (`reports/url_char_ngram_experiment.txt`). Chưa thử: đưa tầng `bronze` vào huấn luyện (ablation B), và dùng URL trong bộ SMS làm tập kiểm tra phụ.

## 4. Giới hạn

- **Chỉ tiếng Việt.** Không dùng và không đánh giá cho ngôn ngữ khác. Tin có xen tiếng Anh hoặc tiếng lóng có thể cho kết quả kém hơn.
- **Lệch phân bố giữa dữ liệu huấn luyện và tin chat.** Dữ liệu thật hiện có toàn là tin SMS của nhà mạng, ngân hàng và đầu số quảng cáo, không có hội thoại giữa người với người. Tin `benign` của chat đời thường chủ yếu đến từ dữ liệu tổng hợp, do đó mức tin cậy của model trên chat thật chỉ được biết qua tập test gán tay. Validation cũng lấy từ SMS nên ngưỡng chọn trên đó có thể không phù hợp với chat.
- **Nhãn nhiễu.** Nhãn `spam` và `benign` của bộ SMS do luật gán, không phải do người gán từng tin; ranh giới giữa quảng cáo và thông báo dịch vụ không rõ ràng. Khoảng một phần ba tin `scam` trong mẫu xem lại là chuỗi ký tự bị xáo trộn để qua mặt bộ lọc, ít gặp trong trò chuyện thông thường, nên tỷ lệ `scam` của bộ này không phản ánh tỷ lệ ngoài thực tế.
- **Model URL kém trên miền mới.** Xem mục 3. Bỏ sót phần lớn URL phishing của PhishVN ở FPR 1%. Chỉ dùng đặc trưng cú pháp nên không phát hiện được URL trông bình thường nhưng độc hại, và dễ nhầm với URL hợp lệ có cấu trúc lạ. Tên miền đăng ký được xác định theo cách đơn giản nên các nền tảng cho thuê tên miền con (như vercel.app) bị tính chung một tên miền khi chia tập.
- **Không phải kết luận an toàn.** `none` chỉ có nghĩa là model không thấy dấu hiệu. Kẻ tấn công có thể cố ý viết để né model, và model chưa được thử với tin nhắn đối kháng.
- **Không hiệu chỉnh xác suất.** `confidence` là xác suất thô của hồi quy logistic, không phải mức chắc chắn đã hiệu chỉnh.
- **Tin ngắn.** Tin rất ngắn (vài từ) có ít thông tin; kết quả được báo cáo riêng theo độ dài khi có tập test: /.

## 5. Chạy trên thiết bị

| Chỉ số | Giá trị |
|---|---|
| Kích thước model URL (LR, JSON) | 1,6 KB |
| Kích thước model tin nhắn | / |
| Thời gian nạp lần đầu | / |
| Độ trễ phân tích (p50, p95, p99) cho tin nhắn, URL và một lần gửi tin | / |
| Chi phí khi chạy cả hai model trong một lần gửi | / |
| Chênh lệch khi bật và tắt AI | / |
| Bộ nhớ, CPU | / |
| Thiết bị và trình duyệt đã đo | / |

Các số này đo bằng trang `/bench` của frontend (`frontend/README.md`, mục 5.2), trên thiết bị yếu thật. Timeout hiện đặt tạm là 1500 ms và chỉ được chốt sau khi có số đo. Khi quá hạn, lỗi hoặc chưa nạp được model, ứng dụng hiện "AI không khả dụng" và vẫn cho gửi tin.

## 6. Tái lập

- Mã nguồn: `ml/`, Python từ 3.10 trở lên. File model `joblib` cần nạp bằng đúng phiên bản scikit-learn lúc huấn luyện (`requirements.txt` chỉ ghi cận dưới). Model ONNX xuất bằng skl2onnx 1.20; lý do không dùng `HistGradientBoosting` ghi trong `configs/url.yaml`.
- Hạt giống: 42 (`configs/*.yaml`).
- Phiên bản model URL đang dùng: `url-24b1a4-c1c13f`.
- Đối chiếu Python và TypeScript: LR URL lệch tối đa 9,3e-8 về xác suất và trùng quyết định 100% trên 512 ca (`reports/parity_python.json`); phía TypeScript có test đối chiếu bằng fixtures trong `frontend/tests/ai`.
- Dữ liệu đầu vào và checksum: `data/SOURCES.md`, mục 2. Checksum của tập test gán tay ghi vào đó khi khóa tập: /.
