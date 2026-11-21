import { beforeEach, describe, expect, it } from 'vitest';
import {
  IndexedDbStorage,
  MemoryStorage,
  type ChatStorage,
  type LocalMessage,
} from '../src/storage';
import { openStorage } from '../src/storage';

const msg = (over: Partial<LocalMessage>): LocalMessage => ({
  id: 'a',
  clientMessageId: 'a',
  conversationId: 'c1',
  senderId: 'u1',
  direction: 'out',
  text: 'hi',
  status: 'sent',
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

let n = 0;
const impls: [string, () => Promise<ChatStorage>][] = [
  ['MemoryStorage', async () => new MemoryStorage()],
  ['IndexedDbStorage', async () => IndexedDbStorage.open(`t${n++}`)],
];

describe.each(impls)('%s', (_name, make) => {
  let s: ChatStorage;
  beforeEach(async () => {
    s = await make();
  });

  it('lưu và tra cứu theo id / messageId / clientMessageId', async () => {
    await s.putMessage(msg({ id: 'x', clientMessageId: 'cm', messageId: 'srv' }));
    expect((await s.getMessage('x'))?.text).toBe('hi');
    expect((await s.findByMessageId('srv'))?.id).toBe('x');
    expect((await s.findByClientMessageId('cm'))?.id).toBe('x');
    expect(await s.findByMessageId('none')).toBeUndefined();
  });

  it('listMessages: theo seq, tin chưa có seq xếp cuối theo thời gian', async () => {
    await s.putMessage(msg({ id: '3', seq: 3 }));
    await s.putMessage(msg({ id: '1', seq: 1 }));
    await s.putMessage(msg({ id: 'p2', createdAt: '2026-01-01T00:00:02Z', status: 'sending' }));
    await s.putMessage(msg({ id: 'p1', createdAt: '2026-01-01T00:00:01Z', status: 'sending' }));
    await s.putMessage(msg({ id: 'other', conversationId: 'c2', seq: 1 }));
    expect((await s.listMessages('c1')).map((m) => m.id)).toEqual(['1', '3', 'p1', 'p2']);
  });

  it('listPending chỉ trả tin còn ciphertext chờ gửi và chưa thất bại vĩnh viễn', async () => {
    await s.putMessage(
      msg({ id: 'a', status: 'sending', pending: { ciphertext: 'AA==', protocolMeta: {} } }),
    );
    await s.putMessage(
      msg({
        id: 'b',
        status: 'failed',
        pending: { ciphertext: 'AA==', protocolMeta: {}, permanentFailure: true },
      }),
    );
    await s.putMessage(msg({ id: 'c' }));
    expect((await s.listPending()).map((m) => m.id)).toEqual(['a']);
  });

  it('cursor mặc định 0, cập nhật từng phần', async () => {
    expect(await s.getCursor('c1')).toEqual({ seq: 0, receiptSeq: 0 });
    await s.setCursor('c1', { seq: 5 });
    await s.setCursor('c1', { receiptSeq: 9 });
    expect(await s.getCursor('c1')).toEqual({ seq: 5, receiptSeq: 9 });
    expect(await s.allCursors()).toEqual({ c1: { seq: 5, receiptSeq: 9 } });
  });

  it('hội thoại và clear()', async () => {
    await s.putConversation({
      id: 'c1',
      kind: 'direct',
      lastSeq: 0,
      members: ['u1', 'u2'],
      createdAt: 'x',
    });
    expect(await s.listConversations()).toHaveLength(1);
    await s.putMessage(msg({}));
    await s.clear();
    expect(await s.listConversations()).toHaveLength(0);
    expect(await s.listMessages('c1')).toHaveLength(0);
  });
});

describe('openStorage', () => {
  it('dùng IndexedDB khi có', async () => {
    const r = await openStorage('u1');
    expect(r.persistent).toBe(true);
  });
});
