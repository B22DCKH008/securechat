/** Hàm thuần cho tin nhắn — tách ra để test dễ, không phụ thuộc mạng/lưu trữ. */
import type { MessageEvent, ReceiptEvent } from '../../transport/protocol';
import type { ApiMessage, ApiReceipt } from '../../transport/types';
import {
  OUT_RANK,
  type LocalMessage,
  type MessageStatus,
  type StoredRisk,
} from '../../storage/types';
import type { RiskAssessment } from '../../ai';
import { ApiError } from '../../transport/rest';
import { WsSendError } from '../../transport/ws';

export function fromWsEvent(ev: MessageEvent): ApiMessage {
  return {
    messageId: ev.messageId,
    clientMessageId: ev.clientMessageId,
    conversationId: ev.conversationId,
    seq: ev.seq,
    senderId: ev.senderId,
    ciphertext: ev.ciphertext,
    protocolMeta: ev.protocolMeta,
    createdAt: ev.acceptedAt,
    ...(ev.kind ? { kind: ev.kind } : {}),
  };
}

export const fromWsReceipt = (r: ReceiptEvent): ApiReceipt => ({ ...r });

/** Nâng trạng thái tin gửi đi; không bao giờ hạ (delivered/read chỉ tăng). */
export function upgradeStatus(
  cur: MessageStatus,
  next: 'sent' | 'delivered' | 'read',
): MessageStatus {
  const curRank = OUT_RANK[cur] ?? 0;
  return OUT_RANK[next]! > curRank ? next : cur;
}

/** Lỗi nào đáng thử lại (mạng/quá tải), lỗi nào là vĩnh viễn (dữ liệu bị từ chối). */
export function isRetryable(e: unknown): boolean {
  if (e instanceof WsSendError)
    return ['not_connected', 'connection_lost', 'timeout'].includes(e.code);
  if (e instanceof ApiError) return e.status === 429 || e.status >= 500;
  return e instanceof TypeError; // fetch thất bại do mạng
}

/** Lỗi nên thử nốt qua REST khi WS không dùng được. */
export function shouldFallbackToRest(e: unknown): boolean {
  return (
    e instanceof WsSendError && ['not_connected', 'connection_lost', 'timeout'].includes(e.code)
  );
}

export function errorText(e: unknown): string {
  if (e instanceof WsSendError || e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

export function toStoredRisk(r: RiskAssessment): StoredRisk {
  const bad = r.urls.filter((u) => u.status === 'ok' && u.label === 'malicious').map((u) => u.url);
  return {
    level: r.level,
    label: r.message.status === 'ok' ? r.message.label : undefined,
    badUrls: bad.length ? bad : undefined,
    modelVersion: r.message.status === 'ok' ? r.message.modelVersion : undefined,
  };
}

/** Người còn lại trong hội thoại 1:1. */
export function peerOf(members: string[], me: string): string | undefined {
  return members.find((m) => m !== me);
}

/** deviceId của người gửi nằm trong protocolMeta (docs backend); mặc định 1. */
export function senderDevice(meta: Record<string, unknown> | undefined): number {
  const d = meta?.deviceId;
  return typeof d === 'number' && Number.isInteger(d) && d > 0 ? d : 1;
}

export function isLocalPlaceholder(m: LocalMessage): boolean {
  return m.direction === 'out' && m.messageId === undefined;
}
