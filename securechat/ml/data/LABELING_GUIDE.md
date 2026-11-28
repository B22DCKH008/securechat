# Hướng dẫn viết và gán nhãn tập test tin nhắn

Tài liệu này quy định cách xây dựng `data/raw/messages_handlabeled.csv`, tập test dùng để báo cáo kết quả cuối của mô hình tin nhắn. Tập này phản ánh loại tin mà ứng dụng thực sự xử lý: tin trò chuyện một-một giữa người với người, khác với tin SMS của nhà mạng và ngân hàng trong dữ liệu huấn luyện.

## 1. Nguyên tắc

1. Người thực hiện tự viết và tự gán nhãn. Không dùng AI để sinh tin cho tập này, không sao chép tin từ bộ SMS hoặc từ dữ liệu tổng hợp.
2. Viết xong và khóa tập test trước khi xem kết quả của mô hình trên tập này. Không sửa nhãn hoặc xóa tin sau khi đã xem kết quả; nếu phát hiện lỗi thật sự thì ghi lại lý do trong cột `note` và nêu trong báo cáo.
3. Tin viết theo kiểu trò chuyện (Zalo, Messenger, Telegram, tin nhắn từ số lạ), không viết theo mẫu tin quảng cáo của nhà mạng.
4. Không dùng thông tin thật: số điện thoại, số tài khoản, tên người, tên thương hiệu cụ thể dùng để lừa người dùng. Dùng giá trị giả (`090xxxxxxx`, `https://vcb-xacminh.top/abc`) và tên chung (ngân hàng, nhà mạng, đơn vị giao hàng).
5. Tập test không được trùng hoặc gần trùng với dữ liệu huấn luyện. Pipeline tự loại các tin huấn luyện gần giống tin test (`train_rows_dropped_near_test` trong `split_manifest.json`), nhưng việc tự viết mới vẫn là biện pháp chính.

## 2. Định dạng tệp

Tệp CSV UTF-8, mỗi dòng một tin, không xuống dòng trong nội dung tin:

| Cột | Bắt buộc | Ghi chú |
|---|---|---|
| `text` | Có | Nội dung tin, giữ nguyên cách viết (không dấu, teencode, sai chính tả) |
| `label` | Có | `benign`, `spam` hoặc `scam` |
| `hard` | Không | `1` nếu thuộc nhóm ca khó ở mục 5, ngược lại `0` |
| `note` | Không | Ghi chú ngắn về tình huống hoặc lý do chọn nhãn khi ranh giới không rõ |

Nếu soạn bằng Excel, lưu theo định dạng "CSV UTF-8". Kiểm tra bằng lệnh:

```powershell
python -m securechat_ml.cli validate-messages --file data/raw/messages_handlabeled.csv
```

## 3. Số lượng

- Tối thiểu 100 tin mỗi nhãn, nên có từ 150 tin mỗi nhãn trở lên (tổng khoảng 450) để các độ đo theo nhãn có khoảng tin cậy đủ hẹp.
- Tối thiểu 30% số tin có `hard=1`, phân bố ở cả ba nhãn.
- Không quá 5 tin viết theo cùng một khuôn câu. Thay đổi người gửi, bối cảnh, độ dài (từ 3 đến 60 từ) và cách mở đầu.

Phân bố đề xuất cho mỗi nhãn (150 tin):

| Nhãn | Nhóm tình huống | Số tin |
|---|---|---|
| `benign` | Trò chuyện thường ngày, hẹn gặp, gia đình, bạn bè | 50 |
| | Công việc, học tập, nhóm đồ án | 30 |
| | Người quen hỏi mượn hoặc chuyển tiền thật, nhờ gửi tài liệu | 20 |
| | Gửi liên kết thật (bài báo, địa điểm, tài liệu, Google Drive) | 20 |
| | Thông báo hợp lệ: OTP kèm cảnh báo, giao hàng thật, nhắc lịch | 15 |
| | Không dấu, teencode, viết tắt | 15 |
| `spam` | Người lạ chào bán hàng, dịch vụ, khóa học | 40 |
| | Quảng cáo cửa hàng, siêu thị, khuyến mãi | 30 |
| | Bất động sản, bảo hiểm, thẻ tín dụng, vay tiêu dùng | 25 |
| | Mời vào nhóm, kêu gọi theo dõi, bình chọn, đa cấp mức nhẹ | 25 |
| | Không dấu, teencode, viết tắt | 30 |
| `scam` | Mạo danh người quen mượn tiền (tài khoản bị chiếm) | 25 |
| | Việc nhẹ lương cao, tuyển cộng tác viên | 20 |
| | Đầu tư, tiền mã hóa, cho vay, làm quen tình cảm rồi dẫn dắt đầu tư | 25 |
| | Giả ngân hàng, ví điện tử, nhà mạng (khóa tài khoản, hỏi OTP, liên kết đăng nhập) | 25 |
| | Giả công an, tòa án, thuế, VNeID, đơn vị giao hàng | 20 |
| | Trúng thưởng, nhận quà, không dấu, teencode | 35 |

