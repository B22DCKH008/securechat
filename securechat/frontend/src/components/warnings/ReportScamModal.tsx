import { useState, type FormEvent } from 'react';
import { SCAM_REPORT_REASONS } from '../../features/auth/types';

interface ReportScamModalProps {
  targetName: string;
  onSubmit: (reason: string, note: string) => void;
  onClose: () => void;
}

export function ReportScamModal({ targetName, onSubmit, onClose }: ReportScamModalProps) {
  const [reason, setReason] = useState<string>(SCAM_REPORT_REASONS[0]);
  const [note, setNote] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSubmit(reason, note.trim());
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-card">
        <h3>Tố cáo tài khoản có dấu hiệu lừa đảo</h3>
        <div style={{ fontSize: 13, color: '#475569' }}>
          Đối tượng bị tố cáo: <strong>{targetName}</strong>. Khi bạn gửi tố cáo, các người dùng SecureChat khác khi tìm kiếm hoặc nhận tin từ tài khoản này sẽ thấy cảnh báo cộng đồng.
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="field">
            <label htmlFor="report-reason">Hành vi nghi vấn</label>
            <select
              id="report-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            >
              {SCAM_REPORT_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="report-note">Ghi chú ngắn cho cộng đồng (tùy chọn)</label>
            <textarea
              id="report-note"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Ví dụ: Giả nhân viên giao hàng đòi chuyển khoản trước 45k..."
            />
          </div>

          <div style={{ fontSize: 11.5, color: '#64748b' }}>
            Bảo mật: Chỉ mã định danh tài khoản bị tố cáo và lý do cảnh báo được lưu; nội dung hội thoại gốc của bạn không bị trích xuất tự động.
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <button type="button" className="btn" onClick={onClose}>
              Hủy
            </button>
            <button type="submit" className="btn btn-danger">
              Xác nhận tố cáo
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}