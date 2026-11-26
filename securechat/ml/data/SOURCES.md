# Nguồn dữ liệu

Mỗi nguồn dữ liệu sử dụng trong đồ án được ghi tại đây trước khi đưa vào `data/raw/`, phục vụ báo cáo và việc kiểm tra giấy phép. Dữ liệu có giấy phép không cho phép tái phân phối không được đưa vào kho mã; kho chỉ lưu mã nguồn và đường dẫn tải.

## 1. Dữ liệu URL

| Nguồn | Liên kết | Giấy phép | Ngày tải | Phiên bản | Mục đích sử dụng | Ghi chú |
|---|---|---|---|---|---|---|
| PhiUSIIL Phishing URL (Prasad và Chandra) | https://archive.ics.uci.edu/dataset/967 | CC BY 4.0 (theo trang UCI) | / | UCI mã 967, đăng ngày 3/3/2024; 235.795 URL (134.850 hợp lệ, 100.945 phishing) | Huấn luyện, validation và test trong miền | `label` 1 là hợp lệ, 0 là phishing; chỉ dùng cột URL |
| PhishVN (Vu Thai Nguyen, University of Transport and Communications) | https://data.mendeley.com/datasets/b97hxbxtpd/4 | CC BY 4.0 (theo trang Mendeley) | / | v3.1.0 (Mendeley Data bản 4, đăng ngày 18/08/2026, DOI 10.17632/b97hxbxtpd.4); tệp dữ liệu giống hệt v3 | Huấn luyện (gold, silver), validation (gold, silver, bronze), test chéo miền (gold, silver) | Dùng ba tệp `splits/url_{train,val,test}.csv`, gộp bằng `scripts/merge_phishvn_splits.py`; còn 36.261 URL sau khi loại trùng |

## 2. Checksum

Giá trị SHA-256 của các tệp đã tải và của tập test gán tay:

| Tệp | SHA-256 |
|---|---|
| `PhiUSIIL_Phishing_URL_Dataset.csv` | `a236549cd369cd80bd478ff8e1779cbf44c58d5c3f79f7a51a1adbed7d06d1c6` |
| `url_train.csv` (PhishVN) | `568e788eda4bdf62531adcddd093373ef6a1e97feec1354063ae337325367b61` |
| `url_val.csv` (PhishVN) | `d9ef64d29df6639af698ef228e5af5ec6f8ae44c8f1a1dd1367f9ba6d073d81f` |
| `url_test.csv` (PhishVN) | `b692882e8ae26b2c0b217c090e92d3a19307a26acbfb3c8c89692db26d409bc9` |
| `full_dataset.csv` (vietnamese_sms_dataset, commit `464a028`, bản clone trên Windows) | `8c86ceea0aa6a4f8588636894075fa1c4579efc1713837523a798eb7601635da` |
| `messages_handlabeled.csv` | `8fe3ae9327b53ec340e3a9d17737ed73ec3d6b9ade180dee7418f4eb3bb63a75` |

Tệp `full_dataset.csv` được tính trên bản clone ở Windows, nơi Git đổi ký tự xuống dòng LF thành CRLF. Bản LF nguyên gốc trong kho có SHA-256 `710cd7b56ef1b4aa82e72c1be0f46a5c89a5fdce8382b30874b3cea494d16e3e` (blob Git `361a893c3800e9ac72d94432f2e06e59f6fcbda1`); hai bản có cùng nội dung và cho cùng kết quả khi chạy `scripts/import_vi_sms.py`.

Tệp `messages_handlabeled.csv` được khóa ngày 27/11/2026 và giữ nguyên từng byte như khi lưu trên Windows (UTF-8 có BOM, xuống dòng CRLF). `.gitattributes` đặt `-text` cho tệp này để Git không đổi ký tự xuống dòng, nên mã băm ở trên khớp trên mọi máy.

## 3. Ghi công

Giấy phép CC BY 4.0 yêu cầu nêu nguồn và các chỉnh sửa đã thực hiện.

