# Model card: hai model phát hiện rủi ro chạy trên thiết bị

Tài liệu này mô tả hai model của SecureChat: model phân loại tin nhắn tiếng Việt (`benign`, `spam`, `scam`) và model phân loại URL (`benign`, `malicious`). Tài liệu ghi nguồn dữ liệu, cách đo, kết quả đã có và giới hạn (AI12). Ô ghi "/" là thông tin chưa có; các ô này được điền khi có kết quả, không được suy đoán. Quy trình tái lập nằm ở `README.md`, nguồn và giấy phép dữ liệu ở `data/SOURCES.md`.

## 1. Mục đích và phạm vi sử dụng

Hai model chạy hoàn toàn trên thiết bị người dùng. Nội dung tin nhắn và URL không được gửi tới máy chủ hay dịch vụ AI bên ngoài. Kết quả chỉ dùng để hiện cảnh báo trước khi gửi hoặc khi nhận tin; model không chặn tin và không thay đổi nội dung tin.

Giao diện có ba mức: `warn` (có dấu hiệu rủi ro), `unknown` (AI tắt, lỗi, quá hạn hoặc chưa nạp được model) và `none` (đã quét, không thấy dấu hiệu). Mức `none` không có nghĩa là an toàn, và mức `unknown` không bao giờ được hiển thị như an toàn.

Ngoài phạm vi: tin nhắn không phải tiếng Việt, ảnh và mã QR, tệp đính kèm, nội dung trang web phía sau URL, và việc đánh giá người gửi.

## 2. Model tin nhắn

**Nhãn.** `benign` là hội thoại bình thường, kể cả tin ngân hàng hoặc nhà mạng thật không yêu cầu hành động nguy hiểm. `spam` là quảng cáo, khuyến mại, tin hàng loạt không mời, không nhằm chiếm đoạt tiền hoặc thông tin. `scam` là lừa đảo, kể cả phishing (giả mạo để lấy OTP, mật khẩu, yêu cầu chuyển tiền, đầu tư hoặc việc nhẹ lương cao giả, trúng thưởng giả, giả công an hoặc ngân hàng). Phishing được gộp vào `scam`. Định nghĩa đầy đủ ở `configs/labels.yaml`.

**Kiến trúc.** Chuẩn hóa văn bản (chữ thường, bỏ dấu và đổi `đ` thành `d`, thay URL bằng token `urltoken` và số dài bằng token `bignum`), TF-IDF trên n-gram ký tự 2 đến 5 (có đệm khoảng trắng) kết hợp n-gram từ 1 đến 2, `sublinear_tf`, `min_df=2`, tối đa 50.000 đặc trưng, rồi hồi quy logistic đa lớp (`C=4`, `class_weight=balanced`). Điểm rủi ro là 1 trừ xác suất `benign`; cảnh báo khi điểm này không thấp hơn ngưỡng. Model được xuất thành JSON và TypeScript tự tính lại TF-IDF và hồi quy, nên không cần runtime ONNX cho model này. Bỏ dấu giúp model chịu được tin không dấu và tin viết tắt, đổi lại mất một phần thông tin do dấu mang.

