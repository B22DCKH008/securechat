import { describe, expect, it } from 'vitest';
import {
  isRetryable,
  peerOf,
  senderDevice,
  shouldFallbackToRest,
  upgradeStatus,
} from '../../src/features/messages/model';
import { ApiError } from '../../src/transport/rest';
import { WsSendError } from '../../src/transport/ws';
import {
  validatePassword,
  validatePeerId,
  validateUsername,
} from '../../src/features/auth/validation';

describe('upgradeStatus', () => {
  it('chỉ tăng, không hạ', () => {
    expect(upgradeStatus('sent', 'delivered')).toBe('delivered');
    expect(upgradeStatus('delivered', 'read')).toBe('read');
    expect(upgradeStatus('read', 'delivered')).toBe('read');
    expect(upgradeStatus('read', 'sent')).toBe('read');
    expect(upgradeStatus('sending', 'sent')).toBe('sent');
  });
});

describe('phân loại lỗi', () => {
  it('đáng thử lại: mạng, timeout, 429, 5xx', () => {
    expect(isRetryable(new TypeError('x'))).toBe(true);
    expect(isRetryable(new WsSendError('timeout', ''))).toBe(true);
    expect(isRetryable(new ApiError(503, ''))).toBe(true);
    expect(isRetryable(new ApiError(429, ''))).toBe(true);
  });
  it('vĩnh viễn: 4xx khác, too_large, conflict', () => {
    expect(isRetryable(new ApiError(409, ''))).toBe(false);
    expect(isRetryable(new ApiError(403, ''))).toBe(false);
    expect(isRetryable(new WsSendError('too_large', ''))).toBe(false);
  });
  it('chỉ fallback REST khi WS không dùng được, không fallback khi server từ chối', () => {
    expect(shouldFallbackToRest(new WsSendError('not_connected', ''))).toBe(true);
    expect(shouldFallbackToRest(new WsSendError('forbidden', ''))).toBe(false);
  });
});

describe('tiện ích', () => {
  it('peerOf / senderDevice', () => {
    expect(peerOf(['a', 'b'], 'a')).toBe('b');
    expect(senderDevice({ deviceId: 3 })).toBe(3);
    expect(senderDevice({ deviceId: '3' })).toBe(1);
    expect(senderDevice(undefined)).toBe(1);
  });
});

describe('validation đăng ký', () => {
  it('username', () => {
    expect(validateUsername('inuc_01')).toBeNull();
    expect(validateUsername('ab')).not.toBeNull();
    expect(validateUsername('có dấu')).not.toBeNull();
  });
  it('mật khẩu tính theo BYTE UTF-8 như backend', () => {
    expect(validatePassword('a'.repeat(12))).toBeNull();
    expect(validatePassword('a'.repeat(11))).not.toBeNull();
    expect(validatePassword('ế'.repeat(4))).toBeNull(); // 4 ký tự × 3 byte = 12 byte
  });
  it('uuid', () => {
    expect(validatePeerId('123e4567-e89b-12d3-a456-426614174000')).toBeNull();
    expect(validatePeerId('abc')).not.toBeNull();
  });
});
