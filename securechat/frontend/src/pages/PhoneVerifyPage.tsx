import { useEffect, useState, type FormEvent } from 'react';
import type { UserAccount } from '../features/auth/types';

interface PhoneVerifyPageProps {
  user: UserAccount;
  onValidatePhone: (phone: string) => string | null;
  onBindVerifiedPhone: (phone: string) => void;
  onLogout: () => void;
}

function generateSixDigitOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function PhoneVerifyPage({
  user,
  onValidatePhone,
  onBindVerifiedPhone,
  onLogout,
}: PhoneVerifyPageProps) {
  const [phone, setPhone] = useState('');
  const [pendingPhone, setPendingPhone] = useState<string | null>(null);
  const [sentOtp, setSentOtp] = useState<string | null>(null);
  const [otpInput, setOtpInput] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, [secondsLeft]);

  function handleSendSmsOtp(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const err = onValidatePhone(phone);
    if (err) {
      setError(err);
      return;
    }
    const code = generateSixDigitOtp();
    setPendingPhone(phone.trim());
    setSentOtp(code);
    setOtpInput('');
    setSecondsLeft(120);
  }

  function handleVerifySmsOtp(e: FormEvent) {
    e.preventDefault();
    if (!pendingPhone || !sentOtp) return;
    setError(null);
    if (secondsLeft <= 0) {
      setError('Mã OTP SMS đã hết hạn. Vui lòng bấm gửi lại.');
      return;
    }
    if (otpInput.trim() !== sentOtp) {
      setError('Mã OTP không khớp. Vui lòng nhập đúng 6 chữ số.');
      return;
    }
    onBindVerifiedPhone(pendingPhone);
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="rail-logo" style={{ marginBottom: 0 }}>SC</div>
          <div>
            <h1>Bắt buộc xác thực SĐT</h1>
            <p>
              Xin chào <strong>{user.displayName}</strong> ({user.email})
            </p>
          </div>
        </div>

        <div className="inline-alert spam">
          <span>🔒</span>
          <span>
            Để chống tài khoản ảo lừa đảo, bạn <strong>bắt buộc phải đăng ký và xác nhận OTP một Số điện thoại duy nhất</strong> trước khi sử dụng tính năng nhắn tin.
          </span>
        </div>

        {!pendingPhone ? (
          <form onSubmit={handleSendSmsOtp} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="field">
              <label htmlFor="bind-phone">
                Số điện thoại di động Việt Nam <span className="unique-tag">Duy nhất · Khóa vĩnh viễn</span>
              </label>
              <input
                id="bind-phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Ví dụ: 0987654321"
                required
              />
            </div>

            {error && (
              <div className="inline-alert scam" role="alert">
                <span>⚠</span>
                <span>{error}</span>
              </div>
            )}

            <button type="submit" className="btn btn-primary" style={{ padding: 10 }}>
              Gửi mã OTP qua SMS
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerifySmsOtp} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="otp-toast" role="status">
              <div>
                <strong>[Mô phỏng SMS OTP]</strong> Mã xác thực gửi tới số <u>{pendingPhone}</u>:
              </div>
              <div className="otp-code-display">{sentOtp}</div>
              <div style={{ fontSize: 11.5, color: '#cbd5e1' }}>
                Hiệu lực còn: <strong>{secondsLeft}s</strong> · Tuyệt đối không chia sẻ mã OTP này cho ai.
              </div>
            </div>

            <div className="field">
              <label htmlFor="bind-otp">Nhập mã OTP 6 chữ số từ SMS</label>
              <input
                id="bind-otp"
                inputMode="numeric"
                maxLength={6}
                value={otpInput}
                onChange={(e) => setOtpInput(e.target.value.replace(/\D/g, ''))}
                placeholder="Nhập 6 chữ số OTP"
                required
              />
            </div>

            {error && (
              <div className="inline-alert scam" role="alert">
                <span>⚠</span>
                <span>{error}</span>
              </div>
            )}

            <button type="submit" className="btn btn-primary" style={{ padding: 10 }}>
              Xác nhận SĐT & Mở khóa SecureChat
            </button>

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setSentOtp(generateSixDigitOtp());
                  setSecondsLeft(120);
                  setError(null);
                }}
              >
                Gửi lại mã SMS
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setPendingPhone(null);
                  setError(null);
                }}
              >
                Đổi số khác
              </button>
            </div>
          </form>
        )}

        <button type="button" className="btn" onClick={onLogout}>
          Đăng xuất / Chọn tài khoản khác
        </button>
      </div>
    </div>
  );
}