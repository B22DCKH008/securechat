# Đặc tả sinh dữ liệu tổng hợp (tin nhắn tiếng Việt) bằng AI

Dùng khi không có/không đủ dữ liệu thật. Mục tiêu: có tập **train** đa dạng; **không** dùng để đo chất lượng cuối.

## Quy tắc cứng (đừng phá)

1. **Test không bao giờ chứa dữ liệu tổng hợp.** `messages_handlabeled.csv` do bạn tự viết/gán tay (kể cả ca khó), mỗi nhãn ≥ 100 tin (đề xuất), tốt nhất ≥ 150 để đo precision đáng tin.
2. Cột `source=synthetic`; cột `group` = id kịch bản/template (`scam_ngan_hang_01`…) → các biến thể cùng kịch bản luôn nằm cùng một tập.
3. Không dán tin test vào prompt sinh dữ liệu (tránh rò rỉ). Viết test trước, hoặc sinh bằng phiên chat khác.
4. Không dùng số điện thoại/STK/tên thật; dùng giá trị giả. Không tạo nội dung thật sự gây hại (chỉ mẫu nhận diện).
5. Nói rõ trong báo cáo: model train trên dữ liệu tổng hợp → kết quả test (tay) mới là con số đáng tin; so với validation tổng hợp thường quá lạc quan.

## Schema CSV (`data/raw/messages_train_pool.csv`)

`text,label,source,group[,lang]` — `label ∈ {benign, spam, scam}`, `source=synthetic`, `lang=vi`.

## Phân loại kịch bản (taxonomy)

**scam** (gồm phishing, mạo danh, lừa chuyển tiền): giả ngân hàng/ví (khoá tài khoản, xác minh, OTP) · giả công an/toà án/VNeID/thuế · giả shipper/bưu điện (phí giao hàng, link theo dõi) · trúng thưởng/nhận quà · việc nhẹ lương cao/tuyển CTV · đầu tư/crypto/cho vay · người quen mượn tiền (hack Zalo/FB) · điện/nước/cước nợ sắp cắt · tình cảm/làm quen rồi đầu tư.
**spam** (quảng cáo không mời, ít lừa đảo): khuyến mãi cửa hàng/siêu thị · đầu số quảng cáo `[QC]`/soạn cú pháp · mời học/khoá học · bất động sản/bảo hiểm/thẻ tín dụng · nhà mạng gói cước.
**benign**: trò chuyện đời thường, hẹn gặp, công việc/lớp học, gia đình, **thông báo hợp lệ** (OTP ngân hàng *có cảnh báo không chia sẻ*, giao hàng thật, nhắc lịch), và **ca khó** (tin hợp lệ có link/số tiền/từ “khoá”, “xác nhận”).

## Số lượng đề xuất (điều chỉnh theo thời gian)

| nhãn | số tin | số kịch bản (group) | biến thể/kịch bản |
|---|---|---|---|
| scam | 600–1000 | 30–50 | ≥ 15 |
| spam | 400–600 | 20–30 | ≥ 15 |
| benign | 1000–1500 | 40–60 | ≥ 15 |

Mỗi kịch bản phải có biến thể: **có dấu**, **không dấu**, teencode/viết tắt (`k`, `ko`, `dc`, `vcb`), sai chính tả, viết hoa toàn bộ, có/không link (`https://…`, `bit.ly`), có/không số điện thoại/STK giả, độ dài ngắn/dài, có emoji. Ít nhất 25–30% không dấu/teencode (tin thật thường như vậy).

## Prompt mẫu (dán vào AI, đổi phần trong ngoặc)

```
Bạn đang giúp tạo dữ liệu huấn luyện cho bộ phát hiện tin nhắn lừa đảo bằng tiếng Việt (mục đích nghiên cứu, đồ án).
Hãy viết {N} tin nhắn SMS/Zalo/Messenger khác nhau cho kịch bản: "{MÔ TẢ KỊCH BẢN}".
Nhãn: {scam|spam|benign}. Mã kịch bản: {group_id}.
Yêu cầu:
- Tiếng Việt tự nhiên như tin thật; đa dạng giọng điệu, độ dài (5–60 từ), cách mở đầu.
- Trộn: có dấu / không dấu / teencode / viết tắt / sai chính tả / VIẾT HOA / emoji (khoảng {30}% không dấu hoặc teencode).
- Một phần có link giả (vd: https://vcb-xacminh.top/abc), một phần có số điện thoại giả (090xxxxxxx), STK giả; không dùng thông tin thật hay tên thương hiệu để lừa người dùng cụ thể ngoài tên chung (ngân hàng, nhà mạng).
- Không lặp ý; mỗi tin khác cấu trúc câu.
Xuất đúng định dạng CSV, không giải thích, cột: text,label,source,group
- label = {nhãn}, source = synthetic, group = {group_id}
- Đặt text trong dấu nháy kép, thoát dấu nháy kép bên trong bằng "".
```
Với **benign khó**: thêm “tin hợp lệ nhưng chứa từ/hình thức giống lừa đảo (OTP, tài khoản, link, chuyển khoản, khoá)”.

## Quy trình kiểm soát chất lượng

1. Gộp các file AI trả về → `data/raw/messages_train_pool.csv` (giữ dòng tiêu đề một lần).
2. `make validate` (hoặc `validate-messages --file ...`): kiểm nhãn, `source`, text rỗng, trùng sau chuẩn hóa, tin quá dài, nhãn < 30 mẫu, tỷ lệ tin có từ tiếng Việt, và in số lượng theo nhãn/nguồn; sửa mọi `errors`. (Tỷ lệ tin không dấu/teencode chưa được tự đo: kiểm tay khi đọc mẫu.)
3. Đọc ngẫu nhiên ≥ 50 tin/nhãn: loại tin sai nhãn, quá vô lý, lặp khuôn (nếu > 30% bắt đầu bằng cùng một cụm → sinh lại với yêu cầu đa dạng hơn).
4. `prepare-messages` và đọc `split_manifest.json`: kiểm `warnings`, số nhóm, `validation_source`, số dòng train bị loại do gần giống test.
5. Sau train, so điểm trên validation (tổng hợp) với test gán tay; chênh lớn → mô hình học khuôn tổng hợp, cần thêm đa dạng/ thêm dữ liệu thật.
