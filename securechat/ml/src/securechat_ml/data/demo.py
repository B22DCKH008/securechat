"""Dữ liệu DEMO tự sinh: CHỈ để thử đường ống end-to-end. Số đo trên đây KHÔNG có ý nghĩa gì.

Định dạng file khớp loader thật: PhiUSIIL (URL,label; 1 = hợp lệ) và một "PhishVN giả" (url,label,tier,split).
Tập test gán tay demo dùng câu chữ KHÁC template train (kiểm chứng chốt chặn leakage).
"""
from __future__ import annotations

import random
from pathlib import Path

import pandas as pd

_NAMES = ["Lan", "Nam", "Hà", "Tuấn", "Mai", "Khoa", "Linh", "Hùng"]
_FOODS = ["phở", "bún chả", "cơm tấm", "trà sữa", "bánh mì"]
_BANKS = ["Vietcombank", "Techcombank", "BIDV", "MBBank", "Agribank"]
_TLDS = ["top", "xyz", "icu", "click", "info"]


def _benign(r: random.Random) -> list[tuple[str, str]]:
    n, f, h = r.choice(_NAMES), r.choice(_FOODS), r.randint(7, 20)
    return [
        (f"Chiều nay {n} đi ăn {f} không?", "b1"),
        (f"Mai họp lúc {h} giờ nhé, nhớ mang tài liệu", "b2"),
        (f"Tối nay mình qua nhà {n} chơi nhé", "b3"),
        (f"Em đã nộp bài rồi ạ, thầy xem giúp em nhé ({h}h)", "b4"),
        (f"Cảm ơn {n} nhiều, hôm nay vui lắm", "b5"),
        (f"Cuối tuần này {n} có rảnh đi cà phê không", "b6"),
    ]


def _spam(r: random.Random) -> list[tuple[str, str]]:
    p = r.choice([10, 20, 30, 50])
    return [
        (f"[QC] Giảm giá {p}% toàn bộ sản phẩm, duy nhất hôm nay!", "s1"),
        (f"Ưu đãi lớn tháng này: mua 1 tặng 1, giảm tới {p}%. Soạn TC gửi 9029", "s2"),
        (f"(QC) Gói cước mới data khủng chỉ {p}k/tháng, đăng ký ngay", "s3"),
        (f"Sale sốc cuối năm giảm {p}% mọi đơn hàng, ghé cửa hàng hôm nay", "s4"),
    ]


def _scam(r: random.Random) -> list[tuple[str, str]]:
    b = r.choice(_BANKS)
    phone = "09" + "".join(r.choice("0123456789") for _ in range(8))
    u = f"https://{b.lower()}-xacminh.{r.choice(_TLDS)}/login"
    return [
        (f"Tài khoản {b} của bạn sẽ bị khóa, truy cập {u} để xác minh ngay", "c1"),
        (f"Công an thông báo bạn có lệnh triệu tập, liên hệ gấp {phone}", "c2"),
        (f"Việc nhẹ lương cao 500k/ngày, nhận hoa hồng, liên hệ zalo {phone}", "c3"),
        (f"Chúc mừng bạn trúng thưởng iPhone, bấm vào {u} nhận ngay", "c4"),
        (f"Vui lòng cung cấp mã OTP vừa gửi để hủy giao dịch lạ trên thẻ {b}", "c5"),
    ]


_HAND = [  # test gán tay DEMO: câu chữ khác hẳn template train
    ("Ngày mai bạn rảnh không, đi xem phim nhé", "benign", 0),
    ("Bố mẹ gửi quà cho con rồi nhé", "benign", 0),
    ("hom nay di hoc ve muon nhe", "benign", 1),
    ("Báo cáo tuần này em gửi trước thứ sáu ạ", "benign", 0),
    ("Nhóm mình họp online lúc 8 giờ tối nha", "benign", 0),
    ("Khuyến mãi cực lớn hôm nay duy nhất, giảm 70% tất cả mặt hàng", "spam", 0),
    ("khuyen mai hom nay giam 40% moi san pham, [QC]", "spam", 1),
    ("Ưu đãi đặc biệt cho thành viên, giảm tối đa 500k", "spam", 0),
    ("Sale lớn cuối tuần, mua 2 tặng 1", "spam", 0),
    ("Mã OTP của bạn bị lộ, hãy chia sẻ mật khẩu cho nhân viên để bảo vệ tài khoản", "scam", 0),
    ("tai khoan ngan hang cua ban bi tam khoa, bam vao https://bank-secure.top de mo", "scam", 1),
    ("Cơ quan điều tra yêu cầu bạn xác minh ngay, chuyển khoản gấp để phong tỏa", "scam", 0),
    ("Cộng tác viên tuyển gấp, lương cao, nhận hoa hồng liên hệ zalo", "scam", 0),
    ("dau tu loi nhuan cam ket gap doi moi ngay, nap tien ngay", "scam", 1),
]


