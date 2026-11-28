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
        ("Soan DK gui 888 de dang ky goi cuoc", 0, ("spam", "soan_gui")),
        ("[TB] Thuê bao cần xác thực thông tin theo Thông tư 08", 0, ("benign", "thong_bao")),
        ("Ong/ba co lich kham benh vao ngay mai", 0, ("benign", "thong_bao")),
        ("Tối nay mấy giờ đi ăn", 0, ("benign", "mac_dinh")),
        ("Goi ST15K da ket thuc. De biet cac uu dai khac, bam goi *098#", 0, ("benign", "trang_thai_dv")),
        ("Dang ky khong thanh cong do chuong trinh khong ap dung cho thue bao", 0, ("benign", "trang_thai_dv")),
        ("[TB] MUA DATA - CHAM CAY. Soan VPL30 gui 191: 20.000d/30 ngay. Cap nhat thong tin huong dan", 0, ("spam", "soan_gui")),
        ("(QC) Goi X da ket thuc, soan DK gui 888", 0, ("spam", "tag_qc")),
        # lời mời đăng ký đi sau câu thông báo "đăng ký thành công" / "đã hủy" vẫn là quảng cáo
        ("(TB) Thue bao 0912345678 duoc +300MB Data khi dang ky thanh cong goi cuoc A. Moi ban soan KUS5 gui 888 dang ky", 0, ("spam", "soan_gui")),
        ("DV Nhac cho da huy do het CTKM. Moi quy khach soan GC5 gui 888 de dang ky lai DV", 0, ("spam", "soan_gui")),
        # cú pháp tiện ích (hủy, xác nhận hủy, tra cứu, khóa) không biến tin trạng thái thành quảng cáo
        ("Quy khach da dang ky thanh cong goi ST30K. Soan HUY ST30K gui 191 de huy gia han", 0, ("benign", "trang_thai_dv")),
        ("Sau khi huy gia han goi 1N, uu dai con lai dung den het chu ky. Xac nhan: soan Y gui 191. Tu choi: soan N gui 191", 0, ("benign", "trang_thai_dv")),
        ("Quy Khach da gia han thanh cong goi D2. Kiem tra dung luong, soan DATA gui 888. De huy, soan HUY D2 gui 888", 0, ("benign", "trang_thai_dv")),
        ("Quy khach da hoan tat xac thuc thanh cong Sacombank Pay. Neu Quy khach KHONG thuc hien, soan STBPAY KHOA gui 8149", 0, ("benign", "mac_dinh")),
        ("Quy khach vui long soan Y gui 988 de nhan 150000d vao tai khoan KM", 0, ("spam", "soan_gui")),
        # tin có kèm cách từ chối quảng cáo là quảng cáo
        ("Sim dang sale upto 65%. Tu choi QC, soan TCQC gui 123", 0, ("spam", "tag_qc")),
        # "mưa" và "mùa" bỏ dấu thành "mua" nhưng không phải mua hàng; "mua bán người" cũng không phải khuyến mại
        ("Thoi tiet Tay Ninh 30/06: Co luc co mua, nhiet do 25-30oC", 0, ("benign", "thong_bao")),
        ("Chúc Quý khách một mùa lễ ấm áp, năm mới thành công", 0, ("benign", "mac_dinh")),
        ("Toàn dân tích cực phòng chống mua bán người, gọi 111", 0, ("benign", "mac_dinh")),
        ("Mua 2 tang 1 cho moi don hom nay", 0, ("spam", "tu_khoa_qc")),
        # thông báo đổi/cộng điểm là tin dịch vụ, còn lời nhắc đổi điểm là quảng cáo
        ("Doi thanh cong 100 tieu dung Viettel++ thanh 20 MB Data. Han su dung truoc 14/10", 0, ("benign", "thong_bao")),
        ("Quy khach duoc cong them 500 Viettel++ boi giao dich thang 04/2026", 0, ("benign", "thong_bao")),
        ("Quy khach dung quen doi diem Viettel++ de nhan data mien phi", 0, ("spam", "tu_khoa_qc")),
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


def _one(pattern, text, seed):
    return re.search(pattern, _fill(text, str(seed))).group(1)


