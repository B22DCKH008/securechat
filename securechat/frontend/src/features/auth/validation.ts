/** Ràng buộc đăng ký khớp backend (openapi Credentials). */
export const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;
export const MIN_PASSWORD_BYTES = 12;
export const MAX_PASSWORD_BYTES = 1024;

export function validateUsername(u: string): string | null {
  return USERNAME_RE.test(u) ? null : 'Tên đăng nhập 3–32 ký tự: chữ không dấu, số hoặc _';
}

export function validatePassword(p: string): string | null {
  const n = new TextEncoder().encode(p).length;
  if (n < MIN_PASSWORD_BYTES) return `Mật khẩu tối thiểu ${MIN_PASSWORD_BYTES} ký tự`;
  if (n > MAX_PASSWORD_BYTES) return 'Mật khẩu quá dài';
  return null;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validatePeerId(id: string): string | null {
  return UUID_RE.test(id.trim())
    ? null
    : 'ID người dùng phải là UUID (ví dụ 123e4567-e89b-12d3-a456-426614174000)';
}
