/**
 * Lưu trữ bền vững bằng IndexedDB (thư viện `idb`).
 *
 * Lưu ý bảo mật: plaintext lưu KHÔNG mã hóa ở đây (bất kỳ script nào cùng origin đều đọc được; ai có máy
 * cũng đọc được). Muốn mã hóa at-rest cần khóa lấy từ mật khẩu người dùng — chưa làm, ghi trong README.
 *
 * Quy mô: listMessages đọc toàn bộ tin của một hội thoại rồi sắp xếp trong bộ nhớ. Đủ cho đồ án; nếu hội thoại
 * lên tới hàng chục nghìn tin thì cần phân trang theo index [conversationId, seq].
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Conversation } from '../transport/types';
import { sortMessages, type ChatStorage, type Cursor, type LocalMessage } from './types';

interface Schema extends DBSchema {
  messages: {
    key: string;
    value: LocalMessage;
    indexes: { byConv: string; byMessageId: string; byClientId: string };
  };
  cursors: { key: string; value: Cursor & { conversationId: string } };
  conversations: { key: string; value: Conversation };
}

export class IndexedDbStorage implements ChatStorage {
  private constructor(private readonly db: IDBPDatabase<Schema>) {}

  static async open(name = 'securechat'): Promise<IndexedDbStorage> {
    const db = await openDB<Schema>(name, 1, {
      upgrade(db) {
        const m = db.createObjectStore('messages', { keyPath: 'id' });
        m.createIndex('byConv', 'conversationId');
        m.createIndex('byMessageId', 'messageId');
        m.createIndex('byClientId', 'clientMessageId');
        db.createObjectStore('cursors', { keyPath: 'conversationId' });
        db.createObjectStore('conversations', { keyPath: 'id' });
      },
    });
    return new IndexedDbStorage(db);
  }

  close(): void {
    this.db.close();
  }

  async putMessage(m: LocalMessage) {
    await this.db.put('messages', m);
  }
  getMessage(id: string) {
    return this.db.get('messages', id);
  }
  findByMessageId(messageId: string) {
    return this.db.getFromIndex('messages', 'byMessageId', messageId);
  }
  findByClientMessageId(cmid: string) {
    return this.db.getFromIndex('messages', 'byClientId', cmid);
  }
  async listMessages(conversationId: string) {
    return sortMessages(await this.db.getAllFromIndex('messages', 'byConv', conversationId));
  }
  async listPending() {
    const all = await this.db.getAll('messages');
    return sortMessages(all.filter((m) => m.pending && !m.pending.permanentFailure));
  }
  async getCursor(conversationId: string): Promise<Cursor> {
    const c = await this.db.get('cursors', conversationId);
    return { seq: c?.seq ?? 0, receiptSeq: c?.receiptSeq ?? 0 };
  }
  async setCursor(conversationId: string, patch: Partial<Cursor>) {
    const tx = this.db.transaction('cursors', 'readwrite');
    const cur = (await tx.store.get(conversationId)) ?? { conversationId, seq: 0, receiptSeq: 0 };
    await tx.store.put({ ...cur, ...patch });
    await tx.done;
  }
  async allCursors() {
    const all = await this.db.getAll('cursors');
    return Object.fromEntries(
      all.map((c) => [c.conversationId, { seq: c.seq, receiptSeq: c.receiptSeq }]),
    );
  }
  async putConversation(c: Conversation) {
    await this.db.put('conversations', c);
  }
  listConversations() {
    return this.db.getAll('conversations');
  }
  async clear() {
    const tx = this.db.transaction(['messages', 'cursors', 'conversations'], 'readwrite');
    await Promise.all([
      tx.objectStore('messages').clear(),
      tx.objectStore('cursors').clear(),
      tx.objectStore('conversations').clear(),
      tx.done,
    ]);
  }
}
