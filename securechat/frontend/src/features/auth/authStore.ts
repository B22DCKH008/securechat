import { create } from 'zustand';
import { analyzer, api } from '../../app/services';
import { startSession, type Session } from '../../app/session';
import { ApiError } from '../../transport/rest';
import type { Credentials, Tokens } from '../../transport/types';

type Status = 'booting' | 'anon' | 'authed';

interface AuthState {
  status: Status;
  session: Session | null;
  error: string | null;
  busy: boolean;
  /** Khôi phục phiên từ token đã lưu (khi tải lại trang). */
  restore(): Promise<void>;
  login(c: Credentials): Promise<void>;
  register(c: Credentials): Promise<void>;
  logout(): Promise<void>;
}

export function authErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return 'Sai tên đăng nhập hoặc mật khẩu';
    if (e.status === 409) return 'Tên đăng nhập đã tồn tại';
    if (e.status === 429) return 'Thử quá nhiều lần, vui lòng đợi một lúc';
    if (e.status === 400) return 'Thông tin không hợp lệ';
    if (e.status >= 500) return 'Máy chủ đang bận, thử lại sau';
    return e.message;
  }
  if (e instanceof TypeError) return 'Không kết nối được máy chủ';
  return e instanceof Error ? e.message : String(e);
}

export const useAuth = create<AuthState>((set, get) => {
  const enter = async (tokens: Tokens) => {
    const session = await startSession(tokens, { api, analyzer });
    set({ status: 'authed', session, error: null });
  };

  api.tokens.on('sessionExpired', () => {
    get().session?.stop(); // giữ dữ liệu cục bộ; chỉ đăng xuất chủ động mới xóa
    set({ status: 'anon', session: null, error: 'Phiên đăng nhập đã hết hạn' });
  });

  return {
    status: 'booting',
    session: null,
    error: null,
    busy: false,

    async restore() {
      const t = api.tokens.current;
      if (!t) return set({ status: 'anon' });
      try {
        await enter(t);
      } catch {
        set({ status: 'anon' });
      }
    },

    async login(c) {
      set({ busy: true, error: null });
      try {
        await enter(await api.login(c));
      } catch (e) {
        set({ error: authErrorText(e) });
      } finally {
        set({ busy: false });
      }
    },

    async register(c) {
      set({ busy: true, error: null });
      try {
        await enter(await api.register(c));
      } catch (e) {
        set({ error: authErrorText(e) });
      } finally {
        set({ busy: false });
      }
    },

    async logout() {
      const s = get().session;
      set({ busy: true });
      try {
        await api.logout();
      } catch {
        /* vẫn đăng xuất cục bộ */
      }
      await s?.wipe();
      set({ status: 'anon', session: null, busy: false, error: null });
    },
  };
});
