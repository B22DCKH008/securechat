import { useState, type FormEvent } from 'react';
import { useAuth } from '../features/auth/authStore';
import { validatePassword, validateUsername } from '../features/auth/validation';

export function LoginPage() {
  const { login, register, busy, error } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);

  const uErr = validateUsername(username);
  const pErr = mode === 'register' ? validatePassword(password) : password ? null : 'Nhập mật khẩu';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (uErr || pErr) return;
    void (mode === 'login' ? login : register)({ username, password });
  };

  return (
    <main className="auth">
      <h1>SecureChat</h1>
      <form onSubmit={submit} noValidate>
        <h2>{mode === 'login' ? 'Đăng nhập' : 'Tạo tài khoản'}</h2>
        <label>
          Tên đăng nhập
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
          />
        </label>
        {touched && uErr && <p className="field-error">{uErr}</p>}
        <label>
          Mật khẩu
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
        </label>
        {touched && pErr && <p className="field-error">{pErr}</p>}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Đang xử lý…' : mode === 'login' ? 'Đăng nhập' : 'Đăng ký'}
        </button>
        <button
          type="button"
          className="link"
          onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
        >
          {mode === 'login' ? 'Chưa có tài khoản? Đăng ký' : 'Đã có tài khoản? Đăng nhập'}
        </button>
      </form>
    </main>
  );
}