**Dữ liệu huấn luyện.** Nguồn thật là bộ SMS tiếng Việt công khai (`data/SOURCES.md`, mục 4): 2.991 tin, còn 2.577 tin sau khi loại 24 tin tiếng Anh, 388 tin trùng và 2 tin có nhãn mâu thuẫn, gồm 1.099 `spam`, 767 `benign`, 711 `scam`. Bộ gốc chỉ có hai nhãn (0 và 1); ba nhãn của dự án được suy ra bằng luật (`src/securechat_ml/data/vi_sms.py`), có tệp sửa tay (`data/vi_sms_overrides.csv`, 8 dòng); 14 tin có thông tin cá nhân đã được che trước khi lưu. Lần xem lại đầu tiên với 150 tin cho thấy luật sai ở 8 tin (ước tính khoảng 6%, mẫu nhỏ nên khoảng tin cậy rộng); sau đó đã xem lại thêm 50 tin và sửa luật theo các lỗi tìm được (chi tiết ở `README.md`, phần về bộ SMS). Phần dữ liệu chat tổng hợp (`data/SYNTHETIC_SPEC.md`): lần 1 có 300 tin do AI sinh ngày 26/11/2026 (`messages_ai_synthetic_v0.csv`, 100 tin mỗi nhãn, nhãn theo kịch bản sinh), chiếm 300 trên 2.480 tin của tập train (12%). Lần 2 thêm 640 tin chat do AI sinh ngày 27/11/2026 (7 tệp `messages_ai_synthetic_v1_*.csv`: 360 `benign`, 177 `scam`, 103 `spam`; cách rà và lọc ghi ở `data/SOURCES.md`, mục 2). Train pool lần 2 có 3.520 tin (2.577 SMS thật, 943 tin tổng hợp), còn 3.509 tin sau khi loại 11 tin trùng; tập train có 2.938 tin, trong đó 758 tin tổng hợp (26%); validation có 571 tin (386 SMS thật và 185 tin tổng hợp).

**Dữ liệu đánh giá.** Tập test do người thực hiện tự viết và tự gán nhãn (`messages_handlabeled.csv`), không sinh bằng AI, không sao chép từ bộ SMS; quy cách ở `data/LABELING_GUIDE.md`. Trạng thái: khóa ngày 27/11/2026, gồm 300 tin (100 mỗi nhãn), trong đó 167 tin đánh dấu `hard` (59 `benign`, 49 `spam`, 59 `scam`); checksum ở mục 6. Một người thứ hai gán độc lập 60 tin: đồng thuận 93,3%, kappa 0,900 cho ba nhãn và 1,000 cho nhóm rủi ro so với `benign` (`reports/handlabel_kappa.md`). Bảy tin có nhãn chỉ phân biệt được khi biết người gửi (`note` là "cần ngữ cảnh người gửi") nên kết quả được báo cáo trên cả 300 tin và trên 293 tin còn lại. Tập validation lấy từ tin thật của bộ SMS, tách theo nhóm tin gần giống nhau (lần 1: 386 tin). Tin tổng hợp không bao giờ vào test.

**Tiêu chí đạt** (đặt trước khi xem kết quả): với nhóm rủi ro (`spam` và `scam` gộp, so với `benign`), precision không thấp hơn 0,90 và recall không thấp hơn 0,80 trên tập test gán tay. Ngưỡng cảnh báo chọn trên validation: recall lớn nhất với precision không thấp hơn một mục tiêu cho trước; lần 1 mục tiêu này là 0,90, bằng tiêu chí đạt.

**Kết quả lần 1** (27/11/2026, `reports/message_metrics_run1.json`). Đây là kết quả báo cáo chính. Khoảng tin cậy 95% theo bootstrap 500 lần ghi trong ngoặc.

