"""Chuyển bộ SMS tiếng Việt công khai sang định dạng train_pool của pipeline tin nhắn.

Nguồn: trannguyenthaituan251209/vietnamese_sms_dataset (cột message_id,date,message,label; label 0/1).
Bộ này chỉ có 2 nhãn (0 = tin hợp lệ, 1 = lừa đảo/spam) nên được ánh xạ sang 3 nhãn của dự án
(benign/spam/scam) bằng luật. Các bước:

  1. Loại tin không phải tiếng Việt (mã xác thực bằng tiếng Anh), tin trùng sau chuẩn hóa (giữ tin đầu;
     tin trùng nhưng khác nhãn bị loại hết), rồi che các thông tin cá nhân còn sót (email, tên viết hoa
     sau "Quy khach", mã tài khoản dịch vụ có chứa tên).
  2. Gán nhãn: label 1 -> scam; label 0 -> spam nếu là tin quảng cáo của nhà mạng, ngược lại benign.
  3. Thay token ẩn danh ([MONEY], [NUMBER], [TIME]...) bằng giá trị giả, sinh theo ngữ cảnh và
     cố định theo message_id (chạy lại cho cùng kết quả). Nếu để nguyên, model sẽ học "có [NUMBER]"
     thay vì học nội dung.
  4. Áp file overrides (message_id,label) nếu có, để sửa tay các nhãn luật gán sai.

Luật chỉ là xấp xỉ: ranh giới giữa tin quảng cáo và tin dịch vụ không rõ ràng. Hàm `review_sample`
trích mẫu kèm tên luật để kiểm tra bằng mắt trước khi train.
"""
from __future__ import annotations

import random
import re
import unicodedata
from typing import Iterable

import pandas as pd

LABELS = ("benign", "spam", "scam")

# Tag nhà mạng/thương hiệu giữ nguyên (là chữ thật trong tin), chỉ thay các token ẩn danh bên dưới.
_ANON_RE = re.compile(r"\[(MONEY|NUMBER|TIME|DATE|POINT|NAME|URL)\]")
_COMBINING_RE = re.compile("[̀-ͯ]")
_WS_RE = re.compile(r"\s+")


def fold(s: str) -> str:
    """Chữ thường, bỏ dấu, đ -> d. Chỉ dùng để so khớp luật, không dùng làm text cuối."""
    s = unicodedata.normalize("NFD", s.lower())
    s = _COMBINING_RE.sub("", s)
    return s.replace("đ", "d")


def has_diacritics(s: str) -> bool:
    return fold(s) != s.lower()


# --------------------------------------------------------------------------- gán nhãn

# Tin OTP / giao dịch ngân hàng / vận đơn: luôn benign, kể cả khi có từ khóa khuyến mại.
_TXN_PATTERNS = [
    r"\botp\b",
    r"\bma (?:xac thuc|xac minh|kich hoat|dang nhap)\b",
    r"\bso du\b",
    r"\bgd:",
    r"\bbien dong\b",
    r"\b(?:ma|so) (?:van don|don hang)\b",
    r"\bnguoi nhan:",
]
_TXN_RE = re.compile("|".join(_TXN_PATTERNS))

# Phản hồi trạng thái dịch vụ (đăng ký/hủy/gia hạn thành công hay không, cú pháp sai): benign.
_STATUS_PATTERNS = [
    r"\bkhong thanh cong\b",
    r"\bda ket thuc\b",
    r"\bda huy\b",
    r"\bhuy gia han\b",
    r"\bse gia han\b",
    r"\b(?:dang ky|huy|gia han) thanh cong\b",
    r"\bkhong hop le\b",
    r"\bkhong ap dung cho\b",
]
_STATUS_RE = re.compile("|".join(_STATUS_PATTERNS))

# Cú pháp "soạn ... gửi ...". Lời mời đăng ký/nhận ưu đãi là spam, kể cả khi mở đầu bằng câu thông báo
# ("khi đăng ký thành công ..."). Cú pháp tiện ích (hủy, tra cứu, khóa, từ chối quảng cáo) thì không tính.
_SOANGUI_ITEM = re.compile(r"\bsoan(?:\s+tin(?:\s+nhan)?)?[:\s]+\"?([^.]{0,60}?)\"?\s*,?\s*\bgui\b")
_SOANGUI_UTIL = re.compile(r"huy\w*|kt\w*|data\w*|khoa|tc(?:qc|\d{0,2})|hd|tracuu")


