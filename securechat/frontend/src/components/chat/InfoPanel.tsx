import { useEffect, useState } from 'react';
import type { ConversationRiskSummary } from '../../ai/runtime/conversationRisk';
import type { ScamReport } from '../../features/auth/types';
import type { ChatMessage, Conversation } from '../../features/conversations/types';

interface InfoPanelProps {
  conversation: Conversation;
  currentAlias: string;
  onSaveAlias: (nickname: string) => void;
  peerReports: ScamReport[];
  alreadyReportedByMe: boolean;
  onOpenReportModal: () => void;
  conversationRisk: ConversationRiskSummary | null;
  aiEnabled: boolean;
  onToggleAI: (next: boolean) => void;
  modelVersion?: string;
  selectedMessage: ChatMessage | null;
}

export function InfoPanel({
  conversation,
  currentAlias,
  onSaveAlias,
  peerReports,
  alreadyReportedByMe,
  onOpenReportModal,
  conversationRisk,
  aiEnabled,
  onToggleAI,
  modelVersion,
  selectedMessage,
}: InfoPanelProps) {
  const [aliasDraft, setAliasDraft] = useState(currentAlias);
  const [savedFlag, setSavedFlag] = useState(false);

  useEffect(() => {
    setAliasDraft(currentAlias);
    setSavedFlag(false);
  }, [conversation.id, currentAlias]);

  const total = conversation.messages.length;
  const scamCount = conversation.messages.filter(
    (m) => m.analysis.status === 'ok' && m.analysis.label === 'scam',
  ).length;
  const spamCount = conversation.messages.filter(
    (m) => m.analysis.status === 'ok' && m.analysis.label === 'spam',
  ).length;

  function handleSaveAlias() {
    onSaveAlias(aliasDraft);
    setSavedFlag(true);
    setTimeout(() => setSavedFlag(false), 1800);
  }

  return (
    <aside className="info-panel">
      <div className="info-profile">
        <div className="avatar lg" style={{ background: conversation.avatarColor }}>
          {conversation.avatarText}
        </div>
        <h3>{currentAlias || conversation.name}</h3>
        <p>{conversation.subtitle}</p>
        {currentAlias && (
          <p style={{ fontSize: 11.5 }}>Tên gốc: <strong>{conversation.name}</strong></p>
        )}
      </div>

      <div className="info-section">
        <h4>Phân tích lịch sử & Lừa đảo dài ngày</h4>
        {conversationRisk ? (
          <div className="inspector-card">
            <div className="kv-row">
              <span>Điểm rủi ro chuỗi hội thoại</span>
              <strong
                style={{
                  color:
                    conversationRisk.level === 'high'
                      ? '#dc2626'
                      : conversationRisk.level === 'watch'
                        ? '#d97706'
                        : '#15803d',
                }}
              >
                {conversationRisk.level === 'unavailable'
                  ? 'Không khả dụng'
                  : `${conversationRisk.score}/100`}
              </strong>
            </div>

            {conversationRisk.level !== 'unavailable' && (
              <div className="prob-track">
                <div
                  className={`prob-fill ${
                    conversationRisk.level === 'high'
                      ? 'scam'
                      : conversationRisk.level === 'watch'
                        ? 'spam'
                        : 'benign'
                  }`}
                  style={{ width: `${Math.max(4, conversationRisk.score)}%` }}
                />
              </div>
            )}

            <div style={{ fontSize: 12, color: '#334155', lineHeight: 1.4 }}>
              {conversationRisk.summaryText}
            </div>

            {conversationRisk.stages.length > 0 && (
              <div className="stage-list">
                {conversationRisk.stages.map((st) => (
                  <div key={st.id} className="stage-item">
                    <strong>{st.title}</strong>
                    <span>{st.evidence}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: '#64748b' }}>Đang đánh giá lịch sử hội thoại...</div>
        )}
      </div>

      <div className="info-section">
        <h4>Tên gợi nhớ</h4>
        <div className="alias-row">
          <input
            value={aliasDraft}
            onChange={(e) => setAliasDraft(e.target.value)}
            placeholder="Đặt biệt danh dễ nhớ..."
          />
          <button type="button" className="btn btn-primary" onClick={handleSaveAlias}>
            Lưu
          </button>
        </div>
        {savedFlag && (
          <span style={{ fontSize: 11.5, color: '#15803d', fontWeight: 600 }}>
            Đã lưu tên gợi nhớ riêng cho tài khoản của bạn.
          </span>
        )}
      </div>

      {conversation.type === 'direct' && conversation.peerUserId && (
        <div className="info-section">
          <h4>Tố cáo lừa đảo cộng đồng</h4>
          {peerReports.length > 0 ? (
            <div className="inline-alert scam" style={{ flexDirection: 'column', gap: 4 }}>
              <strong>Đã bị {peerReports.length} người dùng tố cáo</strong>
              {peerReports.slice(-2).map((r) => (
                <div key={r.id} style={{ fontSize: 11.5 }}>
                  • <strong>{r.reason}</strong>
                  {r.note ? ` — "${r.note}"` : ''}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12.5, color: '#64748b' }}>
              Chưa có lượt tố cáo cộng đồng nào cho tài khoản này.
            </div>
          )}

          <button type="button" className="btn btn-danger-outline" onClick={onOpenReportModal}>
            {alreadyReportedByMe ? 'Gửi thêm tố cáo lừa đảo' : '⚠ Tố cáo tài khoản lừa đảo'}
          </button>
        </div>
      )}

      <div className="info-section">
        <h4>Lá chắn AI On-Device</h4>
        <label className="switch-row" style={{ cursor: 'pointer' }}>
          <span>Bật AI bảo vệ tin nhắn</span>
          <input
            type="checkbox"
            checked={aiEnabled}
            onChange={(e) => onToggleAI(e.target.checked)}
          />
        </label>

        <div className="mini-stats">
          <div className="mini-stat">
            <strong>{total}</strong>
            <span>Tin nhắn</span>
          </div>
          <div className="mini-stat">
            <strong style={{ color: scamCount > 0 ? '#dc2626' : undefined }}>{scamCount}</strong>
            <span>Scam</span>
          </div>
          <div className="mini-stat">
            <strong style={{ color: spamCount > 0 ? '#d97706' : undefined }}>{spamCount}</strong>
            <span>Spam</span>
          </div>
        </div>
      </div>

      <div className="info-section">
        <h4>Chi tiết phân tích tin nhắn</h4>
        {selectedMessage ? (
          <div className="inspector-card">
            <div style={{ fontStyle: 'italic', color: '#334155' }}>
              “{(selectedMessage.text || '[Hình ảnh]').slice(0, 90)}
              {(selectedMessage.text || '').length > 90 ? '…' : ''}”
            </div>
            <div className="kv-row">
              <span>Trạng thái</span>
              <strong>{selectedMessage.analysis.status}</strong>
            </div>
            <div className="kv-row">
              <span>Nhãn dự đoán</span>
              <strong>{selectedMessage.analysis.label ?? 'không xác định'}</strong>
            </div>
            <div className="kv-row">
              <span>Điểm tin cậy</span>
              <strong>
                {selectedMessage.analysis.confidence != null
                  ? `${(selectedMessage.analysis.confidence * 100).toFixed(2)}%`
                  : '—'}
              </strong>
            </div>
            <div className="kv-row">
              <span>Độ trễ suy luận</span>
              <strong>
                {selectedMessage.analysis.latencyMs != null
                  ? `${selectedMessage.analysis.latencyMs.toFixed(3)} ms`
                  : '—'}
              </strong>
            </div>
            <div className="kv-row">
              <span>Phiên bản model</span>
              <strong>{selectedMessage.analysis.modelVersion ?? modelVersion ?? '—'}</strong>
            </div>
            <div className="kv-row">
              <span>Luật Nấc 0 khớp</span>
              <strong>
                {selectedMessage.matchedRules && selectedMessage.matchedRules.length > 0
                  ? selectedMessage.matchedRules.join(', ')
                  : 'Không'}
              </strong>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 12.5, color: '#64748b' }}>
            Bấm vào bong bóng tin nhắn để soi xác suất và độ trễ.
          </div>
        )}
      </div>
    </aside>
  );
}