def make_demo_messages(root: Path, seed: int = 7, n_rounds: int = 60) -> dict:
    r = random.Random(seed)
    rows = []
    for i in range(n_rounds):
        for text, tpl in _benign(r):
            rows.append((text, "benign", "synthetic", tpl))
        for text, tpl in _spam(r):
            rows.append((text, "spam", "synthetic", tpl))
        for text, tpl in _scam(r):
            rows.append((text, "scam", "synthetic", tpl))
    # một ít tin "real" giả để kiểm đường validation (vẫn là dữ liệu demo)
    for i in range(40):
        rows.append((f"Tin demo thật số {i}: hẹn gặp {r.choice(_NAMES)} lúc {r.randint(6, 21)} giờ", "benign", "real", ""))
    df = pd.DataFrame(rows, columns=["text", "label", "source", "group"])
    raw = root / "data" / "demo" / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    df.to_csv(raw / "messages_train_pool.csv", index=False, encoding="utf-8")
    pd.DataFrame(_HAND, columns=["text", "label", "hard"]).to_csv(raw / "messages_handlabeled.csv", index=False, encoding="utf-8")
    return {"train_pool": len(df), "handlabeled": len(_HAND)}


def _rand_word(r: random.Random, lo=4, hi=10) -> str:
    return "".join(r.choice("abcdefghijklmnopqrstuvwxyz") for _ in range(r.randint(lo, hi)))


def _benign_url(r: random.Random) -> str:
    d = _rand_word(r) + r.choice([".com", ".vn", ".com.vn", ".org", ".net"])
    path = "/".join(_rand_word(r, 3, 8) for _ in range(r.randint(0, 3)))
    return f"https://www.{d}/{path}"


def _bad_url(r: random.Random) -> str:
    brand = r.choice(["vietcombank", "momo", "shopee", "paypal", "bidv", "zalopay"])
    kind = r.randint(0, 3)
    if kind == 0:
        return f"http://{brand}.{_rand_word(r)}-xacminh.{r.choice(_TLDS)}/login.php?id={r.randint(1000, 99999)}"
    if kind == 1:
        return f"http://{r.randint(11, 220)}.{r.randint(0, 255)}.{r.randint(0, 255)}.{r.randint(1, 254)}/{brand}/verify/{_rand_word(r)}"
    if kind == 2:
        return f"https://{brand}-{_rand_word(r)}.{r.choice(_TLDS)}/secure/update-account?token={_rand_word(r, 12, 20)}"
    return f"https://bit.ly/{_rand_word(r, 6, 8)}"


def make_demo_urls(root: Path, seed: int = 11, n: int = 1500) -> dict:
    r = random.Random(seed)
    raw = root / "data" / "demo" / "raw"
    (raw / "phishvn").mkdir(parents=True, exist_ok=True)
    rows = [(_benign_url(r), 1) for _ in range(n)] + [(_bad_url(r), 0) for _ in range(n)]
    r.shuffle(rows)
    pd.DataFrame({"FILENAME": [f"{i}.txt" for i in range(len(rows))], "URL": [u for u, _ in rows], "label": [l for _, l in rows]}).to_csv(raw / "PhiUSIIL_Phishing_URL_Dataset.csv", index=False)
    vn = []
    for i in range(600):
        split = r.choice(["train", "train", "train", "validation", "test"])
        if r.random() < 0.5:
            vn.append((_benign_url(r).replace("https://www.", "https://"), "legitimate", r.choice(["gold", "silver"]), split))
        else:
            vn.append((_bad_url(r), "phishing", r.choice(["gold", "silver", "bronze"]), split))
    pd.DataFrame(vn, columns=["url", "label", "label_confidence", "split"]).to_csv(raw / "phishvn" / "phishvn.csv", index=False)
    return {"phiusiil": len(rows), "phishvn": len(vn)}
