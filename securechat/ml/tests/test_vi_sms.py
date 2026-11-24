import importlib.util
import random
import re
from pathlib import Path

import pandas as pd
import pytest

from securechat_ml.data import vi_sms
from securechat_ml.data.messages import dedupe_and_group, read_messages, validate_messages

ROOT = Path(__file__).resolve().parents[1]
LABELS = ["benign", "spam", "scam"]


def _fill(text, seed="1", scam=False):
    return vi_sms.fill_tokens(text, random.Random(seed), scam=scam)


# ---------------------------------------------------------------- gán nhãn

def test_fold_strips_diacritics_and_d():
    assert vi_sms.fold("Đăng ký ƯU ĐÃI") == "dang ky uu dai"
    assert vi_sms.has_diacritics("Quý khách") and not vi_sms.has_diacritics("Quy khach")


@pytest.mark.parametrize(
    "msg,label,expected",
    [
        ("Bạn trúng thưởng, truy cập link để nhận", 1, ("scam", "label1")),
        ("Ma OTP xac thuc GD la 066595, hieu luc 5 phut", 0, ("benign", "giao_dich_otp")),
        ("123456 là mã xác thực OTP đăng nhập ví", 0, ("benign", "giao_dich_otp")),
        ("[QC] Tặng 10GB data khi soạn DK gửi 191", 0, ("spam", "tag_qc")),
        ("(QC) Chuc mung TB duoc MIEN PHI 4G", 0, ("spam", "tag_qc")),
        ("[TB] Dung quen voucher giam 50% khi mua Data", 0, ("spam", "tu_khoa_qc")),
        ("Soan DK gui 888 de dang ky goi cuoc", 0, ("spam", "tu_khoa_qc")),
        ("[TB] Thuê bao cần xác thực thông tin theo Thông tư 08", 0, ("benign", "thong_bao")),
        ("Ong/ba co lich kham benh vao ngay mai", 0, ("benign", "thong_bao")),
        ("Tối nay mấy giờ đi ăn", 0, ("benign", "mac_dinh")),
    ],
)
def test_map_label_rules(msg, label, expected):
    assert vi_sms.map_label(msg, label) == expected


def test_qc_tag_wins_over_otp_but_otp_wins_over_promo_keywords():
    assert vi_sms.map_label("(QC) nhap ma OTP de nhan uu dai", 0)[0] == "spam"
    assert vi_sms.map_label("Ma OTP la 1234. Tang ban 10% uu dai", 0)[0] == "benign"


# ---------------------------------------------------------------- thay token

def test_fill_removes_all_anonymization_tokens_and_keeps_real_tags():
    t = "[TB] [MONEY]/[TIME] vao [DATE], [NAME] nhan [POINT] diem. LH [NUMBER] ([MONEY]) [URL] [KHAO SAT]"
    out = _fill(t)
    assert not re.search(r"\[(MONEY|NUMBER|TIME|DATE|POINT|NAME|URL)\]", out)
    assert out.startswith("[TB] ") and out.endswith("[KHAO SAT]")


def test_fill_is_deterministic_per_seed_and_varies_across_seeds():
    t = "Nhan [MONEY] vao stk [NUMBER] truoc [DATE]"
    assert _fill(t, "COM_1") == _fill(t, "COM_1")
    assert len({_fill(t, f"COM_{i}") for i in range(20)}) > 10


def test_fill_number_contexts():
    for i in range(30):
        s = str(i)
        acc = re.search(r"stk (\d+)", _fill("chuyen khoan vao stk [NUMBER] ngay", s)).group(1)
        assert 9 <= len(acc) <= 13
        code = re.search(r"gui (\d+)", _fill("Soan DK gui [NUMBER] de dang ky", s)).group(1)
        assert 3 <= len(code) <= 4
        otp = re.search(r"OTP (\d+)", _fill("Ma OTP [NUMBER] co hieu luc", s)).group(1)
        assert len(otp) in (4, 6)
        phone = re.search(r"thue bao (\d+)", _fill("thue bao [NUMBER] da dang ky", s)).group(1)
        assert len(phone) == 10 and phone.startswith("0")
        assert re.search(r"08/20(2[456])/TT-BKHCN", _fill("Thong tu 08/[NUMBER]/TT-BKHCN", s))
        assert re.search(r"thang 03/20(2[456])\.", _fill("thang 03/[NUMBER].", s))
        assert re.search(r"nhiem ky 2026\b", _fill("nhiem ky [NUMBER]- [NUMBER]", s))


