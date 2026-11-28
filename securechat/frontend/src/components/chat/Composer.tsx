import { useRef, type ChangeEvent } from 'react';

interface ComposerProps {
  value: string;
  onChange: (next: string) => void;
  onSendOutgoing: () => void;
  onSimulateIncoming: () => void;
  onSendImage: (file: File) => void;
  disabled?: boolean;
}

export function Composer({
  value,
  onChange,
  onSendOutgoing,
  onSimulateIncoming,
  onSendImage,
  disabled,
}: ComposerProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      onSendImage(file);
      e.target.value = '';
    }
  }

  return (
    <div className="composer-wrap">
      <div className="composer-row">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />

        <button
          type="button"
          className="icon-btn"
          title="Gửi ảnh (tự động quét mã QR trên thiết bị)"
          onClick={() => fileRef.current?.click()}
          disabled={disabled}
        >
          📷
        </button>

        <div className="composer-input-box">
          <textarea
            rows={1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Nhập tin nhắn... (Enter để gửi, Shift+Enter xuống dòng)"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSendOutgoing();
              }
            }}
            disabled={disabled}
          />
        </div>

        <button
          type="button"
          className="btn"
          title="Giả lập đối phương gửi tin này tới bạn"
          onClick={onSimulateIncoming}
          disabled={disabled || !value.trim()}
        >
          Tin đến
        </button>

        <button
          type="button"
          className="btn btn-primary"
          onClick={onSendOutgoing}
          disabled={disabled || !value.trim()}
        >
          Gửi
        </button>
      </div>

      <div className="composer-hint">
        <span>Plaintext & ảnh QR chỉ quét cục bộ trên trình duyệt (AI23).</span>
        <span>Muốn test nhanh các kịch bản lừa đảo? Mở mục 🧪 ở thanh bên trái.</span>
      </div>
    </div>
  );
}