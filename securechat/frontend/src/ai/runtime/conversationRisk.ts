import type { ChatMessage } from '../../features/conversations/types';
import { normalizeText } from '../features/text';
import type { LocalRiskAnalyzer } from './analyzer';

export type ConversationRiskLevel = 'low' | 'watch' | 'high' | 'unavailable';

export interface DetectedStage {
  id: 'grooming' | 'platform_shift' | 'financial_pivot' | 'split_evasion';
  title: string;
  evidence: string;
}

export interface ConversationRiskSummary {
  level: ConversationRiskLevel;
  score: number;
  stages: DetectedStage[];
  splitWindowTriggered: boolean;
  splitWindowConfidence?: number;
  summaryText: string;
}

const GROOMING_RE =
  /(lam quen|ket ban|tinh cam|thu nhap thu dong|chia se bi quyet|thay huong dan|chuyen gia|co hoi dau tu|kiem them thu nhap|tu do tai chinh|co duyen|tin tuong minh|huong dan tung buoc)/;

const PLATFORM_SHIFT_RE =
  /(sang telegram|qua telegram|nhom telegram|nhom vip|nhom kin|tai app|cai app|file apk|san giao dich|link ngoai|vao nhom nay|dang ky tai khoan tren san)/;

const FINANCIAL_PIVOT_RE =
  /(nap thu|nap tien|nap von|loi nhuan|hoa hong|rut von|rut lai|chuyen khoan|so tai khoan|\bstk\b|ma otp|xac minh tai khoan|phi thuong nien|lam nhiem vu|chot lenh|dau tu nho)/;

function snippet(text: string): string {
  const clean = text.trim();
  return clean.length > 72 ? `${clean.slice(0, 72)}…` : clean;
}

