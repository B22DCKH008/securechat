import type { Conversation } from '../transport/types';
import { sortMessages, type ChatStorage, type Cursor, type LocalMessage } from './types';

/** Lưu trong RAM — dùng cho test và khi IndexedDB không dùng được. */
export class MemoryStorage implements ChatStorage {
  private msgs = new Map<string, LocalMessage>();
  private cursors = new Map<string, Cursor>();
  private convs = new Map<string, Conversation>();

  async putMessage(m: LocalMessage) {
    this.msgs.set(m.id, structuredClone(m));
  }
  async getMessage(id: string) {
    const m = this.msgs.get(id);
    return m && structuredClone(m);
  }
  async findByMessageId(messageId: string) {
    return this.find((m) => m.messageId === messageId);
  }
  async findByClientMessageId(cmid: string) {
    return this.find((m) => m.clientMessageId === cmid);
  }
  private find(pred: (m: LocalMessage) => boolean) {
    for (const m of this.msgs.values()) if (pred(m)) return structuredClone(m);
    return undefined;
  }
  async listMessages(conversationId: string) {
    return sortMessages(
      [...this.msgs.values()].filter((m) => m.conversationId === conversationId),
    ).map((m) => structuredClone(m));
  }
  async listPending() {
    return sortMessages(
      [...this.msgs.values()].filter((m) => m.pending && !m.pending.permanentFailure),
    ).map((m) => structuredClone(m));
  }
  async getCursor(c: string): Promise<Cursor> {
    return { ...(this.cursors.get(c) ?? { seq: 0, receiptSeq: 0 }) };
  }
  async setCursor(c: string, patch: Partial<Cursor>) {
    this.cursors.set(c, { ...(await this.getCursor(c)), ...patch });
  }
  async allCursors() {
    return Object.fromEntries([...this.cursors].map(([k, v]) => [k, { ...v }]));
  }
  async putConversation(c: Conversation) {
    this.convs.set(c.id, structuredClone(c));
  }
  async listConversations() {
    return [...this.convs.values()].map((c) => structuredClone(c));
  }
  async clear() {
    this.msgs.clear();
    this.cursors.clear();
    this.convs.clear();
  }
}
