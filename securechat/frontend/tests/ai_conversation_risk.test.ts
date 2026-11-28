import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LocalRiskAnalyzer } from '../src/ai/runtime/analyzer';
import { analyzeConversationRisk } from '../src/ai/runtime/conversationRisk';
import type { MessageModelArtifact } from '../src/ai/runtime/messageModel';
import type { ChatMessage } from '../src/features/conversations/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const model = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../ml/models/artifacts/message/message_model.json'),
    'utf-8',
  ),
) as MessageModelArtifact;

function makeMsg(id: string, text: string, direction: 'incoming' | 'outgoing' = 'incoming'): ChatMessage {
  return {
    id,
    senderId: direction === 'incoming' ? 'peer' : 'me',
    senderName: direction === 'incoming' ? 'Người lạ' : 'Bạn',
    direction,
    text,
    timestamp: '10:00',
    analysis: { status: 'ok', label: 'benign', confidence: 0.85 },
  };
}

describe('Conversation-history risk engine (long-term & split-message scams)', () => {
  const analyzer = new LocalRiskAnalyzer();
  analyzer.loadArtifacts(model);

  it('flags multi-day grooming + platform shift + financial pivot as high risk', async () => {
    const msgs = [
      makeMsg('1', 'Chào bạn, mình kết bạn làm quen chia sẻ bí quyết thu nhập thụ động nhé.'),
      makeMsg('2', 'Tối nay bạn sang Telegram vào nhóm VIP nghe hướng dẫn nhé.'),
      makeMsg('3', 'Bạn tải app sàn giao dịch rồi nạp thử 200k trải nghiệm lợi nhuận nha.'),
    ];
    const res = await analyzeConversationRisk({
      messages: msgs,
      isStranger: true,
      peerReportsCount: 0,
      analyzer,
    });
    expect(res.level).toBe('high');
    expect(res.stages.map((s) => s.id)).toEqual(
      expect.arrayContaining(['grooming', 'platform_shift', 'financial_pivot']),
    );
  });

  it('keeps normal friend conversation at low risk', async () => {
    const msgs = [
      makeMsg('1', 'Tối nay 7h ra quán bún đậu đầu ngõ ăn nhé.'),
      makeMsg('2', 'Ok mình đang về tới phòng rồi.', 'outgoing'),
      makeMsg('3', 'Nhớ mang theo quyển vở bài tập môn Học máy giúp mình nha.'),
    ];
    const res = await analyzeConversationRisk({
      messages: msgs,
      isStranger: false,
      peerReportsCount: 0,
      analyzer,
    });
    expect(res.level).toBe('low');
    expect(res.stages).toHaveLength(0);
  });

  it('returns unavailable when AI toggle is disabled', async () => {
    const disabled = new LocalRiskAnalyzer({ enabled: false });
    disabled.loadArtifacts(model);
    const res = await analyzeConversationRisk({
      messages: [makeMsg('1', 'Nạp thử 200k qua Telegram')],
      isStranger: true,
      peerReportsCount: 0,
      analyzer: disabled,
    });
    expect(res.level).toBe('unavailable');
  });
});