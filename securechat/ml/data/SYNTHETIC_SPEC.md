# Đặc tả sinh dữ liệu tổng hợp tin nhắn tiếng Việt

Tài liệu này mô tả cách sinh dữ liệu tổng hợp bằng mô hình ngôn ngữ để bổ sung cho tập huấn luyện khi dữ liệu thật không có hoặc không đủ. Dữ liệu tổng hợp chỉ dùng cho huấn luyện, không dùng để đo chất lượng cuối cùng.

## 1. Nguyên tắc bắt buộc

1. Tập test không chứa dữ liệu tổng hợp. Tệp `messages_handlabeled.csv` do người thực hiện tự viết và gán nhãn, kể cả các ca khó. Mỗi nhãn cần tối thiểu 100 tin; nên có từ 150 tin trở lên để precision đo được đáng tin cậy.
2. Cột `source` nhận giá trị `synthetic`. Cột `group` là mã kịch bản (ví dụ `scam_ngan_hang_01`); các biến thể của cùng một kịch bản luôn nằm trong cùng một tập.
3. Không đưa tin thuộc tập test vào lời nhắc sinh dữ liệu để tránh rò rỉ. Nên viết tập test trước, hoặc sinh dữ liệu trong một phiên làm việc khác.
4. Không dùng số điện thoại, số tài khoản hay tên người thật mà thay bằng giá trị giả. Không tạo nội dung gây hại thực sự, chỉ tạo mẫu phục vụ nhận diện.
5. Báo cáo cần nêu rõ rằng mô hình được huấn luyện trên dữ liệu tổng hợp, vì vậy kết quả trên tập test gán tay mới là số đo đáng tin cậy. Điểm trên validation tổng hợp thường cao hơn thực tế.

## 2. Định dạng CSV

Tệp `data/raw/messages_train_pool.csv` có các cột `text`, `label`, `source`, `group` và tùy chọn `lang`. Giá trị của `label` thuộc {`benign`, `spam`, `scam`}, `source` là `synthetic` và `lang` là `vi`.

## 3. Phân loại kịch bản

Nhãn `scam` (gồm phishing, mạo danh và lừa chuyển tiền):

- Giả danh ngân hàng, ví điện tử (khóa tài khoản, yêu cầu xác minh, hỏi OTP).
- Giả danh công an, tòa án, VNeID, cơ quan thuế.
- Giả danh đơn vị giao hàng, bưu điện (phí giao hàng, liên kết theo dõi).
- Trúng thưởng, nhận quà.
- Việc nhẹ lương cao, tuyển cộng tác viên.
- Đầu tư, tiền mã hóa, cho vay.
- Người quen mượn tiền (tài khoản Zalo, Facebook bị chiếm).
- Thông báo nợ điện, nước, cước sắp bị cắt.
- Làm quen tình cảm rồi dẫn dắt đầu tư.

Nhãn `spam` (quảng cáo không mời, mức độ lừa đảo thấp):

- Khuyến mãi của cửa hàng, siêu thị.
- Tin quảng cáo theo đầu số (`[QC]`, soạn cú pháp).
- Mời tham gia lớp học, khóa học.
- Bất động sản, bảo hiểm, thẻ tín dụng.
- Gói cước của nhà mạng.

Nhãn `benign`:

- Trò chuyện thường ngày, hẹn gặp, công việc, lớp học, gia đình.
- Thông báo hợp lệ: OTP ngân hàng có kèm cảnh báo không chia sẻ, thông báo giao hàng thật, nhắc lịch.
- Ca khó: tin hợp lệ có liên kết, số tiền hoặc các từ như "khóa", "xác nhận".

## 4. Số lượng đề xuất

Số lượng có thể điều chỉnh theo thời gian thực hiện.

