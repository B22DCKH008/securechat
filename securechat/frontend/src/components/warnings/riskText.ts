/**
 * Chuyển kết quả AI thành câu chữ hiển thị. Tách riêng để kiểm thử.
 * Nguyên tắc: KHÔNG BAO GIỜ nói "an toàn". 'none' = không hiện gì; 'unknown' = nói thẳng là chưa kiểm tra được.
 */
import type { RiskAssessment } from '../../ai';
import { SENSITIVE_LABELS_VI } from '../../ai/rules/sensitive';
import type { StoredRisk } from '../../storage';

export interface RiskNote {
  kind: 'danger' | 'warning' | 'info';
  text: string;
}

const LABEL_VI: Record<string, string> = {
  scam: 'có dấu hiệu lừa đảo',
  spam: 'có dấu hiệu spam/quảng cáo rác',
};

/** Cho tin ĐÃ nhận (đọc từ StoredRisk). */
export function notesForStored(r: StoredRisk | undefined): RiskNote[] {
  if (!r) return [];
  const notes: RiskNote[] = [];
  if (r.label && LABEL_VI[r.label]) {
    notes.push({
      kind: r.label === 'scam' ? 'danger' : 'warning',
      text: `Tin nhắn ${LABEL_VI[r.label]}.`,
    });
  }
  if (r.badUrls?.length)
    notes.push({
      kind: 'danger',
      text: 'Chứa liên kết đáng ngờ — đừng bấm vào nếu chưa chắc chắn.',
    });
  if (r.level === 'unknown' && notes.length === 0) {
    notes.push({ kind: 'info', text: 'AI chưa kiểm tra được tin này (tắt hoặc gặp lỗi).' });
  }
  return notes;
}

/** Cho tin SẮP GỬI (đọc từ RiskAssessment đầy đủ, gồm cả luật nhạy cảm). */
export function notesForOutgoing(r: RiskAssessment): RiskNote[] {
  const notes: RiskNote[] = [];
  for (const s of r.sensitive) {
    notes.push({
      kind: 'danger',
      text: `Tin nhắn có vẻ chứa ${SENSITIVE_LABELS_VI[s.kind]}. Chỉ gửi nếu bạn chắc chắn người nhận đáng tin.`,
    });
  }
  if (r.message.status === 'ok' && r.message.label && LABEL_VI[r.message.label]) {
    notes.push({ kind: 'warning', text: `Nội dung ${LABEL_VI[r.message.label]}.` });
  }
  if (r.urls.some((u) => u.status === 'ok' && u.label === 'malicious')) {
    notes.push({ kind: 'danger', text: 'Tin chứa liên kết bị đánh giá là độc hại.' });
  }
  if (notes.length === 0 && r.level === 'unknown') {
    notes.push({ kind: 'info', text: 'AI chưa kiểm tra được tin này nên không có đánh giá.' });
  }
  return notes;
}