## 4. Định nghĩa nhãn và quy tắc phân xử

Định nghĩa gốc nằm trong `configs/labels.yaml`. Nhãn được gán theo ý đồ và nội dung của tin, không theo hình thức.

- `scam`: tin nhằm chiếm đoạt tiền hoặc thông tin, thể hiện ở một trong các dấu hiệu: yêu cầu chuyển tiền, đọc hoặc gửi OTP, mật khẩu, thông tin thẻ; liên kết dẫn đến trang đăng nhập hoặc thanh toán giả; hứa lợi nhuận hoặc thu nhập bất thường; mạo danh người quen hoặc cơ quan để tạo áp lực.
- `spam`: quảng cáo hoặc chào mời gửi hàng loạt, người nhận không yêu cầu, nhưng không nhằm chiếm đoạt (giao dịch bình thường nếu người nhận đồng ý).
- `benign`: trao đổi bình thường, kể cả tin chứa số tiền, liên kết, OTP hoặc từ như "khóa", "xác nhận" khi bối cảnh hợp lệ.

Các tình huống ranh giới:

| Tình huống | Nhãn | Lý do |
|---|---|---|
| Người lạ chào bán hàng, không yêu cầu chuyển tiền trước | `spam` | Quảng cáo không mời |
| Người lạ yêu cầu chuyển cọc trước khi giao hàng không rõ nguồn gốc | `scam` | Có yêu cầu chuyển tiền kèm mạo danh hoặc lợi nhuận bất thường |
| Bạn thân nhắn "chuyển giúp mình 200k, tối trả" trong ngữ cảnh trò chuyện quen thuộc | `benign` | Giao dịch giữa người quen, không có dấu hiệu mạo danh |
| Tin "mình đổi số, chuyển gấp 5 triệu vào STK này" từ số lạ xưng là người quen | `scam` | Mạo danh và gây áp lực |
| Tin OTP của ngân hàng có câu "không chia sẻ mã này" | `benign` | Thông báo hợp lệ |
| Tin "đọc mã OTP vừa gửi cho mình để xác nhận hồ sơ" | `scam` | Yêu cầu chuyển tiếp OTP |
| Tin tuyển việc có mô tả công việc, địa điểm, mức lương hợp lý, không thu phí | `spam` | Chào mời hàng loạt |
| Tin tuyển cộng tác viên "nhấn đơn, hoa hồng 30%/ngày, nạp trước để nhận nhiệm vụ" | `scam` | Lợi nhuận bất thường kèm yêu cầu nạp tiền |
| Mời vào nhóm học tiếng Anh miễn phí qua liên kết thật | `spam` | Chào mời không mời |
| Nhắc lịch, nhắc nộp bài do người quen gửi, có liên kết | `benign` | Trao đổi bình thường |
| Tuyển cộng tác viên "làm nhiệm vụ", tương tác video, kiểm đơn, hoa hồng theo nhiệm vụ (không bán hàng thật), chưa đòi tiền | `scam` | Phễu lừa cộng tác viên; chọn theo hậu quả với người nhận |
| Người lạ chào bán hàng kèm liên kết không dẫn tới trang đăng nhập hoặc thanh toán | `spam` | Liên kết trong tin chào bán không làm tin thành `scam` |
| Mời tải ứng dụng và nhập mã giới thiệu để nhận điểm thưởng | `spam` | Chào mời có điều kiện, gần `scam` nên đặt `hard=1` |