| Chỉ số trên tập test gán tay | Giá trị |
|---|---|
| Phiên bản model và ngưỡng | `msg-29bd2d-50f635`, ngưỡng 0,3432, chọn trên validation (386 tin SMS: precision 0,902, recall 0,985, FPR 0,252) |
| Nhóm rủi ro (300 tin, 200 rủi ro) | Precision 0,782 (0,725 đến 0,833), recall 0,985 (0,966 đến 1,000), F1 0,872 (0,838 đến 0,904), FPR 0,550, PR-AUC 0,968 |
| Đếm theo nhóm rủi ro | 197 tin rủi ro được cảnh báo, 3 bị bỏ sót, 55 tin bình thường bị cảnh báo nhầm, 45 tin bình thường không bị cảnh báo |
| Theo từng nhãn (precision, recall, F1) | `benign` 0,938, 0,450, 0,608; `spam` 0,784, 0,690, 0,734; `scam` 0,567, 0,930, 0,705 |
| Ma trận nhầm lẫn (hàng là nhãn thật; cột là dự đoán `benign`, `spam`, `scam`) | `benign` 45, 12, 43; `spam` 3, 69, 28; `scam` 0, 7, 93 |
| Tập khó `test_hard` (167 tin) | Precision 0,748 (0,677 đến 0,811), recall 0,991 (0,970 đến 1,000), FPR 0,610; `benign` đúng 23 trên 59 tin |
| Bỏ 7 tin cần ngữ cảnh người gửi (293 tin, 196 rủi ro) | Precision 0,788 (0,732 đến 0,839), recall 0,985 (0,964 đến 1,000), F1 0,875 (0,839 đến 0,908), FPR 0,536. Đo lại model lần 1 bằng `eval-message` (`reports/message_eval_msg-29bd2d-50f635.json`). Cả 7 tin bị bỏ đều được model cảnh báo: 4 tin `scam` đúng, 3 tin `benign` nhầm |
| Baseline luật (Nấc 0) trên cùng tập | Precision 1,000, recall 0,120, F1 0,214, FPR 0, PR-AUC 0,707 |
| Đạt hay không đạt tiêu chí | Không đạt. Precision 0,782 dưới 0,90, và cận trên khoảng tin cậy (0,833) cũng dưới 0,90. Recall đạt |

**Nhận xét lần 1.**

- Model bắt gần hết tin rủi ro (bỏ sót 3 trên 200) nhưng cảnh báo nhầm 55 trên 100 tin bình thường: 43 tin bị xếp vào `scam`, 12 tin vào `spam`. So với luật, model bắt được nhiều hơn hẳn (recall 0,985 so với 0,120), còn luật gần như không cảnh báo nhầm.
- FPR là 0,252 trên validation (SMS) nhưng 0,550 trên test (chat), trong khi tỷ lệ tin rủi ro ở hai tập gần nhau (70% và 67%). Kể cả tin `benign` không đánh dấu `hard`, model chỉ xếp đúng 22 trên 41 tin (suy ra từ test trừ `test_hard`). Kết quả này phù hợp với giả thuyết lệch miền giữa SMS (toàn bộ validation và 88% tập train) và tin chat (tập test), hơn là do tin khó.
- Ngưỡng được chọn tại điểm validation vừa đạt precision 0,902, nên không còn biên an toàn khi phân bố dữ liệu thay đổi. Trong khi đó recall còn dư nhiều so với tiêu chí 0,80.
- Precision phụ thuộc tỷ lệ tin rủi ro trong tập đo (67% ở tập test). Trong chat thật tin rủi ro hiếm hơn nhiều. Ví dụ minh họa (không phải số đo): nếu chỉ 5% tin là rủi ro thì với recall 0,985 và FPR 0,550, precision chỉ khoảng 0,09, tức phần lớn cảnh báo là nhầm. Vì vậy cần đọc FPR song song với precision, và giao diện chỉ nên cảnh báo mềm.

**Quyết định sau lần 1** (27/11/2026, sau khi đã xem kết quả test lần 1):

1. Sinh thêm tin chat tổng hợp, ưu tiên `benign` kiểu chat đời thường (`data/SYNTHETIC_SPEC.md`, mục 4).
2. Thêm 20% số nhóm tin tổng hợp vào validation (`split.val_synthetic_fraction`), vì validation toàn SMS không cho thấy lỗi trên chat. Phần này cùng nguồn sinh với dữ liệu train nên vẫn lạc quan hơn chat thật.
3. Chọn ngưỡng với precision mục tiêu 0,95 trên validation (`threshold.target_precision`). Tiêu chí đạt trên test giữ nguyên 0,90 (`threshold.quality_precision`) và recall 0,80.

