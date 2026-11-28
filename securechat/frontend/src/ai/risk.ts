/**
 * Gộp kết quả: luật nhạy cảm + model tin nhắn + model URL cho MỘT tin nhắn.
 *
 * level:
 *  - 'warn'    : có dấu hiệu rủi ro (nhãn spam/scam, URL độc hại, hoặc dữ liệu nhạy cảm khi gửi đi)
 *  - 'unknown' : chưa kết luận được (AI tắt/lỗi/quá hạn) — UI phải nói "AI không khả dụng", KHÔNG nói "an toàn"
 *  - 'none'    : đã quét và không thấy dấu hiệu (không đồng nghĩa với đảm bảo an toàn)
 */
import type { MessageAnalysis, RiskAnalyzer, UrlAnalysis } from './contract';
import { extractUrls } from './features/text';
import { checkSensitive, type SensitiveFinding } from './rules/sensitive';

export type RiskLevel = 'none' | 'warn' | 'unknown';

export interface RiskAssessment {
  level: RiskLevel;
  message: MessageAnalysis;
  urls: UrlAnalysis[];
  sensitive: SensitiveFinding[];
}

export interface AssessOptions {
  /** true khi kiểm tra tin sắp gửi (có chạy luật nhạy cảm). Tin nhận về: false. */
  outgoing: boolean;
  /** Giới hạn số URL phân tích cho mỗi tin (tránh tốn thời gian). */
  maxUrls?: number;
}

export async function assessRisk(
  analyzer: RiskAnalyzer,
  text: string,
  { outgoing, maxUrls = 5 }: AssessOptions,
): Promise<RiskAssessment> {
  const sensitive = outgoing ? checkSensitive(text) : [];
  const urlList = extractUrls(text).slice(0, maxUrls);
  const [message, urls] = await Promise.all([
    analyzer.analyzeMessage(text),
    Promise.all(urlList.map((u) => analyzer.analyzeUrl(u))),
  ]);

  const warn =
    sensitive.length > 0 ||
    (message.status === 'ok' && message.label !== undefined && message.label !== 'benign') ||
    urls.some((u) => u.status === 'ok' && u.label === 'malicious');
  const unknown = message.status !== 'ok' || urls.some((u) => u.status !== 'ok');

  return { level: warn ? 'warn' : unknown ? 'unknown' : 'none', message, urls, sensitive };
}