def _has_promo_syntax(f: str) -> bool:
    for span in _SOANGUI_ITEM.findall(f):
        words = re.findall(r"[a-z0-9_]+|\[number\]", span)
        if not words or any(_SOANGUI_UTIL.fullmatch(w) for w in words):
            continue
        if words in (["y"], ["n"]) and re.search(r"\bhuy\b", f):  # "soạn Y gửi 191" xác nhận hủy, "soạn N gửi 191" từ chối hủy
            continue
        return True
    return False


# Thông báo dịch vụ / quy định (cập nhật thuê bao, lịch khám, giao hàng): benign, nhưng đứng sau tag QC.
_NOTICE_PATTERNS = [
    r"\bthong tu 08\b",
    r"\b(?:xac thuc|cap nhat) thong tin\b",
    r"\bthue bao chinh chu\b",
    r"\bdinh danh\b",
    r"\bdon hang\b",
    r"\bgiao hang\b",
    r"\blich (?:kham|hen)\b",
    r"\bthoi tiet\b",
    r"\bdoi thanh cong\b.{0,40}viettel\+\+",  # thông báo đổi/cộng điểm tích lũy (lời nhắc "đừng quên đổi điểm" vẫn là quảng cáo)
    r"\bduoc cong them\b.{0,30}viettel\+\+",
]
_NOTICE_RE = re.compile("|".join(_NOTICE_PATTERNS))

# Quảng cáo / chào bán dịch vụ của nhà mạng và đơn vị khác.
_PROMO_PATTERNS = [
    r"\bkhuyen mai\b",
    r"\bkm\b",
    r"\buu dai\b",
    r"\bgiam (?:\d|gia|ngay|den|toi)",
    r"\bmien phi\b",
    r"\btang\b",
    r"\bqua tang\b",
    r"\bvoucher\b",
    r"\bcombo\b",
    r"\bgoi cuoc\b",
    r"\bnap the\b",
    r"\bdang ky\b",
    r"\bso luong co han\b",
    r"\bnhan ngay\b",
    r"\bdata\b",
    r"\bung (?:tien|data)\b",
]
_PROMO_RE = re.compile("|".join(_PROMO_PATTERNS))
# Tag [QC]/(QC), hoặc tin có kèm cách từ chối quảng cáo (tự nó đã là tin quảng cáo).
_QC_RE = re.compile(r"[\[(]qc[\])]|\btu choi (?:qc|quang cao|nhan)\b|\btcqc\b")
# "mua" (mua hàng) xét trên chữ gốc: sau khi bỏ dấu, "mưa" và "mùa" cũng thành "mua". "mua bán người" không phải khuyến mại.
_MUA_RE = re.compile(r"\bmua\b(?!\s+b[aá]n\b)")


def map_label(message: str, label: int | str) -> tuple[str, str]:
    """Trả về (nhãn 3 lớp, tên luật). `label` là nhãn gốc 0/1 của bộ SMS."""
    if int(label) == 1:
        return "scam", "label1"
    f = fold(message)
    if _QC_RE.search(f):
        return "spam", "tag_qc"
    if _TXN_RE.search(f):
        return "benign", "giao_dich_otp"
    if _has_promo_syntax(f):
        return "spam", "soan_gui"
    if _STATUS_RE.search(f):
        return "benign", "trang_thai_dv"
    if _NOTICE_RE.search(f):
        return "benign", "thong_bao"
    if _PROMO_RE.search(f) or _MUA_RE.search(unicodedata.normalize("NFC", message).lower()):
        return "spam", "tu_khoa_qc"
    return "benign", "mac_dinh"


# --------------------------------------------------------------------------- thay token ẩn danh

