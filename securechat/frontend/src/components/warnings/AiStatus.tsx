import { useEffect, useState } from 'react';
import type { AnalyzerState, ControllableAnalyzer } from '../../ai';

export function useAnalyzerState(a: ControllableAnalyzer): AnalyzerState {
  const [s, setS] = useState(a.getState());
  useEffect(() => a.subscribe(setS), [a]);
  return s;
}

const TEXT: Record<AnalyzerState['phase'], string> = {
  idle: 'AI: sẵn sàng (sẽ nạp khi cần)',
  loading: 'AI: đang nạp mô hình…',
  ready: 'AI: đang bật',
  failed: 'AI: không khả dụng',
  disabled: 'AI: đã tắt',
};

export function AiStatus({ analyzer }: { analyzer: ControllableAnalyzer }) {
  const s = useAnalyzerState(analyzer);
  const bad = s.phase === 'failed';
  return (
    <span className={`ai-status ai-${s.phase}`} title={s.reason}>
      {TEXT[s.phase]}
      {bad && (
        <>
          {' '}
          <button type="button" className="link" onClick={() => void analyzer.retryInit()}>
            thử lại
          </button>
        </>
      )}
      {s.info?.demo && <em> · mô hình DEMO</em>}
    </span>
  );
}
