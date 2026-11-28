export const FEATURIZER_SPEC_VERSION = 1;

const URL_RE = /(?:https?:\/\/|www\.)\S+/g;
const BIGNUM_RE = /[0-9]{6,}/g;
const WS_RE = /\s+/g;
const COMBINING_RE = /[\u0300-\u036f]/g;

export interface TextAnalyzeOptions {
  charNgram?: [number, number];
  wordNgram?: [number, number];
  stripDiacritics?: boolean;
}

export function normalizeText(input: string, stripDiacritics = true): string {
  let s = input.toLowerCase();
  if (stripDiacritics) {
    s = s.normalize('NFD').replace(COMBINING_RE, '').replace(/đ/g, 'd');
  } else {
    s = s.normalize('NFC');
  }
  s = s.replace(URL_RE, ' urltoken ');
  s = s.replace(BIGNUM_RE, ' bignum ');
  s = s.replace(WS_RE, ' ').trim();
  return s;
}

export function analyze(text: string, opts: TextAnalyzeOptions = {}): string[] {
  const charNgram = opts.charNgram ?? [2, 5];
  const wordNgram = opts.wordNgram ?? [1, 2];
  const stripDiacritics = opts.stripDiacritics ?? true;

  const s = normalizeText(text, stripDiacritics);
  if (!s) return [];

  const words = s.split(' ');
  const feats: string[] = [];

  const [wlo, whi] = wordNgram;
  for (let n = wlo; n <= whi; n++) {
    for (let i = 0; i <= words.length - n; i++) {
      feats.push('w:' + words.slice(i, i + n).join(' '));
    }
  }

  const [clo, chi] = charNgram;
  for (const w of words) {
    const chars = Array.from(` ${w} `);
    const L = chars.length;
    for (let n = clo; n <= chi; n++) {
      for (let i = 0; i <= L - n; i++) {
        feats.push('c:' + chars.slice(i, i + n).join(''));
      }
    }
  }

  return feats;
}

export function tfidfSparse(
  feats: string[],
  vocab: Map<string, number>,
  idf: number[],
  sublinear = true,
): Map<number, number> {
  const counts = new Map<number, number>();
  for (const f of feats) {
    const idx = vocab.get(f);
    if (idx !== undefined) {
      counts.set(idx, (counts.get(idx) ?? 0) + 1);
    }
  }

  const vec = new Map<number, number>();
  let sqSum = 0;
  for (const [j, c] of counts) {
    const tf = sublinear ? 1.0 + Math.log(c) : c;
    const val = tf * idf[j];
    vec.set(j, val);
    sqSum += val * val;
  }

  const norm = Math.sqrt(sqSum);
  if (norm > 0) {
    for (const [j, v] of vec) {
      vec.set(j, v / norm);
    }
  }
  return vec;
}