def test_fill_point_after_dot_has_no_double_separator():
    for i in range(30):
        out = _fill("Tang 10.[POINT] diem", str(i))
        assert re.search(r"Tang 10\.\d{3} diem", out)


def test_fill_follows_the_script_of_the_message():
    for i in range(30):
        plain = _fill("Cuoc [MONEY] trong [TIME]", str(i))
        assert "đ" not in plain and "ngày" not in plain and "phút" not in plain
    seen = {_fill("Cước [MONEY] trong [TIME]", str(i)) for i in range(60)}
    assert any("đ" in s for s in seen)


def test_fill_call_fee_in_parentheses_is_small():
    for i in range(30):
        out = _fill("LH 198 ([MONEY]). Tran trong.", str(i))
        assert re.search(r"\((?:200|300|500|1000|2000)d/phut\)", out)


def test_fill_scam_money_can_be_large():
    big = [_fill("Luong [MONEY]/bai", str(i), scam=True) for i in range(60)]
    small = [_fill("Luong [MONEY]/bai", str(i), scam=False) for i in range(60)]
    digits = lambda s: int(re.sub(r"\D", "", re.search(r"Luong ([^/]+)/", s).group(1)) or 0)
    assert max(digits(s) for s in big) >= 5_000_000
    assert max(digits(s) for s in small) <= 100_000


# ---------------------------------------------------------------- toàn bộ quy trình

def _df(rows):
    return pd.DataFrame(rows, columns=["message_id", "date", "message", "label"])


def test_import_sms_dedupes_drops_conflicts_and_labels():
    df = _df(
        [
            ("A1", "d", "Ma OTP la 123456, hieu luc [TIME]", "0"),
            ("A2", "d", "Ma  OTP la 123456, hieu luc [TIME]\n", "0"),  # trùng sau gộp khoảng trắng
            ("A3", "d", "Truy cap http://x.top de nhan [MONEY]", "1"),
            ("A4", "d", "Cung noi dung nhung khac nhan", "0"),
            ("A5", "d", "cung noi dung nhung khac nhan", "1"),
            ("A6", "d", "[QC] Tang [MONEY] khi dang ky", "0"),
            ("A7", "d", "   ", "0"),
        ]
    )
    d, rep = vi_sms.import_sms(df)
    assert rep["input"] == 7 and rep["empty_dropped"] == 1
    assert rep["conflict_dropped"] == 2 and rep["duplicates_dropped"] == 1
    assert rep["kept"] == 3 and rep["rows_with_leftover_tokens"] == 0
    assert d.set_index("ref")["label"].to_dict() == {"A1": "benign", "A3": "scam", "A6": "spam"}


def test_import_sms_overrides_and_validation():
    df = _df([("A1", "d", "Giam 50% khi mua data", "0"), ("A2", "d", "Hom nay hop luc 9h", "0")])
    d, rep = vi_sms.import_sms(df, overrides={"A1": "benign", "ZZ": "scam"})
    assert d.set_index("ref").loc["A1", ["label", "rule"]].tolist() == ["benign", "override"]
    assert rep["overrides_applied"] == 1 and rep["overrides_unknown_ref"] == ["ZZ"]
    with pytest.raises(ValueError, match="không hợp lệ"):
        vi_sms.import_sms(df, overrides={"A1": "ham"})
    with pytest.raises(ValueError, match="Thiếu cột"):
        vi_sms.import_sms(df.drop(columns=["label"]))