def test_fill_time_clock_versus_duration():
    for i in range(40):
        # hiệu lực của OTP là khoảng thời gian ngắn, không phải giờ trong ngày
        assert re.fullmatch(r"(?:\d+p|\d+ phut)", _one(r"hieu luc (\S+(?: phut)?)", "Ma OTP 123456 hieu luc [TIME]", i))
        # "hiệu lực" ngoài OTP là khoảng thời gian
        assert re.search(r"hieu luc \d+(?:h| phut| ngay| thang| gio)\.", _fill("Uu dai hieu luc [TIME].", str(i)))
        # giờ trong ngày: sau ngày và sau "lúc"
        out = _fill("Ngay GD: [DATE] [TIME].", str(i))
        tok = re.search(r"(\d{1,2})(?::\d{2}|h\d{0,2})\.$", out)
        assert tok and 6 <= int(tok.group(1)) <= 22
        out = _fill("Xay ra luc [TIME] hom nay", str(i))
        tok = re.search(r"luc (\d{1,2})(?::\d{2}|h\d{0,2}) hom", out)
        assert tok and 6 <= int(tok.group(1)) <= 22


def test_fill_more_number_contexts():
    for i in range(40):
        assert re.fullmatch(r"\d{3,10}", _one(r"goi ngay (\S+) de", "Neu khong phai ban, goi ngay [NUMBER] de khoa the", i))
        assert re.fullmatch(r"\d{9,13}", _one(r"Nguoi nhan: (\S+)", "TK Nguoi nhan: [NUMBER] So tien", i))
        assert re.fullmatch(r"\d{8,12}", _one(r"hop dong (\S+)", "ma hop dong [NUMBER] thang", i))
        assert re.fullmatch(r"20(?:24|25|26)", _one(r"nam moi (\S+)!", "Chao nam moi [NUMBER]!", i))
        assert re.fullmatch(r"\d{9,13}", _one(r"- (\d+) tai", "so tai khoan: - [NUMBER] tai Vietinbank.", i))
        assert re.fullmatch(r"0\d{9}", _one(r"Tien di dong (\S+)", "TK Tien di dong [NUMBER] GD", i))
        assert re.fullmatch(r"(?:\d{4}|\d{6})", _one(r"Su dung (\S+) de", "Su dung [NUMBER] de xac thuc 2 yeu to tren Facebook", i))


def test_fill_fee_in_parentheses_keeps_unit_once():
    for i in range(40):
        out = _fill("Chi tiet LH [NUMBER] ([MONEY]/phut). Tran trong", str(i))
        assert out.count("/phut") == 1 and re.search(r"\((?:200|300|500|1000|2000)d/phut\)", out)
        out = _fill("soan KM gui [NUMBER] ([MONEY]) de dang ky", str(i))
        assert re.search(r"\(\d+d/tin\)", out)


def test_fill_sms_fee_with_unit_already_in_text():
    for i in range(40):
        for unit in ("tin", "sms"):
            out = _fill(f"gui 211 de cong 20 tin nhan ([MONEY]/{unit}), su dung 7 ngay", str(i))
            assert re.search(rf"\((?:500|1000|2000|3000|5000|10000|15000)d/{unit}\)", out) and out.count(f"/{unit}") == 1


def test_fill_tv360_is_restored_but_plain_numbers_are_not():
    for i in range(10):
        assert "tren TV360 theo" in _fill("Xem phim va truyen hinh tren [NUMBER] theo chuong trinh", str(i))
        assert "xem TV360." in _fill("Dac biet, mien phi xem [NUMBER]. Goi cuoc gia han", str(i))
        assert "goi cuoc TV360 Standard" in _fill("va goi cuoc [NUMBER] Standard de xem phim", str(i))
        assert "TV360" not in _fill("Duoc xem [NUMBER] kenh truyen hinh", str(i))


def test_fill_syntax_keyword_after_soan_is_a_code_not_a_shortcode():
    for i in range(30):
        out = _fill("Soan [NUMBER] gui 191: [MONEY]/30 ngay", str(i))
        m = re.match(r"Soan (\S+) gui 191:", out)
        assert m and m.group(1) in vi_sms._SYNTAX_CODES


