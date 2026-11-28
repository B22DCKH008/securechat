import type { AnalysisStatus } from '../../ai/contract';
import type { ConversationRiskSummary } from '../../ai/runtime/conversationRisk';
import type { ScamReport } from '../../features/auth/types';
import type { Conversation } from '../../features/conversations/types';
import { AIUnavailableBadge } from '../warnings/AIUnavailableBadge';

interface ChatHeaderProps {
  conversation: Conversation;
  displayName: string;
  peerReports: ScamReport[];
  conversationRisk: ConversationRiskSummary | null;
  aiStatus: AnalysisStatus;
  aiEnabled: boolean;
  modelVersion?: string;
  coldStartMs?: number | null;
  showInfoPanel: boolean;
  onToggleInfoPanel: () => void;
  onOpenReportModal: () => void;
}

export function ChatHeader({
  conversation,
  displayName,
  peerReports,
  conversationRisk,
  aiStatus,
  aiEnabled,
  modelVersion,
  coldStartMs,
  showInfoPanel,
  onToggleInfoPanel,
  onOpenReportModal,
}: ChatHeaderProps) {
  const topReason = peerReports[peerReports.length - 1]?.reason;

  return (
    <>
      <header className="chat-header">
        <div className="chat-header-left">
          <div className="avatar" style={{ background: conversation.avatarColor }}>
            {conversation.avatarText}
            {conversation.isOnline && <span className="online-dot" />}
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="chat-header-title">{displayName}</div>
            <div className="chat-header-sub">
              <span>{conversation.subtitle}</span>
              {displayName !== conversation.name && <span>· Tên gốc: {conversation.name}</span>}
            </div>
          </div>
        </div>

        <div className="chat-header-right">
          <AIUnavailableBadge
            status={aiStatus}
            enabled={aiEnabled}
            modelVersion={modelVersion}
            coldStartMs={coldStartMs}
          />
          {conversation.type === 'direct' && conversation.peerUserId && (
            <button
              type="button"
              className="btn btn-danger-outline"
              onClick={onOpenReportModal}
              title="Tố cáo tài khoản này có dấu hiệu lừa đảo"
            >
              Tố cáo
            </button>
          )}
          <button
            type="button"
            className={`icon-btn ${showInfoPanel ? 'active' : ''}`}
            title="Thông tin hội thoại & phân tích lịch sử chat"
            onClick={onToggleInfoPanel}
          >
            i
          </button>
        </div>
      </header>

      {peerReports.length > 0 && (
        <div className="community-banner" role="alert">
          <div>
            <strong>⚠ CẢNH BÁO CỘNG ĐỒNG:</strong> Tài khoản này đã bị{' '}
            <strong>{peerReports.length} người dùng</strong> tố cáo lừa đảo
            {topReason ? <> (Gần nhất: <em>{topReason}</em>)</> : null}. Hãy cực kỳ cẩn trọng!
          </div>
        </div>
      )}

      {conversationRisk && (conversationRisk.level === 'high' || conversationRisk.level === 'watch') && (
        <div className={`context-banner ${conversationRisk.level}`} role="alert">
          <div>
            <strong>
              {conversationRisk.level === 'high'
                ? `🚨 PHÂN TÍCH LỊCH SỬ CHAT (${conversationRisk.score}/100):`
                : `👁 THEO DÕI NGỮ CẢNH (${conversationRisk.score}/100):`}
            </strong>{' '}
            {conversationRisk.summaryText}
          </div>
        </div>
      )}
    </>
  );
}