import { useEffect, useRef } from 'react';
import type { ChatMessage, Conversation } from '../../features/conversations/types';

interface MessageListProps {
  conversation: Conversation;
  selectedMessageId: string | null;
  onSelectMessage: (msg: ChatMessage) => void;
}

function renderTicks(status?: ChatMessage['deliveryStatus']) {
  if (status === 'read') return <span className="tick-read" title="Đã xem">✓✓</span>;
  if (status === 'delivered') return <span title="Đã nhận">✓✓</span>;
  return <span title="Đã gửi">✓</span>;
}

export function MessageList({
  conversation,
  selectedMessageId,
  onSelectMessage,
}: MessageListProps) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [conversation.id, conversation.messages.length]);

  return (
    <div className="message-feed">
      <div className="date-divider">Hôm nay</div>

      {conversation.isStranger && (
        <div className="inline-alert unavailable" style={{ alignSelf: 'center' }}>
          <span>ℹ</span>
          <span>
            Cuộc trò chuyện với <strong>người lạ</strong>. Tin nhắn được quét lừa đảo cục bộ ngay trên trình duyệt của bạn.
          </span>
        </div>
      )}

      {conversation.messages.length === 0 && (
        <div style={{ margin: 'auto', textAlign: 'center', color: '#64748b', fontSize: 13.5 }}>
          Chưa có tin nhắn trong cuộc trò chuyện này. Hãy gửi lời chào đầu tiên.
        </div>
      )}

      {conversation.messages.map((m) => {
        const a = m.analysis;
        const isScam = a.status === 'ok' && a.label === 'scam';
        const isSpam = a.status === 'ok' && a.label === 'spam';
        const isUnavailable = a.status !== 'ok';
        const pct = a.confidence != null ? `${(a.confidence * 100).toFixed(1)}%` : '';

        return (
          <div
            key={m.id}
            className={`msg-group ${m.direction} ${selectedMessageId === m.id ? 'selected' : ''}`}
            onClick={() => onSelectMessage(m)}
            title="Bấm để xem chi tiết phân tích AI ở bảng bên phải"
          >
            {m.direction === 'incoming' && (
              <div className="avatar sm" style={{ background: conversation.avatarColor }}>
                {conversation.avatarText}
              </div>
            )}

            <div className="msg-content">
              {m.direction === 'incoming' && conversation.type === 'group' && (
                <div className="msg-sender">{m.senderName}</div>
              )}

              {m.imageUrl && (
                <img src={m.imageUrl} alt={m.imageName ?? 'Ảnh đính kèm'} className="msg-image" />
              )}

              {m.text && <div className="msg-bubble">{m.text}</div>}

              {m.qrPayloads && m.qrPayloads.length > 0 && (
                <div className="inline-alert unavailable">
                  <span>QR</span>
                  <span>
                    Mã QR trong ảnh: <code>{m.qrPayloads.join(' | ')}</code>
                  </span>
                </div>
              )}

              {isScam && (
                <div className="inline-alert scam" role="alert">
                  <span>⚠</span>
                  <span>
                    <strong>Cảnh báo LỪA ĐẢO ({pct})</strong> — Không chuyển tiền, không bấm link lạ và tuyệt đối không đọc mã OTP.
                  </span>
                </div>
              )}

              {isSpam && (
                <div className="inline-alert spam">
                  <span>!</span>
                  <span>
                    <strong>Tin quảng cáo / Spam ({pct})</strong> — Có dấu hiệu chào mời hàng loạt.
                  </span>
                </div>
              )}

              {isUnavailable && (
                <div className="inline-alert unavailable">
                  <span>○</span>
                  <span>AI không khả dụng tại thời điểm quét (không thể đánh giá rủi ro).</span>
                </div>
              )}

              <div className="msg-footer">
                <span>{m.timestamp}</span>
                {a.status === 'ok' && a.label === 'benign' && (
                  <span className="safe-chip">Không thấy dấu hiệu rủi ro</span>
                )}
                {a.latencyMs != null && <span>· {a.latencyMs.toFixed(2)}ms</span>}
                {m.direction === 'outgoing' && renderTicks(m.deliveryStatus)}
              </div>
            </div>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}