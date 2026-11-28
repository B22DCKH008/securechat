/**
 * Đo hiệu năng AI trên thiết bị:
 *  - AI18: thời gian nạp lần đầu, độ trễ lần gọi đầu, độ trễ các lần sau (p50/p95/p99).
 *  - AI19: kích thước model, bộ nhớ heap (chỉ Chrome), tác vụ dài trên luồng chính.
 *  - AI20: trường hợp 'send' chạy đúng đường đi khi gửi tin (model tin nhắn + model URL cùng lúc).
 *  - AI21: `runOnOff` đo cùng một lần gửi khi AI bật và khi AI tắt, lấy chênh lệch làm chi phí của AI.
 *  - AI26: ghi lại thiết bị và trình duyệt đang chạy.
 * Số liệu dùng để chốt timeout trong labels.yaml (runtime.timeout_ms) — nên đo trên máy yếu thật, không chỉ máy dev.
 */
import type { RiskAnalyzer } from '../contract';
import { assessRisk } from '../risk';
import type { ControllableAnalyzer } from '../runtime/analyzer';

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

export type BenchKind = 'message' | 'url' | 'send';

export interface BenchCase {
  name: string;
  /**
   * 'message' / 'url': gọi riêng từng model.
   * 'send': chạy `assessRisk` như lúc gửi tin (model tin nhắn và các model URL chạy song song).
   */
  kind: BenchKind;
  input: string;
}

export interface BenchMeta {
  /** Tổng dung lượng file model (byte) theo manifest. */
  modelBytes?: number;
  messageVersion?: string;
  urlVersion?: string;
  /** true: đang dùng model demo, số đo chỉ để thử đường chạy. */
  demo?: boolean;
  /** Thời gian nạp model bên trong engine (ms), không gồm chờ Worker khởi động. */
  engineLoadMs?: number;
}

export interface BenchOptions {
  warmup?: number; // mặc định 5
  iterations?: number; // mặc định 50
  now?: () => number;
  onProgress?: (done: number, total: number) => void;
  /** Gọi sau init() để lấy thông tin model (kích thước, phiên bản). */
  getMeta?: () => BenchMeta;
}

export interface BenchCaseResult {
  name: string;
  kind: BenchKind;
  chars: number;
  stats: LatencyStats;
  /** `stats` chỉ gồm các lần ok. Số lần KHÔNG ra kết quả 'ok' (timeout/lỗi/chưa nạp) — phải báo, không được ngầm bỏ qua. */
  notOk: number;
}

