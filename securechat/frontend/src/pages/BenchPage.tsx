import { useState } from 'react';
import { Link } from 'react-router-dom';
import { analyzer } from '../app/services';
import { runBench, type BenchReport } from '../ai/bench/bench';
import { BENCH_CASES } from '../ai/bench/samples';
import { AiStatus } from '../components/warnings/AiStatus';

const f = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : '—');

/** /bench — đo độ trễ AI trên chính thiết bị đang mở trang. Không cần đăng nhập. */
export function BenchPage() {
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [report, setReport] = useState<BenchReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    setReport(null);
    try {
      analyzer.setEnabled(true);
      setReport(
        await runBench(analyzer, BENCH_CASES, { onProgress: (d, t) => setProgress([d, t]) }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
    }
  };

  const download = () => {
    if (!report) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-bench-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="page">
      <header className="topbar">
        <Link to="/">←</Link>
        <h1>Đo hiệu năng AI</h1>
      </header>
      <p className="muted">
        Đo độ trễ phân tích trên thiết bị này. Hãy chạy trên máy yếu/điện thoại thật trước khi chốt
        timeout. <AiStatus analyzer={analyzer} />
      </p>
      <button
        type="button"
        className="primary"
        onClick={() => void run()}
        disabled={progress !== null}
      >
        {progress ? `Đang đo… ${progress[0]}/${progress[1]}` : 'Chạy đo'}
      </button>
      {error && <p className="field-error">{error}</p>}
      {report && (
        <>
          {report.notOkTotal > 0 && (
            <p className="banner banner-danger" role="alert">
              Có {report.notOkTotal} lần AI không ra kết quả (chưa nạp được model, lỗi hoặc quá
              hạn). Số đo bên dưới KHÔNG đáng tin; hãy xem cột "Không ok" và console.
            </p>
          )}
          <p>
            Nạp lần đầu: <strong>{f(report.coldLoadMs)} ms</strong> · p95 tệ nhất:{' '}
            <strong>{f(report.worstP95Ms)} ms</strong> · CPU {report.hardwareConcurrency ?? '?'}{' '}
            luồng
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Trường hợp</th>
                  <th>p50</th>
                  <th>p95</th>
                  <th>p99</th>
                  <th>max</th>
                  <th>Không ok</th>
                </tr>
              </thead>
              <tbody>
                {report.cases.map((c) => (
                  <tr key={c.name}>
                    <td>{c.name}</td>
                    <td>{f(c.stats.p50)}</td>
                    <td>{f(c.stats.p95)}</td>
                    <td>{f(c.stats.p99)}</td>
                    <td>{f(c.stats.max)}</td>
                    <td className={c.notOk ? 'bad' : ''}>{c.notOk}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            Đơn vị ms. "Không ok" = số lần timeout/lỗi/chưa nạp được model.
          </p>
          <button type="button" onClick={download}>
            Tải báo cáo JSON
          </button>
        </>
      )}
    </main>
  );
}