_HO = ["Nguyễn", "Trần", "Lê", "Phạm", "Hoàng", "Huỳnh", "Phan", "Vũ", "Võ", "Đặng", "Bùi", "Đỗ", "Hồ", "Ngô", "Dương", "Lý"]
_DEM = ["Văn", "Thị", "Minh", "Hữu", "Ngọc", "Thanh", "Quốc", "Đức", "Anh", "Thu", "Hoài", "Gia"]
_TEN = [
    "An", "Anh", "Bình", "Châu", "Dũng", "Dung", "Giang", "Hà", "Hải", "Hạnh", "Hiếu", "Hoa", "Hùng", "Huy", "Khánh",
    "Lan", "Linh", "Long", "Mai", "Nam", "Ngân", "Nhung", "Phong", "Phương", "Quân", "Quỳnh", "Sơn", "Thảo", "Trang",
    "Trung", "Tú", "Tuấn", "Vân", "Việt", "Yến",
]
_SHORTCODES = ["191", "999", "888", "1515", "9029", "6789", "9199", "1560", "5090", "8149", "9166", "1227"]
_MOBILE_PREFIX = ["090", "093", "089", "070", "079", "077", "076", "078", "091", "094", "088", "081", "082", "083", "084", "085", "086", "096", "097", "098", "032", "033", "034", "035", "036", "037", "038", "039"]
_URLS = ["https://bit.ly/3xK9aQ2", "https://tinyurl.com/yc8m3n5p", "http://s.id/vnq7Lk", "https://cutt.ly/dTb4Re1"]

_SMALL_MONEY = [1000, 2000, 3000, 5000, 10000, 15000, 20000, 25000, 30000, 50000, 70000, 90000, 100000]
_MID_MONEY = [50000, 100000, 150000, 200000, 300000, 500000, 700000, 1000000, 2000000]
_BIG_MONEY = [5_000_000, 8_000_000, 10_000_000, 20_000_000, 30_000_000, 50_000_000, 100_000_000, 500_000_000]
_BIG_MONEY_KW = re.compile(r"\b(luong|thu nhap|hoa hong|trung thuong|thuong|hoan tien|von|vay|lai suat|dau tu|tien thuong)\b")
_MID_MONEY_KW = re.compile(r"\b(nap|the|goi|voucher|giam|khuyen mai|so du|giao dich|cuoc|thanh toan|qua)\b")

_PHONE_CTX = re.compile(r"(?:thue bao|\btb|sdt|so dien thoai|sim|mang va|cho tb|tu tb|nhan vien|zalo|telegram|whatsapp|viber|tien di dong|so thue bao|cho ban:)\s*$")
_HOTLINE_CTX = re.compile(
    r"(?:\blh|lien he|cskh|tong dai|hotline|ho tro|bam goi|goi\s+(?:ngay|gap|dien|toi|den|vao)|chi tiet|dat lich hen)\s*:?\s*$"
)
_SHORT_CTX = re.compile(r"(?:gui|soan[^.]{0,40}?)\s*$")
_ACCOUNT_CTX = re.compile(r"(?:stk|tai khoan(?: la)?|chuyen khoan|so tk|\btk(?: thanh toan)?|nguoi nhan)\s*:?\s*[-•]?\s*$")
_BANK_AFTER = re.compile(
    r"^(?:tai|o)\s+(?:ngan hang|vietinbank|vietcombank|agribank|bidv|mbbank|mb bank|techcombank|vpbank|acb|sacombank|tpbank|kho bac)"
)
_OTP_CTX = re.compile(r"(?:otp|ma|code)\s*:?\s*$")
_ORDER_CTX = re.compile(r"(?:don hang|van don|ma don|hop dong|ma ho so|ten dang nhap)\s*:?\s*$")
_DAY_CTX = re.compile(r"\b(?:vao|truoc|den|tu|het)\s+ngay\s*$")
_YEAR_CTX = re.compile(r"(?:\bnam|nam moi|nhiem ky|\bthang \d{1,2}/|\bcup)\s*$")
_YEAR_RANGE_CTX = re.compile(r"\b20\d\d\s*-\s*$")
_LEGAL_AFTER = re.compile(r"^\s*/\s*(?:tt|nd|qd|ubnd|nq)")
_ZALO_CTX = re.compile(r"(?:zalo\.me|t\.me|wa\.me)/\s*$")
_KM_AFTER = re.compile(r"^(?:km|kilomet)\b")
_SYNTAX_BEFORE = re.compile(r"\bsoan(?:\s+tin)?\s*:?\s*$")
# "TV360" bị ẩn danh nguyên cả cụm thành [NUMBER]: "xem phim trên [NUMBER]", "gói cước [NUMBER] Standard".
_TV_BEFORE = re.compile(r"(?:\bxem|\btren|goi cuoc|mien phi)\s*$")
_TV_AFTER = re.compile(r"^(?:[.,;!:)]|$|standard\b|theo\b|khong\b|tai\b|de\b|voi\b|va\b)")
_SYNTAX_CODES = ["SD70", "ST30K", "SD90", "V120B", "MXH100", "ST15K", "DK1", "D60", "TV95K"]
_OTP_MSG_RE = re.compile(r"\botp\b|ma xac (?:thuc|minh)|xac thuc 2 yeu to|verification|activation")

