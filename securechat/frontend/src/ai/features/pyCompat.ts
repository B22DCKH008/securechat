/**
 * Tiện ích để TypeScript cho kết quả GIỐNG HỆT Python (spec nằm ở ml/src/securechat_ml/features/*.py).
 * Điểm lệch hay gặp giữa hai ngôn ngữ:
 *  - `\s` của Python (str) khác `\s` của JS: Python có \x1c-\x1f, \x85 và KHÔNG có ﻿; JS ngược lại.
 *  - `str.strip()` của Python dùng cùng tập khoảng trắng đó; `String.trim()` của JS dùng tập khác.
 *  - Python đếm/cắt theo code point, JS theo UTF-16 => dùng Array.from cho ký tự ngoài BMP (emoji).
 *  - `$` trong regex Python (không cờ MULTILINE) khớp cả TRƯỚC dấu xuống dòng cuối chuỗi.
 */

/** Tập khoảng trắng của Python: các ký tự mà str.isspace() = True. */
export const PY_WS_CLASS =
  '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';

const WS_RUN_RE = new RegExp(`[${PY_WS_CLASS}]+`, 'g');
const WS_EDGE_RE = new RegExp(`^[${PY_WS_CLASS}]+|[${PY_WS_CLASS}]+$`, 'g');

/** Tương đương `re.sub(r"\s+", " ", s)` của Python. */
export function collapseWhitespace(s: string): string {
  return s.replace(WS_RUN_RE, ' ');
}

/** Tương đương `str.strip()` của Python. */
export function pyStrip(s: string): string {
  return s.replace(WS_EDGE_RE, '');
}

/** Tương đương `str.rstrip(ch)` với một ký tự. */
export function rstripChar(s: string, ch: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) end--;
  return s.slice(0, end);
}

/** Độ dài theo code point (giống `len()` của Python). */
export function cpLen(s: string): number {
  let n = 0;
  for (const _ of s) {
    void _;
    n++;
  }
  return n;
}

/** Cắt theo code point (giống `s[a:b]` của Python, với 0 <= a <= b). */
export function cpSlice(s: string, start: number, end?: number): string {
  return Array.from(s).slice(start, end).join('');
}

/** Python `str.find(ch)` -> -1 nếu không có (indexOf theo UTF-16; chỉ dùng với ký tự ASCII). */
export function findAscii(s: string, ch: string): number {
  return s.indexOf(ch);
}