Vì các thay đổi trên được quyết định sau khi đã xem kết quả test, số đo của lần 2 trên cùng tập test không còn là ước lượng hoàn toàn độc lập. Báo cáo cần nêu cả hai lần. Không có nhãn hay dòng nào của tập test bị sửa hoặc loại sau khi xem kết quả. Quy tắc dừng: chỉ thêm một vòng cải thiện; nếu lần 2 vẫn không đạt thì giữ model, ghi nguyên nhân và giao diện dùng cảnh báo mềm.

**Kết quả lần 2** (28/11/2026, `reports/message_metrics_run2.json`). Đây là model đang dùng. Khoảng tin cậy 95% theo bootstrap 500 lần ghi trong ngoặc.

| Chỉ số | Giá trị |
|---|---|
| Phiên bản model và ngưỡng | `msg-29bd2d-f60d69`, ngưỡng 0,6199, chọn trên validation với precision mục tiêu 0,95 (571 tin: precision 0,950, recall 0,937, FPR 0,087) |
| Validation theo nguồn | SMS thật (386 tin): precision 0,973, recall 0,934, FPR 0,061. Chat tổng hợp (185 tin): precision 0,890, recall 0,947, FPR 0,121 |
| Test, nhóm rủi ro (300 tin, 200 rủi ro) | Precision 0,951 (0,918 đến 0,979), recall 0,870 (0,827 đến 0,917), F1 0,909 (0,879 đến 0,939), FPR 0,090, PR-AUC 0,979 |
| Đếm theo nhóm rủi ro | 174 tin rủi ro được cảnh báo, 26 bị bỏ sót, 9 tin bình thường bị cảnh báo nhầm, 91 tin bình thường không bị cảnh báo |
| Theo từng nhãn (precision, recall, F1) | `benign` 0,778, 0,910, 0,839; `spam` 0,865, 0,640, 0,736; `scam` 0,697, 0,760, 0,727 |
| Ma trận nhầm lẫn (hàng là nhãn thật; cột là dự đoán `benign`, `spam`, `scam`) | `benign` 91, 2, 7; `spam` 10, 64, 26; `scam` 16, 8, 76 |
| Tập khó `test_hard` (167 tin) | Precision 0,918 (0,857 đến 0,965), recall 0,833 (0,754 đến 0,897), FPR 0,136 |
| Bỏ 7 tin cần ngữ cảnh người gửi (293 tin) | Precision 0,950 (0,919 đến 0,981), recall 0,878 (0,832 đến 0,918), FPR 0,093 |
| Baseline luật (Nấc 0) trên cùng tập test | Không đổi so với lần 1: precision 1,000, recall 0,120 |
| Đạt hay không đạt tiêu chí | Đạt trên tập test (300 tin) và trên 293 tin; cận dưới khoảng tin cậy của precision (0,918) và recall (0,827) đều trên tiêu chí. Trên `test_hard`, giá trị đo đạt nhưng cận dưới khoảng tin cậy thấp hơn tiêu chí |

**Nhận xét lần 2.**