export interface LongTaskStats {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface OnOffResult {
  name: string;
  on: LatencyStats;
  off: LatencyStats;
  /** Chi phí AI cho một lần gửi: độ trễ khi bật trừ độ trễ khi tắt. */
  overheadP50Ms: number;
  overheadP95Ms: number;
  /** Số lần AI bật nhưng không ra kết quả ok (không được tính vào `on`). */
  onNotOk: number;
  /** Số lần AI đã tắt mà vẫn ra 'ok'. Khác 0 nghĩa là công tắc không tắt thật, số so sánh vô nghĩa. */
  offUnexpectedOk: number;
}

export interface BenchReport {
  generatedAt: string;
  userAgent: string;
  hardwareConcurrency: number | null;
  deviceMemoryGb: number | null;
  /** true nếu trang chạy ở chế độ cô lập nguồn gốc (cần cho đo bộ nhớ chính xác và WASM nhiều luồng). */
  crossOriginIsolated: boolean | null;
  /** Trình duyệt có Web Worker; khi có, model chạy trong Worker và không chặn giao diện. */
  workerAvailable: boolean;
  meta: BenchMeta;
  /** Thời gian từ lúc gọi init() đến khi sẵn sàng. */
  coldLoadMs: number;
  /** Độ trễ của lần phân tích đầu tiên sau init (theo từng loại), chưa "ấm". Bỏ trống nếu lần đó không ra ok. */
  firstCallMs: Partial<Record<BenchKind, number>>;
  /** Heap JS của luồng chính (MB), chỉ có trên Chrome. Không gồm bộ nhớ của Web Worker nơi model chạy. */
  heapBeforeMb: number | null;
  heapAfterMb: number | null;
  /** Các tác vụ > 50 ms trên luồng chính trong lúc đo. null = trình duyệt không hỗ trợ. */
  longTasks: LongTaskStats | null;
  cases: BenchCaseResult[];
  /** Tổng số lần không ra kết quả 'ok' trên mọi trường hợp. > 0 nghĩa là báo cáo KHÔNG đáng tin. */
  notOkTotal: number;
  worstP95Ms: number;
  /** Do `runOnOff` điền vào (nếu có chạy). */
  onOff?: OnOffResult[];
}

function heapMb(): number | null {
  if (typeof performance === 'undefined') return null;
  const m = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  return m?.usedJSHeapSize != null ? m.usedJSHeapSize / (1024 * 1024) : null;
}

function observeLongTasks(): { stop: () => LongTaskStats | null } {
  try {
    if (
      typeof PerformanceObserver === 'undefined' ||
      !PerformanceObserver.supportedEntryTypes?.includes('longtask')
    ) {
      return { stop: () => null };
    }
    const st: LongTaskStats = { count: 0, totalMs: 0, maxMs: 0 };
    const add = (entries: PerformanceEntryList) => {
      for (const e of entries) {
        st.count++;
        st.totalMs += e.duration;
        st.maxMs = Math.max(st.maxMs, e.duration);
      }
    };
    const po = new PerformanceObserver((list) => add(list.getEntries()));
    po.observe({ type: 'longtask' });
    return {
      stop: () => {
        add(po.takeRecords());
        po.disconnect();
        return st;
      },
    };
  } catch {
    return { stop: () => null };
  }
}

/** Một lần gọi theo loại trường hợp; trả về true nếu mọi phân tích trong lần đó đều 'ok'. */
async function callOnce(analyzer: RiskAnalyzer, c: BenchCase): Promise<boolean> {
  if (c.kind === 'message') return (await analyzer.analyzeMessage(c.input)).status === 'ok';
  if (c.kind === 'url') return (await analyzer.analyzeUrl(c.input)).status === 'ok';
  const r = await assessRisk(analyzer, c.input, { outgoing: true });
  return r.message.status === 'ok' && r.urls.every((u) => u.status === 'ok');
}

interface CaseTiming {
  /** Độ trễ các lần đo (sau warmup). Với `onlyOk`, chỉ gồm lần ra 'ok'. */
  lat: number[];
  okCount: number;
  notOk: number;
  firstCallMs?: number;
}

async function timeCase(
  analyzer: RiskAnalyzer,
  c: BenchCase,
  warmup: number,
  iterations: number,
  now: () => number,
  onlyOk: boolean,
  tick: () => void,
): Promise<CaseTiming> {
  let firstCallMs: number | undefined;
  for (let i = 0; i < warmup; i++) {
    const s = now();
    const ok = await callOnce(analyzer, c);
    if (i === 0 && ok) firstCallMs = now() - s;
    tick();
  }
  const lat: number[] = [];
  let okCount = 0;
  let notOk = 0;
  for (let i = 0; i < iterations; i++) {
    const s = now();
    const ok = await callOnce(analyzer, c);
    const ms = now() - s;
    if (ok) okCount++;
    else notOk++;
    // Khi đo AI bật, chỉ tính độ trễ của lần phân tích THÀNH CÔNG: lần lỗi thường trả về rất nhanh,
    // sẽ làm số đo đẹp một cách giả tạo.
    if (ok || !onlyOk) lat.push(ms);
    tick();
  }
  return { lat, okCount, notOk, firstCallMs };
}

export async function runBench(
  analyzer: RiskAnalyzer,
  cases: BenchCase[],
  {
    warmup = 5,
    iterations = 50,
    now = () => performance.now(),
    onProgress,
    getMeta,
  }: BenchOptions = {},
): Promise<BenchReport> {
  const heapBeforeMb = heapMb();
  const longTaskObserver = observeLongTasks();

  const t0 = now();
  await analyzer.init();
  const coldLoadMs = now() - t0;

  const total = cases.length * (warmup + iterations);
  let done = 0;
  const tick = () => onProgress?.(++done, total);
  const results: BenchCaseResult[] = [];
  const firstCallMs: Partial<Record<BenchKind, number>> = {};
  for (const c of cases) {
    const r = await timeCase(analyzer, c, warmup, iterations, now, true, tick);
    if (r.firstCallMs !== undefined && firstCallMs[c.kind] === undefined) {
      firstCallMs[c.kind] = r.firstCallMs;
    }
    results.push({
      name: c.name,
      kind: c.kind,
      chars: c.input.length,
      stats: summarize(r.lat),
      notOk: r.notOk,
    });
  }

  const longTasks = longTaskObserver.stop();
  const nav =
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as Navigator & { deviceMemory?: number });
  return {
    generatedAt: new Date().toISOString(),
    userAgent: nav?.userAgent ?? 'unknown',
    hardwareConcurrency: nav?.hardwareConcurrency ?? null,
    deviceMemoryGb: nav?.deviceMemory ?? null,
    crossOriginIsolated:
      typeof globalThis.crossOriginIsolated === 'boolean' ? globalThis.crossOriginIsolated : null,
    workerAvailable: typeof Worker !== 'undefined',
    meta: getMeta?.() ?? {},
    coldLoadMs,
    firstCallMs,
    heapBeforeMb,
    heapAfterMb: heapMb(),
    longTasks,
    cases: results,
    notOkTotal: results.reduce((a, r) => a + r.notOk, 0),
    worstP95Ms: Math.max(...results.map((r) => r.stats.p95).filter(Number.isFinite)),
  };
}

