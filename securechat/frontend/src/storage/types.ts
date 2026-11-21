import type { Conversation } from '../transport/types';

/**
 * Trạng thái hiển thị của tin nhắn.
 *  out: sending → sent → delivered → read   (failed: lỗi gửi, có thể thử lại)
 *  in : received | undecryptable
 * delivered/read chỉ tăng, không bao giờ giảm (receipt có thể đến lộn xộn).
 */
export type MessageStatus =
  'sending' | 'failed' | 'sent' | 'delivered' | 'read' | 'received' | 'undecryptable';

export const OUT_RANK: Partial<Record<MessageStatus, number>> = { sent: 1, delivered: 2, read: 3 };

/** Tóm tắt kết quả AI lưu kèm tin (KHÔNG lưu nội dung/URL đầy đủ ngoài những gì đã có trong tin). */
export interface StoredRisk {
  level: 'none' | 'warn' | 'unknown';
  label?: string;
  /** các URL bị gắn nhãn độc hại */
  badUrls?: string[];
  modelVersion?: string;
}

export interface LocalMessage {
  /** Khóa chính cục bộ: clientMessageId với tin gửi; messageId với tin nhận. */
  id: string;
  clientMessageId: string;
  messageId?: string;
  conversationId: string;
  seq?: number;
  senderId: string;
  direction: 'in' | 'out';
  /** null khi không giải mã được */
  text: string | null;
  status: MessageStatus;
  createdAt: string;
  /** Chỉ giữ cho tin gửi chưa được server nhận: phải gửi lại ĐÚNG ciphertext này (idempotency). */
  pending?: {
    ciphertext: string;
    protocolMeta: Record<string, unknown>;
    permanentFailure?: boolean;
  };
  risk?: StoredRisk;
  error?: string;
}

export interface Cursor {
  seq: number;
  receiptSeq: number;
}

export interface ChatStorage {
  putMessage(m: LocalMessage): Promise<void>;
  getMessage(id: string): Promise<LocalMessage | undefined>;
  findByMessageId(messageId: string): Promise<LocalMessage | undefined>;
  findByClientMessageId(clientMessageId: string): Promise<LocalMessage | undefined>;
  /** Đã sắp xếp: có seq theo seq tăng dần, rồi tới tin chưa có seq theo createdAt. */
  listMessages(conversationId: string): Promise<LocalMessage[]>;
  listPending(): Promise<LocalMessage[]>;

  getCursor(conversationId: string): Promise<Cursor>;
  setCursor(conversationId: string, patch: Partial<Cursor>): Promise<void>;
  allCursors(): Promise<Record<string, Cursor>>;

  putConversation(c: Conversation): Promise<void>;
  listConversations(): Promise<Conversation[]>;

  /** Xóa mọi dữ liệu (đăng xuất). */
  clear(): Promise<void>;
}

export function sortMessages(ms: LocalMessage[]): LocalMessage[] {
  return [...ms].sort((a, b) => {
    if (a.seq !== undefined && b.seq !== undefined) return a.seq - b.seq;
    if (a.seq !== undefined) return -1;
    if (b.seq !== undefined) return 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
}
