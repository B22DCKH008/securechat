# Nguồn dữ liệu

Mỗi nguồn dữ liệu sử dụng trong đồ án được ghi tại đây trước khi đưa vào `data/raw/`, phục vụ báo cáo và việc kiểm tra giấy phép. Dữ liệu có giấy phép không cho phép tái phân phối không được đưa vào kho mã; kho chỉ lưu mã nguồn và đường dẫn tải.

## 1. Dữ liệu URL

| Nguồn | Liên kết | Giấy phép | Ngày tải | Phiên bản | Mục đích sử dụng | Ghi chú |
|---|---|---|---|---|---|---|
| PhiUSIIL Phishing URL (Prasad và Chandra) | https://archive.ics.uci.edu/dataset/967 | CC BY 4.0 (theo trang UCI) | / | UCI mã 967, đăng ngày 3/3/2024; 235.795 URL (134.850 hợp lệ, 100.945 phishing) | Huấn luyện, validation và test trong miền | `label` 1 là hợp lệ, 0 là phishing; chỉ dùng cột URL |
| PhishVN (Vu Thai Nguyen, University of Transport and Communications) | https://data.mendeley.com/datasets/b97hxbxtpd/4 | CC BY 4.0 (theo trang Mendeley) | / | v3.1.0 (Mendeley Data bản 4, đăng ngày 18/08/2026, DOI 10.17632/b97hxbxtpd.4); tệp dữ liệu giống hệt v3 | Huấn luyện (gold, silver), validation (gold, silver, bronze), test chéo miền (gold, silver) | Dùng ba tệp `splits/url_{train,val,test}.csv`, gộp bằng `scripts/merge_phishvn_splits.py`; còn 36.261 URL sau khi loại trùng |

## 2. Checksum

Giá trị SHA-256 của các tệp đã tải:

| Tệp | SHA-256 |
|---|---|
| `PhiUSIIL_Phishing_URL_Dataset.csv` | `a236549cd369cd80bd478ff8e1779cbf44c58d5c3f79f7a51a1adbed7d06d1c6` |
| `url_train.csv` (PhishVN) | `568e788eda4bdf62531adcddd093373ef6a1e97feec1354063ae337325367b61` |
| `url_val.csv` (PhishVN) | `d9ef64d29df6639af698ef228e5af5ec6f8ae44c8f1a1dd1367f9ba6d073d81f` |
| `url_test.csv` (PhishVN) | `b692882e8ae26b2c0b217c090e92d3a19307a26acbfb3c8c89692db26d409bc9` |

## 3. Ghi công

Giấy phép CC BY 4.0 yêu cầu nêu nguồn và các chỉnh sửa đã thực hiện.

- Prasad, A. và Chandra, S. (2024), Computers & Security, doi:10.1016/j.cose.2023.103545. Dữ liệu lấy từ UCI Machine Learning Repository, mã 967.
- Vu, T. N. (2026), *PhishVN: A Time-Stamped Vietnamese URL Phishing Dataset with Impersonation-Scenario Labels and Confidence Tiers*, v3.1.0, Mendeley Data bản 4, doi:10.17632/b97hxbxtpd.4.
- Chỉnh sửa trong đồ án: chỉ giữ URL và nhãn, loại URL trùng, loại khỏi tập huấn luyện mọi tên miền có mặt ở validation hoặc test, và chia lại theo nhóm tên miền.

## 4. Dữ liệu tin nhắn tiếng Việt

| Nguồn | Liên kết | Giấy phép | Số mẫu | Nhãn gốc và nhãn của dự án | Ghi chú |
|---|---|---|---|---|---|
| Bộ SMS spam tiếng Việt công khai | / | / | / | spam thành spam, ham thành benign | Chưa xác định nguồn cụ thể |
| Tin nhắn tự thu thập (có xin phép, đã ẩn danh) | / | Tự quản lý | / | Gán nhãn tay | Chỉ dùng cho `messages_handlabeled.csv` (tập test); phải xóa số điện thoại, số tài khoản và tên thật |
| Dữ liệu tổng hợp bằng AI | Xem `SYNTHETIC_SPEC.md` | Tự tạo | / | / | Chỉ dùng cho huấn luyện, và cho validation khi thiếu dữ liệu thật |

## 5. Quy ước

- Chỉ sử dụng dữ liệu tiếng Việt; không dùng dữ liệu tiếng Anh hoặc ngôn ngữ khác.
- Tin nhắn thật phải được ẩn danh trước khi lưu: thay số điện thoại, số tài khoản, số CCCD và tên người bằng giá trị giả.
- Mỗi dòng trong tệp CSV có cột `source` nhận một trong ba giá trị `real`, `synthetic`, `handlabeled`, để tách được các nguồn khi đánh giá.
