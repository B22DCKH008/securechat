import type { RiskNote } from './riskText';

interface Props {
  notes: RiskNote[];
  onCancel(): void;
  onSend(): void;
}

/** Hỏi lại trước khi gửi tin có dấu hiệu rủi ro. Chỉ là cảnh báo: người dùng vẫn có thể gửi. */
export function SendWarningDialog({ notes, onCancel, onSend }: Props) {
  return (
    <div className="overlay" role="presentation">
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="warn-title">
        <h2 id="warn-title">Kiểm tra lại trước khi gửi</h2>
        <ul>
          {notes.map((n) => (
            <li key={n.text}>{n.text}</li>
          ))}
        </ul>
        <div className="dialog-actions">
          <button type="button" className="primary" autoFocus onClick={onCancel}>
            Sửa lại
          </button>
          <button type="button" onClick={onSend}>
            Vẫn gửi
          </button>
        </div>
      </div>
    </div>
  );
}
