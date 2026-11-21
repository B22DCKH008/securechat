/**
 * Chỗ cắm cho Signal (X3DH + Double Ratchet) chạy trong trình duyệt. CHƯA CÀI ĐẶT.
 *
 * Việc cần làm (xem README mục "Signal PoC — go/no-go"):
 *  1. Chọn thư viện và kiểm chứng: chạy được trong browser, license, bảo trì, có được kiểm toán không.
 *     Ứng viên: @privacyresearch/libsignal-protocol-typescript (GPL-3.0, chưa xác minh bảo trì/kiểm toán).
 *  2. Lưu khóa riêng ở IndexedDB (đánh đổi: XSS đọc được; cân nhắc non-extractable WebCrypto key để bọc).
 *  3. Mapping với backend: bundle -> PUT /v1/keys/bundle; lấy bundle người nhận qua
 *     GET /v1/users/{id}/devices/{deviceId}/bundle; PreKeyWhisperMessage đặt trong ciphertext, loại tin ở protocolMeta.
 *  4. Giải mã phải theo ĐÚNG thứ tự seq theo hội thoại (ChatService đã tuần tự hóa).
 *
 * Nếu PoC không đạt: giữ MockProvider + ghi rõ trong báo cáo là hạn chế, hoặc dùng WebCrypto tự thiết kế
 * (ECDH + AES-GCM, KHÔNG có ratchet — nêu rõ thiếu forward secrecy).
 */
import type { CryptoProvider, EncryptedMessage, PeerRef } from './types';
import type { PublicKeyBundle } from '../transport/types';

export class SignalNotImplementedError extends Error {
  override name = 'SignalNotImplementedError';
}

export class SignalCryptoProvider implements CryptoProvider {
  readonly kind = 'signal' as const;
  readonly isRealE2EE = true;

  init(_self: PeerRef): Promise<PublicKeyBundle> {
    return Promise.reject(
      new SignalNotImplementedError('Signal chưa được cài đặt (cần PoC chọn thư viện).'),
    );
  }
  encrypt(_peer: PeerRef, _plaintext: string): Promise<EncryptedMessage> {
    return Promise.reject(new SignalNotImplementedError('Signal chưa được cài đặt.'));
  }
  decrypt(_peer: PeerRef, _c: Uint8Array, _m: Record<string, unknown>): Promise<string> {
    return Promise.reject(new SignalNotImplementedError('Signal chưa được cài đặt.'));
  }
  wipe(): Promise<void> {
    return Promise.resolve();
  }
}
