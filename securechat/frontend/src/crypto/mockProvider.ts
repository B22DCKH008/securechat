/**
 * ⚠ KHÔNG PHẢI MÃ HÓA. Chỉ để chạy được luồng gửi/nhận/đồng bộ trước khi có thư viện Signal.
 * "ciphertext" ở đây là UTF-8 của plaintext, đánh dấu scheme 'mock-v0' trong protocolMeta để không ai nhầm.
 * Backend vẫn thấy một blob + meta như thật, nên toàn bộ kiểm thử transport/idempotency/sync dùng được.
 */
import { DecryptError, type CryptoProvider, type EncryptedMessage, type PeerRef } from './types';
import type { PublicKeyBundle } from '../transport/types';

export const MOCK_SCHEME = 'mock-v0';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export class MockCryptoProvider implements CryptoProvider {
  readonly kind = 'mock' as const;
  readonly isRealE2EE = false;

  async init(self: PeerRef): Promise<PublicKeyBundle> {
    // Bundle giả: không có khóa thật. Backend chỉ lưu blob nên vẫn chấp nhận; đừng dùng cho môi trường thật.
    return {
      deviceId: self.deviceId,
      registrationId: 1,
      identityKey: 'AA==',
      signedPreKeyId: 1,
      signedPreKey: 'AA==',
      signedPreKeySignature: 'AA==',
    };
  }

  async encrypt(_peer: PeerRef, plaintext: string): Promise<EncryptedMessage> {
    return { ciphertext: enc.encode(plaintext), protocolMeta: { scheme: MOCK_SCHEME } };
  }

  async decrypt(
    _peer: PeerRef,
    ciphertext: Uint8Array,
    protocolMeta: Record<string, unknown>,
  ): Promise<string> {
    if (protocolMeta?.scheme !== MOCK_SCHEME) {
      throw new DecryptError(`scheme không được hỗ trợ: ${String(protocolMeta?.scheme)}`);
    }
    try {
      return dec.decode(ciphertext);
    } catch {
      throw new DecryptError('dữ liệu không phải UTF-8 hợp lệ');
    }
  }

  async wipe(): Promise<void> {
    /* không có khóa để xóa */
  }
}
