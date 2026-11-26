import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  CONV,
  ME,
  PEER,
  WsSendError,
  apiMsg,
  harness,
  receipt,
  settle,
  wsMessage,
} from '../helpers/chatHarness';
import type { RiskAnalyzer } from '../../src/ai';
import { MOCK_SCHEME } from '../../src/crypto/mockProvider';

async function started(opts?: Parameters<typeof harness>[0]) {
  const h = harness(opts);
  await h.svc.start();
  return h;
}

describe('gửi', () => {
  it('WS accepted → lưu seq/messageId, status sent, xóa ciphertext chờ, tiến cursor', async () => {
    const { svc, storage } = await started();
    const m = await svc.sendText(CONV, 'xin chào');
    expect(m.status).toBe('sending');
    await settle();
    const [saved] = await storage.listMessages(CONV);
    expect(saved).toMatchObject({ text: 'xin chào', status: 'sent', seq: 1, messageId: 'srv-id1' });
    expect(saved!.pending).toBeUndefined();
    expect((await storage.getCursor(CONV)).seq).toBe(1);
  });

  it('server chỉ nhận ciphertext + meta, không có plaintext', async () => {
    const { svc, ws } = await started();
    await svc.sendText(CONV, 'bí mật 123');
    await settle();
    const frame = JSON.stringify(ws.sent[0]);
    expect(ws.sent[0]!.protocolMeta).toEqual({ scheme: MOCK_SCHEME });
    expect(ws.sent[0]!.clientMessageId).toBe('id1');
    expect(frame).not.toContain('bí mật'); // chỉ base64 (mock vẫn là base64 của plaintext — chỉ kiểm không lộ dạng thô)
  });

  it('WS chưa kết nối → tự dùng REST (cùng clientMessageId)', async () => {
    const { svc, ws, api, storage } = await started();
    ws.sendImpl = async () => {
      throw new WsSendError('not_connected', 'x');
    };
    await svc.sendText(CONV, 'a');
    await settle();
    expect(api.send).toHaveBeenCalledOnce();
    expect(api.send.mock.calls[0]![1].clientMessageId).toBe('id1');
    expect((await storage.listMessages(CONV))[0]!.status).toBe('sent');
  });

  it('lỗi mạng → failed nhưng giữ ciphertext; retry dùng ĐÚNG clientMessageId và ciphertext', async () => {
    const { svc, ws, api, storage } = await started();
    ws.sendImpl = async () => {
      throw new WsSendError('timeout', 'x');
    };
    api.send.mockRejectedValueOnce(new TypeError('network'));
    await svc.sendText(CONV, 'gửi lại');
    await settle();
    const failed = (await storage.listMessages(CONV))[0]!;
    expect(failed.status).toBe('failed');
    expect(failed.pending?.permanentFailure).toBeFalsy();
    const first = ws.sent[0]!;

    ws.sendImpl = async (p) => ({
      clientMessageId: p.clientMessageId,
      messageId: 'S',
      conversationId: CONV,
      seq: 1,
      duplicate: true,
      state: 'accepted',
    });
    await svc.retry('id1');
    await settle();
    const second = ws.sent[1]!;
    expect(second.clientMessageId).toBe(first.clientMessageId);
    expect(second.ciphertext).toBe(first.ciphertext);
    expect((await storage.listMessages(CONV))[0]).toMatchObject({ status: 'sent', messageId: 'S' });
  });

  it('lỗi vĩnh viễn (409) → không tự gửi lại khi reconnect', async () => {
    const { svc, ws, api, storage } = await started();
    ws.sendImpl = async () => {
      throw new WsSendError('not_connected', 'x');
    };
    api.send.mockRejectedValueOnce(new ApiError(409, 'đổi payload', 'idempotency_conflict'));
    await svc.sendText(CONV, 'a');
    await settle();
    expect((await storage.listMessages(CONV))[0]!.pending?.permanentFailure).toBe(true);
    expect(await storage.listPending()).toHaveLength(0);
  });

  it('quá 64 KiB → failed vĩnh viễn, không gọi mạng', async () => {
    const { svc, ws, api } = await started();
    const m = await svc.sendText(CONV, 'x'.repeat(70_000)); // mock: ciphertext ≈ plaintext
    expect(m.status).toBe('failed');
    expect(m.pending?.permanentFailure).toBe(true);
    await settle();
    expect(ws.sent).toHaveLength(0);
    expect(api.send).not.toHaveBeenCalled();
  });

  it('retryPending gửi lại tin dang dở theo thứ tự tạo', async () => {
    const { svc, ws, storage } = await started();
    for (const id of ['b', 'a']) {
      await storage.putMessage({
        id,
        clientMessageId: id,
        conversationId: CONV,
        senderId: ME,
        direction: 'out',
        text: id,
        status: 'sending',
        createdAt: id === 'a' ? '2026-01-01T00:00:01Z' : '2026-01-01T00:00:02Z',
        pending: { ciphertext: btoa(id), protocolMeta: {} },
      });
    }
    await svc.retryPending();
    expect(ws.sent.map((p) => p.clientMessageId)).toEqual(['a', 'b']);
  });
});