# Ngữ cảnh của [TIME]: giờ trong ngày (có ngày đi kèm, khoảng giờ, "lúc ...") hay khoảng thời gian.
_CLOCK_BEFORE = re.compile(r"(?:(?<!hieu )\bluc|\bhen)\s*$")
_CLOCK_PREV = re.compile(r"\d{1,2}(?::\d{2}|h\d{0,2})\s*(?:-|den)\s*$")
_AFTER_DATE = re.compile(r"\d{1,2}/\d{1,2}(?:/\d{2,4})?\s*$")
_CLOCK_AFTER = re.compile(
    r"^\s*(?:(?:-|den)\s*(?:\[time\]|\d{1,2}(?::\d{2}|h\d{0,2}))|(?:ngay\s+)?(?:\[date\]|\d{1,2}/\d{1,2})|hom nay)"
)
_CLOCK_UNTIL = re.compile(r"\bden\s*$")
_REG_DAY_AFTER = re.compile(r"^\s*ngay\s+(?:dang ky|kich hoat)")
_AROUND_BEFORE = re.compile(r"\b(?:chieu|sang|toi|trua)\b.{0,15}\btam\s*$")
_MINUTES_AFTER = re.compile(r"^\s*(?:(?:noi|ngoai|lien) mang)")
_MINUTES_BEFORE = re.compile(r"\bcuoc goi duoi\s*$")
_SMS_FEE_CTX = re.compile(r"(?:gui|soan)\b[^()]{0,40}\(\s*$")


def _digits(rng: random.Random, n: int, first_nonzero: bool = True) -> str:
    s = "".join(rng.choice("0123456789") for _ in range(n))
    if first_nonzero and s[0] == "0":
        s = str(rng.randint(1, 9)) + s[1:]
    return s


def _mobile(rng: random.Random) -> str:
    return rng.choice(_MOBILE_PREFIX) + _digits(rng, 7, first_nonzero=False)


def _hotline(rng: random.Random) -> str:
    r = rng.random()
    if r < 0.4:
        return "1800" + _digits(rng, 4)
    if r < 0.7:
        return _mobile(rng)
    return rng.choice(["198", "18001090", "1900" + _digits(rng, 4), "19001234"])


def _money(rng: random.Random, folded_text: str, scam: bool, accented: bool) -> str:
    if scam and _BIG_MONEY_KW.search(folded_text):
        v = rng.choice(_BIG_MONEY if rng.random() < 0.6 else _MID_MONEY)
    elif _MID_MONEY_KW.search(folded_text) and rng.random() < 0.6:
        v = rng.choice(_MID_MONEY)
    else:
        v = rng.choice(_SMALL_MONEY)
    dotted = f"{v:,}".replace(",", ".")
    unit = "đ" if accented else "d"
    forms = [f"{dotted}{unit}", f"{dotted}{unit}", f"{v}{unit}", f"{dotted} VND"]
    if v % 1000 == 0 and v < 1_000_000:
        forms += [f"{v // 1000}k", f"{v // 1000}K"]
    if v >= 1_000_000 and v % 1_000_000 == 0:
        forms += [f"{v // 1_000_000} triệu" if accented else f"{v // 1_000_000} trieu"]
    return rng.choice(forms)


def _fee(rng: random.Random, accented: bool, values: list[int], suffix: str = "") -> str:
    """Cước gọi hoặc cước tin nhắn trong ngoặc, ví dụ (500đ/phút), (1000đ/tin)."""
    v = rng.choice(values)
    return f"{v}{'đ' if accented else 'd'}{suffix}"


