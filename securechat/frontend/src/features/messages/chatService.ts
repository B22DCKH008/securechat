/**
 * ChatService: điều phối gửi/nhận tin giữa transport (REST+WS), crypto, storage và AI.
 *
 * Bất biến quan trọng (xem docs backend):
 *  1. Giao hàng at-least-once  → khử trùng theo messageId; sắp xếp theo seq.
 *  2. seq liền mạch theo hội thoại → tin đến WS có seq > cursor+1 nghĩa là hụt → gọi /v1/sync, không tự bỏ qua.
 *  3. Gửi lại phải dùng ĐÚNG clientMessageId + ĐÚNG ciphertext đã lưu (nếu khác payload → 409 idempotency_conflict).
 *  4. Mỗi tin chỉ có một ciphertext → người gửi tự giữ plaintext ở local (LocalMessage.text).
 *  5. Mọi thay đổi dữ liệu của MỘT hội thoại đi qua hàng đợi tuần tự (giải mã Signal cần đúng thứ tự, tránh race
 *     giữa WS và sync).
 *  6. Receipt: gộp đơn điệu (delivered → read, không hạ), cursor receiptSeq tách biệt với cursor tin nhắn.
 */
import { Emitter } from '../../lib/emitter';
import { base64ToBytes, bytesToBase64 } from '../../lib/base64';
import { KeyedSerialQueue } from '../../lib/serialQueue';
import { uuid } from '../../lib/uuid';
import type { CryptoProvider } from '../../crypto';
import type { ApiClient } from '../../transport/rest';
import type { WsClient } from '../../transport/ws';
import { WsClient as WsClientStatic } from '../../transport/ws';
import type { AcceptedPayload, SendPayload } from '../../transport/protocol';
import type { ApiMessage, ApiReceipt, Conversation } from '../../transport/types';
import type { ChatStorage, LocalMessage } from '../../storage';
import { assessRisk, type RiskAnalyzer } from '../../ai';
import {
  errorText,
  fromWsEvent,
  fromWsReceipt,
  isRetryable,
  peerOf,
  senderDevice,
  shouldFallbackToRest,
  toStoredRisk,
  upgradeStatus,
} from './model';

export interface ChatServiceDeps {
  me: { userId: string; deviceId: number };
  api: Pick<ApiClient, 'send' | 'receipt' | 'sync' | 'listConversations' | 'openConversation'>;
  ws: Pick<WsClient, 'send' | 'ack' | 'on' | 'start' | 'stop'>;
  crypto: CryptoProvider;
  storage: ChatStorage;
  /** Không có => không phân tích tin nhận (risk không được ghi). */
  analyzer?: RiskAnalyzer;
  now?: () => Date;
  newId?: () => string;
  /** Số tin mỗi trang sync (backend tối đa 200). */
  syncLimit?: number;
}

type Events = {
  /** Dữ liệu của một hội thoại đổi (tin mới, trạng thái, risk...). */
  changed: { conversationId: string };
  conversations: undefined;
  error: { where: string; message: string };
};