describe('nhận', () => {
  it('giải mã, lưu, gửi ack delivered, tiến cursor', async () => {
    const { ws, storage } = await started();
    ws.fire('message', wsMessage(1));
    await settle();
    expect(await storage.listMessages(CONV)).toMatchObject([
      { id: 'm1', text: 'tin 1', status: 'received', direction: 'in' },
    ]);
    expect(ws.acks).toEqual([{ id: 'm1', state: 'delivered' }]);
    expect((await storage.getCursor(CONV)).seq).toBe(1);
  });

  it('khử trùng (at-least-once): cùng messageId đến hai lần chỉ lưu một', async () => {
    const { ws, storage } = await started();
    ws.fire('message', wsMessage(1));
    ws.fire('message', wsMessage(1));
    await settle();
    expect(await storage.listMessages(CONV)).toHaveLength(1);
    expect(ws.acks).toHaveLength(1);
  });

  it('hụt seq (đến 3 khi mới có 1) → gọi sync với cursor đúng, xử lý đủ theo thứ tự', async () => {
    const { ws, api, storage, syncCalls } = await started();
    ws.fire('message', wsMessage(1));
    await settle();
    api.syncPages.push({
      conversations: [
        { conversationId: CONV, messages: [apiMsg(2), apiMsg(3)], nextCursor: 3, hasMore: false },
      ],
    });
    ws.fire('message', wsMessage(3));
    await settle();
    expect(syncCalls.at(-1)!.cursors).toEqual({ [CONV]: 1 });
    expect((await storage.listMessages(CONV)).map((m) => m.seq)).toEqual([1, 2, 3]);
    expect((await storage.getCursor(CONV)).seq).toBe(3);
  });

  it('không giải mã được → vẫn lưu "undecryptable" và tiến cursor (không kẹt hàng đợi)', async () => {
    const { ws, storage } = await started();
    ws.fire('message', wsMessage(1, { protocolMeta: { scheme: 'signal' } }));
    ws.fire('message', wsMessage(2));
    await settle();
    const ms = await storage.listMessages(CONV);
    expect(ms.map((m) => m.status)).toEqual(['undecryptable', 'received']);
    expect(ms[0]!.text).toBeNull();
    expect((await storage.getCursor(CONV)).seq).toBe(2);
  });

  it('tin hệ thống của nhóm (kind=system): không giải mã, không ack, không lưu, vẫn tiến cursor', async () => {
    const { ws, storage } = await started();
    ws.fire('message', wsMessage(1, { kind: 'system', ciphertext: '' }));
    ws.fire('message', wsMessage(2));
    await settle();
    expect((await storage.listMessages(CONV)).map((m) => m.seq)).toEqual([2]);
    expect(ws.acks).toEqual([{ id: 'm2', state: 'delivered' }]);
    expect((await storage.getCursor(CONV)).seq).toBe(2);
  });

  it('tin hệ thống đến qua sync cũng bị bỏ qua nhưng cursor đi tiếp', async () => {
    const { ws, api, storage } = await started();
    api.syncPages.push({
      conversations: [
        {
          conversationId: CONV,
          messages: [apiMsg(1, { kind: 'system', ciphertext: '' }), apiMsg(2)],
          nextCursor: 2,
          hasMore: false,
        },
      ],
    });
    ws.fire('resync');
    await settle();
    expect((await storage.listMessages(CONV)).map((m) => m.seq)).toEqual([2]);
    expect((await storage.getCursor(CONV)).seq).toBe(2);
  });

  it('danh sách hội thoại từ server: bỏ nhóm, chỉ giữ chat 1:1', async () => {
    const { svc, api, storage } = await started();
    const [direct] = await api.listConversations();
    api.listConversations.mockResolvedValueOnce([direct!, { ...direct!, id: 'g1', kind: 'group' }]);
    const list = await svc.refreshConversations();
    expect(list.map((c) => c.id)).toEqual([direct!.id]);
    expect((await storage.listConversations()).map((c) => c.id)).toEqual([direct!.id]);
  });

  it('base64 hỏng không làm sập', async () => {
    const { ws, storage } = await started();
    ws.fire('message', wsMessage(1, { ciphertext: '***' }));
    await settle();
    expect((await storage.listMessages(CONV))[0]!.status).toBe('undecryptable');
  });

  it('ack qua REST khi WS không gửi được', async () => {
    const { ws, api } = await started();
    ws.ackOk = false;
    ws.fire('message', wsMessage(1));
    await settle();
    expect(api.receipt).toHaveBeenCalledWith('m1', 'delivered');
  });

  it('echo tin của chính mình ghép vào bản local, không tạo bản trùng', async () => {
    const { svc, ws, storage } = await started();
    ws.sendImpl = async () => new Promise(() => {}); // accepted chưa về
    await svc.sendText(CONV, 'hello');
    await settle();
    ws.fire(
      'message',
      wsMessage(1, {
        senderId: ME,
        messageId: 'srv1',
        clientMessageId: 'id1',
        ciphertext: btoa('hello'),
      }),
    );
    await settle();
    const ms = await storage.listMessages(CONV);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({
      id: 'id1',
      messageId: 'srv1',
      seq: 1,
      status: 'sent',
      text: 'hello',
    });
    expect(ms[0]!.pending).toBeUndefined();
  });

  it('tin của mình từ thiết bị khác → hiển thị placeholder không đọc được', async () => {
    const { ws, storage } = await started();
    ws.fire('message', wsMessage(1, { senderId: ME }));
    await settle();
    expect((await storage.listMessages(CONV))[0]).toMatchObject({
      direction: 'out',
      text: null,
      status: 'undecryptable',
    });
  });
});

