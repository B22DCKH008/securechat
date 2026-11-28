/**
 * Giao diện mã hóa đầu-cuối. UI/ChatService chỉ biết giao diện này; có thể thay MockProvider bằng Signal
 * mà không đụng chỗ khác.
 *
 * Quy ước với backend: server chỉ thấy `ciphertext` (base64) + `protocolMeta` (JSON ≤ 4096 B) và KHÔNG
 * bao giờ thấy plaintext. Mỗi tin chỉ có MỘT ciphertext (gửi cho thiết bị của người nhận), nên người gửi
 * phải tự giữ plaintext của tin mình gửi ở local (xem storage).
 */
import type { PublicKeyBundle } from '../transport/types';

export interface PeerRef {
  userId: string;
  deviceId: number;
}

export interface EncryptedMessage {
  ciphertext: Uint8Array;
  protocolMeta: Record<string, unknown>;
}

export class DecryptError extends Error {
  override name = 'DecryptError';
}

export interface CryptoProvider {
  /** 'mock' = KHÔNG mã hóa thật; UI phải hiển thị cảnh báo khi isRealE2EE=false. */
  readonly kind: 'mock' | 'signal';
  readonly isRealE2EE: boolean;

  /** Tạo/nạp khóa của thiết bị này; trả bundle CÔNG KHAI để đăng ký lên server (PUT /v1/keys/bundle). */
  init(self: PeerRef): Promise<PublicKeyBundle>;

  /** Mã hóa cho `peer`. Có thể tự gọi `fetchBundle` để lấy khóa công khai khi chưa có session. */
  encrypt(peer: PeerRef, plaintext: string): Promise<EncryptedMessage>;

  /** Giải mã tin từ `peer`. Ném DecryptError nếu không giải mã được. */
  decrypt(
    peer: PeerRef,
    ciphertext: Uint8Array,
    protocolMeta: Record<string, unknown>,
  ): Promise<string>;

  /** Xóa toàn bộ khóa/session cục bộ (đăng xuất, đổi tài khoản). */
  wipe(): Promise<void>;
}

export type BundleFetcher = (peer: PeerRef) => Promise<PublicKeyBundle>;
