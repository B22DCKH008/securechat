import { useState } from 'react';
import { LocalRiskAnalyzer } from '../ai/runtime/analyzer';

interface PerformanceWithMemory extends Performance {
  memory?: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
}

interface BenchResult {
  modelVersion: string;
  modelBytes: number;
  rulesBytes: number;
  coldStartMs: number;
  runs: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  meanMs: number;
  maxMs: number;
  usedHeapMB: number | null;
  userAgent: string;
}

const BENCH_CORPUS = [
  'Tối nay mấy giờ anh em mình đi ăn bún đậu thế?',
  'Mình vừa push code lên GitHub rồi bạn pull về test thử nhé: https://github.com/securechat-demo/ml',
  'Ma xac thuc OTP cua Quy khach la 482910. Tuyet doi KHONG chia se ma nay cho bat ky ai.',
  '[QC] Thuê bao của quý khách được ưu đãi gói data 4G 6GB/ngày chỉ 90k/tháng, soạn DK90 gửi 191.',
  'Chào anh/chị, trung tâm mở lớp tiếng Anh giao tiếp giảm 40% học phí cho sinh viên trong tuần này.',
  'Thông báo tài khoản ngân hàng của bạn sắp bị khóa, xác minh ngay tại https://vcb-xacminh.top/login',
  'a oi e lo bam nham sdt cua a de nhan ma huy goi cuoc, gui giup e ma otp 6 so vua ve may a voi',
  'Tuyển CTV làm việc tại nhà chỉ cần thả tim video TikTok nhận 400k/ngày thanh toán qua STK.',
  'Alo anh ơi em shipper giao hàng đứng ở cổng gọi ko dc, anh ck trước 45k vào STK 0903847261 nhé.',
  'Thông báo từ Công an phường: Hồ sơ VNeID mức 2 bị sai lệch, cập nhật tại https://dinhdanh-vneid.xyz/app',
];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function BenchPage() {
  const [runs, setRuns] = useState(300);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BenchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function runBench() {
    setRunning(true);
    setError(null);
    setCopied(false);

    try {
      const bust = `?t=${Date.now()}`;
      const modelUrl = `/models/message_model.json${bust}`;
      const rulesUrl = `/models/message_rules.json${bust}`;

      const [mHead, rHead] = await Promise.all([fetch(modelUrl), fetch(rulesUrl)]);
      const [mBuf, rBuf] = await Promise.all([mHead.arrayBuffer(), rHead.arrayBuffer()]);

      const analyzer = new LocalRiskAnalyzer({
        messageModelUrl: `/models/message_model.json?cold=${Date.now()}`,
        messageRulesUrl: `/models/message_rules.json?cold=${Date.now()}`,
      });

      const tCold0 = performance.now();
      await analyzer.init();
      const first = await analyzer.analyzeMessage(BENCH_CORPUS[0]);
      const coldStartMs = performance.now() - tCold0;

      const times: number[] = [];
      for (let i = 0; i < runs; i++) {
        const text = BENCH_CORPUS[i % BENCH_CORPUS.length];
        const t0 = performance.now();
        await analyzer.analyzeMessage(text);
        times.push(performance.now() - t0);
      }

      const sorted = [...times].sort((a, b) => a - b);
      const meanMs = times.reduce((a, b) => a + b, 0) / times.length;
      const mem = (performance as PerformanceWithMemory).memory;

      setResult({
        modelVersion: first.modelVersion ?? 'unknown',
        modelBytes: mBuf.byteLength,
        rulesBytes: rBuf.byteLength,
        coldStartMs,
        runs,
        minMs: sorted[0] ?? 0,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        p99Ms: percentile(sorted, 99),
        meanMs,
        maxMs: sorted[sorted.length - 1] ?? 0,
        usedHeapMB: mem ? mem.usedJSHeapSize / (1024 * 1024) : null,
        userAgent: navigator.userAgent,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  const markdownReport = result
    ? `## Browser Performance Benchmark (AI18–AI21)

- **Model version:** \`${result.modelVersion}\`
- **Artifact size:** \`${(result.modelBytes / 1024).toFixed(1)} KB\` (model JSON) + \`${(result.rulesBytes / 1024).toFixed(1)} KB\` (rules JSON)
- **Cold start (fetch + parse + 1st inference):** \`${result.coldStartMs.toFixed(2)} ms\`
- **Warm inference (${result.runs} runs):** p50 = \`${result.p50Ms.toFixed(3)} ms\`, p95 = \`${result.p95Ms.toFixed(3)} ms\`, p99 = \`${result.p99Ms.toFixed(3)} ms\`, mean = \`${result.meanMs.toFixed(3)} ms\`
- **JS Heap used (Chromium):** ${result.usedHeapMB != null ? `\`${result.usedHeapMB.toFixed(2)} MB\`` : 'N/A (browser does not expose performance.memory)'}
- **Environment:** \`${result.userAgent}\``
    : '';

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Đo hiệu năng On-Device AI trên trình duyệt (`/bench`)</h2>
      <p style={{ fontSize: 13, color: '#475569' }}>
        Đo thời gian nạp mô hình lần đầu (cold start), độ trễ suy luận warm (p50/p95/p99), kích thước artifact và bộ nhớ JS Heap để ghi vào <code>ml/reports/performance.md</code>.
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13 }}>
          Số lượt warm:{' '}
          <input
            type="number"
            min={50}
            max={5000}
            step={50}
            value={runs}
            onChange={(e) => setRuns(Math.max(50, Number(e.target.value) || 300))}
            style={{ width: 80, padding: 5, borderRadius: 6, border: '1px solid #cfd8e3' }}
          />
        </label>
        <button type="button" className="btn btn-primary" onClick={runBench} disabled={running}>
          {running ? 'Đang đo...' : 'Chạy Benchmark'}
        </button>
      </div>

      {error && (
        <div className="warning-box warning-scam" style={{ marginTop: 12 }}>
          Lỗi chạy benchmark: {error}
        </div>
      )}

      {result && (
        <>
          <div className="bench-grid">
            <div className="stat-box">
              <div className="stat-label">Cold Start</div>
              <div className="stat-value">{result.coldStartMs.toFixed(2)} ms</div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Warm p50</div>
              <div className="stat-value">{result.p50Ms.toFixed(3)} ms</div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Warm p95 / p99</div>
              <div className="stat-value">
                {result.p95Ms.toFixed(3)} / {result.p99Ms.toFixed(3)} ms
              </div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Kích thước JSON</div>
              <div className="stat-value">{(result.modelBytes / 1024).toFixed(1)} KB</div>
            </div>
            <div className="stat-box">
              <div className="stat-label">JS Heap (Chromium)</div>
              <div className="stat-value">
                {result.usedHeapMB != null ? `${result.usedHeapMB.toFixed(2)} MB` : 'N/A'}
              </div>
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <strong style={{ fontSize: 13 }}>Markdown sẵn sàng dán vào ml/reports/performance.md</strong>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  navigator.clipboard.writeText(markdownReport);
                  setCopied(true);
                }}
              >
                {copied ? 'Đã sao chép' : 'Sao chép Markdown'}
              </button>
            </div>
            <pre className="md-out">{markdownReport}</pre>
          </div>
        </>
      )}
    </div>
  );
}