describe('receipt', () => {
  async function sent() {
    const h = await started();
    await h.svc.sendText(CONV, 'a');
    await settle();
    return h;
  }

  it('delivered → read, KHÔNG hạ khi receipt đến lộn xộn', async () => {
    const { ws, storage } = await sent();
    ws.fire('receipt', receipt({ messageId: 'srv-id1', state: 'read', receiptSeq: 2 }));
    await settle();
    ws.fire('receipt', receipt({ messageId: 'srv-id1', state: 'delivered', receiptSeq: 1 }));
    await settle();
    expect((await storage.listMessages(CONV))[0]!.status).toBe('read');
  });

  it('lưu receiptSeq (đơn điệu) tách biệt với cursor tin', async () => {
    const { ws, storage } = await sent();
    ws.fire('receipt', receipt({ messageId: 'srv-id1', receiptSeq: 7 }));
    ws.fire('receipt', receipt({ messageId: 'srv-id1', receiptSeq: 3 }));
    await settle();
    expect(await storage.getCursor(CONV)).toMatchObject({ receiptSeq: 7, seq: 1 });
  });

  it('receipt đến trước accepted được áp dụng khi accepted về', async () => {
    const { svc, ws, storage } = await started();
    let resolve!: (v: any) => void;
    ws.sendImpl = () => new Promise((r) => (resolve = r));
    await svc.sendText(CONV, 'a');
    await settle();
    ws.fire('receipt', receipt({ messageId: 'SRV', state: 'read' }));
    await settle();
    resolve({
      clientMessageId: 'id1',
      messageId: 'SRV',
      conversationId: CONV,
      seq: 1,
      duplicate: false,
      state: 'accepted',
    });
    await settle();
    expect((await storage.listMessages(CONV))[0]!.status).toBe('read');
  });

  it('receipt về tin người khác gửi bị bỏ qua', async () => {
    const { ws, storage } = await started();
    ws.fire('message', wsMessage(1));
    await settle();
    ws.fire(
      'receipt',
      receipt({ messageId: 'm1', senderId: PEER, recipientId: ME, state: 'read' }),
    );
    await settle();
    expect((await storage.listMessages(CONV))[0]!.status).toBe('received');
  });

  it('markRead gửi ack read một lần cho mỗi tin chưa đọc', async () => {
    const { svc, ws } = await started();
    ws.fire('message', wsMessage(1));
    ws.fire('message', wsMessage(2));
    await settle();
    ws.acks.length = 0;
    const seen = new Set<string>();
    await svc.markRead(CONV, seen);
    await svc.markRead(CONV, seen);
    expect(ws.acks).toEqual([
      { id: 'm1', state: 'read' },
      { id: 'm2', state: 'read' },
    ]);
  });
});

