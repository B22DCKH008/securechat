import type { LocalMessage, MessageStatus } from '../../storage';
import { RiskBanner } from '../warnings/RiskBanner';

const STATUS_VI: Partial<Record<MessageStatus, string>> = {
  sending: 'Đang gửi…',
  failed: 'Gửi lỗi',
  sent: 'Đã gửi',
  delivered: 'Đã nhận',
  read: 'Đã xem',
};

export function statusLabel(m: Pick<LocalMessage, 'direction' | 'status'>): string {
  return m.direction === 'out' ? (STATUS_VI[m.status] ?? '') : '';
}

const fmt = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' });
function time(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : fmt.format(d);
}

interface Props {
  m: LocalMessage;
  onRetry?(id: string): void;
}

export function MessageBubble({ m, onRetry }: Props) {
  const mine = m.direction === 'out';
  return (
    <li className={`bubble-row ${mine ? 'mine' : 'theirs'}`}>
      <div className={`bubble ${m.status === 'undecryptable' ? 'bubble-broken' : ''}`}>
        {m.text !== null ? (
          <p className="bubble-text">{m.text}</p>
        ) : (
          <p className="bubble-text muted">{m.error ?? 'Không giải mã được tin này'}</p>
        )}
        {!mine && <RiskBanner risk={m.risk} />}
        <div className="bubble-meta">
          <span>{time(m.createdAt)}</span>
          {mine && <span className={`st st-${m.status}`}>{statusLabel(m)}</span>}
          {mine && m.status === 'failed' && !m.pending?.permanentFailure && (
            <button type="button" className="link" onClick={() => onRetry?.(m.id)}>
              Thử lại
            </button>
          )}
        </div>
        {mine && m.status === 'failed' && m.error && <div className="bubble-error">{m.error}</div>}
      </div>
    </li>
  );
}
