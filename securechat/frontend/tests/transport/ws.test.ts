import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsClient, WsSendError, type WebSocketLike } from '../../src/transport/ws';
import type { SendPayload } from '../../src/transport/protocol';
import { FakeWebSocket } from '../helpers/fakes';

const payload = (over: Partial<SendPayload> = {}): SendPayload => ({
  clientMessageId: 'cm1',
  conversationId: 'c1',
  ciphertext: 'AAAA',
  protocolMeta: {},
  ...over,
});

function make(opts: Partial<ConstructorParameters<typeof WsClient>[0]> = {}) {
  const getToken = vi.fn(async () => 'tok');
  const c = new WsClient({
    url: 'ws://x/ws',
    getToken,
    factory: (u) => new FakeWebSocket(u) as unknown as WebSocketLike,
    rng: () => 1,
    ...opts,
  });
  return { c, getToken };
}
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});
afterEach(() => vi.useRealTimers());

describe('WsClient', () => {
  it('kết nối kèm access_token và phát open', async () => {
    const { c } = make();
    const onOpen = vi.fn();
    c.on('open', onOpen);
    c.start();
    await flush();
    expect(FakeWebSocket.last.url).toBe('ws://x/ws?access_token=tok');
    FakeWebSocket.last.open();
    expect(c.status).toBe('open');
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('send → accepted ghép theo ref', async () => {
    const { c } = make();
    c.start();
    await flush();
    FakeWebSocket.last.open();
    const p = c.send(payload());
    const frame = FakeWebSocket.last.frames()[0]!;
    expect(frame.type).toBe('send');
    FakeWebSocket.last.recv({
      type: 'accepted',
      ref: frame.ref,
      payload: {
        clientMessageId: 'cm1',
        messageId: 'm1',
        conversationId: 'c1',
        seq: 5,
        duplicate: false,
        state: 'accepted',
      },
    });
    await expect(p).resolves.toMatchObject({ seq: 5, messageId: 'm1' });
  });

  it('error có ref → từ chối đúng lời gửi', async () => {
    const { c } = make();
    c.start();
    await flush();
    FakeWebSocket.last.open();
    const p = c.send(payload());
    const ref = FakeWebSocket.last.frames()[0]!.ref;
    FakeWebSocket.last.recv({ type: 'error', ref, payload: { code: 'forbidden', message: 'no' } });
    await expect(p).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('chưa mở => từ chối ngay not_connected', async () => {
    const { c } = make();
    await expect(c.send(payload())).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('từ chối ciphertext > 64 KiB và protocolMeta > 4096 B trước khi gửi', async () => {
    const { c } = make();
    c.start();
    await flush();
    FakeWebSocket.last.open();
    const big = btoa('a'.repeat(64 * 1024 + 1));
    await expect(c.send(payload({ ciphertext: big }))).rejects.toMatchObject({ code: 'too_large' });
    await expect(c.send(payload({ protocolMeta: { x: 'a'.repeat(5000) } }))).rejects.toMatchObject({
      code: 'meta_too_large',
    });
    expect(FakeWebSocket.last.sent).toHaveLength(0);
  });

  it('tin nhóm: giới hạn tính trên tổng các bản ciphertexts', () => {
    const group = (...sizes: number[]): SendPayload => {
      const p = payload();
      delete p.ciphertext;
      p.ciphertexts = sizes.map((n, i) => ({
        recipientId: `u${i}`,
        ciphertext: btoa('a'.repeat(n)),
      }));
      return p;
    };
    expect(() => WsClient.validate(group(32 * 1024, 32 * 1024))).not.toThrow();
    expect(() => WsClient.validate(group(40 * 1024, 30 * 1024))).toThrow(
      expect.objectContaining({ code: 'too_large' }),
    );
  });

  it('thiếu cả ciphertext lẫn ciphertexts thì bị từ chối ngay', () => {
    const p = payload();
    delete p.ciphertext;
    expect(() => WsClient.validate(p)).toThrow(expect.objectContaining({ code: 'invalid' }));
  });

  it('đúng 64 KiB thì được phép', () => {
    expect(() =>
      WsClient.validate(payload({ ciphertext: btoa('a'.repeat(64 * 1024)) })),
    ).not.toThrow();
  });

  it('timeout khi server không trả lời', async () => {
    const { c } = make({ sendTimeoutMs: 1000 });
    c.start();
    await flush();
    FakeWebSocket.last.open();
    const p = c.send(payload());
    const assertion = expect(p).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
  });

  it('mất kết nối => lời gửi đang chờ bị từ chối, rồi reconnect theo backoff', async () => {
    const { c } = make();
    c.start();
    await flush();
    FakeWebSocket.last.open();
    const p = c.send(payload());
    const assertion = expect(p).rejects.toBeInstanceOf(WsSendError);
    FakeWebSocket.last.serverClose(1001);
    await assertion;
    expect(c.status).toBe('reconnecting');
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600); // rng=1 → 500ms
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('backoff tăng khi kết nối thất bại liên tiếp và reset khi mở được', async () => {
    const { c } = make();
    c.start();
    await flush();
    FakeWebSocket.last.serverClose(1006); // lần 1: 500ms
    await vi.advanceTimersByTimeAsync(501);
    FakeWebSocket.last.serverClose(1006); // lần 2: 1000ms
    await vi.advanceTimersByTimeAsync(900);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(FakeWebSocket.instances).toHaveLength(3);
    FakeWebSocket.last.open();
    FakeWebSocket.last.serverClose(1006); // reset → 500ms
    await vi.advanceTimersByTimeAsync(501);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it('1008: refresh được thì reconnect; không được thì auth_failed và dừng', async () => {
    const ok = make({ onAuthRejected: async () => true });
    ok.c.start();
    await flush();
    FakeWebSocket.last.open();
    FakeWebSocket.last.serverClose(1008);
    await vi.advanceTimersByTimeAsync(600);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.reset();
    const bad = make({ onAuthRejected: async () => false });
    bad.c.start();
    await flush();
    FakeWebSocket.last.open();
    FakeWebSocket.last.serverClose(1008);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bad.c.status).toBe('auth_failed');
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('1013: chờ lâu hơn bình thường', async () => {
    const { c } = make();
    c.start();
    await flush();
    FakeWebSocket.last.open();
    FakeWebSocket.last.serverClose(1013);
    await vi.advanceTimersByTimeAsync(600);
    expect(FakeWebSocket.instances).toHaveLength(1); // bình thường sẽ là 500ms
    await vi.advanceTimersByTimeAsync(1500);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('không có token (phiên chết) => auth_failed, không mở socket', async () => {
    const { c } = make({ getToken: async () => null });
    c.start();
    await flush();
    expect(c.status).toBe('auth_failed');
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('phát message / receipt / resync', async () => {
    const { c } = make();
    const m = vi.fn(),
      r = vi.fn(),
      s = vi.fn();
    c.on('message', m);
    c.on('receipt', r);
    c.on('resync', s);
    c.start();
    await flush();
    FakeWebSocket.last.open();
    FakeWebSocket.last.recv({ type: 'message', payload: { messageId: 'm1' } });
    FakeWebSocket.last.recv({ type: 'receipt', payload: { messageId: 'm1', state: 'read' } });
    FakeWebSocket.last.recv({ type: 'resync' });
    expect(m).toHaveBeenCalledOnce();
    expect(r).toHaveBeenCalledOnce();
    expect(s).toHaveBeenCalledOnce();
  });

  it('heartbeat: gửi ping, không có pong thì đóng và reconnect', async () => {
    const { c } = make({ pingIntervalMs: 1000, pongTimeoutMs: 500 });
    c.start();
    await flush();
    FakeWebSocket.last.open();
    await vi.advanceTimersByTimeAsync(1001);
    expect(FakeWebSocket.instances[0]!.frames().some((f) => f.type === 'ping')).toBe(true);
    await vi.advanceTimersByTimeAsync(600); // quá pongTimeout
    expect(FakeWebSocket.instances[0]!.closedWith).toBe(4000);
    await vi.advanceTimersByTimeAsync(600);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('stop() đóng và không reconnect nữa', async () => {
    const { c } = make();
    c.start();
    await flush();
    FakeWebSocket.last.open();
    c.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(c.status).toBe('stopped');
  });

  it('ack gửi khi mở, trả false khi chưa mở', async () => {
    const { c } = make();
    expect(c.ack('m1', 'read')).toBe(false);
    c.start();
    await flush();
    FakeWebSocket.last.open();
    expect(c.ack('m1', 'read')).toBe(true);
    expect(FakeWebSocket.last.frames()[0]).toMatchObject({
      type: 'ack',
      payload: { messageId: 'm1', state: 'read' },
    });
  });
});
