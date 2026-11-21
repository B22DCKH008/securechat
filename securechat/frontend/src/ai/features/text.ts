/**
 * Chuẩn hóa + tách đặc trưng cho model tin nhắn.
 * SPEC: ml/src/securechat_ml/features/text.py (FEATURIZER_SPEC_VERSION = 1).
 * Kiểm tra bằng ml/models/artifacts/message/message_parity_fixtures.json (xem tests/ai/text.parity.test.ts).
 */
import { PY_WS_CLASS, collapseWhitespace, pyStrip } from './pyCompat';

export const FEATURIZER_SPEC_VERSION = 1;

// Python: r"(?:https?://|www\.)\S+"  với \S = ký tự KHÔNG thuộc tập khoảng trắng của Python.
const URL_RE = new RegExp(`(?:https?://|www\\.)[^${PY_WS_CLASS}]+`, 'g');
const BIGNUM_RE = /[0-9]{6,}/g; // chỉ ASCII, không dùng \d (Unicode)
const COMBINING_RE = /[̀-ͯ]/g;

export interface FeaturizerConfig {
  charNgram: [number, number];
  wordNgram: [number, number];
  stripDiacritics: boolean;
}

export const DEFAULT_FEATURIZER: FeaturizerConfig = {
  charNgram: [2, 5],
  wordNgram: [1, 2],
  stripDiacritics: true,
};

/** lower -> (NFD, bỏ dấu, đ->d | NFC) -> URL -> số dài -> gộp khoảng trắng -> strip. */
export function normalizeText(input: string, stripDiacritics = true): string {
  let s = input.toLowerCase();
  if (stripDiacritics) {
    s = s.normalize('NFD').replace(COMBINING_RE, '');
    s = s.split('đ').join('d');
  } else {
    s = s.normalize('NFC');
  }
  s = s.replace(URL_RE, ' urltoken ');
  s = s.replace(BIGNUM_RE, ' bignum ');
  return pyStrip(collapseWhitespace(s));
}

/** Danh sách feature (có lặp): 'w:' = word n-gram, 'c:' = char n-gram trong từ (đệm khoảng trắng). */
export function analyze(text: string, cfg: FeaturizerConfig = DEFAULT_FEATURIZER): string[] {
  const s = normalizeText(text, cfg.stripDiacritics);
  if (!s) return [];
  const words = s.split(' ');
  const feats: string[] = [];
  const [wlo, whi] = cfg.wordNgram;
  for (let n = wlo; n <= whi; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      feats.push('w:' + words.slice(i, i + n).join(' '));
    }
  }
  const [clo, chi] = cfg.charNgram;
  for (const w of words) {
    const p = Array.from(' ' + w + ' '); // theo code point, giống Python
    const len = p.length;
    for (let n = clo; n <= chi; n++) {
      for (let i = 0; i + n <= len; i++) {
        feats.push('c:' + p.slice(i, i + n).join(''));
      }
    }
  }
  return feats;
}

/** Vector TF-IDF thưa, L2-chuẩn hóa (giống sklearn TfidfVectorizer(norm='l2', smooth_idf=True)). */
export function tfidfSparse(
  feats: string[],
  vocab: ReadonlyMap<string, number>,
  idf: ArrayLike<number>,
  sublinear = true,
): Map<number, number> {
  const counts = new Map<number, number>();
  for (const f of feats) {
    const j = vocab.get(f);
    if (j !== undefined) counts.set(j, (counts.get(j) ?? 0) + 1);
  }
  const vec = new Map<number, number>();
  let sumSq = 0;
  for (const [j, c] of counts) {
    const tf = sublinear ? 1 + Math.log(c) : c;
    const v = tf * (idf[j] as number);
    vec.set(j, v);
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (norm > 0) for (const [j, v] of vec) vec.set(j, v / norm);
  return vec;
}

/** Trích URL trong tin nhắn bằng đúng regex của featurizer (để chạy model URL). */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  const re = new RegExp(URL_RE.source, 'gi');
  for (const m of text.matchAll(re)) {
    // bỏ dấu câu dính cuối URL (ví dụ "...link.com/abc," hoặc "...)")
    out.push(m[0].replace(/[),.;:!?"'\]]+$/, ''));
  }
  return [...new Set(out)];
}
