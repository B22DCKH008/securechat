/**
 * RiskAnalyzer: cài đặt `RiskAnalyzer` của contract.ts trên một InferenceEngine.
 *
 * Nguyên tắc (AI22, AI24): lỗi / quá hạn / chưa nạp / đang tắt => status KHÁC 'ok'.
 * Không bao giờ trả 'ok' với nhãn benign khi thực ra không phân tích được.
 */
import type { MessageAnalysis, RiskAnalyzer, UrlAnalysis } from '../contract';
import type { EngineInfo, InferenceEngine } from './engine';
import { ModelNotLoadedError } from './engine';

export type AnalyzerPhase = 'idle' | 'loading' | 'ready' | 'failed' | 'disabled';

export interface AnalyzerState {
  phase: AnalyzerPhase;
  /** Lý do ngắn gọn (chỉ để hiển thị/ghi log, không chứa nội dung tin nhắn). */
  reason?: string;
  info?: EngineInfo;
}

export interface AnalyzerOptions {
  /** Quá hạn => status 'timeout'. Giá trị cụ thể do nhóm chốt sau khi đo (labels.yaml: runtime.timeout_ms). */
  timeoutMs: number;
  /**
   * Thời gian tối đa một lần phân tích chờ model đang nạp (mặc định = timeoutMs). Hết thời gian thì trả
   * 'unavailable' NGAY, còn việc nạp vẫn tiếp tục ở nền. Nhờ vậy gửi tin không bị kẹt vài giây khi model
   * (khoảng 2 MB) chưa nạp xong trên máy yếu hoặc mạng chậm.
   */
  initWaitMs?: number;
  enabled?: boolean;
  now?: () => number;
}

export interface ControllableAnalyzer extends RiskAnalyzer {
  getState(): AnalyzerState;
  subscribe(cb: (s: AnalyzerState) => void): () => void;
  setEnabled(enabled: boolean): void;
  /** Thử nạp lại sau khi lỗi. */
  retryInit(): Promise<void>;
}

class TimeoutError extends Error {
  override name = 'TimeoutError';
}

/** Chờ `p` tối đa `ms`; trả true nếu `p` xong (thành công hoặc lỗi) trong thời gian đó. Không hủy `p`. */
function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    const done = () => {
      clearTimeout(t);
      resolve(true);
    };
    p.then(done, done);
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(`quá ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function createRiskAnalyzer(
  engine: InferenceEngine,
  options: AnalyzerOptions,
): ControllableAnalyzer {
  const now = options.now ?? (() => performance.now());
  let enabled = options.enabled ?? true;
  let state: AnalyzerState = { phase: enabled ? 'idle' : 'disabled' };
  let initPromise: Promise<void> | null = null;
  const subs = new Set<(s: AnalyzerState) => void>();

  const setState = (s: AnalyzerState) => {
    state = s;
    for (const cb of subs) cb(state);
  };

  async function doInit(): Promise<void> {
    setState({ phase: 'loading' });
    try {
      const info = await withTimeout(engine.init(), Math.max(options.timeoutMs, 15000));
      setState({ phase: 'ready', info });
    } catch (e) {
      engine.reset();
      setState({ phase: 'failed', reason: (e as Error).message });
    }
  }

  function init(): Promise<void> {
    if (!enabled) return Promise.resolve();
    initPromise ??= doInit();
    return initPromise;
  }

  /**
   * Trả về lý do không chạy được, hoặc null nếu sẵn sàng. Không chờ model đang nạp quá `initWaitMs`:
   * việc nạp tiếp tục ở nền, các lần gọi sau sẽ dùng được model khi đã sẵn sàng.
   */
  async function ensureReady(): Promise<string | null> {
    if (!enabled) return 'disabled';
    if (state.phase !== 'ready') {
      const settled = await settlesWithin(init(), options.initWaitMs ?? options.timeoutMs);
      if (!settled) return 'loading';
    }
    return state.phase === 'ready' ? null : (state.reason ?? 'not_ready');
  }

  async function run<T>(
    task: () => Promise<T>,
  ): Promise<
    { ok: true; value: T; ms: number } | { ok: false; status: 'unavailable' | 'timeout' | 'error' }
  > {
    if ((await ensureReady()) !== null) return { ok: false, status: 'unavailable' };
    const t0 = now();
    try {
      const value = await withTimeout(task(), options.timeoutMs);
      return { ok: true, value, ms: now() - t0 };
    } catch (e) {
      if (e instanceof TimeoutError) {
        // worker có thể đang kẹt: hủy và buộc nạp lại ở lần sau
        engine.reset();
        initPromise = null;
        setState({ phase: 'idle', reason: 'timeout' });
        return { ok: false, status: 'timeout' };
      }
      if (e instanceof ModelNotLoadedError) return { ok: false, status: 'unavailable' };
      return { ok: false, status: 'error' };
    }
  }

  return {
    init,

    async analyzeMessage(text: string): Promise<MessageAnalysis> {
      const r = await run(() => engine.analyzeMessage(text));
      if (!r.ok) return { status: r.status };
      return {
        status: 'ok',
        label: r.value.label,
        confidence: r.value.confidence,
        modelVersion: r.value.modelVersion,
        latencyMs: r.ms,
      };
    },

    async analyzeUrl(url: string): Promise<UrlAnalysis> {
      const r = await run(() => engine.analyzeUrl(url));
      if (!r.ok) return { status: r.status, url };
      return {
        status: 'ok',
        url,
        label: r.value.label,
        confidence: r.value.confidence,
        modelVersion: r.value.modelVersion,
        latencyMs: r.ms,
      };
    },

    getState: () => state,
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    setEnabled(v: boolean) {
      if (v === enabled) return;
      enabled = v;
      if (!v) {
        engine.reset();
        initPromise = null;
        setState({ phase: 'disabled' });
      } else {
        setState({ phase: 'idle' });
      }
    },
    async retryInit() {
      initPromise = null;
      await init();
    },
  };
}