def _time(rng: random.Random, before: str, after: str, accented: bool, otp_msg: bool) -> str:
    b = before.rstrip()
    clock = bool(
        _CLOCK_BEFORE.search(before)
        or _CLOCK_PREV.search(before)
        or _AFTER_DATE.search(before)
        or _CLOCK_AFTER.search(after)
        or _AROUND_BEFORE.search(b) and after.lstrip().startswith("tro")
        or _CLOCK_UNTIL.search(b) and _REG_DAY_AFTER.search(after)
    )
    if clock:
        if _CLOCK_UNTIL.search(b) and _REG_DAY_AFTER.search(after):
            return rng.choice(["23h59", "23:59", "24h"])
        # đầu khoảng giờ ("từ [TIME] - 17h30") phải sớm hơn cuối khoảng
        h, m = rng.randint(6, 10) if re.match(r"^\s*-\s*\d", after) else rng.randint(6, 22), rng.choice([0, 15, 30, 45])
        return rng.choice([f"{h:02d}:{m:02d}", f"{h}h{m:02d}" if m else f"{h}h", f"{h}:{m:02d}"])
    if _MINUTES_AFTER.search(after) or _MINUTES_BEFORE.search(b):
        n = rng.choice([10, 15, 20, 30, 50, 100, 200])
        return f"{n}p" if rng.random() < 0.25 else f"{n} {'phút' if accented else 'phut'}"
    if otp_msg:
        n = rng.choice([1, 2, 3, 5, 5, 10])
        return f"{n}p" if rng.random() < 0.2 else f"{n} {'phút' if accented else 'phut'}"
    if after.lstrip().startswith("ngay"):
        return str(rng.choice([1, 2, 3, 7, 15, 30]))
    n, unit = rng.choice([(24, "h"), (1, "h"), (30, " phút"), (3, " ngày"), (7, " ngày"), (15, " ngày"), (30, " ngày"), (1, " tháng"), (2, " giờ")])
    if not accented:
        unit = {" phút": " phut", " ngày": " ngay", " tháng": " thang", " giờ": " gio"}.get(unit, unit)
    return f"{n}{unit}"


def _date(rng: random.Random) -> str:
    d, m = rng.randint(1, 28), rng.randint(1, 12)
    return rng.choice([f"{d:02d}/{m:02d}/{rng.choice([2025, 2026])}", f"{d:02d}/{m:02d}", f"{d}/{m}/{rng.choice([2025, 2026])}"])


def _point(rng: random.Random) -> str:
    if rng.random() < 0.5:
        return str(rng.choice([5, 10, 20, 50, 100, 150, 200, 500]))
    n = rng.randint(100, 9999)
    return f"{n:,}".replace(",", ".")


def _person(rng: random.Random) -> str:
    return f"{rng.choice(_HO)} {rng.choice(_DEM)} {rng.choice(_TEN)}"


def _name(rng: random.Random, accented: bool) -> str:
    n = _person(rng)
    return n if accented else fold(n).title()


def _number(rng: random.Random, before_folded: str, after_folded: str, otp_msg: bool = False) -> str:
    b = before_folded.rstrip()
    a = after_folded.lstrip()
    if _ZALO_CTX.search(b):
        return _mobile(rng)
    if b.endswith("nhiem ky"):
        return "2026"
    if _LEGAL_AFTER.search(after_folded) or _YEAR_CTX.search(b):
        return str(rng.choice([2024, 2025, 2026]))
    if _YEAR_RANGE_CTX.search(b):
        return str(rng.choice([2027, 2028, 2031]))
    if _ACCOUNT_CTX.search(b) or _BANK_AFTER.search(a):
        return _digits(rng, rng.choice([9, 10, 12, 13]))
    if _OTP_CTX.search(b):
        return _digits(rng, rng.choice([4, 6, 6]))
    if _ORDER_CTX.search(b):
        return _digits(rng, rng.choice([8, 10, 12]))
    if re.search(r"\bluc\s*$", b) and a.startswith("[time]"):
        return f"{rng.randint(1, 28):02d}/{rng.randint(1, 12):02d}"
    if _SYNTAX_BEFORE.search(b) and a.startswith("gui"):
        return rng.choice(_SYNTAX_CODES)
    if _TV_BEFORE.search(b) and _TV_AFTER.search(a):
        return "TV360"
    if _KM_AFTER.search(a):
        return str(rng.randint(2, 50))
    if _SHORT_CTX.search(b) or (a.startswith("(") and re.search(r"(?:gui|soan)\b", b[-60:])):
        return rng.choice(_SHORTCODES)
    if _HOTLINE_CTX.search(b):
        return _hotline(rng)
    if _PHONE_CTX.search(b):
        return _mobile(rng)
    if _DAY_CTX.search(b):
        return f"{rng.randint(1, 28):02d}/{rng.randint(1, 12):02d}"
    if a.startswith("(") or re.search(r"\b(?:lh|cskh)\b", b[-30:]):
        return _hotline(rng)
    if otp_msg:
        return _digits(rng, rng.choice([4, 6, 6]))
    return _digits(rng, rng.choice([3, 4, 5]))


