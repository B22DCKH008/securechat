/**
 * Kiểm tra dữ liệu nhạy cảm trước khi gửi (doc §3.1 bước 2) bằng luật regex — KHÔNG dùng model.
 * Chỉ trả về LOẠI phát hiện (không trả/ghi giá trị) để không làm lộ dữ liệu qua log.
 * Đây là cảnh báo cho người dùng, không phải rào chắn: người dùng vẫn có thể chọn gửi.
 */
export type SensitiveKind =
  'card_number' | 'national_id' | 'otp' | 'password' | 'bank_account' | 'private_key';

export interface SensitiveFinding {
  kind: SensitiveKind;
}

export const SENSITIVE_LABELS_VI: Record<SensitiveKind, string> = {
  card_number: 'số thẻ ngân hàng',
  national_id: 'số CCCD/CMND',
  otp: 'mã OTP / mã xác thực',
  password: 'mật khẩu',
  bank_account: 'số tài khoản ngân hàng',
  private_key: 'khóa bí mật',
};

/** lower + bỏ dấu tiếng Việt (không đổi số/URL như featurizer của model). */
export function fold(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split('đ').join('d');
}

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const CARD_RE = /(?<![0-9])(?:[0-9][ -]?){12,18}[0-9](?![0-9])/g;
const NATIONAL_ID_RE = /(cccd|cmnd|can cuoc|chung minh)[^0-9]{0,30}([0-9]{12}|[0-9]{9})(?![0-9])/;
const OTP_RE = /(otp|ma xac thuc|ma xac nhan|ma bao mat)[^0-9]{0,20}[0-9]{4,8}(?![0-9])/;
const PASSWORD_RE = /\b(mat khau|password|passcode|pin)\s*(?:la|is)?\s*[:=]?\s*\S{4,}/;
const BANK_ACCOUNT_RE = /\b(stk|so tai khoan|so tk)\s*[:=]?\s*[0-9]{8,19}(?![0-9])/;
const PRIVATE_KEY_RE = /-----begin [a-z ]*private key-----/;

export function checkSensitive(text: string): SensitiveFinding[] {
  const s = fold(text);
  const found = new Set<SensitiveKind>();

  for (const m of s.matchAll(CARD_RE)) {
    const digits = m[0].replace(/[^0-9]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) found.add('card_number');
  }
  if (NATIONAL_ID_RE.test(s)) found.add('national_id');
  if (OTP_RE.test(s)) found.add('otp');
  if (PASSWORD_RE.test(s)) found.add('password');
  if (BANK_ACCOUNT_RE.test(s)) found.add('bank_account');
  if (PRIVATE_KEY_RE.test(s)) found.add('private_key');

  return [...found].map((kind) => ({ kind }));
}