| Nhãn | Số tin | Số kịch bản (`group`) | Biến thể mỗi kịch bản |
|---|---|---|---|
| scam | 600-1000 | 30-50 | Tối thiểu 15 |
| spam | 400-600 | 20-30 | Tối thiểu 15 |
| benign | 1000-1500 | 40-60 | Tối thiểu 15 |

Mỗi kịch bản cần có các biến thể: có dấu, không dấu, teencode và viết tắt (`k`, `ko`, `dc`, `vcb`), sai chính tả, viết hoa toàn bộ, có hoặc không có liên kết (`https://...`, `bit.ly`), có hoặc không có số điện thoại và số tài khoản giả, độ dài ngắn và dài, có emoji. Tối thiểu 25-30% số tin ở dạng không dấu hoặc teencode, vì tin nhắn thật thường như vậy.

## 5. Lời nhắc mẫu

Thay các phần trong ngoặc nhọn trước khi dùng.

```
Bạn đang giúp tạo dữ liệu huấn luyện cho bộ phát hiện tin nhắn lừa đảo bằng tiếng Việt (mục đích nghiên cứu, đồ án).
Hãy viết {N} tin nhắn SMS/Zalo/Messenger khác nhau cho kịch bản: "{MÔ TẢ KỊCH BẢN}".
Nhãn: {scam|spam|benign}. Mã kịch bản: {group_id}.
Yêu cầu:
- Tiếng Việt tự nhiên như tin thật; đa dạng giọng điệu, độ dài (5-60 từ), cách mở đầu.
- Trộn: có dấu / không dấu / teencode / viết tắt / sai chính tả / VIẾT HOA / emoji (khoảng {30}% không dấu hoặc teencode).
- Một phần có link giả (vd: https://vcb-xacminh.top/abc), một phần có số điện thoại giả (090xxxxxxx), STK giả; không dùng thông tin thật hay tên thương hiệu để lừa người dùng cụ thể ngoài tên chung (ngân hàng, nhà mạng).
- Không lặp ý; mỗi tin khác cấu trúc câu.
Xuất đúng định dạng CSV, không giải thích, cột: text,label,source,group
- label = {nhãn}, source = synthetic, group = {group_id}
- Đặt text trong dấu nháy kép, thoát dấu nháy kép bên trong bằng "".
```

Với nhãn `benign` ở mức khó, bổ sung vào lời nhắc: "tin hợp lệ nhưng chứa từ hoặc hình thức giống lừa đảo (OTP, tài khoản, link, chuyển khoản, khóa)".

## 6. Quy trình kiểm soát chất lượng

1. Gộp các tệp do AI trả về vào `data/raw/messages_train_pool.csv`, giữ dòng tiêu đề một lần.
2. Chạy `make validate` (hoặc `validate-messages --file ...`). Lệnh kiểm tra nhãn, `source`, văn bản rỗng, tin trùng sau chuẩn hóa, tin quá dài, nhãn có dưới 30 mẫu và tỷ lệ tin có từ tiếng Việt, đồng thời in số lượng theo nhãn và nguồn. Mọi mục `errors` cần được sửa. Tỷ lệ tin không dấu hoặc teencode chưa được đo tự động và cần kiểm tra thủ công khi đọc mẫu.
3. Đọc ngẫu nhiên ít nhất 50 tin mỗi nhãn, loại các tin sai nhãn hoặc quá vô lý. Nếu hơn 30% số tin bắt đầu bằng cùng một cụm từ thì sinh lại với yêu cầu đa dạng hơn.
4. Chạy `prepare-messages` và đọc `split_manifest.json`, kiểm tra `warnings`, số nhóm, `validation_source` và số dòng train bị loại do gần giống tập test.
5. Sau khi huấn luyện, so điểm trên validation (tổng hợp) với điểm trên test gán tay. Nếu chênh lệch lớn thì mô hình đang học theo khuôn của dữ liệu tổng hợp, cần bổ sung dữ liệu đa dạng hơn hoặc dữ liệu thật.
