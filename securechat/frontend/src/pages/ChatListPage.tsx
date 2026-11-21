import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSettings } from '../app/settings';
import { useAuth } from '../features/auth/authStore';
import { validatePeerId } from '../features/auth/validation';
import { peerOf } from '../features/messages/model';
import { useConversations, useWsStatus } from '../features/messages/hooks';
import { AiStatus } from '../components/warnings/AiStatus';
import { E2eeBanner } from '../components/warnings/E2eeBanner';
import type { Session } from '../app/session';

const WS_VI = {
  idle: 'Chưa kết nối',
  connecting: 'Đang kết nối…',
  open: 'Đã kết nối',
  reconnecting: 'Đang kết nối lại…',
  auth_failed: 'Cần đăng nhập lại',
  stopped: 'Đã dừng',
} as const;

export function ChatListPage({ session }: { session: Session }) {
  const nav = useNavigate();
  const logout = useAuth((s) => s.logout);
  const convs = useConversations(session.chat);
  const wsStatus = useWsStatus(session.ws);
  const { aiEnabled, setAiEnabled } = useSettings();
  const [peerId, setPeerId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void session.chat.refreshConversations().catch(() => undefined);
  }, [session]);

  const open = async (e: FormEvent) => {
    e.preventDefault();
    const bad = validatePeerId(peerId);
    if (bad) return setErr(bad);
    if (peerId.trim() === session.user.userId) return setErr('Không thể trò chuyện với chính mình');
    try {
      const c = await session.chat.openWith(peerId.trim().toLowerCase());
      nav(`/c/${c.id}`);
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  };

  return (
    <main className="page">
      <header className="topbar">
        <h1>Tin nhắn</h1>
        <button type="button" onClick={() => void logout()}>
          Đăng xuất
        </button>
      </header>
      <E2eeBanner crypto={session.crypto} />
      {!session.persistentStorage && (
        <div className="banner">
          Trình duyệt không cho lưu dữ liệu: lịch sử sẽ mất khi đóng tab.
        </div>
      )}

      <section className="card">
        <p>
          Kết nối: <strong>{WS_VI[wsStatus]}</strong> · <AiStatus analyzer={session.analyzer} />
        </p>
        <label className="switch">
          <input
            type="checkbox"
            checked={aiEnabled}
            onChange={(e) => setAiEnabled(e.target.checked)}
          />{' '}
          Cảnh báo bằng AI trên thiết bị
        </label>
        <p className="muted small">
          ID của bạn (gửi cho người muốn nhắn với bạn):
          <br />
          <code>{session.user.userId}</code>{' '}
          <button
            type="button"
            className="link"
            onClick={() =>
              void navigator.clipboard?.writeText(session.user.userId).then(() => setCopied(true))
            }
          >
            {copied ? 'Đã chép' : 'Chép'}
          </button>
        </p>
      </section>

      <section className="card">
        <h2>Bắt đầu cuộc trò chuyện</h2>
        <form onSubmit={open} className="row">
          <input
            value={peerId}
            onChange={(e) => setPeerId(e.target.value)}
            placeholder="ID (UUID) của người nhận"
            aria-label="ID người nhận"
          />
          <button type="submit" className="primary">
            Mở
          </button>
        </form>
        {err && <p className="field-error">{err}</p>}
        <p className="muted small">Backend hiện chưa có API tìm người dùng, nên cần nhập ID.</p>
      </section>

      <ul className="conv-list">
        {convs.map((c) => (
          <li key={c.id}>
            <Link to={`/c/${c.id}`}>
              <span className="conv-name">
                {(peerOf(c.members, session.user.userId) ?? '—').slice(0, 8)}…
              </span>
              <span className="muted small">{c.lastSeq} tin</span>
            </Link>
          </li>
        ))}
        {convs.length === 0 && <li className="empty">Chưa có cuộc trò chuyện nào.</li>}
      </ul>
    </main>
  );
}
