/**
 * Đặc trưng URL (chỉ từ chuỗi URL; không WHOIS/tải trang/API ngoài).
 * SPEC: ml/src/securechat_ml/features/url.py (URL_SPEC_VERSION = 1).
 * Hằng số có thể lấy từ url_spec.json (đi kèm model) để đảm bảo cùng danh sách với lúc train.
 */
import { cpLen, cpSlice, pyStrip, rstripChar } from './pyCompat';

export const URL_SPEC_VERSION = 1;

export interface UrlSpec {
  specVersion: number;
  featureNames: string[];
  suspiciousTlds: string[];
  shorteners: string[];
  keywords: string[];
  brands: string[];
  multiSuffix: string[];
}

export const FEATURE_NAMES = [
  'url_len', 'host_len', 'path_len', 'query_len',
  'n_dots_host', 'n_subdomains', 'n_hyphens_host', 'n_digits_host',
  'n_digits_url', 'digit_ratio_url', 'n_special_chars', 'path_depth',
  'has_at', 'is_ip_host', 'has_nonstd_port', 'is_punycode',
  'tld_len', 'tld_suspicious', 'entropy_host', 'entropy_url',
  'n_susp_keywords', 'has_shortener', 'longest_host_label', 'has_double_slash_path',
  'has_www', 'brand_in_subdomain', 'brand_in_path',
]; // prettier-ignore

export const DEFAULT_URL_SPEC: UrlSpec = {
  specVersion: URL_SPEC_VERSION,
  featureNames: FEATURE_NAMES,
  suspiciousTlds: ['zip', 'top', 'xyz', 'icu', 'click', 'link', 'work', 'support', 'online', 'site', 'shop', 'cfd', 'sbs', 'vip', 'info', 'cc', 'tk', 'ml', 'ga', 'cf', 'gq'],
  shorteners: ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'cutt.ly', 'rebrand.ly', 'shorturl.at', 'ow.ly', 'tiny.cc', 's.id', 'rb.gy'],
  keywords: ['login', 'signin', 'verify', 'secure', 'account', 'update', 'confirm', 'bank', 'otp', 'wallet', 'password', 'xacminh', 'xac-minh', 'taikhoan', 'tai-khoan', 'dangnhap', 'dang-nhap', 'ngan-hang', 'nganhang', 'khoa-tai-khoan', 'nhan-qua', 'trung-thuong'],
  brands: ['vietcombank', 'techcombank', 'vietinbank', 'bidv', 'mbbank', 'agribank', 'vpbank', 'tpbank', 'sacombank', 'momo', 'zalopay', 'shopee', 'lazada', 'tiki', 'viettel', 'vnpt', 'mobifone', 'vneid', 'paypal', 'apple', 'microsoft', 'google', 'facebook'],
  multiSuffix: ['com.vn', 'net.vn', 'org.vn', 'edu.vn', 'gov.vn', 'ac.vn', 'biz.vn', 'info.vn', 'co.uk', 'org.uk', 'com.au', 'co.jp', 'com.br', 'co.in', 'com.cn', 'com.sg', 'com.hk', 'com.tw', 'co.kr', 'co.id'],
}; // prettier-ignore

// Python `$` khớp cả trước "\n" cuối chuỗi => thêm `\n?` để giống hệt.
const SCHEME_RE = /^[a-z][a-z0-9+.\-]*:\/\//;
const IPV4_RE = /^[0-9]{1,3}(\.[0-9]{1,3}){3}\n?$/;
const HEXIP_RE = /^0x[0-9a-f]+\n?$/;
const PORT_RE = /^[0-9]+\n?$/;
const SPECIAL = new Set('@%&=?_~$');
const DIGITS = new Set('0123456789');

export interface ParsedUrl {
  rest: string;
  userinfo: string;
  host: string;
  port: string;
  path: string;
  query: string;
  fragment: string;
}

