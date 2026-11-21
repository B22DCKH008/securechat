import { describe, expect, it, vi } from 'vitest';
import { AuthExpiredError, MemoryTokenStore, TokenManager } from '../../src/transport/tokenManager';
import { tokens } from '../helpers/fakes';

function setup(refreshRequest: (r: string) => Promise<ReturnType<typeof tokens>>, now = () => 0) {
  const store = new MemoryTokenStore(tokens(1));
  const tm = new TokenManager({ store, refreshRequest, now });
  return { store, tm };
}

describe('TokenManager', () => {
  it('nhiều lời gọi refresh đồng thời chỉ gửi MỘT request (single-flight)', async () => {
    const req = vi.fn(async () => tokens(2));
    const { tm } = setup(req);
    const [a, b, c] = await Promise.all([tm.refresh(), tm.refresh(), tm.refresh()]);
    expect(req).toHaveBeenCalledTimes(1);
    expect(req).toHaveBeenCalledWith('ref1');
    expect([a, b, c].every((t) => t.accessToken === 'acc2')).toBe(true);
  });

  it('token mới được lưu nguyên tử sau khi thành công', async () => {
    const { tm, store } = setup(async () => tokens(2));
    await tm.refresh();
    expect(store.load()?.refreshToken).toBe('ref2');
  });

  it('401 từ refresh => xóa phiên, phát sessionExpired, ném AuthExpiredError', async () => {
    const { tm, store } = setup(async () => {
      throw Object.assign(new Error('x'), { status: 401 });
    });
    const expired = vi.fn();
    tm.on('sessionExpired', expired);
    await expect(tm.refresh()).rejects.toBeInstanceOf(AuthExpiredError);
    expect(store.load()).toBeNull();
    expect(expired).toHaveBeenCalledOnce();
  });

  it('lỗi mạng khi refresh KHÔNG xóa phiên (chưa biết server đã tiêu thụ token chưa)', async () => {
    const { tm, store } = setup(async () => {
      throw new TypeError('network');
    });
    await expect(tm.refresh()).rejects.toBeInstanceOf(TypeError);
    expect(store.load()?.refreshToken).toBe('ref1');
  });

  it('không refresh lại nếu token đã được thay bởi lời gọi khác', async () => {
    const req = vi.fn(async () => tokens(3));
    const { tm } = setup(req);
    tm.set(tokens(2)); // ai đó vừa refresh xong
    const t = await tm.refresh('acc1'); // lời gọi cũ dùng acc1 bị 401
    expect(req).not.toHaveBeenCalled();
    expect(t.accessToken).toBe('acc2');
  });

  it('getAccessToken tự refresh khi sắp hết hạn', async () => {
    const req = vi.fn(async () => tokens(2));
    const store = new MemoryTokenStore(tokens(1, new Date(10_000).toISOString()));
    const tm = new TokenManager({ store, refreshRequest: req, now: () => 5_000, skewMs: 30_000 });
    expect(await tm.getAccessToken()).toBe('acc2');
    expect(req).toHaveBeenCalledOnce();
  });

  it('getAccessToken trả null nếu chưa đăng nhập', async () => {
    const tm = new TokenManager({
      store: new MemoryTokenStore(null),
      refreshRequest: async () => tokens(1),
    });
    expect(await tm.getAccessToken()).toBeNull();
  });
});
