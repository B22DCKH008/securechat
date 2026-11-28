import { useEffect, useState, type FormEvent } from 'react';
import type { RegisterPayload, UserAccount } from '../features/auth/types';

interface AuthPageProps {
  onLogin: (identifier: string, password: string) => Promise<string | null>;
  onValidateRegister: (payload: RegisterPayload) => string | null;
  onCompleteRegister: (payload: RegisterPayload) => Promise<string | null>;
  onQuickLogin: (userId: string) => void;
  demoUsers: UserAccount[];
}

function generateSixDigitOtp(): string {
  const n = Math.floor(100000 + Math.random() * 900000);
  return String(n);
}

export function AuthPage({
  onLogin,
  onValidateRegister,
  onCompleteRegister,
  onQuickLogin,
  demoUsers,
}: AuthPageProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [identifier, setIdentifier] = useState('vu.tran@securechat.vn');
  const [password, setPassword] = useState('123456');

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');

  const [pendingReg, setPendingReg] = useState<RegisterPayload | null>(null);
  const [sentOtp, setSentOtp] = useState<string | null>(null);
  const [otpInput, setOtpInput] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, [secondsLeft]);

  async function handleLoginSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const err = await onLogin(identifier.trim(), password);
      if (err) setError(err);
    } finally {
      setBusy(false);
    }
  }

  function handleRequestRegisterOtp(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const payload: RegisterPayload = {
      displayName: displayName.trim(),
      username: username.trim().toLowerCase(),
      email: email.trim().toLowerCase(),
      password: regPassword,
    };
    const validationErr = onValidateRegister(payload);
    if (validationErr) {
      setError(validationErr);
      return;
    }
    const code = generateSixDigitOtp();
    setPendingReg(payload);
    setSentOtp(code);
    setOtpInput('');
    setSecondsLeft(120);
  }

  async function handleVerifyRegisterOtp(e: FormEvent) {
    e.preventDefault();
    if (!pendingReg || !sentOtp) return;
    setError(null);
    if (secondsLeft <= 0) {
      setError('Mã OTP đã hết hạn. Vui lòng bấm "Gửi lại mã OTP".');
      return;
    }
    if (otpInput.trim() !== sentOtp) {
      setError('Mã OTP không chính xác. Vui lòng kiểm tra lại.');
      return;
    }
    setBusy(true);
    try {
      const err = await onCompleteRegister(pendingReg);
      if (err) setError(err);
    } finally {
      setBusy(false);
    }
  }

  const quickAccounts = demoUsers.filter(
    (u) => u.id === 'u-vu' || u.id === 'u-linh' || u.id === 'u-email-only',
  );

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="rail-logo" style={{ marginBottom: 0 }}>SC</div>
          <div>
            <h1>SecureChat</h1>
            <p>Xác thực OTP Email & SĐT duy nhất · AI phát hiện lừa đảo theo ngữ cảnh</p>
          </div>
        </div>

        <div className="auth-tabs">
          <button
            type="button"
            className={`auth-tab ${mode === 'login' ? 'active' : ''}`}
            onClick={() => {
              setMode('login');
              setPendingReg(null);
              setError(null);
            }}
          >
            Đăng nhập
          </button>
          <button
            type="button"
            className={`auth-tab ${mode === 'register' ? 'active' : ''}`}
            onClick={() => {
              setMode('register');
              setPendingReg(null);
              setError(null);
            }}
          >
            Đăng ký (OTP)
          </button>
        </div>

        {mode === 'login' ? (
          <form onSubmit={handleLoginSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="field">
              <label htmlFor="auth-id">Email, Số điện thoại hoặc @username</label>
              <input
                id="auth-id"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="Ví dụ: vu.tran@securechat.vn hoặc 0912000001"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="auth-pass">Mật khẩu</label>
              <input
                id="auth-pass"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={6}
                required
              />
            </div>

            {error && (
              <div className="inline-alert scam" role="alert">
                <span>⚠</span>
                <span>{error}</span>
              </div>
            )}

            <button type="submit" className="btn btn-primary" disabled={busy} style={{ padding: 10 }}>
              {busy ? 'Đang đăng nhập...' : 'Đăng nhập vào SecureChat'}
            </button>
          </form>
        ) : !pendingReg ? (
          <form onSubmit={handleRequestRegisterOtp} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="field">
              <label htmlFor="reg-name">Họ và tên hiển thị</label>
              <input
                id="reg-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Ví dụ: Nguyễn Văn An"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="reg-email">
                Địa chỉ Email <span className="unique-tag">Duy nhất · Nhận OTP</span>
              </label>
              <input
                id="reg-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Ví dụ: an.nguyen@example.com"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="reg-user">Tên định danh (@username)</label>
              <input
                id="reg-user"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Ví dụ: an.nguyen"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="reg-pass">Mật khẩu</label>
              <input
                id="reg-pass"
                type="password"
                value={regPassword}
                onChange={(e) => setRegPassword(e.target.value)}
                placeholder="Tối thiểu 6 ký tự"
                minLength={6}
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
              Gửi mã OTP xác nhận Email
            </button>
            <div style={{ fontSize: 11.5, color: '#64748b' }}>
              Bước tiếp theo: Xác nhận OTP Email xong, bạn sẽ cần liên kết & xác thực OTP Số điện thoại duy nhất để mở khóa nhắn tin.
            </div>
          </form>
        ) : (
          <form onSubmit={handleVerifyRegisterOtp} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="otp-toast" role="status">
              <div>
                <strong>[Mô phỏng Email OTP]</strong> Đã gửi mã xác nhận tới <u>{pendingReg.email}</u>:
              </div>
              <div className="otp-code-display">{sentOtp}</div>
              <div style={{ fontSize: 11.5, color: '#cbd5e1' }}>
                Hiệu lực còn: <strong>{secondsLeft}s</strong> · (Môi trường thật sẽ gửi qua SMTP/SMS server)
              </div>
            </div>

            <div className="field">
              <label htmlFor="reg-otp">Nhập mã OTP 6 chữ số</label>
              <input
                id="reg-otp"
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

            <button type="submit" className="btn btn-primary" disabled={busy} style={{ padding: 10 }}>
              {busy ? 'Đang kích hoạt...' : 'Xác nhận OTP & Tiếp tục'}
            </button>

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  const code = generateSixDigitOtp();
                  setSentOtp(code);
                  setSecondsLeft(120);
                  setError(null);
                }}
              >
                Gửi lại mã OTP
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setPendingReg(null);
                  setError(null);
                }}
              >
                Quay lại sửa Email
              </button>
            </div>
          </form>
        )}

        {quickAccounts.length > 0 && !pendingReg && (
          <div className="demo-box">
            <div className="demo-box-title">
              Vào nhanh tài khoản mẫu (mật khẩu: 123456):
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {quickAccounts.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className="btn"
                  style={{ textAlign: 'left' }}
                  onClick={() => onQuickLogin(u.id)}
                >
                  {u.displayName} — {u.email}
                  {!u.phoneVerified ? ' [Test bắt buộc gắn SĐT]' : ''}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}