- Prasad, A. và Chandra, S. (2024), Computers & Security, doi:10.1016/j.cose.2023.103545. Dữ liệu lấy từ UCI Machine Learning Repository, mã 967.
- Vu, T. N. (2026), *PhishVN: A Time-Stamped Vietnamese URL Phishing Dataset with Impersonation-Scenario Labels and Confidence Tiers*, v3.1.0, Mendeley Data bản 4, doi:10.17632/b97hxbxtpd.4.
- Chỉnh sửa trong đồ án: chỉ giữ URL và nhãn, loại URL trùng, loại khỏi tập huấn luyện mọi tên miền có mặt ở validation hoặc test, và chia lại theo nhóm tên miền.
- Tran, N. T. T., Le, H. K., Nguyen, M. T., Nguyen, V. T. và Mai, H. D. (2026), *Vietnamese SMS Dataset with Quality Assurance*, IEEE Access, theo mục trích dẫn trong README của kho https://github.com/trannguyenthaituan251209/vietnamese_sms_dataset (thông tin xuất bản chưa đối chiếu với bài báo).
- Chỉnh sửa trong đồ án (dữ liệu tin nhắn): bỏ 24 tin tiếng Anh, loại tin trùng, gộp khoảng trắng, che 14 tin còn chứa email, tên người hoặc mã tài khoản có tên, chuyển nhãn nhị phân sang ba nhãn bằng luật (sửa tay 8 tin), và thay các token ẩn danh (`[MONEY]`, `[NUMBER]`, `[TIME]`, `[DATE]`, `[POINT]`, `[NAME]`, `[URL]`) bằng giá trị giả. Các tag nhà mạng và thương hiệu như `[TB]`, `[QC]` được giữ nguyên.

## 4. Dữ liệu tin nhắn tiếng Việt

| Nguồn | Liên kết | Giấy phép | Số mẫu | Nhãn gốc và nhãn của dự án | Ghi chú |
|---|---|---|---|---|---|
| Vietnamese SMS Dataset with Quality Assurance (Tran Nguyen Thai Tuan và cộng sự) | https://github.com/trannguyenthaituan251209/vietnamese_sms_dataset | CC BY 4.0 (theo README của kho) | 2.991 tin; còn 2.577 sau khi bỏ tin tiếng Anh và tin trùng | Nhãn gốc 0 và 1. Nhãn 1 thành `scam`; nhãn 0 thành `spam` (tin quảng cáo) hoặc `benign` theo luật trong `src/securechat_ml/data/vi_sms.py` | Huấn luyện và validation, `source=real`. Chuyển bằng `scripts/import_vi_sms.py`. Không dùng `train.csv` và `test.csv` của bộ này vì 97 trong 597 tin của `test.csv` gần trùng với `train.csv`. Toàn bộ là tin SMS, không có tin trò chuyện |
| Tin nhắn tự viết hoặc tự thu thập (có xin phép, đã ẩn danh) | / | Tự quản lý | 300 (100 mỗi nhãn) | Gán nhãn tay | Chỉ dùng cho `messages_handlabeled.csv` (tập test), khóa ngày 27/11/2026. Soạn theo khung tình huống trong `LABELING_GUIDE.md`, dùng thông tin giả (số điện thoại, số tài khoản, tên, liên kết). Bản soạn đầu (26/11/2026) có AI sinh nên bị loại khỏi tập test và chuyển thành dữ liệu tổng hợp ở dòng dưới; tập hiện tại do người thực hiện soạn lại và gán nhãn trong các ngày 26 đến 27/11/2026. Độ nhất quán của nhãn: xem `reports/handlabel_kappa.md` |
| Dữ liệu tổng hợp bằng AI | Xem `SYNTHETIC_SPEC.md` | Tự tạo | 300 (đợt 1, 100 mỗi nhãn, tệp `messages_ai_synthetic_v0.csv`) | Nhãn theo kịch bản sinh | Chỉ dùng cho huấn luyện, và cho validation khi thiếu dữ liệu thật. Sinh ngày 26/11/2026, trước khi soạn lại tập test hiện tại; cột `source` là `synthetic` |

## 5. Quy ước

- Chỉ sử dụng dữ liệu tiếng Việt; không dùng dữ liệu tiếng Anh hoặc ngôn ngữ khác, kể cả bản dịch máy từ tiếng Anh.
- Tin nhắn thật phải được ẩn danh trước khi lưu: thay số điện thoại, số tài khoản, số CCCD và tên người bằng giá trị giả.
- Tin SMS (nhà mạng, ngân hàng, đầu số quảng cáo) và tin trò chuyện giữa người với người có phân bố khác nhau. Bộ SMS chỉ được dùng để huấn luyện; tập test phải là tin kiểu trò chuyện do người thực hiện tự viết.
- Mỗi dòng trong tệp CSV có cột `source` nhận một trong ba giá trị `real`, `synthetic`, `handlabeled`, để tách được các nguồn khi đánh giá.
