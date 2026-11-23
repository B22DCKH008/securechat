# Nguồn dữ liệu (điền khi tải về – phục vụ báo cáo & kiểm tra giấy phép)

> Mỗi nguồn dùng trong đồ án phải có một dòng ở đây **trước khi** cho vào `data/raw/`. Không commit dữ liệu có giấy phép không cho phép tái phân phối; chỉ commit script/đường dẫn tải.

## URL

| Nguồn | Link | Giấy phép | Ngày tải | Phiên bản/hash | Dùng cho | Ghi chú |
|---|---|---|---|---|---|---|
| PhiUSIIL Phishing URL (Prasad & Chandra) | https://archive.ics.uci.edu/dataset/967 | CC BY 4.0 (theo trang UCI) | 11/2026 | UCI id 967, đăng 3/3/2024; 235.795 URL (134.850 hợp lệ / 100.945 phishing); hash ở mục Checksum | train + val/test trong miền | `label` 1 = hợp lệ, 0 = phishing; chỉ dùng cột URL |
| PhishVN (Vu Thai Nguyen, University of Transport and Communications) | https://data.mendeley.com/datasets/b97hxbxtpd/4 | CC BY 4.0 (theo trang Mendeley) | 11/2026 | v3.1.0 = Mendeley Data V4, đăng 18/08/2026, DOI 10.17632/b97hxbxtpd.4; file dữ liệu giống hệt v3; hash ở mục Checksum | train (gold/silver) + val (gold/silver/bronze) + test chéo miền (gold/silver) | dùng 3 file `splits/url_{train,val,test}.csv`, gộp bằng `scripts/merge_phishvn_splits.py`; còn 36.261 URL sau khi bỏ trùng |

## Checksum (SHA-256 của file đã tải)

| File | SHA-256 |
|---|---|
| `PhiUSIIL_Phishing_URL_Dataset.csv` | `a236549cd369cd80bd478ff8e1779cbf44c58d5c3f79f7a51a1adbed7d06d1c6` |
| `url_train.csv` (PhishVN) | `568e788eda4bdf62531adcddd093373ef6a1e97feec1354063ae337325367b61` |
| `url_val.csv` (PhishVN) | `d9ef64d29df6639af698ef228e5af5ec6f8ae44c8f1a1dd1367f9ba6d073d81f` |
| `url_test.csv` (PhishVN) | `b692882e8ae26b2c0b217c090e92d3a19307a26acbfb3c8c89692db26d409bc9` |

## Ghi công (CC BY 4.0 yêu cầu nêu nguồn và việc chỉnh sửa)

- Prasad, A. & Chandra, S. (2024), Computers & Security, doi:10.1016/j.cose.2023.103545. Dữ liệu: UCI Machine Learning Repository, id 967.
- Vu, T. N. (2026), *PhishVN: A Time-Stamped Vietnamese URL Phishing Dataset with Impersonation-Scenario Labels and Confidence Tiers*, v3.1.0, Mendeley Data V4, doi:10.17632/b97hxbxtpd.4.
- Đã xử lý trong dự án: chỉ giữ URL và nhãn, bỏ URL trùng, loại khỏi train mọi tên miền có mặt ở val/test, chia lại theo nhóm tên miền.

## Tin nhắn tiếng Việt (chưa có dữ liệu – cần tìm/tự tạo)

| Nguồn | Link/liên hệ | Giấy phép | Số mẫu | Nhãn gốc → nhãn dự án | Ghi chú |
|---|---|---|---|---|---|
| Vietnamese SMS spam (nếu có) | thử github.com/pth1993; hỏi tác giả hoangpt@fpt.edu.vn / phuonglh@vnu.edu.vn | ? | | spam→spam, ham→benign | chưa xác nhận tồn tại/giấy phép |
| Tin tự thu thập (xin phép, ẩn danh) | – | tự quản | | gán tay | **chỉ dùng cho `messages_handlabeled.csv` (TEST)**; xoá số điện thoại/STK/tên thật |
| Dữ liệu tổng hợp bằng AI | xem `SYNTHETIC_SPEC.md` | tự tạo | | | chỉ vào train (và validation khi thiếu real) |

## Quy ước

- Không dùng dữ liệu tiếng Anh/ngôn ngữ khác (đã quyết: chỉ tiếng Việt).
- Tin thật phải ẩn danh: thay số điện thoại, STK, CCCD, tên người bằng giá trị giả trước khi lưu.
- Ghi `source` cho từng dòng trong CSV (`real` / `synthetic` / `handlabeled`) để có thể tách khi đánh giá.