export async function analyzeConversationRisk(params: {
  messages: ChatMessage[];
  isStranger?: boolean;
  peerReportsCount: number;
  analyzer: LocalRiskAnalyzer;
}): Promise<ConversationRiskSummary> {
  const { messages, isStranger, peerReportsCount, analyzer } = params;

  if (!analyzer.isEnabled() || !analyzer.isReady()) {
    return {
      level: 'unavailable',
      score: 0,
      stages: [],
      splitWindowTriggered: false,
      summaryText: 'AI đang tắt hoặc chưa sẵn sàng — không thể đánh giá rủi ro theo lịch sử hội thoại.',
    };
  }

  const incoming = messages.filter((m) => m.direction === 'incoming' && m.text.trim().length > 0);
  if (incoming.length === 0) {
    return {
      level: peerReportsCount > 0 ? 'high' : 'low',
      score: peerReportsCount > 0 ? 70 : 0,
      stages: [],
      splitWindowTriggered: false,
      summaryText:
        peerReportsCount > 0
          ? 'Tài khoản đã bị cộng đồng tố cáo dù chưa có tin nhắn đến.'
          : 'Chưa phát hiện dấu hiệu dẫn dụ trong lịch sử hội thoại.',
    };
  }

  const stages: DetectedStage[] = [];
  let groomingEvidence: string | null = null;
  let shiftEvidence: string | null = null;
  let pivotEvidence: string | null = null;

  for (const m of incoming) {
    const norm = normalizeText(m.text, true);
    if (!groomingEvidence && GROOMING_RE.test(norm)) {
      groomingEvidence = `[${m.timestamp}] ${snippet(m.text)}`;
    }
    if (!shiftEvidence && PLATFORM_SHIFT_RE.test(norm)) {
      shiftEvidence = `[${m.timestamp}] ${snippet(m.text)}`;
    }
    if (!pivotEvidence && FINANCIAL_PIVOT_RE.test(norm)) {
      pivotEvidence = `[${m.timestamp}] ${snippet(m.text)}`;
    }
  }

  if (groomingEvidence) {
    stages.push({
      id: 'grooming',
      title: 'Giai đoạn 1: Tạo niềm tin / Dẫn dắt lợi ích',
      evidence: groomingEvidence,
    });
  }
  if (shiftEvidence) {
    stages.push({
      id: 'platform_shift',
      title: 'Giai đoạn 2: Kéo sang nền tảng khác / Cài app ngoài',
      evidence: shiftEvidence,
    });
  }
  if (pivotEvidence) {
    stages.push({
      id: 'financial_pivot',
      title: 'Giai đoạn 3: Chuyển hướng tài chính / OTP / Nạp thử',
      evidence: pivotEvidence,
    });
  }

  // Cửa sổ trượt 4 tin nhắn đến gần nhất để phát hiện chiêu tách nhỏ tin nhắn né bộ lọc
  const recentWindow = incoming.slice(-4);
  let splitWindowTriggered = false;
  let splitWindowConfidence: number | undefined;
  if (recentWindow.length >= 2) {
    const combinedText = recentWindow.map((m) => m.text).join(' ');
    const windowPred = await analyzer.analyzeMessage(combinedText);
    const anySingleScamInWindow = recentWindow.some(
      (m) => m.analysis.status === 'ok' && m.analysis.label === 'scam',
    );
    if (windowPred.status === 'ok' && windowPred.label === 'scam') {
      splitWindowConfidence = windowPred.confidence;
      if (!anySingleScamInWindow) {
        splitWindowTriggered = true;
        stages.push({
          id: 'split_evasion',
          title: 'Chiêu tách nhỏ tin nhắn né bộ lọc đơn lẻ',
          evidence: `Gộp ${recentWindow.length} tin gần nhất đạt điểm scam ${((windowPred.confidence ?? 0) * 100).toFixed(1)}%`,
        });
      }
    }
  }

  const singleScamCount = incoming.filter(
    (m) => m.analysis.status === 'ok' && m.analysis.label === 'scam',
  ).length;
  const singleSpamCount = incoming.filter(
    (m) => m.analysis.status === 'ok' && m.analysis.label === 'spam',
  ).length;

  let score = 0;
  if (groomingEvidence) score += 20;
  if (shiftEvidence) score += 25;
  if (pivotEvidence) score += 25;
  // Cộng điểm leo thang khi có lộ trình lừa đảo dài ngày (>= 2 giai đoạn kết hợp)
  if (groomingEvidence && (shiftEvidence || pivotEvidence)) score += 25;
  if (shiftEvidence && pivotEvidence) score += 20;
  if (splitWindowTriggered) score += 40;
  if (singleScamCount > 0) score += 35 + Math.min(20, (singleScamCount - 1) * 10);
  if (singleSpamCount > 0) score += 15;
  if (peerReportsCount > 0) score += 30;
  if (isStranger && score > 0) score += 10;

  score = Math.min(100, score);

  let level: ConversationRiskLevel = 'low';
  if (score >= 65) level = 'high';
  else if (score >= 35) level = 'watch';

  let summaryText = 'Chưa thấy chuỗi hành vi dẫn dụ bất thường trong lịch sử hội thoại.';
  if (level === 'high') {
    if (groomingEvidence && (shiftEvidence || pivotEvidence)) {
      summaryText =
        'Phát hiện mô hình LỪA ĐẢO DÀI NGÀY (nuôi béo): tạo niềm tin ban đầu rồi dẫn dụ sang nền tảng ngoài hoặc yêu cầu nạp tiền/giao dịch.';
    } else if (splitWindowTriggered) {
      summaryText =
        'Phát hiện đối phương chia nhỏ nội dung lừa đảo qua nhiều tin nhắn ngắn để né kiểm tra đơn lẻ.';
    } else {
      summaryText = 'Hội thoại có nhiều tín hiệu lừa đảo rõ rệt từ lịch sử tin nhắn và/hoặc tố cáo cộng đồng.';
    }
  } else if (level === 'watch') {
    summaryText =
      'Cần theo dõi: Đã xuất hiện bước khởi đầu của kịch bản dẫn dụ trong lịch sử hội thoại. Không cung cấp thông tin cá nhân hay chuyển tiền.';
  }

  return {
    level,
    score,
    stages,
    splitWindowTriggered,
    splitWindowConfidence,
    summaryText,
  };
}