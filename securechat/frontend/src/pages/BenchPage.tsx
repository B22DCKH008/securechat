import { useState } from 'react';
import { Link } from 'react-router-dom';
import { analyzer } from '../app/services';
import { runBench, runOnOff, type BenchMeta, type BenchReport } from '../ai/bench/bench';
import { BENCH_CASES } from '../ai/bench/samples';
import { AiStatus } from '../components/warnings/AiStatus';

const f = (n: number | null | undefined) => (n != null && Number.isFinite(n) ? n.toFixed(1) : '—');
const kb = (b: number | undefined) => (b ? `${(b / 1024).toFixed(1)} KB` : '—');

function currentMeta(): BenchMeta {
  const info = analyzer.getState().info;
  return {
    modelBytes: info?.bytes,
    messageVersion: info?.messageVersion,
    urlVersion: info?.urlVersion,
    demo: info?.demo,
    engineLoadMs: info?.loadMs,
  };
}

/** /bench — đo độ trễ AI trên chính thiết bị đang mở trang. Không cần đăng nhập. */
export function BenchPage() {
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [phase, setPhase] = useState<'main' | 'onoff'>('main');
  const [report, setReport] = useState<BenchReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    setReport(null);
    try {
      analyzer.setEnabled(true);
      setPhase('main');
      const rep = await runBench(analyzer, BENCH_CASES, {
        onProgress: (d, t) => setProgress([d, t]),
        getMeta: currentMeta,
      });
      setReport(rep);
      setPhase('onoff');
      setProgress([0, 1]);
      const onOff = await runOnOff(analyzer, BENCH_CASES, {
        onProgress: (d, t) => setProgress([d, t]),
      });
      setReport({ ...rep, onOff });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      analyzer.setEnabled(true);
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

  const sendOffBad = report?.onOff?.some((r) => r.offUnexpectedOk > 0) ?? false;

  return (
    <main className="page">
      <header className="topbar">
        <Link to="/">←</Link>
        <h1>Đo hiệu năng AI</h1>
      </header>
      <p className="muted">
        Đo độ trễ phân tích trên thiết bị này. Hãy chạy trên máy yếu/điện thoại thật trước khi chốt
        timeout, và ghi lại tên máy, trình duyệt. <AiStatus analyzer={analyzer} />
      </p>
      <button
        type="button"
        className="primary"
        onClick={() => void run()}
        disabled={progress !== null}
      >
        {progress
          ? `${phase === 'main' ? 'Đang đo' : 'Đang đo AI bật/tắt'}… ${progress[0]}/${progress[1]}`
          : 'Chạy đo'}
      </button>
      {error && <p className="field-error">{error}</p>}
      {report && (
        <>
          {report.meta.demo && (
            <p className="banner banner-danger" role="alert">
              Đang dùng model demo: số đo chỉ để thử đường chạy, không dùng làm kết quả.
            </p>
          )}
          {report.notOkTotal > 0 && (
            <p className="banner banner-danger" role="alert">
              Có {report.notOkTotal} lần AI không ra kết quả (chưa nạp được model, lỗi hoặc quá
              hạn). Số đo bên dưới KHÔNG đáng tin; hãy xem cột "Không ok" và console.
              {!report.meta.messageVersion &&
                ' Manifest hiện chưa có model tin nhắn nên các dòng tin nhắn và gửi tin luôn không ok; chỉ các dòng URL đáng tin.'}
            </p>
          )}
          <p>
            Nạp lần đầu: <strong>{f(report.coldLoadMs)} ms</strong> · p95 tệ nhất:{' '}
            <strong>{f(report.worstP95Ms)} ms</strong> · CPU {report.hardwareConcurrency ?? '?'}{' '}
            luồng
          </p>
          <ul className="muted small">
            <li>
              Model: {kb(report.meta.modelBytes)}
              {report.meta.messageVersion ? ` · tin nhắn ${report.meta.messageVersion}` : ''}
              {report.meta.urlVersion ? ` · URL ${report.meta.urlVersion}` : ''}
              {report.meta.engineLoadMs != null
                ? ` · nạp trong engine ${f(report.meta.engineLoadMs)} ms`
                : ''}
            </li>
            <li>
              Lần gọi đầu sau khi nạp (chưa ấm), ms: tin nhắn {f(report.firstCallMs.message)} · URL{' '}
              {f(report.firstCallMs.url)} · gửi tin {f(report.firstCallMs.send)}
            </li>
            <li>
              Heap luồng chính: {f(report.heapBeforeMb)} → {f(report.heapAfterMb)} MB
              {report.heapBeforeMb == null
                ? ' (trình duyệt này không cho đọc; dùng Chrome)'
                : ' (không gồm Web Worker, nơi model chạy)'}
            </li>
            <li>
              Tác vụ dài trên luồng chính (&gt; 50 ms):{' '}
              {report.longTasks
                ? `${report.longTasks.count} lần, tổng ${f(report.longTasks.totalMs)} ms, dài nhất ${f(report.longTasks.maxMs)} ms`
                : 'trình duyệt không hỗ trợ'}
            </li>
            <li>
              Web Worker: {report.workerAvailable ? 'có' : 'không (model chạy trên luồng chính)'} ·
              RAM thiết bị: {report.deviceMemoryGb ?? '?'} GB · cô lập nguồn gốc:{' '}
              {report.crossOriginIsolated == null
                ? '?'
                : report.crossOriginIsolated
                  ? 'có'
                  : 'không'}
            </li>
          </ul>
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
            Đơn vị ms. "Không ok" = số lần timeout/lỗi/chưa nạp được model. Các dòng "Gửi tin" chạy
            cả hai model như khi gửi tin thật.
          </p>
          {report.onOff && (
            <>
              <h2>AI bật và tắt (cùng một lần gửi)</h2>
              {sendOffBad && (
                <p className="banner banner-danger" role="alert">
                  Có lần AI đã tắt mà vẫn ra kết quả: công tắc không tắt thật, bỏ qua bảng này.
                </p>
              )}
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Trường hợp</th>
                      <th>Bật p50</th>
                      <th>Bật p95</th>
                      <th>Tắt p50</th>
                      <th>Tắt p95</th>
                      <th>Chênh p50</th>
                      <th>Chênh p95</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.onOff.map((r) => (
                      <tr key={r.name}>
                        <td>{r.name}</td>
                        <td>{f(r.on.p50)}</td>
                        <td>{f(r.on.p95)}</td>
                        <td>{f(r.off.p50)}</td>
                        <td>{f(r.off.p95)}</td>
                        <td>{f(r.overheadP50Ms)}</td>
                        <td>{f(r.overheadP95Ms)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted small">
                Khi tắt, luật dữ liệu nhạy cảm vẫn chạy. Đây chỉ là phần AI; độ trễ gửi tin từ đầu
                đến cuối (mã hóa, mạng, backend) đo riêng khi ghép với backend.
              </p>
            </>
          )}
          <p className="muted small">
            CPU và RAM của Worker: mở Task Manager của Chrome (Shift+Esc), xem dòng của tab này và
            "Dedicated Worker" trước và trong lúc đo.
          </p>
          <button type="button" onClick={download}>
            Tải báo cáo JSON
          </button>
        </>
      )}
    </main>
  );
}
