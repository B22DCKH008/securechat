import math

import numpy as np
import pytest

from securechat_ml.features.text import analyze, normalize_text
from securechat_ml.features.url import FEATURE_NAMES, domain_of_url, extract_features, parse_url, registered_domain


def feat(url):
    return dict(zip(FEATURE_NAMES, extract_features(url)))


# ---------- text ----------
@pytest.mark.parametrize(
    "src,expected",
    [
        ("Đặng Thị Ưu", "dang thi uu"),
        ("TÀI KHOẢN bị KHÓA", "tai khoan bi khoa"),
        ("xem https://abc.top/x?y=1 nhé", "xem urltoken nhe"),
        ("OTP 123456 và 12345", "otp bignum va 12345"),
        ("  nhiều   khoảng\ttrắng\n", "nhieu khoang trang"),
        ("", ""),
    ],
)
def test_normalize(src, expected):
    assert normalize_text(src) == expected


def test_normalize_keep_diacritics_mode():
    assert normalize_text("Đi ăn", strip_diacritics=False) == "đi ăn"


def test_analyze_shapes_and_prefixes():
    f = analyze("ab cd", char_ngram=(2, 3), word_ngram=(1, 2))
    assert "w:ab" in f and "w:cd" in f and "w:ab cd" in f
    assert "c: a" in f and "c:ab" in f and "c:b " in f and "c: ab" in f
    assert analyze("") == []


def test_no_diacritics_equals_diacritics():
    assert analyze("Tài khoản bị khóa") == analyze("tai khoan bi khoa")


# ---------- url ----------
def test_parse_and_domain():
    p = parse_url("HTTPS://User:pw@Sub.Example.CO.UK:8443/a/b?x=1#f")
    assert p["host"] == "sub.example.co.uk" and p["port"] == "8443" and p["userinfo"] == "user:pw"
    assert p["path"] == "/a/b" and p["query"] == "x=1" and p["fragment"] == "f"
    assert registered_domain("a.b.example.co.uk") == "example.co.uk"
    assert registered_domain("shop.vietcombank.com.vn") == "vietcombank.com.vn"
    assert registered_domain("192.168.1.1") == "192.168.1.1"
    assert domain_of_url("shopee.vn/product/1") == "shopee.vn"


def test_features_basic_signals():
    assert feat("http://192.168.1.10:8080/admin/login")["is_ip_host"] == 1
    assert feat("http://192.168.1.10:8080/admin/login")["has_nonstd_port"] == 1
    assert feat("https://xn--vitcombank-hsb.com/verify")["is_punycode"] == 1
    assert feat("https://user:pass@secure-update.example.com/a")["has_at"] == 1
    f = feat("http://vietcombank.com.vn.xacminh-taikhoan.top/login.php?id=1")
    assert f["brand_in_subdomain"] == 1 and f["tld_suspicious"] == 1 and f["n_susp_keywords"] >= 2
    assert feat("https://bit.ly/abc")["has_shortener"] == 1
    assert feat("https://www.google.com/")["has_www"] == 1


def test_scheme_is_ignored():
    a, b = extract_features("http://example.com/path"), extract_features("https://example.com/path")
    assert a == b  # không có tín hiệu is_https (artefact thu thập)


def test_features_finite_and_fixed_length():
    for u in ["", "a", "http://", "https://[::1]/x", "ftp://x.y/z", "https://a..b/c"]:
        v = extract_features(u)
        assert len(v) == len(FEATURE_NAMES)
        assert all(math.isfinite(x) for x in v)