- So với lần 1, số tin bình thường bị cảnh báo nhầm giảm từ 55 xuống 9 trên 100 (FPR từ 0,550 xuống 0,090), đổi lại số tin rủi ro bị bỏ sót tăng từ 3 lên 26 trên 200 (recall từ 0,985 xuống 0,870). Thay đổi đến từ hai phía: dữ liệu chat thêm vào và ngưỡng cao hơn (0,6199 so với 0,3432).
- Phần chat tổng hợp của validation không lạc quan hơn test như dự kiến khi thiết kế: FPR trên phần này (0,121) còn cao hơn trên test (0,090). Do đó cảnh báo "phần tổng hợp lạc quan hơn chat thật" trong `split_manifest.json` là giả định thận trọng, không phải kết quả đo được.
- Lỗi nguy hiểm nhất bây giờ là bỏ sót lừa đảo: 16 trên 100 tin `scam` bị xếp vào `benign`, nên người dùng không được cảnh báo. Nhầm lẫn giữa `spam` và `scam` (26 và 8 tin) không ảnh hưởng tới việc có cảnh báo hay không, vì cả hai đều thuộc nhóm rủi ro.
- Như lần 1, precision phụ thuộc tỷ lệ tin rủi ro trong tập đo (67% ở test). Ví dụ minh họa (không phải số đo): nếu chỉ 5% tin là rủi ro thì với recall 0,870 và FPR 0,090, precision khoảng 0,34.
- Theo quy tắc dừng đã ghi ở trên, không có vòng cải thiện thứ ba; model lần 2 là model được đưa vào giao diện. Số đo lần 2 không hoàn toàn độc lập với tập test vì các thay đổi được quyết định sau khi xem kết quả lần 1.

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
- **Lệch phân bố giữa dữ liệu huấn luyện và tin chat.** Dữ liệu thật hiện có toàn là tin SMS của nhà mạng, ngân hàng và đầu số quảng cáo, không có hội thoại giữa người với người. Tin `benign` của chat đời thường chủ yếu đến từ dữ liệu tổng hợp, do đó mức tin cậy của model trên chat thật chỉ được biết qua tập test gán tay. Validation cũng lấy từ SMS nên ngưỡng chọn trên đó có thể không phù hợp với chat. Lần 1 xác nhận rủi ro này: FPR 0,252 trên validation SMS nhưng 0,550 trên test chat (mục 2).
- **Precision phụ thuộc tỷ lệ tin rủi ro.** Tập test có 67% tin rủi ro để đo được cả ba nhãn; trong chat thật tỷ lệ này thấp hơn nhiều, nên precision thực tế sẽ thấp hơn số đo trên test. FPR (tỷ lệ tin bình thường bị cảnh báo nhầm) không phụ thuộc tỷ lệ này và cần được báo cáo kèm.
- **Nhãn nhiễu.** Nhãn `spam` và `benign` của bộ SMS do luật gán, không phải do người gán từng tin; ranh giới giữa quảng cáo và thông báo dịch vụ không rõ ràng. Khoảng một phần ba tin `scam` trong mẫu xem lại là chuỗi ký tự bị xáo trộn để qua mặt bộ lọc, ít gặp trong trò chuyện thông thường, nên tỷ lệ `scam` của bộ này không phản ánh tỷ lệ ngoài thực tế.
- **Model URL kém trên miền mới.** Xem mục 3. Bỏ sót phần lớn URL phishing của PhishVN ở FPR 1%. Chỉ dùng đặc trưng cú pháp nên không phát hiện được URL trông bình thường nhưng độc hại, và dễ nhầm với URL hợp lệ có cấu trúc lạ. Tên miền đăng ký được xác định theo cách đơn giản nên các nền tảng cho thuê tên miền con (như vercel.app) bị tính chung một tên miền khi chia tập.
- **Không phải kết luận an toàn.** `none` chỉ có nghĩa là model không thấy dấu hiệu. Kẻ tấn công có thể cố ý viết để né model, và model chưa được thử với tin nhắn đối kháng.
- **Không hiệu chỉnh xác suất.** `confidence` là xác suất thô của hồi quy logistic, không phải mức chắc chắn đã hiệu chỉnh.
- **Tin ngắn.** Tin rất ngắn (vài từ) có ít thông tin; kết quả được báo cáo riêng theo độ dài khi có tập test: /.

## 5. Chạy trên thiết bị

Các số đo bằng trang `/bench` của frontend (`frontend/README.md`, mục 5.2). Mỗi dòng đo 5 lần khởi động và 50 lần tính.

