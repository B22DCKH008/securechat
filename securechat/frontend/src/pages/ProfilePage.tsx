import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { ProfileUpdatePayload, UserAccount } from '../features/auth/types';

interface ProfilePageProps {
  user: UserAccount;
  myReportsCount: number;
  aiEnabled: boolean;
  modelVersion?: string;
  onSaveProfile: (payload: ProfileUpdatePayload) => void;
  onLogout: () => void;
}

function resizeAvatarToDataUrl(file: File, maxSize = 180): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Không thể đọc tệp ảnh.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Tệp ảnh không hợp lệ.'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Không khởi tạo được canvas xử lý ảnh.'));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export function ProfilePage({
  user,
  myReportsCount,
  aiEnabled,
  modelVersion,
  onSaveProfile,
  onLogout,
}: ProfilePageProps) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [bio, setBio] = useState(user.bio);
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>(user.avatarUrl);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function handleAvatarPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const dataUrl = await resizeAvatarToDataUrl(file);
      setAvatarUrl(dataUrl);
      setStatusMsg('Đã nạp ảnh đại diện mới. Bấm "Lưu thay đổi" để áp dụng.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Lỗi xử lý ảnh.');
    } finally {
      e.target.value = '';
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    const trimmedName = displayName.trim();
    if (trimmedName.length < 2) {
      setErrorMsg('Tên hiển thị cần ít nhất 2 ký tự.');
      return;
    }
    onSaveProfile({
      displayName: trimmedName,
      bio: bio.trim(),
      avatarUrl,
    });
    setStatusMsg('Đã lưu hồ sơ cá nhân thành công.');
  }

  return (
    <div className="page-scroll">
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0 }}>Hồ sơ cá nhân & Định danh bảo mật</h2>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#475569' }}>
              Bạn có thể thay đổi tên hiển thị và ảnh đại diện. Số điện thoại và email được khóa cố định làm định danh duy nhất chống mạo danh.
            </p>
          </div>
          <button type="button" className="btn btn-danger-outline" onClick={onLogout}>
            Đăng xuất / Đổi tài khoản
          </button>
        </div>

        <div className="profile-grid">
          <div className="profile-avatar-card">
            <div className="avatar xl" style={{ background: user.avatarColor }}>
              {avatarUrl ? <img src={avatarUrl} alt={displayName} /> : user.avatarText}
            </div>
            <div>
              <strong>{displayName || user.displayName}</strong>
              <div style={{ fontSize: 12.5, color: '#64748b' }}>@{user.username}</div>
            </div>

            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => void handleAvatarPick(e)}
            />

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
              <button type="button" className="btn btn-primary" onClick={() => fileRef.current?.click()}>
                Đổi ảnh đại diện
              </button>
              {avatarUrl && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setAvatarUrl(undefined);
                    setStatusMsg('Đã gỡ ảnh đại diện. Bấm "Lưu thay đổi" để áp dụng.');
                  }}
                >
                  Gỡ ảnh
                </button>
              )}
            </div>

            <div className="inspector-card" style={{ width: '100%', textAlign: 'left', marginTop: 6 }}>
              <div className="kv-row">
                <span>AI bảo vệ</span>
                <strong>{aiEnabled ? 'Đang bật' : 'Đang tắt'}</strong>
              </div>
              <div className="kv-row">
                <span>Model</span>
                <strong>{modelVersion ?? 'Chưa nạp'}</strong>
              </div>
              <div className="kv-row">
                <span>Lượt tố cáo đã gửi</span>
                <strong>{myReportsCount}</strong>
              </div>
            </div>
          </div>

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="field">
              <label htmlFor="prof-name">Tên hiển thị (có thể thay đổi)</label>
              <input
                id="prof-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            </div>

            <div className="field">
              <label htmlFor="prof-bio">Giới thiệu ngắn</label>
              <textarea
                id="prof-bio"
                rows={3}
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="Thông tin giới thiệu hiển thị trên hồ sơ của bạn..."
              />
            </div>

            <div className="field">
              <label htmlFor="prof-phone">
                Số điện thoại <span className="unique-tag">🔒 Duy nhất · Đã khóa</span>
              </label>
              <input id="prof-phone" value={user.phone} readOnly className="locked-field" />
            </div>

            <div className="field">
              <label htmlFor="prof-email">
                Email <span className="unique-tag">🔒 Duy nhất · Đã khóa</span>
              </label>
              <input id="prof-email" value={user.email} readOnly className="locked-field" />
            </div>

            <div className="field">
              <label htmlFor="prof-username">
                Tên định danh <span className="unique-tag">🔒 Duy nhất</span>
              </label>
              <input id="prof-username" value={`@${user.username}`} readOnly className="locked-field" />
            </div>

            {errorMsg && (
              <div className="inline-alert scam" role="alert">
                <span>⚠</span>
                <span>{errorMsg}</span>
              </div>
            )}

            {statusMsg && (
              <div className="inline-alert unavailable" style={{ background: '#dcfce7', borderColor: '#86efac', color: '#166534' }}>
                <span>✓</span>
                <span>{statusMsg}</span>
              </div>
            )}

            <div>
              <button type="submit" className="btn btn-primary" style={{ padding: '9px 18px' }}>
                Lưu thay đổi hồ sơ
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}