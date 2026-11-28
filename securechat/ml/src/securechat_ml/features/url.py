"""Đặc trưng URL (chỉ từ chuỗi URL; KHÔNG WHOIS/tải trang/API ngoài).

Parity với TypeScript: mọi bước dưới đây dùng thao tác chuỗi đơn giản (find/split/lastIndexOf, regex ASCII).
Scheme (http/https) bị loại bỏ trước khi đo => không dùng is_https (artefact thu thập) và độ dài không phụ thuộc scheme.
"""
from __future__ import annotations

import math
import re
from collections import Counter

URL_SPEC_VERSION = 1

# Hằng số được xuất cùng model (url_spec.json) để TS dùng đúng cùng danh sách.
SUSPICIOUS_TLDS = ["zip", "top", "xyz", "icu", "click", "link", "work", "support", "online", "site", "shop", "cfd", "sbs", "vip", "info", "cc", "tk", "ml", "ga", "cf", "gq"]
SHORTENERS = ["bit.ly", "tinyurl.com", "t.co", "goo.gl", "is.gd", "cutt.ly", "rebrand.ly", "shorturl.at", "ow.ly", "tiny.cc", "s.id", "rb.gy"]
KEYWORDS = ["login", "signin", "verify", "secure", "account", "update", "confirm", "bank", "otp", "wallet", "password", "xacminh", "xac-minh", "taikhoan", "tai-khoan", "dangnhap", "dang-nhap", "ngan-hang", "nganhang", "khoa-tai-khoan", "nhan-qua", "trung-thuong"]
BRANDS = ["vietcombank", "techcombank", "vietinbank", "bidv", "mbbank", "agribank", "vpbank", "tpbank", "sacombank", "momo", "zalopay", "shopee", "lazada", "tiki", "viettel", "vnpt", "mobifone", "vneid", "paypal", "apple", "microsoft", "google", "facebook"]
MULTI_SUFFIX = ["com.vn", "net.vn", "org.vn", "edu.vn", "gov.vn", "ac.vn", "biz.vn", "info.vn", "co.uk", "org.uk", "com.au", "co.jp", "com.br", "co.in", "com.cn", "com.sg", "com.hk", "com.tw", "co.kr", "co.id"]

FEATURE_NAMES = [
    "url_len", "host_len", "path_len", "query_len",
    "n_dots_host", "n_subdomains", "n_hyphens_host", "n_digits_host",
    "n_digits_url", "digit_ratio_url", "n_special_chars", "path_depth",
    "has_at", "is_ip_host", "has_nonstd_port", "is_punycode",
    "tld_len", "tld_suspicious", "entropy_host", "entropy_url",
    "n_susp_keywords", "has_shortener", "longest_host_label", "has_double_slash_path",
    "has_www", "brand_in_subdomain", "brand_in_path",
]

_SCHEME_RE = re.compile(r"^[a-z][a-z0-9+.\-]*://")
_IPV4_RE = re.compile(r"^[0-9]{1,3}(\.[0-9]{1,3}){3}$")
_HEXIP_RE = re.compile(r"^0x[0-9a-f]+$")
_PORT_RE = re.compile(r"^[0-9]+$")
_SPECIAL = set("@%&=?_~$")


def parse_url(raw: str) -> dict:
    u = raw.strip().lower()
    m = _SCHEME_RE.match(u)
    rest = u[m.end():] if m else u
    idx = len(rest)
    for ch in "/?#":
        j = rest.find(ch)
        if j != -1 and j < idx:
            idx = j
    authority, tail = rest[:idx], rest[idx:]
    userinfo = ""
    k = authority.rfind("@")
    if k != -1:
        userinfo, authority = authority[:k], authority[k + 1:]
    host, port = authority, ""
    c = authority.rfind(":")
    if c != -1 and not authority.startswith("["):
        cand = authority[c + 1:]
        if _PORT_RE.match(cand):
            host, port = authority[:c], cand
    frag = ""
    h = tail.find("#")
    if h != -1:
        tail, frag = tail[:h], tail[h + 1:]
    query = ""
    q = tail.find("?")
    if q != -1:
        tail, query = tail[:q], tail[q + 1:]
    host = host.rstrip(".")
    return {"rest": rest, "userinfo": userinfo, "host": host, "port": port, "path": tail, "query": query, "fragment": frag}