describe('đồng bộ', () => {
  it('khi kết nối: sync từ cursor lưu sẵn, phân trang theo hasMore, rồi gửi lại tin chờ', async () => {
    const { ws, api, storage, syncCalls } = await started();
    await storage.setCursor(CONV, { seq: 5, receiptSeq: 2 });
    api.syncPages.push(
      {
        conversations: [
          { conversationId: CONV, messages: [apiMsg(6), apiMsg(7)], nextCursor: 7, hasMore: true },
        ],
      },
      {
        conversations: [
          { conversationId: CONV, messages: [apiMsg(8)], nextCursor: 8, hasMore: false },
        ],
      },
    );
    await storage.putMessage({
      id: 'p',
      clientMessageId: 'p',
      conversationId: CONV,
      senderId: ME,
      direction: 'out',
      text: 'p',
      status: 'failed',
      createdAt: '2026-01-01T00:00:00Z',
      pending: { ciphertext: btoa('p'), protocolMeta: {} },
    });
    ws.fire('open');
    await settle();
    expect(syncCalls[0]).toMatchObject({ cursors: { [CONV]: 5 }, receiptCursors: { [CONV]: 2 } });
    expect(syncCalls[1]!.cursors[CONV]).toBe(7);
    expect((await storage.getCursor(CONV)).seq).toBe(8);
    expect(ws.sent.map((p) => p.clientMessageId)).toContain('p');
  });

  it('server trả hasMore nhưng không tiến → dừng, không lặp vô hạn', async () => {
    const { ws, api, syncCalls } = await started();
    for (let i = 0; i < 5; i++)
      api.syncPages.push({
        conversations: [{ conversationId: CONV, messages: [], nextCursor: 0, hasMore: true }],
      });
    ws.fire('open');
    await settle();
    expect(syncCalls.length).toBeLessThanOrEqual(2);
  });

  it('nhiều lần resync chồng nhau gộp lại (không bão request)', async () => {
    const { svc, api } = await started();
    await Promise.all([svc.syncAll(), svc.syncAll(), svc.syncAll(), svc.syncAll()]);
    expect(api.sync.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('resync từ server kích hoạt sync', async () => {
    const { ws, api } = await started();
    ws.fire('resync');
    await settle();
    expect(api.sync).toHaveBeenCalled();
  });
});

describe('AI trên tin nhận', () => {
  const analyzer = (over: Partial<RiskAnalyzer> = {}): RiskAnalyzer => ({
    init: async () => {},
    analyzeMessage: async () => ({
      status: 'ok',
      label: 'scam',
      confidence: 0.9,
      modelVersion: 'v1',
      latencyMs: 1,
    }),
    analyzeUrl: async (url) => ({
      status: 'ok',
      url,
      label: 'benign',
      confidence: 0.9,
      modelVersion: 'u1',
      latencyMs: 1,
    }),
    ...over,
  });

  it('lưu kết quả cảnh báo kèm tin nhận', async () => {
    const { ws, storage } = await started({ analyzer: analyzer() });
    ws.fire('message', wsMessage(1));
    await settle();
    expect((await storage.listMessages(CONV))[0]!.risk).toMatchObject({
      level: 'warn',
      label: 'scam',
    });
  });

  it('AI lỗi/quá hạn → level "unknown" (không báo an toàn), tin vẫn hiển thị', async () => {
    const a = analyzer({ analyzeMessage: async () => ({ status: 'timeout' }) });
    const { ws, storage } = await started({ analyzer: a });
    ws.fire('message', wsMessage(1));
    await settle();
    const m = (await storage.listMessages(CONV))[0]!;
    expect(m.text).toBe('tin 1');
    expect(m.risk?.level).toBe('unknown');
  });

  it('analyzer ném exception không làm hỏng việc nhận tin', async () => {
    const a = analyzer({
      analyzeMessage: async () => {
        throw new Error('boom');
      },
    });
    const { ws, svc, storage } = await started({ analyzer: a });
    const errors = vi.fn();
    svc.on('error', errors);
    ws.fire('message', wsMessage(1));
    await settle();
    expect((await storage.listMessages(CONV))[0]!.text).toBe('tin 1');
    expect(errors).toHaveBeenCalled();
  });
});
