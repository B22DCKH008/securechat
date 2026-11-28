import type { MessageAnalysis } from '../../ai/contract';

interface RiskWarningProps {
  analysis: MessageAnalysis;
  pendingText: string;
  onConfirmSend: () => void;
  onCancel: () => void;
}

export function RiskWarning({
  analysis,
  pendingText,
  onConfirmSend,
  onCancel,
}: RiskWarningProps) {
  const isScam = analysis.label === 'scam';
  const scorePct = analysis.confidence != null ? (analysis.confidence * 100).toFixed(1) : '?';

  return (
    <div
      className={`warning-box ${isScam ? 'warning-scam' : 'warning-spam'}`}
      role="alert"
    >
      <strong>
        {isScam
          ? 'Cảnh báo rủi ro cao: Tin nhắn có dấu hiệu LỪA ĐẢO (scam)'
          : 'Cảnh báo: Tin nhắn có dấu hiệu QUẢNG CÁO / SPAM'}
      </strong>
      <div style={{ fontSize: 13 }}>
        Điểm rủi ro: <strong>{scorePct}%</strong>
        {analysis.latencyMs != null && <> · {analysis.latencyMs.toFixed(2)} ms</>}
        {analysis.modelVersion && <> · {analysis.modelVersion}</>}
      </div>
      <div style={{ fontSize: 13, fontStyle: 'italic' }}>
        “{pendingText.length > 140 ? `${pendingText.slice(0, 140)}…` : pendingText}”
      </div>
      <div className="warning-actions">
        <button type="button" className="btn btn-primary" onClick={onCancel}>
          Hủy gửi để chỉnh sửa
        </button>
        <button type="button" className="btn btn-danger" onClick={onConfirmSend}>
          Tôi hiểu rủi ro, vẫn gửi
        </button>
      </div>
    </div>
  );
}