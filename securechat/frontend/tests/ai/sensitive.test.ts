import { describe, expect, it } from 'vitest';
import { checkSensitive, luhnValid } from '../../src/ai/rules/sensitive';

const kinds = (t: string) => checkSensitive(t).map((f) => f.kind);

describe('checkSensitive', () => {
  it('số thẻ hợp lệ (Luhn), có dấu cách/gạch', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(kinds('thẻ của mình 4111 1111 1111 1111 nhé')).toContain('card_number');
    expect(kinds('4111-1111-1111-1111')).toContain('card_number');
  });
  it('dãy số dài nhưng không qua Luhn => không phải thẻ', () => {
    expect(kinds('mã đơn 1234567890123456')).not.toContain('card_number');
  });
  it('CCCD/CMND theo ngữ cảnh', () => {
    expect(kinds('CCCD: 012345678901')).toContain('national_id');
    expect(kinds('số cmnd 123456789')).toContain('national_id');
    expect(kinds('liên hệ 012345678901')).not.toContain('national_id');
  });
  it('OTP / mã xác thực (có dấu tiếng Việt)', () => {
    expect(kinds('Mã OTP của tôi là 123456')).toContain('otp');
    expect(kinds('mã xác thực: 8841')).toContain('otp');
    expect(kinds('mã giảm giá 123456')).not.toContain('otp');
  });
  it('mật khẩu, số tài khoản, khóa bí mật', () => {
    expect(kinds('mật khẩu là Abc12345')).toContain('password');
    expect(kinds('mật khẩu của bạn là gì')).not.toContain('password');
    expect(kinds('STK: 0123456789 Vietcombank')).toContain('bank_account');
    expect(kinds('-----BEGIN RSA PRIVATE KEY-----')).toContain('private_key');
  });
  it('tin bình thường không có phát hiện', () => {
    expect(checkSensitive('mai 9h họp nhóm nhé, nhớ mang laptop')).toEqual([]);
  });
  it('không trả về giá trị nhạy cảm (chỉ loại)', () => {
    for (const f of checkSensitive('OTP 123456')) expect(Object.keys(f)).toEqual(['kind']);
  });
});
