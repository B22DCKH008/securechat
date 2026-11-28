"""Chuẩn hóa + tách đặc trưng cho model tin nhắn.

QUAN TRỌNG (parity Python <-> TypeScript): hàm này là SPEC. Bản TS phải cho kết quả GIỐNG HỆT
(kiểm bằng fixtures do `export-message` sinh ra). Các điểm dễ lệch:
  * chỉ dùng [0-9] (không dùng \\d Unicode), duyệt theo code point (TS: Array.from(str)),
  * thứ tự bước: lower -> (NFD, bỏ dấu, đ->d | NFC) -> URL -> số dài -> gộp khoảng trắng.
"""
from __future__ import annotations

import re
import unicodedata
from collections import Counter
from functools import partial

FEATURIZER_SPEC_VERSION = 1

_URL_RE = re.compile(r"(?:https?://|www\.)\S+")
_BIGNUM_RE = re.compile(r"[0-9]{6,}")
_WS_RE = re.compile(r"\s+")
_COMBINING_RE = re.compile("[̀-ͯ]")


def normalize_text(s: str, strip_diacritics: bool = True) -> str:
    s = s.lower()
    if strip_diacritics:
        s = unicodedata.normalize("NFD", s)
        s = _COMBINING_RE.sub("", s)
        s = s.replace("đ", "d")  # đ -> d
    else:
        s = unicodedata.normalize("NFC", s)
    s = _URL_RE.sub(" urltoken ", s)
    s = _BIGNUM_RE.sub(" bignum ", s)
    s = _WS_RE.sub(" ", s).strip()
    return s


def analyze(
    text: str,
    *,
    char_ngram: tuple[int, int] = (2, 5),
    word_ngram: tuple[int, int] = (1, 2),
    strip_diacritics: bool = True,
) -> list[str]:
    """Trả về danh sách feature (có lặp) với tiền tố 'w:' (word n-gram) và 'c:' (char n-gram trong từ, đệm khoảng trắng)."""
    s = normalize_text(text, strip_diacritics)
    if not s:
        return []
    words = s.split(" ")
    feats: list[str] = []
    wlo, whi = word_ngram
    for n in range(wlo, whi + 1):
        for i in range(len(words) - n + 1):
            feats.append("w:" + " ".join(words[i : i + n]))
    clo, chi = char_ngram
    for w in words:
        p = " " + w + " "
        L = len(p)
        for n in range(clo, chi + 1):
            for i in range(L - n + 1):
                feats.append("c:" + p[i : i + n])
    return feats


def make_analyzer(fcfg: dict):
    return partial(
        analyze,
        char_ngram=tuple(fcfg["char_ngram"]),
        word_ngram=tuple(fcfg["word_ngram"]),
        strip_diacritics=bool(fcfg["strip_diacritics"]),
    )


def tfidf_sparse(feats: list[str], vocab: dict[str, int], idf: list[float], sublinear: bool = True) -> dict[int, float]:
    """Tham chiếu: vector TF-IDF L2-chuẩn hóa (giống sklearn TfidfVectorizer(norm='l2', smooth_idf=True))."""
    import math

    counts = Counter(f for f in feats if f in vocab)
    vec: dict[int, float] = {}
    for f, c in counts.items():
        tf = 1.0 + math.log(c) if sublinear else float(c)
        j = vocab[f]
        vec[j] = tf * idf[j]
    norm = math.sqrt(sum(v * v for v in vec.values()))
    if norm > 0:
        vec = {j: v / norm for j, v in vec.items()}
    return vec
