/**
 * Quản lý access/refresh token.
 *
 * Ràng buộc từ backend (docs/be1-handoff.md):
 *  - refresh token xoay vòng, dùng được ĐÚNG MỘT LẦN; dùng lại (replay) => thu hồi cả họ phiên.
 *  - client PHẢI refresh tuần tự và thay token nguyên tử.
 *
 * Hiện thực: mọi lời gọi refresh dùng chung một Promise đang chạy (single-flight); token mới chỉ được
 * lưu SAU khi server trả về thành công. Lỗi mạng (không biết server đã tiêu thụ token chưa) KHÔNG tự động
 * thử lại trong cùng lượt; nếu lần sau bị 401 thì coi như phiên hết hạn và yêu cầu đăng nhập lại.
 */
import { Emitter } from '../lib/emitter';
import type { Tokens } from './types';

export interface TokenStore {
  load(): Tokens | null;
  save(tokens: Tokens | null): void;
}

export class MemoryTokenStore implements TokenStore {
  constructor(private value: Tokens | null = null) {}
  load() {
    return this.value;
  }
  save(t: Tokens | null) {
    this.value = t;
  }
}

/**
 * Lưu trong Web Storage. Đánh đổi bảo mật: refresh token đọc được bởi mọi script cùng origin (XSS).
 * Mặc định dùng sessionStorage (mất khi đóng tab); đổi sang localStorage nếu muốn giữ đăng nhập.
 */
export class WebStorageTokenStore implements TokenStore {
  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    private readonly key = 'securechat.tokens',
  ) {}
  load(): Tokens | null {
    try {
      const raw = this.storage.getItem(this.key);
      return raw ? (JSON.parse(raw) as Tokens) : null;
    } catch {
      return null;
    }
  }
  save(t: Tokens | null): void {
    try {
      if (t) this.storage.setItem(this.key, JSON.stringify(t));
      else this.storage.removeItem(this.key);
    } catch {
      /* storage bị chặn: bỏ qua, vẫn giữ token trong bộ nhớ */
    }
  }
}

export class AuthExpiredError extends Error {
  override name = 'AuthExpiredError';
}

export interface TokenManagerOptions {
  store: TokenStore;
  /** Gọi POST /v1/auth/refresh. Phải ném lỗi có `status` (HTTP) nếu server từ chối. */
  refreshRequest: (refreshToken: string) => Promise<Tokens>;
  now?: () => number;
  /** Refresh sớm khi access token còn ít hơn khoảng này. */
  skewMs?: number;
}

export class TokenManager extends Emitter<{ sessionExpired: undefined; changed: Tokens | null }> {
  private tokens: Tokens | null;
  private inflight: Promise<Tokens> | null = null;
  private readonly now: () => number;
  private readonly skewMs: number;

  constructor(private readonly opts: TokenManagerOptions) {
    super();
    this.tokens = opts.store.load();
    this.now = opts.now ?? Date.now;
    this.skewMs = opts.skewMs ?? 30_000;
  }

  get current(): Tokens | null {
    return this.tokens;
  }

  set(tokens: Tokens | null): void {
    this.tokens = tokens;
    this.opts.store.save(tokens);
    this.emit('changed', tokens);
  }

  clear(): void {
    this.set(null);
  }

  private expiringSoon(t: Tokens): boolean {
    const exp = Date.parse(t.expiresAt);
    return Number.isFinite(exp) && exp - this.now() <= this.skewMs;
  }

  /** Access token còn hạn (tự refresh nếu sắp hết). null nếu chưa đăng nhập. */
  async getAccessToken(): Promise<string | null> {
    if (!this.tokens) return null;
    if (this.expiringSoon(this.tokens)) {
      try {
        await this.refresh();
      } catch (e) {
        if (e instanceof AuthExpiredError) return null;
        // lỗi tạm thời (mạng/429/503): vẫn thử dùng token cũ, server sẽ quyết định
      }
    }
    return this.tokens?.accessToken ?? null;
  }

  /**
   * Refresh tuần tự. `usedAccessToken`: token mà lời gọi thất bại đã dùng; nếu token hiện tại đã khác
   * (có lời gọi khác vừa refresh xong) thì không refresh nữa, chỉ trả token hiện tại.
   */
  refresh(usedAccessToken?: string): Promise<Tokens> {
    const cur = this.tokens;
    if (!cur) return Promise.reject(new AuthExpiredError('chưa đăng nhập'));
    if (usedAccessToken && cur.accessToken !== usedAccessToken && !this.inflight)
      return Promise.resolve(cur);
    this.inflight ??= this.doRefresh(cur.refreshToken).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(refreshToken: string): Promise<Tokens> {
    try {
      const next = await this.opts.refreshRequest(refreshToken);
      this.set(next); // thay nguyên tử: chỉ sau khi thành công
      return next;
    } catch (e) {
      if ((e as { status?: number }).status === 401) {
        this.clear();
        this.emit('sessionExpired', undefined);
        throw new AuthExpiredError('phiên đã hết hạn, cần đăng nhập lại');
      }
      throw e;
    }
  }
}