def test_import_sms_gives_same_result_for_crlf_and_lf():
    lf = _df([("A1", "d", "Giam 50% khi mua data\nLH [NUMBER]", "0"), ("A2", "d", "Hom nay hop luc 9h", "0")])
    crlf = lf.copy()
    crlf["message"] = crlf["message"].str.replace("\n", "\r\n", regex=False) + "\r"
    a, _ = vi_sms.import_sms(lf)
    b, _ = vi_sms.import_sms(crlf)
    assert a["text"].tolist() == b["text"].tolist() and a["label"].tolist() == b["label"].tolist()


def test_import_sms_is_deterministic():
    df = _df([(f"M{i}", "d", f"Tang [MONEY] cho tb [NUMBER] truoc [DATE] lan {i}", "0") for i in range(10)])
    a, _ = vi_sms.import_sms(df, seed=7)
    b, _ = vi_sms.import_sms(df, seed=7)
    c, _ = vi_sms.import_sms(df, seed=8)
    assert a["text"].tolist() == b["text"].tolist()
    assert a["text"].tolist() != c["text"].tolist()


def test_pool_output_passes_pipeline_validation_and_grouping(tmp_path):
    df = _df(
        [(f"S{i}", "d", f"[QC] Tang [MONEY] khi tb [NUMBER] soan DK{i} gui 191, cuoc [MONEY]/[TIME]", "0") for i in range(6)]
        + [(f"C{i}", "d", f"Ban nhan duoc [MONEY], truy cap http://nhan-thuong{i}.top truoc [DATE]", "1") for i in range(6)]
        + [(f"B{i}", "d", f"Ma OTP [NUMBER] dang nhap ung dung so {i}", "0") for i in range(6)]
    )
    d, _ = vi_sms.import_sms(df)
    p = tmp_path / "pool.csv"
    vi_sms.to_pool(d).to_csv(p, index=False, encoding="utf-8")
    pool = read_messages(p)
    rep = validate_messages(pool, LABELS)
    assert rep["errors"] == [] and set(pool["source"]) == {"real"} and set(pool["lang"]) == {"vi"}
    out, st = dedupe_and_group(pool, 0.85)
    assert st["kept"] == len(out) and out["group_id"].nunique() < len(out)  # tin cùng mẫu bị gộp nhóm


def test_review_sample_is_stratified_and_has_check_column():
    rows = [(f"M{i}", "d", f"Giam {i}% khi mua data", "0") for i in range(40)] + [
        (f"N{i}", "d", f"Hom nay hop luc {i}h", "0") for i in range(40)
    ]
    d, _ = vi_sms.import_sms(_df(rows))
    r = vi_sms.review_sample(d, per_rule=5)
    assert r.groupby(["label", "rule"]).size().max() == 5
    assert set(r["rule"]) == {"tu_khoa_qc", "mac_dinh"}
    assert list(r.columns) == ["ref", "label", "rule", "original", "text", "check"]


def _load_script(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_build_message_pool_concatenates_and_keeps_columns(tmp_path):
    a = tmp_path / "a.csv"
    b = tmp_path / "b.csv"
    pd.DataFrame({"text": ["xin chao ban", "toi di hoc"], "label": ["benign", "benign"], "source": "real"}).to_csv(a, index=False)
    pd.DataFrame({"text": ["nhan thuong ngay"], "label": ["scam"], "source": "synthetic", "group": "g1"}).to_csv(b, index=False)
    mod = _load_script("build_message_pool")
    out = tmp_path / "pool.csv"
    rep = mod.build([a, b], out, LABELS)
    got = pd.read_csv(out, dtype=str, keep_default_na=False)
    assert list(got.columns) == ["text", "label", "source", "group", "lang"]
    assert rep["rows"] == 3 and rep["by_source_label"] == {"real/benign": 2, "synthetic/scam": 1}
    bad = tmp_path / "bad.csv"
    pd.DataFrame({"text": ["x"], "label": ["ham"]}).to_csv(bad, index=False)
    with pytest.raises(SystemExit):
        mod.build([bad], tmp_path / "o.csv", LABELS)
