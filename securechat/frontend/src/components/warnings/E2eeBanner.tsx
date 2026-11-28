import type { CryptoProvider } from '../../crypto';

/** Hiển thị khi KHÔNG dùng mã hóa thật, để không ai nhầm bản thử nghiệm là bảo mật. */
export function E2eeBanner({ crypto }: { crypto: CryptoProvider }) {
  if (crypto.isRealE2EE) return null;
  return (
    <div className="banner banner-danger" role="alert">
      <strong>Chế độ thử nghiệm:</strong> tin nhắn CHƯA được mã hóa đầu-cuối (đang dùng mô-đun giả
      lập). Đừng gửi thông tin thật.
    </div>
  );
}