export function parseUrl(raw: string): ParsedUrl {
  const u = pyStrip(raw).toLowerCase();
  const m = SCHEME_RE.exec(u);
  const rest = m ? u.slice(m[0].length) : u;
  let idx = rest.length;
  for (const ch of '/?#') {
    const j = rest.indexOf(ch);
    if (j !== -1 && j < idx) idx = j;
  }
  let authority = rest.slice(0, idx);
  let tail = rest.slice(idx);
  let userinfo = '';
  const k = authority.lastIndexOf('@');
  if (k !== -1) {
    userinfo = authority.slice(0, k);
    authority = authority.slice(k + 1);
  }
  let host = authority;
  let port = '';
  const c = authority.lastIndexOf(':');
  if (c !== -1 && !authority.startsWith('[')) {
    const cand = authority.slice(c + 1);
    if (PORT_RE.test(cand)) {
      host = authority.slice(0, c);
      port = cand;
    }
  }
  let fragment = '';
  const h = tail.indexOf('#');
  if (h !== -1) {
    fragment = tail.slice(h + 1);
    tail = tail.slice(0, h);
  }
  let query = '';
  const q = tail.indexOf('?');
  if (q !== -1) {
    query = tail.slice(q + 1);
    tail = tail.slice(0, q);
  }
  host = rstripChar(host, '.');
  return { rest, userinfo, host, port, path: tail, query, fragment };
}

export function registeredDomain(hostIn: string, spec: UrlSpec = DEFAULT_URL_SPEC): string {
  const host = rstripChar(pyStrip(hostIn).toLowerCase(), '.');
  if (!host || IPV4_RE.test(host)) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const last2 = labels.slice(-2).join('.');
  if (spec.multiSuffix.includes(last2) && labels.length >= 3) return labels.slice(-3).join('.');
  return last2;
}

export function domainOfUrl(url: string, spec: UrlSpec = DEFAULT_URL_SPEC): string {
  return registeredDomain(parseUrl(url).host, spec);
}

function entropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  let n = 0;
  for (const ch of s) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
    n++;
  }
  let h = 0;
  for (const c of counts.values()) h -= (c / n) * Math.log2(c / n);
  return h;
}

function countIn(s: string, set: Set<string>): number {
  let n = 0;
  for (const ch of s) if (set.has(ch)) n++;
  return n;
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/** Trả về vector theo thứ tự FEATURE_NAMES. */
export function extractFeatures(url: string, spec: UrlSpec = DEFAULT_URL_SPEC): number[] {
  const p = parseUrl(url);
  const { rest, host, path, query } = p;
  const reg = registeredDomain(host, spec);
  const isIp = IPV4_RE.test(host) || HEXIP_RE.test(host);
  const sub =
    !isIp && host.endsWith(reg) ? rstripChar(cpSlice(host, 0, cpLen(host) - cpLen(reg)), '.') : '';
  const nSub = sub ? sub.split('.').filter((x) => x).length : 0;
  const labels = host ? host.split('.') : [''];
  const tld = labels.length > 1 && !isIp ? (labels[labels.length - 1] as string) : '';
  const digitsUrl = countIn(rest, DIGITS);
  const segs = path.split('/').filter((s) => s);
  const restLen = cpLen(rest);
  const pathQuery = path + '?' + query;
  const f: Record<string, number> = {
    url_len: restLen,
    host_len: cpLen(host),
    path_len: cpLen(path),
    query_len: cpLen(query),
    n_dots_host: countChar(host, '.'),
    n_subdomains: nSub,
    n_hyphens_host: countChar(host, '-'),
    n_digits_host: countIn(host, DIGITS),
    n_digits_url: digitsUrl,
    digit_ratio_url: restLen ? digitsUrl / restLen : 0,
    n_special_chars: countIn(rest, SPECIAL),
    path_depth: segs.length,
    has_at: rest.includes('@') ? 1 : 0,
    is_ip_host: isIp ? 1 : 0,
    has_nonstd_port: !['', '80', '443'].includes(p.port) ? 1 : 0,
    is_punycode: host.includes('xn--') ? 1 : 0,
    tld_len: cpLen(tld),
    tld_suspicious: spec.suspiciousTlds.includes(tld) ? 1 : 0,
    entropy_host: entropy(host),
    entropy_url: entropy(rest),
    n_susp_keywords: spec.keywords.filter((k) => rest.includes(k)).length,
    has_shortener: spec.shorteners.includes(reg) ? 1 : 0,
    longest_host_label: Math.max(0, ...labels.map((x) => cpLen(x))),
    has_double_slash_path: path.includes('//') ? 1 : 0,
    has_www: host.startsWith('www.') ? 1 : 0,
    brand_in_subdomain: spec.brands.some((b) => sub.includes(b) && !reg.includes(b)) ? 1 : 0,
    brand_in_path: spec.brands.some((b) => pathQuery.includes(b) && !reg.includes(b)) ? 1 : 0,
  };
  return spec.featureNames.map((n) => f[n] as number);
}
