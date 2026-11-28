/**
 * UUID v4. `crypto.randomUUID` chỉ có ở "secure context" (HTTPS hoặc localhost): mở app qua http://192.168.x.x
 * (ví dụ thử trên điện thoại) thì nó không tồn tại. `crypto.getRandomValues` thì luôn có, nên dùng làm dự phòng.
 */
export function uuid(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10xx
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
}
