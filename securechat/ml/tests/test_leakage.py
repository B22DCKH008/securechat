import pandas as pd
import pytest

from securechat_ml.data.messages import build_message_splits, dedupe_and_group, read_messages, validate_messages
from securechat_ml.data.splits import assert_disjoint, group_split
from securechat_ml.data.urls import build_url_splits, clean_urls, load_phiusiil, url_key

MSG_CFG = {
    "dedupe": {"near_dup_cosine": 0.85},
    "split": {"val_fraction": 0.2, "val_min_real": 20},
}


def test_group_split_keeps_groups_whole_and_is_deterministic():
    rows = [(f"g{i}", "a" if i % 3 else "b") for i in range(60) for _ in range(3)]
    df = pd.DataFrame(rows, columns=["g", "y"])
    s1 = group_split(df, "g", "y", {"train": 0.7, "val": 0.3}, 1)
    s2 = group_split(df, "g", "y", {"train": 0.7, "val": 0.3}, 1)
    assert set(s1["train"]["g"]).isdisjoint(set(s1["val"]["g"]))
    assert list(s1["val"]["g"]) == list(s2["val"]["g"])
    assert 0.2 <= len(s1["val"]) / len(df) <= 0.4
    assert s1["val"]["y"].nunique() == 2  # phân tầng: val có cả hai lớp


def test_assert_disjoint_raises_on_overlap():
    a = pd.DataFrame({"domain": ["x.com", "y.com"]})
    b = pd.DataFrame({"domain": ["y.com", "z.com"]})
    with pytest.raises(AssertionError, match="LEAKAGE"):
        assert_disjoint({"train": a, "test": b}, "domain")


def test_phiusiil_label_is_inverted(tmp_path):
    p = tmp_path / "p.csv"
    pd.DataFrame({"URL": ["https://a.com", "http://b.top/x"], "label": [1, 0]}).to_csv(p, index=False)
    cfg = {"phiusiil": {"url_col": "URL", "label_col": "label", "legit_value": 1}}
    df = load_phiusiil(p, cfg)
    assert df.set_index("url")["y"].to_dict() == {"https://a.com": 0, "http://b.top/x": 1}  # 1 = hợp lệ => y=0


def test_clean_urls_dedupes_and_drops_conflicts():
    df = pd.DataFrame({"url": ["https://www.a.com/", "http://a.com", "https://b.com/x", "https://b.com/x/"], "y": [0, 0, 0, 1]})
    out, info = clean_urls(df)
    assert url_key("https://www.a.com/") == url_key("http://a.com")
    assert len(out) == 1 and info["conflicting_labels_dropped"] == 1


def test_url_splits_are_domain_disjoint_and_train_overlap_is_dropped():
    rows = []
    for i in range(80):
        rows.append((f"https://d{i}.com/p", i % 2, "phiusiil", "", ""))
    pi = pd.DataFrame(rows, columns=["url", "y", "source", "tier", "split"])
    # PhishVN val/test chứa domain d1.com, d2.com (đã có trong PhiUSIIL) => phải bị loại khỏi train
    vn = pd.DataFrame(
        [("https://d1.com/z", 1, "phishvn", "gold", "validation"), ("https://d2.com/z", 0, "phishvn", "gold", "test"),
         ("https://new1.vn/z", 1, "phishvn", "gold", "train"), ("https://new2.vn/z", 0, "phishvn", "silver", "train"),
         ("https://v1.vn/z", 1, "phishvn", "gold", "validation"), ("https://v2.vn/z", 0, "phishvn", "gold", "validation"),
         ("https://t1.vn/z", 1, "phishvn", "gold", "test"), ("https://t2.vn/z", 0, "phishvn", "bronze", "test")],
        columns=["url", "y", "source", "tier", "split"],
    )
    pi, _ = clean_urls(pi)
    vn_c, _ = clean_urls(vn.assign(split=vn["split"].replace({"validation": "val"})))
    cfg = {"split": {"phiusiil_fractions": {"train": 0.8, "val_in": 0.1, "test_in": 0.1}}, "phishvn": {"eval_tiers": ["gold", "silver"], "train_tiers": ["gold", "silver"]}, "use_phishvn_train": True}
    sets, man = build_url_splits(pi, vn_c, cfg, 0)
    for k in ("val_in", "test_in", "val_cross", "test_cross"):
        assert set(sets["train"]["domain"]).isdisjoint(set(sets[k]["domain"])), k
    assert "d1.com" not in set(sets["train"]["domain"]) and "d2.com" not in set(sets["train"]["domain"])
    assert "t2.vn" not in set(sets["test_cross"]["domain"])  # bronze không vào test chéo miền


