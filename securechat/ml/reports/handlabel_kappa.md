# Độ nhất quán của nhãn trong tập test gán tay

Tệp được kiểm tra: `data/raw/messages_handlabeled.csv` (300 tin, 100 tin mỗi nhãn), SHA-256 `8fe3ae9327b53ec340e3a9d17737ed73ec3d6b9ade180dee7418f4eb3bb63a75`.

## 1. Cách làm

- Chọn ngẫu nhiên có phân tầng 60 tin (20 mỗi nhãn, seed 20261127) từ 300 tin của tập test.
- Người thứ hai, là bạn của người thực hiện, gán nhãn độc lập vào ngày 27/11/2026. Người này không thấy nhãn lần 1 và chỉ có trang hướng dẫn tóm tắt định nghĩa nhãn và bảng ranh giới (mục 4 của `data/LABELING_GUIDE.md`).
- Tính bằng `scripts/kappa_check.py`: Cohen's kappa trên ba nhãn, và kappa của nhóm rủi ro (`spam` và `scam` gộp lại so với `benign`).

## 2. Kết quả

| Chỉ số | Giá trị |
|---|---|
| Số tin | 60 |
| Đồng thuận (ba nhãn) | 56/60 (93,3%) |
| Cohen's kappa (ba nhãn) | 0,900 |
| Cohen's kappa (nhóm rủi ro so với `benign`) | 1,000 (đồng thuận 100%) |

Ma trận nhầm lẫn (hàng là lần 1, cột là lần 2):

| | `benign` | `spam` | `scam` |
|---|---|---|---|
| `benign` | 20 | 0 | 0 |
| `spam` | 0 | 18 | 2 |
| `scam` | 0 | 2 | 18 |

Cả 4 tin khác nhau đều nằm ở ranh giới giữa `spam` và `scam`. Không có tin nào lệch với `benign`, nên chỉ số chính của sản phẩm (nhóm rủi ro so với `benign`) không bị ảnh hưởng trên mẫu này. Mẫu chỉ có 60 tin nên khoảng tin cậy của kappa rộng.

## 3. Các tin hai lần gán khác nhau

STT là số thứ tự dòng dữ liệu trong tệp CSV, không tính dòng tiêu đề.

| STT | Tin | Lần 1 | Lần 2 | Nhãn cuối | Lý do |
|---|---|---|---|---|---|
| 161 | Bên em bán xe máy trả góp, a xem mẫu nhé: https://xemay.example/tragop | `spam` | `scam` | `spam` | Người lạ chào bán, liên kết không dẫn tới trang đăng nhập hay thanh toán, không đòi chuyển tiền |
| 170 | Admin thông báo chương trình dành cho thành viên trong nhóm. Mọi người tải ứng dụng về máy, khi đăng ký nhớ nhập mã giới thiệu NHOM88 để nhận 50 điểm thưởng... | `spam` | `scam` | `spam`, `hard=1` | Mời tải ứng dụng và nhập mã giới thiệu là `spam` theo guide; gần `scam` nên đặt `hard=1` |
| 218 | Ben minh dang tuyen cong tac vien online, cong viec chu yeu la tuong tac video, hoa hong tinh theo nhiem vu. | `scam` | `spam` | `scam` | Chọn theo hậu quả: tuyển cộng tác viên làm nhiệm vụ, tương tác video là phễu lừa dù chưa đòi tiền |
| 222 | Tuyển người làm online, lương trả hằng ngày, bạn muống tham gia nhóm không? | `scam` | `spam` | `scam`, `hard=1` | Cùng lý do với STT 218 |

Từ kết quả này, mục 4 của `data/LABELING_GUIDE.md` được thêm ba quy tắc: tuyển cộng tác viên làm nhiệm vụ là `scam`, liên kết trong tin chào bán không làm tin thành `scam`, mời tải ứng dụng kèm mã giới thiệu là `spam`.

## 4. Tin phụ thuộc ngữ cảnh người gửi

Bảy tin có `note` là "cần ngữ cảnh người gửi": STT 55, 61, 63 (`benign`) và STT 207, 210, 213, 215 (`scam`). Chúng có hình thức rất giống nhau (nhờ chuyển hoặc mượn một khoản tiền), nhãn chỉ khác nhau nhờ người gửi là người quen hay số lạ xưng là người quen, thông tin mà mô hình không có. Khi đánh giá, báo cáo kết quả trên cả 300 tin và trên 293 tin còn lại.

## 5. Lịch sử tập test

- 26/11/2026: bản soạn đầu gồm 300 tin có AI sinh. Bản này bị loại khỏi tập test và chuyển thành dữ liệu tổng hợp cho huấn luyện (`messages_ai_synthetic_v0.csv`, xem `data/SOURCES.md`).
- 26 đến 27/11/2026: tập test hiện tại được soạn lại, rà soát bằng công cụ (kiểm tra định dạng, tin trùng, độ dài và liên kết theo nhãn, đối chiếu với tập AI sinh và bộ SMS) và chỉnh sửa theo kết quả rà soát trước khi khóa.
- 27/11/2026: kiểm tra nhất quán (mục 2), khóa tệp và ghi mã băm vào `data/SOURCES.md`.