def registered_domain(host: str) -> str:
    host = host.strip().lower().rstrip(".")
    if not host or _IPV4_RE.match(host):
        return host
    labels = host.split(".")
    if len(labels) <= 2:
        return host
    last2 = ".".join(labels[-2:])
    if last2 in MULTI_SUFFIX and len(labels) >= 3:
        return ".".join(labels[-3:])
    return last2


def domain_of_url(url: str) -> str:
    return registered_domain(parse_url(url)["host"])


def _entropy(s: str) -> float:
    if not s:
        return 0.0
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in Counter(s).values())


def extract_features(url: str) -> list[float]:
    p = parse_url(url)
    rest, host, path, query = p["rest"], p["host"], p["path"], p["query"]
    reg = registered_domain(host)
    is_ip = bool(_IPV4_RE.match(host) or _HEXIP_RE.match(host))
    sub = host[: len(host) - len(reg)].rstrip(".") if (not is_ip and host.endswith(reg)) else ""
    n_sub = len([x for x in sub.split(".") if x]) if sub else 0
    labels = host.split(".") if host else [""]
    tld = labels[-1] if len(labels) > 1 and not is_ip else ""
    digits_url = sum(ch in "0123456789" for ch in rest)
    segs = [s for s in path.split("/") if s]
    feats = {
        "url_len": len(rest),
        "host_len": len(host),
        "path_len": len(path),
        "query_len": len(query),
        "n_dots_host": host.count("."),
        "n_subdomains": n_sub,
        "n_hyphens_host": host.count("-"),
        "n_digits_host": sum(ch in "0123456789" for ch in host),
        "n_digits_url": digits_url,
        "digit_ratio_url": (digits_url / len(rest)) if rest else 0.0,
        "n_special_chars": sum(ch in _SPECIAL for ch in rest),
        "path_depth": len(segs),
        "has_at": 1.0 if ("@" in rest) else 0.0,
        "is_ip_host": 1.0 if is_ip else 0.0,
        "has_nonstd_port": 1.0 if p["port"] not in ("", "80", "443") else 0.0,
        "is_punycode": 1.0 if "xn--" in host else 0.0,
        "tld_len": len(tld),
        "tld_suspicious": 1.0 if tld in SUSPICIOUS_TLDS else 0.0,
        "entropy_host": _entropy(host),
        "entropy_url": _entropy(rest),
        "n_susp_keywords": sum(1 for k in KEYWORDS if k in rest),
        "has_shortener": 1.0 if reg in SHORTENERS else 0.0,
        "longest_host_label": max((len(x) for x in labels), default=0),
        "has_double_slash_path": 1.0 if "//" in path else 0.0,
        "has_www": 1.0 if host.startswith("www.") else 0.0,
        "brand_in_subdomain": 1.0 if any(b in sub and b not in reg for b in BRANDS) else 0.0,
        "brand_in_path": 1.0 if any(b in (path + "?" + query) and b not in reg for b in BRANDS) else 0.0,
    }
    return [float(feats[n]) for n in FEATURE_NAMES]


def spec_constants() -> dict:
    return {
        "specVersion": URL_SPEC_VERSION,
        "featureNames": FEATURE_NAMES,
        "suspiciousTlds": SUSPICIOUS_TLDS,
        "shorteners": SHORTENERS,
        "keywords": KEYWORDS,
        "brands": BRANDS,
        "multiSuffix": MULTI_SUFFIX,
    }