def test_fill_time_contexts_from_second_review():
    for i in range(40):
        # "trước ... hôm nay": giờ trong ngày
        out = _fill("thanh toan truoc [TIME] hom nay", str(i))
        assert re.search(r"truoc (\d{1,2})(?::\d{2}|h\d{0,2}) hom nay", out)
        # đầu khoảng giờ phải sớm hơn cuối khoảng
        out = _fill("tu [TIME] - 17h30 ngay 1/6", str(i))
        assert 6 <= int(re.search(r"tu (\d{1,2})", out).group(1)) <= 10
        # "dùng đến ... ngày đăng ký": cuối ngày, không phải số ngày
        assert re.search(r"den (?:23h59|23:59|24h) ngay dang ky", _fill("su dung den [TIME] ngay dang ky", str(i)))
        # "tầm ... trở lên" sau buổi trong ngày
        out = _fill("giao giup e buoi chieu nha a tam [TIME] tro len cang tot", str(i))
        assert re.search(r"tam \d{1,2}(?::\d{2}|h\d{0,2}) tro len", out)
        # thời lượng gọi: phút
        assert re.search(r"cong \d+ ?(?:phut|p) noi mang", _fill("de cong [TIME] noi mang", str(i)))
        assert re.search(r"cuoc goi duoi \d+ ?(?:phut|p),", _fill("moi cuoc goi duoi [TIME], 3 ngay", str(i)))


def test_fill_number_contexts_from_second_review():
    for i in range(40):
        assert re.fullmatch(r"\d{9,13}", _one(r"So TK thanh toan: (\S+)", "So TK thanh toan: [NUMBER] Ten", i))
        assert re.fullmatch(r"\d{9,13}", _one(r"so tai khoan la: (\S+)\.", "so tai khoan la: [NUMBER]. Truy cap", i))
        assert re.fullmatch(r"\d{8,12}", _one(r"Ten dang nhap: (\S+)", "Ten dang nhap: [NUMBER] Vui long", i))
        assert 2 <= int(_one(r"duoi (\d+) kilomet", "va duoi [NUMBER] kilomet. Neu", i)) <= 50
        assert re.fullmatch(r"20(?:24|25|26)", _one(r"Cup (\S+) tai", "chuong trinh Cup [NUMBER] tai https://x.vn", i))
        assert re.fullmatch(r"0\d{9}", _one(r"cho Ban: (\S+),", "TANG 3K cho Ban: [NUMBER], soan V gui 999", i))


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


def test_is_english_only_flags_english_verification_messages():
    assert vi_sms.is_english("G-123456 is your Google verification code.")
    assert vi_sms.is_english("Your Discord verification code is: 123456")
    assert not vi_sms.is_english("Nhap code 1234 de nhan qua")
    assert not vi_sms.is_english("Ma OTP la 123456")


def test_scrub_pii_masks_names_emails_and_account_ids():
    t = "Tong cuoc cua Quy khach LO QUANG THANG ma hop dong 1, account t008_ftth_thanglq24, mail drtai678@gmail.com."
    out = vi_sms.scrub_pii(t, random.Random("x"))
    assert "LO QUANG THANG" not in out and "thanglq24" not in out and "drtai678" not in out
    assert "Quy khach " in out and "t008_ftth_" in out and out.endswith("@gmail.com.")
    assert out == vi_sms.scrub_pii(t, random.Random("x"))
    assert vi_sms.scrub_pii("Hom nay hop luc 9h", random.Random("x")) == "Hom nay hop luc 9h"


def test_import_sms_drops_english_and_scrubs_pii():
    df = _df(
        [
            ("E1", "d", "G-[NUMBER] is your Google verification code.", "0"),
            ("P1", "d", "Tong cuoc DV cua Quy khach LO QUANG THANG ma hop dong [NUMBER] la [MONEY]. Lien he drtai1@gmail.com", "0"),
        ]
    )
    d, rep = vi_sms.import_sms(df)
    assert rep["english_dropped"] == 1 and rep["pii_scrubbed"] == 1 and rep["kept"] == 1
    assert "LO QUANG THANG" not in d["original"].iloc[0] and "drtai1" not in d["text"].iloc[0]


def test_overrides_file_is_valid():
    o = pd.read_csv(ROOT / "data" / "vi_sms_overrides.csv", dtype=str, encoding="utf-8-sig")
    assert {"message_id", "label"} <= set(o.columns)
    assert set(o["label"]) <= set(vi_sms.LABELS) and o["message_id"].is_unique


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


def test_import_script_reports_locked_file_clearly(capsys):
    spec = importlib.util.spec_from_file_location("import_vi_sms", ROOT / "scripts" / "import_vi_sms.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    def locked(_path):
        raise PermissionError(13, "Permission denied")

    with pytest.raises(SystemExit) as e:
        mod._save(Path("data/interim/vi_sms_review.csv"), locked)
    assert "Excel" in str(e.value) and "vi_sms_review.csv" in str(e.value)
