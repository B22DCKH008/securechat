/**
 * Đo hiệu năng AI trên thiết bị (AI18): độ trễ từng lần phân tích, thời gian nạp lần đầu, kích thước model.
 * Số liệu dùng để chốt timeout trong labels.yaml (runtime.timeout_ms) — nên đo trên máy yếu thật, không chỉ máy dev.
 */
import type { RiskAnalyzer } from '../contract';

export interface LatencyStats {
  n: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/** Percentile kiểu "nearest-rank" (không nội suy): p95 của 100 mẫu = mẫu thứ 95. */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length, Math.max(1, rank)) - 1]!;
}

export function summarize(samples: number[]): LatencyStats {
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: s[0] ?? NaN,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s[s.length - 1] ?? NaN,
    mean: s.length ? sum / s.length : NaN,
  };
}

export interface BenchOptions {
  warmup?: number; // mặc định 5
  iterations?: number; // mặc định 50
  now?: () => number;
  onProgress?: (done: number, total: number) => void;
}

export interface BenchCase {
  name: string;
  kind: 'message' | 'url';
  input: string;
}

export interface BenchCaseResult {
  name: string;
  kind: 'message' | 'url';
  chars: number;
  stats: LatencyStats;
  /** `stats` chỉ gồm các lần ok. Số lần KHÔNG ra kết quả 'ok' (timeout/lỗi/chưa nạp) — phải báo, không được ngầm bỏ qua. */
  notOk: number;
}

export interface BenchReport {
  generatedAt: string;
  userAgent: string;
  hardwareConcurrency: number | null;
  deviceMemoryGb: number | null;
  /** Thời gian từ lúc gọi init() đến khi sẵn sàng. */
  coldLoadMs: number;
  cases: BenchCaseResult[];
  /** Tổng số lần không ra kết quả 'ok' trên mọi trường hợp. > 0 nghĩa là báo cáo KHÔNG đáng tin. */
  notOkTotal: number;
  worstP95Ms: number;
}

export async function runBench(
  analyzer: RiskAnalyzer,
  cases: BenchCase[],
  { warmup = 5, iterations = 50, now = () => performance.now(), onProgress }: BenchOptions = {},
): Promise<BenchReport> {
  const t0 = now();
  await analyzer.init();
  const coldLoadMs = now() - t0;

  const total = cases.length * (warmup + iterations);
  let done = 0;
  const results: BenchCaseResult[] = [];
  for (const c of cases) {
    const call = () =>
      c.kind === 'message' ? analyzer.analyzeMessage(c.input) : analyzer.analyzeUrl(c.input);
    for (let i = 0; i < warmup; i++) {
      await call();
      onProgress?.(++done, total);
    }
    const lat: number[] = [];
    let notOk = 0;
    for (let i = 0; i < iterations; i++) {
      const s = now();
      const r = await call();
      // Chỉ tính độ trễ của lần phân tích THÀNH CÔNG: lần lỗi thường trả về rất nhanh, sẽ làm số đo đẹp một cách giả tạo.
      if (r.status === 'ok') lat.push(now() - s);
      else notOk++;
      onProgress?.(++done, total);
    }
    results.push({
      name: c.name,
      kind: c.kind,
      chars: c.input.length,
      stats: summarize(lat),
      notOk,
    });
  }

  const nav =
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as Navigator & { deviceMemory?: number });
  return {
    generatedAt: new Date().toISOString(),
    userAgent: nav?.userAgent ?? 'unknown',
    hardwareConcurrency: nav?.hardwareConcurrency ?? null,
    deviceMemoryGb: nav?.deviceMemory ?? null,
    coldLoadMs,
    cases: results,
    notOkTotal: results.reduce((a, r) => a + r.notOk, 0),
    worstP95Ms: Math.max(...results.map((r) => r.stats.p95).filter(Number.isFinite)),
  };
}