/**
 * Đo từng trường hợp 'send' hai lần: AI bật rồi AI tắt, cùng nội dung, cùng số lần lặp.
 * Khi tắt, hai model không chạy nhưng luật dữ liệu nhạy cảm vẫn chạy (đúng như ứng dụng thật),
 * nên chênh lệch chỉ là chi phí của hai model. Đây là phần AI trong AI21/EXP9; độ trễ gửi tin từ đầu đến cuối
 * (mã hóa, mạng, backend) phải đo riêng khi có backend.
 * Luôn bật lại AI khi xong, kể cả khi lỗi giữa chừng.
 */
export async function runOnOff(
  analyzer: ControllableAnalyzer,
  cases: BenchCase[],
  {
    warmup = 5,
    iterations = 50,
    now = () => performance.now(),
    onProgress,
  }: Pick<BenchOptions, 'warmup' | 'iterations' | 'now' | 'onProgress'> = {},
): Promise<OnOffResult[]> {
  const sendCases = cases.filter((c) => c.kind === 'send');
  const total = sendCases.length * 2 * (warmup + iterations);
  let done = 0;
  const tick = () => onProgress?.(++done, total);
  const out: OnOffResult[] = [];
  try {
    for (const c of sendCases) {
      analyzer.setEnabled(true);
      await analyzer.init();
      const on = await timeCase(analyzer, c, warmup, iterations, now, true, tick);
      analyzer.setEnabled(false);
      const off = await timeCase(analyzer, c, warmup, iterations, now, false, tick);
      const onStats = summarize(on.lat);
      const offStats = summarize(off.lat);
      out.push({
        name: c.name,
        on: onStats,
        off: offStats,
        overheadP50Ms: onStats.p50 - offStats.p50,
        overheadP95Ms: onStats.p95 - offStats.p95,
        onNotOk: on.notOk,
        offUnexpectedOk: off.okCount,
      });
    }
  } finally {
    analyzer.setEnabled(true);
  }
  return out;
}