def fill_tokens(text: str, rng: random.Random, scam: bool = False) -> str:
    """Thay từng token ẩn danh bằng giá trị giả theo ngữ cảnh xung quanh."""
    accented = has_diacritics(text)
    out: list[str] = []
    pos = 0
    folded_all = fold(text)
    otp_msg = _OTP_MSG_RE.search(folded_all) is not None
    for m in _ANON_RE.finditer(text):
        out.append(text[pos : m.start()])
        before = fold("".join(out))[-60:]
        after = fold(text[m.end() : m.end() + 20])
        kind = m.group(1)
        if kind == "MONEY":
            b, a = before.rstrip(), after.lstrip()
            if b.endswith("(") and re.match(r"/(?:tin|sms)\b", a):
                out.append(_fee(rng, accented, [500, 1000, 2000, 3000, 5000, 10000, 15000]))
            elif b.endswith("(") and a.startswith("/p"):
                out.append(_fee(rng, accented, [200, 300, 500, 1000, 2000]))
            elif b.endswith("(") and a.startswith(")"):
                if _SMS_FEE_CTX.search(b):
                    out.append(_fee(rng, accented, [500, 1000, 2000, 3000, 5000, 10000, 15000], "/tin"))
                else:
                    out.append(_fee(rng, accented, [200, 300, 500, 1000, 2000], "/phút" if accented else "/phut"))
            else:
                out.append(_money(rng, folded_all, scam, accented))
        elif kind == "NUMBER":
            out.append(_number(rng, before, after, otp_msg))
        elif kind == "TIME":
            out.append(_time(rng, before, after, accented, otp_msg))
        elif kind == "DATE":
            out.append(_date(rng))
        elif kind == "POINT":
            out.append(_digits(rng, 3, first_nonzero=False) if re.search(r"\d\.$", before) else _point(rng))
        elif kind == "NAME":
            out.append(_name(rng, accented))
        else:  # URL
            out.append(rng.choice(_URLS))
        pos = m.end()
    out.append(text[pos:])
    return "".join(out)


# --------------------------------------------------------------------------- lọc ngôn ngữ và che thông tin cá nhân

_EN_RE = re.compile(r"\b(?:is your|your|verification|code|do not share|don't share|expires|activation|thank you|please|login|password)\b")
_VI_RE = re.compile(r"\b(?:quy khach|ban|cua|va|de|khong|duoc|la|tai|cho|voi|nhan|goi|tin|thue bao|vui long|xin|cam on|trong|ma|xac|nhap)\b")
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_UPPER_NAME_RE = re.compile(r"(Quy khach\s+)((?:[A-ZĐ]{2,}\s+){1,3}[A-ZĐ]{2,})(?=\s+(?:ma|da|co|dang)\b)")
_ACCOUNT_ID_RE = re.compile(r"\b([a-z]\d{3}_[a-z]+_)[a-z]+\d*\b")


def is_english(message: str) -> bool:
    """Tin chỉ có tiếng Anh (thường là mã xác thực của dịch vụ nước ngoài): có từ khóa tiếng Anh và không có từ tiếng Việt."""
    f = fold(message)
    return _EN_RE.search(f) is not None and _VI_RE.search(f) is None


def scrub_pii(text: str, rng: random.Random) -> str:
    """Che thông tin cá nhân còn sót trong bộ gốc: email, tên viết hoa sau "Quy khach", mã tài khoản dịch vụ có chứa tên."""

    def handle() -> str:
        return fold(rng.choice(_TEN)).replace(" ", "")

    text = _EMAIL_RE.sub(lambda m: f"{handle()}{rng.randint(10, 99)}@gmail.com", text)
    text = _UPPER_NAME_RE.sub(lambda m: m.group(1) + fold(_person(rng)).upper(), text)
    text = _ACCOUNT_ID_RE.sub(lambda m: m.group(1) + handle() + str(rng.randint(10, 99)), text)
    return text


# --------------------------------------------------------------------------- toàn bộ quy trình

