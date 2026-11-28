import { describe, expect, it } from 'vitest';
import { DecryptError } from '../src/crypto/types';
import { MockCryptoProvider } from '../src/crypto/mockProvider';
import { SignalCryptoProvider, SignalNotImplementedError } from '../src/crypto/signalProvider';
import { createCryptoProvider } from '../src/crypto';

const peer = { userId: 'u2', deviceId: 1 };

describe('MockCryptoProvider', () => {
  const p = new MockCryptoProvider();
  it('khứ hồi, kể cả tiếng Việt và emoji', async () => {
    for (const t of ['xin chào', 'Đây là tin 🚀', '']) {
      const e = await p.encrypt(peer, t);
      expect(await p.decrypt(peer, e.ciphertext, e.protocolMeta)).toBe(t);
    }
  });
  it('tự khai báo không phải E2EE thật', () => {
    expect(p.isRealE2EE).toBe(false);
    expect(p.kind).toBe('mock');
  });
  it('từ chối scheme lạ và dữ liệu hỏng bằng DecryptError', async () => {
    await expect(p.decrypt(peer, new Uint8Array([1]), { scheme: 'signal' })).rejects.toBeInstanceOf(
      DecryptError,
    );
    await expect(
      p.decrypt(peer, new Uint8Array([0xff, 0xfe]), { scheme: 'mock-v0' }),
    ).rejects.toBeInstanceOf(DecryptError);
  });
});

describe('factory', () => {
  it('mặc định mock; signal chưa cài đặt thì báo lỗi rõ ràng', async () => {
    expect(createCryptoProvider(undefined).kind).toBe('mock');
    const s = createCryptoProvider('signal');
    expect(s).toBeInstanceOf(SignalCryptoProvider);
    await expect(s.init({ userId: 'a', deviceId: 1 })).rejects.toBeInstanceOf(
      SignalNotImplementedError,
    );
  });
});