Nếu một tin vẫn khó quyết định sau khi đối chiếu bảng trên, chọn nhãn theo hậu quả với người nhận nếu làm theo tin đó (mất tiền hoặc thông tin thì `scam`, chỉ bị làm phiền thì `spam`), ghi lý do vào `note` và đặt `hard=1`.

Tin mà nhãn chỉ khác nhau nhờ người gửi (ví dụ "cho mình mượn 300k" từ bạn thân hoặc từ số lạ xưng là người quen) thì mô hình không có thông tin để phân biệt. Gán nhãn theo kịch bản dự kiến, ghi `note` là "cần ngữ cảnh người gửi", và khi báo cáo nêu kết quả trên cả tập lẫn trên tập bỏ các dòng này.

## 5. Ca khó (`hard=1`)

Các nhóm sau được đánh dấu `hard=1`:

1. Tin không dấu, teencode, viết tắt (`k`, `ko`, `dc`, `vcb`, `stk`), sai chính tả, viết hoa toàn bộ, có emoji.
2. Tin `benign` có hình thức giống lừa đảo: có liên kết, số tiền, OTP, số tài khoản, từ "khóa", "xác nhận", "gấp".
3. Tin `scam` giọng thân thiện hoặc văn phong tự nhiên, không có liên kết và không có từ khóa quen thuộc.
4. Tin `spam` gần với `scam` (khuyến mãi lớn bất thường, chương trình có điều kiện) hoặc gần với `benign` (người quen rao bán).
5. Tin ngắn dưới 5 từ mà ý nghĩa phụ thuộc vào ngữ cảnh.

## 6. Kiểm tra độ nhất quán của nhãn

Báo cáo cần nêu mức nhất quán của nhãn gán tay. Chọn ngẫu nhiên 60 tin (20 mỗi nhãn) và gán lại một lần nữa mà không xem nhãn cũ:

- Nếu có người thứ hai: người đó gán nhãn độc lập, hai bên so sánh.
- Nếu làm một mình: gán lại sau ít nhất ba ngày.

Tính hệ số Cohen's kappa:

```python
import pandas as pd
from sklearn.metrics import cohen_kappa_score

a = pd.read_csv("lan1.csv")["label"]
b = pd.read_csv("lan2.csv")["label"]
print(cohen_kappa_score(a, b))
```

Nên ghi cả kappa và danh sách các tin hai lần gán khác nhau (kèm nhãn cuối cùng và lý do) vào báo cáo. Kappa dưới 0,6 cho thấy ranh giới nhãn chưa rõ, cần bổ sung quy tắc ở mục 4 trước khi gán tiếp. Kết quả của tập test hiện tại nằm ở `reports/handlabel_kappa.md`; script tính kappa là `scripts/kappa_check.py`.

## 7. Quy trình

1. Viết tin theo bảng ở mục 3, đánh dấu `hard` và `note` ngay khi viết.
2. Chạy `validate-messages`; sửa mọi mục `errors`. Lưu ý các cảnh báo về số tin mỗi nhãn và tỷ lệ tiếng Việt.
3. Làm bước kiểm tra nhất quán ở mục 6.
4. Khóa tệp: tính SHA-256 (`Get-FileHash data/raw/messages_handlabeled.csv` trên PowerShell), ghi vào mục 2 của `data/SOURCES.md`, và từ đây không sửa tệp.
5. Chỉ sau đó mới chạy `prepare-messages` và `train-message` với tập test này.

## 8. Ví dụ định dạng

Các dòng dưới đây chỉ minh họa định dạng và không được đưa vào tập test.

```csv
text,label,hard,note
"mai 7h30 mình đón bạn ở cổng trường nhé",benign,0,
"ck giup m 200k di, toi tra, dang het tien mat",benign,1,"người quen, giọng thân mật, có yêu cầu chuyển tiền"
"Chi oi shop dang xa kho ao khoac giam 50% chi con 2 ngay ib em nhe",spam,0,
"anh oi em la nhan vien ngan hang, tai khoan anh bi khoa, anh doc giup em ma xac nhan vua gui ve may",scam,1,"hỏi OTP, văn phong thân thiện"
```
