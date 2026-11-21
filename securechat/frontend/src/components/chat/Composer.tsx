import { useRef, useState } from 'react';
import { assessRisk, type ControllableAnalyzer, type RiskAssessment } from '../../ai';
import { notesForOutgoing, type RiskNote } from '../warnings/riskText';
import { SendWarningDialog } from '../warnings/SendWarningDialog';

export const MAX_CHARS = 4000;

interface Props {
  analyzer: ControllableAnalyzer;
  aiEnabled: boolean;
  disabled?: boolean;
  onSend(text: string, assessment?: RiskAssessment): void;
}

/**
 * Luồng gửi (doc §3.1): kiểm tra tin sắp gửi → nếu có cảnh báo (nhạy cảm/spam/scam/URL xấu) hỏi lại →
 * gửi. AI lỗi hoặc quá hạn KHÔNG chặn việc gửi (chỉ không có đánh giá).
 */
export function Composer({ analyzer, aiEnabled, disabled, onSend }: Props) {
  const [text, setText] = useState('');
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState<{
    text: string;
    assessment: RiskAssessment;
    notes: RiskNote[];
  } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  const finish = (t: string, a?: RiskAssessment) => {
    onSend(t, a);
    setText('');
    setPending(null);
    area.current?.focus();
  };

  const submit = async () => {
    const t = text.trim();
    if (!t || checking || disabled) return;
    if (!aiEnabled) return finish(t);
    setChecking(true);
    try {
      const a = await assessRisk(analyzer, t, { outgoing: true });
      const notes = notesForOutgoing(a);
      if (notes.some((n) => n.kind !== 'info')) setPending({ text: t, assessment: a, notes });
      else finish(t, a);
    } finally {
      setChecking(false);
    }
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={area}
        value={text}
        maxLength={MAX_CHARS}
        rows={2}
        placeholder="Nhập tin nhắn…"
        aria-label="Nhập tin nhắn"
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Không gửi khi đang gõ dấu tiếng Việt (IME/Telex): Enter lúc đó chỉ để chốt chữ.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <button type="submit" className="primary" disabled={disabled || checking || !text.trim()}>
        {checking ? 'Đang kiểm tra…' : 'Gửi'}
      </button>
      {pending && (
        <SendWarningDialog
          notes={pending.notes}
          onCancel={() => setPending(null)}
          onSend={() => finish(pending.text, pending.assessment)}
        />
      )}
    </form>
  );
}
