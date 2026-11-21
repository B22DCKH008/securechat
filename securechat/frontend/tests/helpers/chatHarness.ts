import { vi } from 'vitest';
import { Emitter } from '../../src/lib/emitter';
import { ChatService } from '../../src/features/messages/chatService';
import { MockCryptoProvider } from '../../src/crypto/mockProvider';
import { MemoryStorage } from '../../src/storage';
import { ApiError } from '../../src/transport/rest';
import { WsSendError } from '../../src/transport/ws';
import type {
  AcceptedPayload,
  MessageEvent,
  ReceiptEvent,
  SendPayload,
} from '../../src/transport/protocol';
import type {
  ApiMessage,
  ApiReceipt,
  Conversation,
  SyncRequest,
  SyncResponse,
} from '../../src/transport/types';
import type { RiskAnalyzer } from '../../src/ai';

export const ME = 'me';
export const PEER = 'peer';
export const CONV = 'c1';
const conv: Conversation = {
  id: CONV,
  kind: 'direct',
  lastSeq: 0,
  members: [ME, PEER],
  createdAt: 'x',
};

export class FakeWs extends Emitter<any> {
  sendImpl: (p: SendPayload) => Promise<AcceptedPayload> = async (p) => ({
    clientMessageId: p.clientMessageId,
    messageId: `srv-${p.clientMessageId}`,
    conversationId: p.conversationId,
    seq: ++this.seqCounter,
    duplicate: false,
    state: 'accepted',
  });
  seqCounter = 0;
  sent: SendPayload[] = [];
  acks: { id: string; state: string }[] = [];
  ackOk = true;
  start = vi.fn();
  stop = vi.fn();
  async send(p: SendPayload) {
    this.sent.push(p);
    return this.sendImpl(p);
  }
  ack(id: string, state: 'delivered' | 'read') {
    if (!this.ackOk) return false;
    this.acks.push({ id, state });
    return true;
  }
  fire<K extends string>(ev: K, v?: unknown) {
    this.emit(ev, v as never);
  }
}

export const wsMessage = (seq: number, over: Partial<MessageEvent> = {}): MessageEvent => ({
  messageId: `m${seq}`,
  clientMessageId: `cm${seq}`,
  conversationId: CONV,
  seq,
  senderId: PEER,
  recipients: [ME],
  ciphertext: btoa(`tin ${seq}`),
  protocolMeta: { scheme: 'mock-v0' },
  acceptedAt: '2026-01-01T00:00:00Z',
  ...over,
});

export const apiMsg = (seq: number, over: Partial<ApiMessage> = {}): ApiMessage => ({
  messageId: `m${seq}`,
  clientMessageId: `cm${seq}`,
  conversationId: CONV,
  seq,
  senderId: PEER,
  ciphertext: btoa(`tin ${seq}`),
  protocolMeta: { scheme: 'mock-v0' },
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

export const receipt = (over: Partial<ReceiptEvent>): ReceiptEvent => ({
  receiptSeq: 1,
  messageId: 'x',
  conversationId: CONV,
  seq: 1,
  recipientId: PEER,
  senderId: ME,
  state: 'delivered',
  at: 'x',
  ...over,
});

export function harness(opts: { analyzer?: RiskAnalyzer; syncLimit?: number } = {}) {
  const ws = new FakeWs();
  const storage = new MemoryStorage();
  const syncCalls: SyncRequest[] = [];
  const api = {
    send: vi.fn(async (_c: string, r: { clientMessageId: string }) => ({
      messageId: `rest-${r.clientMessageId}`,
      clientMessageId: r.clientMessageId,
      conversationId: CONV,
      seq: ++ws.seqCounter,
      state: 'accepted' as const,
      duplicate: false,
    })),
    receipt: vi.fn(async () => undefined),
    listConversations: vi.fn(async () => [conv]),
    openConversation: vi.fn(async () => conv),
    syncPages: [] as SyncResponse[],
    sync: vi.fn(async (req: SyncRequest): Promise<SyncResponse> => {
      syncCalls.push(structuredClone(req));
      return api.syncPages.shift() ?? { conversations: [] };
    }),
  };
  let n = 0;
  const svc = new ChatService({
    me: { userId: ME, deviceId: 1 },
    api: api as never,
    ws: ws as never,
    crypto: new MockCryptoProvider(),
    storage,
    analyzer: opts.analyzer,
    newId: () => `id${++n}`,
    syncLimit: opts.syncLimit,
  });
  return { svc, ws, api, storage, syncCalls };
}

/** Chờ mọi tác vụ nền (void promise) hoàn tất. */
export const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

export { ApiError, WsSendError };
export type { ApiReceipt };
