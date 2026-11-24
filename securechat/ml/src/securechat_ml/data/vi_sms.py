"""Chuyển bộ SMS tiếng Việt công khai sang định dạng train_pool của pipeline tin nhắn.

Nguồn: trannguyenthaituan251209/vietnamese_sms_dataset (cột message_id,date,message,label; label 0/1).
Bộ này chỉ có 2 nhãn (0 = tin hợp lệ, 1 = lừa đảo/spam) nên được ánh xạ sang 3 nhãn của dự án
(benign/spam/scam) bằng luật. Các bước:

  1. Loại tin trùng sau chuẩn hóa (giữ tin đầu; tin trùng nhưng khác nhãn bị loại hết).
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

# Thông báo dịch vụ / quy định (cập nhật thuê bao, lịch khám, giao hàng): benign, nhưng đứng sau tag QC.
_NOTICE_PATTERNS = [
    r"\bthong tu 08\b",
    r"\b(?:xac thuc|cap nhat) thong tin\b",
    r"\bthue bao chinh chu\b",
    r"\bdinh danh\b",
    r"\bdon hang\b",
    r"\bgiao hang\b",
    r"\blich (?:kham|hen)\b",
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
    r"\bsoan\b.{0,60}\bgui\b",
    r"\bso luong co han\b",
    r"\bnhan ngay\b",
    r"\bdata\b",
    r"\bung (?:tien|data)\b",
    r"\bmua\b",
]
_PROMO_RE = re.compile("|".join(_PROMO_PATTERNS))
_QC_RE = re.compile(r"[\[(]qc[\])]")


def map_label(message: str, label: int | str) -> tuple[str, str]:
    """Trả về (nhãn 3 lớp, tên luật). `label` là nhãn gốc 0/1 của bộ SMS."""
    if int(label) == 1:
        return "scam", "label1"
    f = fold(message)
    if _QC_RE.search(f):
        return "spam", "tag_qc"
    if _TXN_RE.search(f):
        return "benign", "giao_dich_otp"
    if _NOTICE_RE.search(f):
        return "benign", "thong_bao"
    if _PROMO_RE.search(f):
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

_PHONE_CTX = re.compile(r"(?:thue bao|\btb|sdt|so dien thoai|sim|mang va|cho tb|tu tb|nhan vien|zalo|telegram|whatsapp|viber)\s*$")
_HOTLINE_CTX = re.compile(r"(?:\blh|lien he|cskh|tong dai|hotline|ho tro|bam goi|goi|chi tiet)\s*:?\s*$")
_SHORT_CTX = re.compile(r"(?:gui|soan[^.]{0,40}?)\s*$")
_ACCOUNT_CTX = re.compile(r"(?:stk|tai khoan|chuyen khoan|so tk|tk)\s*:?\s*$")
_OTP_CTX = re.compile(r"(?:otp|ma|code)\s*:?\s*$")
_ORDER_CTX = re.compile(r"(?:don hang|van don|ma don)\s*:?\s*$")
_DAY_CTX = re.compile(r"\bngay\s*$")
_YEAR_CTX = re.compile(r"(?:\bnam|nhiem ky|\bthang \d{1,2}/)\s*$")
_YEAR_RANGE_CTX = re.compile(r"\b20\d\d\s*-\s*$")
_LEGAL_AFTER = re.compile(r"^\s*/\s*(?:tt|nd|qd|ubnd|nq)")
_ZALO_CTX = re.compile(r"(?:zalo\.me|t\.me|wa\.me)/\s*$")


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


def _call_fee(rng: random.Random, accented: bool) -> str:
    v = rng.choice([200, 300, 500, 1000, 2000])
    return f"{v}{'đ/phút' if accented else 'd/phut'}"


def _time(rng: random.Random, before: str, accented: bool) -> str:
    clock_ctx = re.search(r"(?:\bluc|\bvao luc|\btu|\bden|\bden het|\blich)\s*$", before) is not None
    if clock_ctx and rng.random() < 0.8:
        h, m = rng.randint(0, 23), rng.choice([0, 15, 30, 45])
        return rng.choice([f"{h:02d}:{m:02d}", f"{h}h{m:02d}" if m else f"{h}h"])
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


def _name(rng: random.Random, accented: bool) -> str:
    n = f"{rng.choice(_HO)} {rng.choice(_DEM)} {rng.choice(_TEN)}"
    return n if accented else fold(n).title()


def _number(rng: random.Random, before_folded: str, after_folded: str) -> str:
    b = before_folded.rstrip()
    if _ZALO_CTX.search(b):
        return _mobile(rng)
    if b.endswith("nhiem ky"):
        return "2026"
    if _LEGAL_AFTER.search(after_folded) or _YEAR_CTX.search(b):
        return str(rng.choice([2024, 2025, 2026]))
    if _YEAR_RANGE_CTX.search(b):
        return str(rng.choice([2027, 2028, 2031]))
    if _ACCOUNT_CTX.search(b):
        return _digits(rng, rng.choice([9, 10, 12, 13]))
    if _OTP_CTX.search(b):
        return _digits(rng, rng.choice([4, 6, 6]))
    if _ORDER_CTX.search(b):
        return _digits(rng, rng.choice([8, 10, 12]))
    if _DAY_CTX.search(b):
        return f"{rng.randint(1, 28):02d}/{rng.randint(1, 12):02d}"
    if _SHORT_CTX.search(b) or (after_folded.lstrip().startswith("(") and re.search(r"(?:gui|soan)\b", b[-60:])):
        return rng.choice(_SHORTCODES)
    if _HOTLINE_CTX.search(b):
        return _hotline(rng)
    if _PHONE_CTX.search(b):
        return _mobile(rng)
    if after_folded.lstrip().startswith("(") or re.search(r"\b(?:lh|cskh)\b", b[-30:]):
        return _hotline(rng)
    return _digits(rng, rng.choice([3, 4, 5]))


def fill_tokens(text: str, rng: random.Random, scam: bool = False) -> str:
    """Thay từng token ẩn danh bằng giá trị giả theo ngữ cảnh xung quanh."""
    accented = has_diacritics(text)
    out: list[str] = []
    pos = 0
    folded_all = fold(text)
    for m in _ANON_RE.finditer(text):
        out.append(text[pos : m.start()])
        before = fold("".join(out))[-60:]
        after = fold(text[m.end() : m.end() + 20])
        kind = m.group(1)
        if kind == "MONEY":
            if before.rstrip().endswith("(") and after.lstrip().startswith(")") and not scam:
                out.append(_call_fee(rng, accented))
            else:
                out.append(_money(rng, folded_all, scam, accented))
        elif kind == "NUMBER":
            out.append(_number(rng, before, after))
        elif kind == "TIME":
            out.append(_time(rng, before, accented))
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
    ref, rule, label, text (đã thay token), original (bản gốc đã gộp khoảng trắng)."""
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

    d["key"] = d["original"].map(fold)
    nl = d.groupby("key")["orig_label"].nunique()
    in_conflict = d["key"].isin(set(nl[nl > 1].index))
    rep["conflict_dropped"] = int(in_conflict.sum())
    d = d[~in_conflict]
    n1 = len(d)
    d = d.drop_duplicates(subset="key", keep="first").reset_index(drop=True)
    rep["duplicates_dropped"] = n1 - len(d)

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
