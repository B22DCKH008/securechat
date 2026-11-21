import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, type FetchFn } from '../../src/transport/rest';
import { MemoryTokenStore } from '../../src/transport/tokenManager';
import { jsonRes, tokens } from '../helpers/fakes';

function client(fetchFn: FetchFn, withTokens = true) {
  return new ApiClient({
    fetchFn,
    tokenStore: new MemoryTokenStore(withTokens ? tokens(1) : null),
  });
}

describe('ApiClient', () => {
  it('gắn Bearer token', async () => {
    const f = vi.fn<FetchFn>(async () => jsonRes(200, { conversations: [] }));
    await client(f).listConversations();
    expect((f.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe(
      'Bearer acc1',
    );
  });

  it('401 => refresh => thử lại ĐÚNG MỘT lần với token mới', async () => {
    const f = vi.fn<FetchFn>(async (url, init) => {
      if (url.endsWith('/v1/auth/refresh')) return jsonRes(200, tokens(2));
      const auth = (init!.headers as Record<string, string>).Authorization;
      return auth === 'Bearer acc2'
        ? jsonRes(200, { conversations: [] })
        : jsonRes(401, { error: 'expired' });
    });
    await expect(client(f).listConversations()).resolves.toEqual([]);
    expect(f.mock.calls.filter(([u]) => u.endsWith('/refresh'))).toHaveLength(1);
  });

  it('nhiều request cùng bị 401 => chỉ MỘT lần refresh (tránh replay làm thu hồi họ phiên)', async () => {
    let refreshed = false;
    const f = vi.fn<FetchFn>(async (url, init) => {
      if (url.endsWith('/v1/auth/refresh')) {
        refreshed = true;
        return jsonRes(200, tokens(2));
      }
      const auth = (init!.headers as Record<string, string>).Authorization;
      return auth === 'Bearer acc2' ? jsonRes(200, { conversations: [] }) : jsonRes(401, {});
    });
    const c = client(f);
    await Promise.all([c.listConversations(), c.listConversations(), c.listConversations()]);
    expect(refreshed).toBe(true);
    expect(f.mock.calls.filter(([u]) => u.endsWith('/refresh'))).toHaveLength(1);
  });

  it('401 sau khi đã refresh => không lặp vô hạn', async () => {
    const f = vi.fn<FetchFn>(async (url) =>
      url.endsWith('/v1/auth/refresh') ? jsonRes(200, tokens(2)) : jsonRes(401, { error: 'no' }),
    );
    await expect(client(f).listConversations()).rejects.toMatchObject({ status: 401 });
    expect(f).toHaveBeenCalledTimes(3); // gọi, refresh, gọi lại
  });

  it('chưa đăng nhập => ApiError 401, không gọi mạng', async () => {
    const f = vi.fn<FetchFn>();
    await expect(client(f, false).listConversations()).rejects.toBeInstanceOf(ApiError);
    expect(f).not.toHaveBeenCalled();
  });

  it('lỗi HTTP được chuyển thành ApiError có status và code', async () => {
    const f = vi.fn<FetchFn>(async () =>
      jsonRes(409, { code: 'idempotency_conflict', message: 'khác payload' }),
    );
    await expect(
      client(f).send('c1', { clientMessageId: 'x', ciphertext: 'AA==' }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'idempotency_conflict',
    });
  });

  it('history dùng before_seq', async () => {
    const f = vi.fn<FetchFn>(async () => jsonRes(200, { messages: [], nextBeforeSeq: null }));
    await client(f).history('c1', { beforeSeq: 50, limit: 20 });
    expect(f.mock.calls[0]![0]).toBe('/v1/conversations/c1/messages?before_seq=50&limit=20');
  });

  it('login lưu token', async () => {
    const f = vi.fn<FetchFn>(async () => jsonRes(200, tokens(7)));
    const c = client(f, false);
    await c.login({ username: 'a', password: 'b' });
    expect(c.tokens.current?.accessToken).toBe('acc7');
  });
});
