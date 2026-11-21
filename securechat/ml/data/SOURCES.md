# Nguồn dữ liệu (điền khi tải về – phục vụ báo cáo & kiểm tra giấy phép)

> Mỗi nguồn dùng trong đồ án phải có một dòng ở đây **trước khi** cho vào `data/raw/`. Không commit dữ liệu có giấy phép không cho phép tái phân phối; chỉ commit script/đường dẫn tải.

## URL

| Nguồn | Link | Giấy phép | Ngày tải | Phiên bản/hash | Dùng cho | Ghi chú |
|---|---|---|---|---|---|---|
| PhiUSIIL Phishing URL | https://archive.ics.uci.edu/dataset/967 | (kiểm tra trang UCI) | | | train + val/test trong miền | `label` 1 = hợp lệ, 0 = phishing; chỉ dùng cột URL |
| PhishVN | (Mendeley Data – điền link) | CC BY 4.0 (theo mô tả; xác nhận lại) | | | train (gold/silver) + val/test chéo miền | schema chưa kiểm; tầng gold/silver/bronze; có cột split theo thời gian |

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