export class ChatService extends Emitter<Events> {
  private readonly queue = new KeyedSerialQueue();
  private readonly unsub: (() => void)[] = [];
  /** Receipt đến trước khi biết messageId của tin mình gửi (accepted chưa về). */
  private readonly orphanReceipts = new Map<string, 'delivered' | 'read'>();
  private syncing: Promise<void> | null = null;
  private syncAgain = false;
  private started = false;
  private convCache = new Map<string, Conversation>();
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly d: ChatServiceDeps) {
    super();
    this.now = d.now ?? (() => new Date());
    this.newId = d.newId ?? uuid;
  }

  // ---------------------------------------------------------------- vòng đời
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const c of await this.d.storage.listConversations()) this.convCache.set(c.id, c);
    this.unsub.push(
      this.d.ws.on('open', () => {
        void this.onConnected();
      }),
      this.d.ws.on('message', (ev) => {
        const m = fromWsEvent(ev);
        void this.queue
          .run(m.conversationId, () => this.ingest(m.conversationId, [m], false))
          .catch((e) => this.fail('ws.message', e));
      }),
      this.d.ws.on('receipt', (r) => {
        const rc = fromWsReceipt(r);
        void this.queue
          .run(rc.conversationId, () => this.applyReceipts(rc.conversationId, [rc]))
          .catch((e) => this.fail('ws.receipt', e));
      }),
      this.d.ws.on('resync', () => {
        void this.syncAll().catch((e) => this.fail('resync', e));
      }),
    );
    this.d.ws.start();
  }

  stop(): void {
    this.started = false;
    for (const u of this.unsub.splice(0)) u();
    this.d.ws.stop();
  }

  private fail(where: string, e: unknown) {
    this.emit('error', { where, message: errorText(e) });
  }

  private async onConnected(): Promise<void> {
    try {
      await this.syncAll();
      await this.retryPending();
    } catch (e) {
      this.fail('connect', e);
    }
  }

  // ---------------------------------------------------------------- hội thoại
  async listConversations(): Promise<Conversation[]> {
    return this.d.storage.listConversations();
  }

  async refreshConversations(): Promise<Conversation[]> {
    const list = await this.d.api.listConversations();
    for (const c of list) {
      this.convCache.set(c.id, c);
      await this.d.storage.putConversation(c);
    }
    this.emit('conversations', undefined);
    return list;
  }

  /** Mở (hoặc tạo) hội thoại 1:1 với người dùng `peerUserId` (UUID). */
  async openWith(peerUserId: string): Promise<Conversation> {
    const c = await this.d.api.openConversation(peerUserId);
    this.convCache.set(c.id, c);
    await this.d.storage.putConversation(c);
    this.emit('conversations', undefined);
    return c;
  }

  private async conversation(id: string): Promise<Conversation> {
    const hit = this.convCache.get(id);
    if (hit) return hit;
    await this.refreshConversations();
    const c = this.convCache.get(id);
    if (!c) throw new Error(`không tìm thấy hội thoại ${id}`);
    return c;
  }

  async messages(conversationId: string): Promise<LocalMessage[]> {
    return this.d.storage.listMessages(conversationId);
  }

  // ---------------------------------------------------------------- gửi
  /** Mã hóa, lưu cục bộ rồi gửi. Trả về bản ghi local ngay khi đã lưu (trước khi server nhận). */
  async sendText(
    conversationId: string,
    text: string,
    risk?: LocalMessage['risk'],
  ): Promise<LocalMessage> {
    const conv = await this.conversation(conversationId);
    const peerId = peerOf(conv.members, this.d.me.userId);
    if (!peerId) throw new Error('hội thoại không có người nhận');

    const id = this.newId();
    const msg = await this.queue.run(conversationId, async () => {
      const m: LocalMessage = {
        id,
        clientMessageId: id,
        conversationId,
        senderId: this.d.me.userId,
        direction: 'out',
        text,
        status: 'sending',
        createdAt: this.now().toISOString(),
        risk,
      };
      try {
        const enc = await this.d.crypto.encrypt({ userId: peerId, deviceId: 1 }, text);
        m.pending = { ciphertext: bytesToBase64(enc.ciphertext), protocolMeta: enc.protocolMeta };
        WsClientStatic.validate(this.payloadOf(m)); // quá lớn => lỗi vĩnh viễn, không tốn mạng
      } catch (e) {
        m.status = 'failed';
        m.error = errorText(e);
        if (m.pending) m.pending.permanentFailure = true;
      }
      await this.d.storage.putMessage(m);
      this.emit('changed', { conversationId });
      return m;
    });
    if (msg.status === 'sending') void this.transmit(msg.id);
    return msg;
  }

  /** Thử lại một tin gửi lỗi. Dùng lại đúng ciphertext đã lưu. */
  async retry(id: string): Promise<void> {
    const m = await this.d.storage.getMessage(id);
    if (!m || m.direction !== 'out' || m.messageId) return;
    if (m.pending?.permanentFailure) return;
    if (!m.pending) {
      // lần mã hóa trước thất bại: mã hóa lại (chưa có gì gửi đi nên không vi phạm idempotency)
      const conv = await this.conversation(m.conversationId);
      const peerId = peerOf(conv.members, this.d.me.userId);
      if (!peerId || m.text === null) return;
      await this.queue.run(m.conversationId, async () => {
        const enc = await this.d.crypto.encrypt({ userId: peerId, deviceId: 1 }, m.text!);
        m.pending = { ciphertext: bytesToBase64(enc.ciphertext), protocolMeta: enc.protocolMeta };
        m.status = 'sending';
        m.error = undefined;
        await this.d.storage.putMessage(m);
      });
    } else {
      m.status = 'sending';
      m.error = undefined;
      await this.d.storage.putMessage(m);
      this.emit('changed', { conversationId: m.conversationId });
    }
    await this.transmit(id);
  }

  /** Gửi lại mọi tin còn chờ (sau khi kết nối lại), theo thứ tự tạo. */
  async retryPending(): Promise<void> {
    for (const m of await this.d.storage.listPending()) {
      if (m.pending) await this.transmit(m.id);
    }
  }

  private payloadOf(m: LocalMessage): SendPayload {
    return {
      clientMessageId: m.clientMessageId,
      conversationId: m.conversationId,
      ciphertext: m.pending!.ciphertext,
      protocolMeta: m.pending!.protocolMeta,
      clientCreatedAt: m.createdAt,
    };
  }

  private async transmit(id: string): Promise<void> {
    const m = await this.d.storage.getMessage(id);
    if (!m?.pending || m.messageId) return;
    const payload = this.payloadOf(m);
    try {
      let acc: AcceptedPayload;
      try {
        acc = await this.d.ws.send(payload);
      } catch (e) {
        if (!shouldFallbackToRest(e)) throw e;
        const r = await this.d.api.send(m.conversationId, {
          clientMessageId: payload.clientMessageId,
          ciphertext: payload.ciphertext,
          protocolMeta: payload.protocolMeta,
          clientCreatedAt: payload.clientCreatedAt,
        });
        acc = { ...r, state: 'accepted' };
      }
      await this.queue.run(m.conversationId, () => this.onAccepted(id, acc));
    } catch (e) {
      await this.queue.run(m.conversationId, async () => {
        const cur = await this.d.storage.getMessage(id);
        if (!cur || cur.messageId) return; // đã được nhận bởi đường khác (echo/sync)
        cur.status = 'failed';
        cur.error = errorText(e);
        if (cur.pending && !isRetryable(e)) cur.pending.permanentFailure = true;
        await this.d.storage.putMessage(cur);
        this.emit('changed', { conversationId: cur.conversationId });
      });
    }
  }

  private async onAccepted(id: string, acc: AcceptedPayload): Promise<void> {
    const m = await this.d.storage.getMessage(id);
    if (!m) return;
    m.messageId = acc.messageId;
    m.seq = acc.seq;
    m.status = upgradeStatus(
      m.status === 'sending' || m.status === 'failed' ? 'sent' : m.status,
      'sent',
    );
    m.error = undefined;
    delete m.pending;
    const orphan = this.orphanReceipts.get(acc.messageId);
    if (orphan) {
      m.status = upgradeStatus(m.status, orphan);
      this.orphanReceipts.delete(acc.messageId);
    }
    await this.d.storage.putMessage(m);
    await this.advanceCursorIfContiguous(m.conversationId, acc.seq);
    this.emit('changed', { conversationId: m.conversationId });
  }

  private async advanceCursorIfContiguous(conversationId: string, seq: number): Promise<void> {
    const { seq: cur } = await this.d.storage.getCursor(conversationId);
    if (seq === cur + 1) await this.d.storage.setCursor(conversationId, { seq });
    else if (seq > cur + 1) void this.syncAll().catch((e) => this.fail('gap', e)); // tin người khác chen giữa
  }

  // ---------------------------------------------------------------- nhận
  /**
   * Xử lý lô tin (đã chạy trong hàng đợi của hội thoại).
   * fromSync=true: server đã trả đúng thứ tự từ cursor nên tin nào cũng xử lý được.
   * fromSync=false (WS): chỉ nhận seq == cursor+1; thấp hơn là trùng, cao hơn là hụt → sync.
   */
  private async ingest(
    conversationId: string,
    batch: ApiMessage[],
    fromSync: boolean,
  ): Promise<void> {
    const sorted = [...batch].sort((a, b) => a.seq - b.seq);
    let { seq: cursor } = await this.d.storage.getCursor(conversationId);
    let gap = false;
    for (const m of sorted) {
      if (m.seq <= cursor) {
        // đã có (trùng do at-least-once) — nhưng nếu là tin của mình mà chưa ghép messageId thì ghép
        await this.mergeOwnEcho(m);
        continue;
      }
      if (!fromSync && m.seq > cursor + 1) {
        gap = true;
        break;
      }
      await this.processOne(m);
      cursor = m.seq;
      await this.d.storage.setCursor(conversationId, { seq: cursor });
    }
    this.emit('changed', { conversationId });
    if (gap) void this.syncAll().catch((e) => this.fail('gap', e));
  }

  private async mergeOwnEcho(m: ApiMessage): Promise<void> {
    if (m.senderId !== this.d.me.userId) return;
    const local = await this.d.storage.findByClientMessageId(m.clientMessageId);
    if (local && local.direction === 'out' && !local.messageId) {
      await this.d.storage.putMessage(this.mergeSent(local, m));
    }
  }

  private mergeSent(local: LocalMessage, m: ApiMessage): LocalMessage {
    const next: LocalMessage = { ...local, messageId: m.messageId, seq: m.seq, error: undefined };
    next.status = upgradeStatus(
      local.status === 'sending' || local.status === 'failed' ? 'sent' : local.status,
      'sent',
    );
    delete next.pending;
    const orphan = this.orphanReceipts.get(m.messageId);
    if (orphan) {
      next.status = upgradeStatus(next.status, orphan);
      this.orphanReceipts.delete(m.messageId);
    }
    return next;
  }

  private async processOne(m: ApiMessage): Promise<void> {
    if (await this.d.storage.findByMessageId(m.messageId)) return; // trùng

    if (m.senderId === this.d.me.userId) {
      const local = await this.d.storage.findByClientMessageId(m.clientMessageId);
      if (local && local.direction === 'out') {
        await this.d.storage.putMessage(this.mergeSent(local, m));
        return;
      }
      // Tin do CHÍNH MÌNH gửi từ thiết bị khác/đã mất dữ liệu local: ciphertext chỉ mở được bởi người nhận.
      await this.d.storage.putMessage({
        id: m.messageId,
        clientMessageId: m.clientMessageId,
        messageId: m.messageId,
        conversationId: m.conversationId,
        seq: m.seq,
        senderId: m.senderId,
        direction: 'out',
        text: null,
        status: 'undecryptable',
        createdAt: m.createdAt,
        error: 'Tin do bạn gửi từ thiết bị khác nên không đọc lại được ở đây',
      });
      return;
    }

    let text: string | null = null;
    let error: string | undefined;
    try {
      text = await this.d.crypto.decrypt(
        { userId: m.senderId, deviceId: senderDevice(m.protocolMeta) },
        base64ToBytes(m.ciphertext),
        m.protocolMeta ?? {},
      );
    } catch (e) {
      error = errorText(e);
    }
    const local: LocalMessage = {
      id: m.messageId,
      clientMessageId: m.clientMessageId,
      messageId: m.messageId,
      conversationId: m.conversationId,
      seq: m.seq,
      senderId: m.senderId,
      direction: 'in',
      text,
      status: text === null ? 'undecryptable' : 'received',
      createdAt: m.createdAt,
      error,
    };
    await this.d.storage.putMessage(local);
    void this.sendReceipt(m.messageId, 'delivered');
    if (text !== null) void this.analyzeIncoming(local.id, m.conversationId, text);
  }

  private async analyzeIncoming(id: string, conversationId: string, text: string): Promise<void> {
    if (!this.d.analyzer) return;
    try {
      const r = await assessRisk(this.d.analyzer, text, { outgoing: false });
      await this.queue.run(conversationId, async () => {
        const cur = await this.d.storage.getMessage(id);
        if (!cur) return;
        cur.risk = toStoredRisk(r);
        await this.d.storage.putMessage(cur);
        this.emit('changed', { conversationId });
      });
    } catch (e) {
      this.fail('ai', e);
    }
  }

  // ---------------------------------------------------------------- receipt
  private async sendReceipt(messageId: string, state: 'delivered' | 'read'): Promise<void> {
    if (this.d.ws.ack(messageId, state)) return;
    try {
      await this.d.api.receipt(messageId, state);
    } catch {
      /* best effort: lần sync sau server vẫn đúng trạng thái đã nhận */
    }
  }

  /** Đánh dấu đã đọc mọi tin nhận chưa đọc trong hội thoại (gọi khi người dùng đang xem). */
  async markRead(conversationId: string, readIds: Set<string> = new Set()): Promise<void> {
    const msgs = await this.d.storage.listMessages(conversationId);
    for (const m of msgs) {
      if (
        m.direction === 'in' &&
        m.messageId &&
        m.status === 'received' &&
        !readIds.has(m.messageId)
      ) {
        readIds.add(m.messageId);
        await this.sendReceipt(m.messageId, 'read');
      }
    }
  }

  private async applyReceipts(conversationId: string, receipts: ApiReceipt[]): Promise<void> {
    let maxSeq = 0;
    let changed = false;
    for (const r of receipts) {
      if (r.receiptSeq) maxSeq = Math.max(maxSeq, r.receiptSeq);
      if (r.senderId !== this.d.me.userId) continue; // receipt về tin người khác gửi
      const m = await this.d.storage.findByMessageId(r.messageId);
      if (!m) {
        const prev = this.orphanReceipts.get(r.messageId);
        if (prev !== 'read') this.orphanReceipts.set(r.messageId, r.state);
        continue;
      }
      if (m.direction !== 'out') continue;
      const next = upgradeStatus(m.status, r.state);
      if (next !== m.status) {
        m.status = next;
        await this.d.storage.putMessage(m);
        changed = true;
      }
    }
    if (maxSeq > 0) {
      const cur = await this.d.storage.getCursor(conversationId);
      if (maxSeq > cur.receiptSeq)
        await this.d.storage.setCursor(conversationId, { receiptSeq: maxSeq });
    }
    if (changed) this.emit('changed', { conversationId });
  }

  // ---------------------------------------------------------------- đồng bộ
  /** Đồng bộ mọi hội thoại. Gọi chồng sẽ gộp thành tối đa một lượt chạy thêm. */
  syncAll(): Promise<void> {
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      try {
        do {
          this.syncAgain = false;
          await this.syncOnce();
        } while (this.syncAgain);
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  private async syncOnce(): Promise<void> {
    await this.refreshConversations(); // phát hiện hội thoại mới do người khác mở
    const limit = this.d.syncLimit ?? 100;
    for (let round = 0; round < 1000; round++) {
      const cursors = await this.d.storage.allCursors();
      const convIds = [...this.convCache.keys()];
      const body = {
        cursors: Object.fromEntries(convIds.map((id) => [id, cursors[id]?.seq ?? 0])),
        receiptCursors: Object.fromEntries(convIds.map((id) => [id, cursors[id]?.receiptSeq ?? 0])),
        limit,
      };
      if (convIds.length === 0) return;
      const res = await this.d.api.sync(body);
      let more = false;
      for (const sc of res.conversations ?? []) {
        const before = cursors[sc.conversationId] ?? { seq: 0, receiptSeq: 0 };
        await this.queue.run(sc.conversationId, async () => {
          await this.ingest(sc.conversationId, sc.messages ?? [], true);
          await this.applyReceipts(sc.conversationId, sc.receipts ?? []);
        });
        const after = await this.d.storage.getCursor(sc.conversationId);
        const progressed = after.seq > before.seq || after.receiptSeq > before.receiptSeq;
        // chỉ lặp tiếp nếu còn dữ liệu VÀ vừa tiến được (chống vòng lặp vô hạn khi server trả trang rỗng)
        if ((sc.hasMore || sc.hasMoreReceipts) && progressed) more = true;
      }
      if (!more) return;
    }
  }
}