def _msgs(n_real=0, n_syn=0):
    rows = []
    for i in range(n_real):
        rows.append((f"tin thật số {i} hẹn gặp bạn lúc {i % 24} giờ tại quán cà phê số {i * 7}", "benign", "real", ""))
    for i in range(n_syn):
        lab = "scam" if i % 2 else "spam"
        rows.append((f"mẫu tổng hợp {lab} loại {i} nhận quà ngay {i * 13}", lab, "synthetic", f"tpl{i % 6}"))
    return pd.DataFrame(rows, columns=["text", "label", "source", "group"]).assign(hard=0, lang="vi")


def test_near_duplicates_share_group():
    df = pd.DataFrame({"text": ["Tài khoản của bạn bị khóa, truy cập ngay link này", "Tài khoản của bạn bị khóa, truy cập ngay link này!!", "Mai đi ăn phở không"],
                       "label": ["scam", "scam", "benign"], "source": "synthetic", "group": "", "hard": 0, "lang": "vi"})
    out, _ = dedupe_and_group(df, 0.8)
    g = dict(zip(out["text"], out["group_id"]))
    assert g["Tài khoản của bạn bị khóa, truy cập ngay link này"] == g["Tài khoản của bạn bị khóa, truy cập ngay link này!!"]
    assert g["Mai đi ăn phở không"] != g["Tài khoản của bạn bị khóa, truy cập ngay link này"]


def test_test_set_is_protected_from_train_near_duplicates():
    pool = _msgs(30, 60)
    leak = "mẫu tổng hợp scam loại 1 nhận quà ngay 13"  # trùng/gần giống một tin train
    hand = pd.DataFrame({"text": [leak, "Hôm nay trời đẹp quá"], "label": ["scam", "benign"], "hard": [0, 1], "source": "handlabeled", "group": "", "lang": "vi"})
    sets, man = build_message_splits(pool, hand, MSG_CFG, 0)
    train_norm = set(sets["train"]["text"].str.lower())
    assert leak.lower() not in train_norm
    assert man["train_rows_dropped_near_test"] >= 1


def test_synthetic_never_in_validation_when_enough_real():
    sets, man = build_message_splits(_msgs(60, 60), None, MSG_CFG, 0)
    assert man["validation_source"] == "real"
    assert set(sets["val"]["source"]) == {"real"}
    assert set(sets["val"]["group_id"]).isdisjoint(set(sets["train"]["group_id"]))


def test_few_real_triggers_warning():
    _, man = build_message_splits(_msgs(5, 60), None, MSG_CFG, 0)
    assert any("validation lẫn dữ liệu tổng hợp" in w for w in man["warnings"])
    assert any("KHÔNG có test" in w for w in man["warnings"])


def test_validate_messages_flags_errors():
    df = pd.DataFrame({"text": ["a", ""], "label": ["scam", "weird"], "source": ["real", "bogus"], "group": "", "hard": 0, "lang": "vi"})
    rep = validate_messages(df, ["benign", "spam", "scam"])
    assert len(rep["errors"]) >= 3


def test_read_messages_requires_columns(tmp_path):
    p = tmp_path / "m.csv"
    pd.DataFrame({"text": ["x"]}).to_csv(p, index=False)
    with pytest.raises(ValueError, match="thiếu cột"):
        read_messages(p)


def test_read_messages_accepts_excel_bom(tmp_path):
    p = tmp_path / "m.csv"
    p.write_bytes("text,label\nxin chào,benign\n".encode("utf-8-sig"))  # Excel/Windows hay thêm BOM
    assert list(read_messages(p).columns[:2]) == ["text", "label"]