def clean_text(s: str) -> str:
    return _WS_RE.sub(" ", str(s)).strip()


def import_sms(
    df: pd.DataFrame,
    overrides: dict[str, str] | None = None,
    seed: int = 42,
    id_col: str = "message_id",
    text_col: str = "message",
    label_col: str = "label",
) -> tuple[pd.DataFrame, dict]:
    """Trả về (bảng chi tiết, báo cáo). Bảng chi tiết có đủ cột để ghi file train và file review:
    ref, rule, label, text (đã thay token), original (bản gốc đã gộp khoảng trắng và che thông tin cá nhân)."""
    overrides = overrides or {}
    bad = sorted({v for v in overrides.values() if v not in LABELS})
    if bad:
        raise ValueError(f"overrides có nhãn không hợp lệ {bad}; cho phép {list(LABELS)}")
    need = [id_col, text_col, label_col]
    miss = [c for c in need if c not in df.columns]
    if miss:
        raise ValueError(f"Thiếu cột {miss}")

    rep: dict = {"input": int(len(df))}
    d = df[need].copy()
    d.columns = ["ref", "original", "orig_label"]
    d["original"] = d["original"].map(clean_text)
    d = d[d["original"] != ""]
    rep["empty_dropped"] = rep["input"] - int(len(d))

    en = d["original"].map(is_english)
    rep["english_dropped"] = int(en.sum())
    d = d[~en]

    d["key"] = d["original"].map(fold)
    nl = d.groupby("key")["orig_label"].nunique()
    in_conflict = d["key"].isin(set(nl[nl > 1].index))
    rep["conflict_dropped"] = int(in_conflict.sum())
    d = d[~in_conflict]
    n1 = len(d)
    d = d.drop_duplicates(subset="key", keep="first").reset_index(drop=True)
    rep["duplicates_dropped"] = n1 - len(d)

    scrubbed = [scrub_pii(t, random.Random(f"{seed}:{ref}:pii")) for t, ref in zip(d["original"], d["ref"])]
    rep["pii_scrubbed"] = int(sum(a != b for a, b in zip(scrubbed, d["original"])))
    d["original"] = scrubbed

    labs, rules = [], []
    for msg, lb in zip(d["original"], d["orig_label"]):
        a, r = map_label(msg, lb)
        labs.append(a)
        rules.append(r)
    d["label"], d["rule"] = labs, rules
    applied = 0
    for i, ref in enumerate(d["ref"]):
        if ref in overrides and overrides[ref] != d.at[i, "label"]:
            d.at[i, "label"], d.at[i, "rule"] = overrides[ref], "override"
            applied += 1
    rep["overrides_applied"] = applied
    unknown_ref = sorted(set(overrides) - set(d["ref"]))
    if unknown_ref:
        rep["overrides_unknown_ref"] = unknown_ref

    d["text"] = [
        fill_tokens(t, random.Random(f"{seed}:{ref}"), scam=(lb == "scam"))
        for t, ref, lb in zip(d["original"], d["ref"], d["label"])
    ]
    rep["kept"] = int(len(d))
    rep["label_counts"] = {k: int(v) for k, v in d["label"].value_counts().items()}
    rep["rule_counts"] = {k: int(v) for k, v in d["rule"].value_counts().items()}
    left = int(d["text"].map(lambda t: _ANON_RE.search(t) is not None).sum())
    rep["rows_with_leftover_tokens"] = left
    return d, rep


def to_pool(d: pd.DataFrame) -> pd.DataFrame:
    """Định dạng train_pool: text,label,source,group,lang."""
    return pd.DataFrame({"text": d["text"], "label": d["label"], "source": "real", "group": "", "lang": "vi"})


def review_sample(d: pd.DataFrame, per_rule: int = 25, seed: int = 42, rules: Iterable[str] | None = None) -> pd.DataFrame:
    """Mẫu phân tầng theo (label, rule) để người xem kiểm tra luật. Cột `check` để người xem điền."""
    parts = []
    for (lb, rule), g in d.groupby(["label", "rule"]):
        if rules is not None and rule not in rules:
            continue
        parts.append(g.sample(min(per_rule, len(g)), random_state=seed))
    out = pd.concat(parts) if parts else d.head(0)
    out = out[["ref", "label", "rule", "original", "text"]].sort_values(["label", "rule", "ref"]).reset_index(drop=True)
    out["check"] = ""
    return out
