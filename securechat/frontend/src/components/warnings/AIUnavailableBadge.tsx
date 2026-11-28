import type { AnalysisStatus } from '../../ai/contract';

interface AIUnavailableBadgeProps {
  status: AnalysisStatus;
  enabled: boolean;
  modelVersion?: string;
  coldStartMs?: number | null;
}

export function AIUnavailableBadge({
  status,
  enabled,
  modelVersion,
  coldStartMs,
}: AIUnavailableBadgeProps) {
  if (!enabled) {
    return (
      <span className="badge badge-unavailable" role="status">
        AI đang tắt — không thể phân tích rủi ro
      </span>
    );
  }

  if (status === 'ok') {
    const coldLabel = coldStartMs != null ? ` · cold ${coldStartMs.toFixed(1)}ms` : '';
    return (
      <span className="badge badge-ok" role="status">
        AI on-device sẵn sàng ({modelVersion ?? 'loaded'}
        {coldLabel})
      </span>
    );
  }

  if (status === 'error' || status === 'timeout') {
    return (
      <span className="badge badge-error" role="alert">
        AI gặp lỗi ({status}) — không thể phân tích rủi ro
      </span>
    );
  }

  return (
    <span className="badge badge-unavailable" role="status">
      AI không khả dụng — không thể phân tích rủi ro
    </span>
  );
}