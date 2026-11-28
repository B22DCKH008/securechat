import { useState, type ChangeEvent } from 'react';
import { normalizeText } from '../ai/features/text';
import type { DetailedInspection, LocalRiskAnalyzer } from '../ai/runtime/analyzer';
import { scanImageOnDevice, type ImageScanResult } from '../ai/runtime/imageScanner';

interface TestLabPageProps {
  analyzer: LocalRiskAnalyzer;
  aiEnabled: boolean;
}

const TEST_PRESETS = [
  {
    label: 'An toàn (đời thường)',
    text: 'Tối nay 7h ra quán bún đậu đầu ngõ ăn nhé, tiền điện nước 320k mình vừa ck rồi đó.',
  },
  {
    label: 'An toàn (OTP thật)',
    text: 'Ma xac thuc OTP cua Quy khach la 482910. Hieu luc 2 phut. Tuyet doi KHONG chia se ma nay cho bat ky ai.',
  },
  {
    label: 'Spam quảng cáo',
    text: '[QC] Thuê bao quý khách được ưu đãi gói data 4G 6GB/ngày chỉ 90k/tháng, soạn DK90 gửi 191.',
  },
  {
    label: 'Scam khóa tài khoản',
    text: 'Thông báo tài khoản ngân hàng của bạn sắp bị khóa, xác minh ngay tại https://vcb-xacminh.top/login',
  },
  {
    label: 'Scam hỏi OTP không dấu',
    text: 'a oi e ben ngan hang a, doc giup e ma otp 6 so vua gui ve sms de huy phi thuong nien nhe',
  },
  {
    label: 'Scam giả mạo VNeID',
    text: 'Công an phường thông báo hồ sơ định danh VNeID mức 2 bị sai lệch, cập nhật tại https://dinhdanh-vneid.xyz/app',
  },
];

export function TestLabPage({ analyzer, aiEnabled }: TestLabPageProps) {
  const [input, setInput] = useState(TEST_PRESETS[3].text);
  const [result, setResult] = useState<DetailedInspection | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageScan, setImageScan] = useState<ImageScanResult | null>(null);

  async function runInspect(textToTest = input) {
    const res = await analyzer.inspectMessage(textToTest);
    setResult(res);
  }

  async function handleImagePick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImagePreview(URL.createObjectURL(file));
    const scanned = await scanImageOnDevice(file, analyzer);
    setImageScan(scanned);
    if (scanned.qrPayloads.length > 0) {
      const qrText = scanned.qrPayloads.join(' ');
      setInput(qrText);
      setResult(await analyzer.inspectMessage(qrText));
    }
  }

  return (
    <div className="page-scroll">
      <div className="card">
        <h2 style={{ marginTop: 0, marginBottom: 6 }}>Phòng thử nghiệm AI chống lừa đảo (`/test`)</h2>
        <p style={{ marginTop: 0, fontSize: 13, color: '#475569' }}>
          Kiểm thử độc lập mô hình phân loại tin nhắn tiếng Việt trên thiết bị, soi xác suất từng lớp, luật Nấc 0 và thử quét mã QR từ hình ảnh.
        </p>

        {!aiEnabled && (
          <div className="inline-alert spam" style={{ marginBottom: 12 }}>
            <span>⚠</span>
            <span>Lá chắn AI đang tắt — kết quả phân tích sẽ trả về trạng thái <strong>unavailable</strong> đúng hợp đồng an toàn (AI22, AI24).</span>
          </div>
        )}

        <div className="quick-samples">
          {TEST_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className="sample-chip"
              onClick={() => {
                setInput(p.text);
                void runInspect(p.text);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="lab-grid">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="field">
              <label htmlFor="lab-input">Nội dung tin nhắn cần kiểm tra</label>
              <textarea
                id="lab-input"
                rows={5}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Nhập tin nhắn tiếng Việt (có dấu hoặc không dấu)..."
              />
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void runInspect()}
                disabled={!input.trim()}
              >
                Phân tích ngay
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setInput('');
                  setResult(null);
                }}
              >
                Xóa nội dung
              </button>
            </div>

            <div className="inspector-card">
              <strong>Chuỗi sau chuẩn hóa (parity Python ↔ TS):</strong>
              <code style={{ wordBreak: 'break-word', fontSize: 12, color: '#0f172a' }}>
                {input.trim() ? normalizeText(input, true) : '(trống)'}
              </code>
            </div>

            <div className="inspector-card">
              <strong>Thử nghiệm quét hình ảnh / mã QR on-device:</strong>
              <input type="file" accept="image/*" onChange={(e) => void handleImagePick(e)} />
              {imagePreview && (
                <img
                  src={imagePreview}
                  alt="Ảnh kiểm thử"
                  style={{ maxHeight: 160, borderRadius: 8, objectFit: 'contain', background: '#e2e8f0' }}
                />
              )}
              {imageScan && (
                <div style={{ fontSize: 12, color: '#334155', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div>{imageScan.note}</div>
                  {imageScan.qrPayloads.length > 0 && (
                    <div>
                      <strong>Nội dung QR:</strong> <code>{imageScan.qrPayloads.join(' | ')}</code>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="inspector-card">
              <strong>Kết quả suy luận</strong>
              {!result ? (
                <span style={{ color: '#64748b' }}>
                  Chọn một mẫu phía trên hoặc bấm <strong>Phân tích ngay</strong> để xem chi tiết.
                </span>
              ) : result.analysis.status !== 'ok' ? (
                <div className="inline-alert unavailable">
                  <span>○</span>
                  <span>
                    Trạng thái: <strong>{result.analysis.status}</strong> (không hiển thị là an toàn).
                  </span>
                </div>
              ) : (
                <>
                  <div
                    className={`inline-alert ${
                      result.analysis.label === 'scam'
                        ? 'scam'
                        : result.analysis.label === 'spam'
                          ? 'spam'
                          : 'unavailable'
                    }`}
                  >
                    <strong>
                      Kết luận: {result.analysis.label?.toUpperCase()} (riskyScore ={' '}
                      {(result.riskyScore * 100).toFixed(2)}% · ngưỡng{' '}
                      {(result.threshold * 100).toFixed(2)}%)
                    </strong>
                  </div>

                  <div className="prob-bar-wrap">
                    {result.labels.map((lb, idx) => {
                      const p = result.probs[idx] ?? 0;
                      return (
                        <div key={lb} className="prob-row">
                          <div className="kv-row">
                            <span>Xác suất lớp <strong>{lb}</strong></span>
                            <strong>{(p * 100).toFixed(2)}%</strong>
                          </div>
                          <div className="prob-track">
                            <div
                              className={`prob-fill ${lb}`}
                              style={{ width: `${Math.max(1, p * 100)}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="kv-row">
                    <span>Độ trễ suy luận</span>
                    <strong>{result.analysis.latencyMs?.toFixed(3)} ms</strong>
                  </div>
                  <div className="kv-row">
                    <span>Phiên bản model</span>
                    <strong>{result.analysis.modelVersion}</strong>
                  </div>
                  <div className="kv-row">
                    <span>Luật Nấc 0 khớp</span>
                    <strong>
                      {result.matchedRules.length > 0 ? result.matchedRules.join(', ') : 'Không'}
                    </strong>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}