| Chỉ số | Model URL (LR, JSON) | Model tin nhắn |
|---|---|---|
| Kích thước | 1,6 KB | / |
| Nạp lần đầu | 16,8 ms (trong đó 7,7 ms ở engine) | / |
| Lần gọi đầu sau khi nạp | 0,1 ms | / |
| Độ trễ p50, p95, p99 | 0,1 ms, 0,2 đến 0,3 ms, 0,5 ms | / |
| Một lần gửi tin (tin nhắn cùng 0, 1, 5 URL) | / | / |
| Chênh lệch khi bật và tắt AI | / | / |
| Bộ nhớ heap luồng chính | 3,7 MB lên 4,4 MB | / |
| CPU và RAM của Worker | / | / |
| Tác vụ dài trên luồng chính (trên 50 ms) | 0 lần | / |

**Thiết bị đã đo (25/11/2026):** Acer Nitro 5 AN515-57, 12 luồng CPU, RAM 16 GB, Chrome 158 trên Windows, chạy bản build bằng `npm run preview`, Web Worker có sẵn, trang không ở chế độ cô lập nguồn gốc. Đây là máy cấu hình khá, chưa phải thiết bị yếu. Chưa đo trên thiết bị yếu hoặc điện thoại.

**Độ chính xác.** Khi trang không cô lập nguồn gốc, trình duyệt làm tròn đồng hồ đo đến 0,1 ms, nên với model URL chỉ nên đọc kết quả là "dưới 1 ms". Phép đo này chỉ cho thấy model URL không phải nút cổ chai; thời gian chờ tối đa sẽ chốt theo p95 của model tin nhắn trên thiết bị yếu.

**Công tắc tắt AI.** Khi tắt AI, cả ba ca gửi tin đều không có lần phân tích nào của model chạy ra kết quả (0 trên 50 lần mỗi ca). Luật dữ liệu nhạy cảm vẫn chạy khi AI tắt.

**Thư viện ONNX.** Bản build có file WebAssembly của onnxruntime-web nặng 14,8 MB (3,9 MB khi nén gzip). File này chỉ được nạp khi manifest có model ONNX; model LR dạng JSON đang dùng không cần đến nó, đó là một lý do giữ LR cho phía client.

Timeout hiện đặt tạm là 1500 ms và chỉ được chốt sau khi có số đo của model tin nhắn trên thiết bị yếu. Khi quá hạn, lỗi hoặc chưa nạp được model, ứng dụng hiện "AI không khả dụng" và vẫn cho gửi tin.

## 6. Tái lập

- Mã nguồn: `ml/`, Python từ 3.10 trở lên. File model `joblib` cần nạp bằng đúng phiên bản scikit-learn lúc huấn luyện (`requirements.txt` chỉ ghi cận dưới). Model ONNX xuất bằng skl2onnx 1.20; lý do không dùng `HistGradientBoosting` ghi trong `configs/url.yaml`.
- Hạt giống: 42 (`configs/*.yaml`).
- Phiên bản model URL đang dùng: `url-24b1a4-c1c13f`.
- Model tin nhắn đang dùng (lần 2): `msg-29bd2d-f60d69` (`reports/message_metrics_run2.json`), cấu hình như `configs/message.yaml` hiện tại, train pool gồm `messages_vi_sms.csv`, `messages_ai_synthetic_v0.csv` và 7 tệp `messages_ai_synthetic_v1_*.csv`.
- Model tin nhắn lần 1: `msg-29bd2d-50f635` (`reports/message_metrics_run1.json`). Để tái lập: `split.val_synthetic_fraction: 0`, `threshold.target_precision: 0.90`, train pool gồm `messages_vi_sms.csv` và `messages_ai_synthetic_v0.csv`.
- Đối chiếu Python và TypeScript: LR URL lệch tối đa 9,3e-8 về xác suất và trùng quyết định 100% trên 512 ca (`reports/parity_python.json`); phía TypeScript có test đối chiếu bằng fixtures trong `frontend/tests/ai`.
- Dữ liệu đầu vào và checksum: `data/SOURCES.md`, mục 2. SHA-256 của tập test gán tay (khóa ngày 27/11/2026): `8fe3ae9327b53ec340e3a9d17737ed73ec3d6b9ade180dee7418f4eb3bb63a75`.
