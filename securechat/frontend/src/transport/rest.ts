/** REST client — khớp backend/api/openapi.yaml. */
import { TokenManager, type TokenStore, MemoryTokenStore } from './tokenManager';
import type {
  Accepted,
  ApiMessage,
  Conversation,
  Credentials,
  PublicKeyBundle,
  SendRequest,
  SyncRequest,
  SyncResponse,
  Tokens,
} from './types';

export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl?: string;
  tokenStore?: TokenStore;
  fetchFn?: FetchFn;
  now?: () => number;
}

interface ReqOpts {
  auth?: boolean;
  /** true = đã retry sau refresh, không retry nữa */
  retried?: boolean;
}

export class ApiClient {
  readonly tokens: TokenManager;
  private readonly base: string;
  private readonly fetchFn: FetchFn;

  constructor(opts: ApiClientOptions = {}) {
    this.base = (opts.baseUrl ?? '').replace(/\/$/, '');
    this.fetchFn = opts.fetchFn ?? ((i, init) => fetch(i, init));
    this.tokens = new TokenManager({
      store: opts.tokenStore ?? new MemoryTokenStore(),
      now: opts.now,
      refreshRequest: (refreshToken) =>
        this.request<Tokens>('POST', '/v1/auth/refresh', { refreshToken }, { auth: false }),
    });
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: ReqOpts = {},
  ): Promise<T> {
    const auth = opts.auth ?? true;
    const headers: Record<string, string> = {};
    let token: string | null = null;
    if (auth) {
      token = await this.tokens.getAccessToken();
      if (!token) throw new ApiError(401, 'chưa đăng nhập', 'not_authenticated');
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await this.fetchFn(this.base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 401 && auth && !opts.retried) {
      await this.tokens.refresh(token ?? undefined); // ném AuthExpiredError nếu phiên chết
      return this.request<T>(method, path, body, { ...opts, retried: true });
    }
    if (!res.ok) {
      let code: string | undefined;
      let message = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string; message?: string; code?: string };
        code = j.code ?? j.error;
        message = j.message ?? j.error ?? message;
      } catch {
        /* body không phải JSON */
      }
      throw new ApiError(res.status, message, code);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // ---- auth
  async register(c: Credentials): Promise<Tokens> {
    const t = await this.request<Tokens>(
      'POST',
      '/v1/auth/register',
      { deviceId: 1, ...c },
      { auth: false },
    );
    this.tokens.set(t);
    return t;
  }
  async login(c: Credentials): Promise<Tokens> {
    const t = await this.request<Tokens>(
      'POST',
      '/v1/auth/login',
      { deviceId: 1, ...c },
      { auth: false },
    );
    this.tokens.set(t);
    return t;
  }
  async logout(): Promise<void> {
    try {
      await this.request<void>('POST', '/v1/auth/logout');
    } finally {
      this.tokens.clear();
    }
  }

  // ---- hội thoại / tin nhắn
  async listConversations(): Promise<Conversation[]> {
    return (
      (await this.request<{ conversations: Conversation[] }>('GET', '/v1/conversations'))
        .conversations ?? []
    );
  }
  openConversation(peerUserId: string): Promise<Conversation> {
    return this.request('POST', '/v1/conversations', { peerUserId });
  }
  history(conversationId: string, p: { beforeSeq?: number; limit?: number } = {}) {
    const q = new URLSearchParams();
    if (p.beforeSeq !== undefined) q.set('before_seq', String(p.beforeSeq));
    if (p.limit !== undefined) q.set('limit', String(p.limit));
    const qs = q.size ? `?${q}` : '';
    return this.request<{ messages: ApiMessage[]; nextBeforeSeq: number | null }>(
      'GET',
      `/v1/conversations/${conversationId}/messages${qs}`,
    );
  }
  /** Gửi qua REST (dự phòng khi WS không mở). Idempotent theo clientMessageId. */
  send(conversationId: string, req: SendRequest): Promise<Accepted> {
    return this.request('POST', `/v1/conversations/${conversationId}/messages`, req);
  }
  receipt(messageId: string, state: 'delivered' | 'read'): Promise<void> {
    return this.request('POST', `/v1/messages/${messageId}/receipts`, { state });
  }
  sync(req: SyncRequest): Promise<SyncResponse> {
    return this.request('POST', '/v1/sync', req);
  }

  // ---- khóa công khai (SC2)
  putKeyBundle(b: PublicKeyBundle): Promise<void> {
    return this.request('PUT', '/v1/keys/bundle', b);
  }
  getPeerBundle(userId: string, deviceId: number): Promise<PublicKeyBundle> {
    return this.request('GET', `/v1/users/${userId}/devices/${deviceId}/bundle`);
  }
}
