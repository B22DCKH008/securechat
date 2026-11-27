import { describe, expect, it, vi } from 'vitest';
import { createRiskAnalyzer } from '../../src/ai/runtime/analyzer';
import { ModelNotLoadedError, type InferenceEngine } from '../../src/ai/runtime/engine';
import { assessRisk } from '../../src/ai/risk';

const okMsg = (label: 'benign' | 'scam' | 'spam' = 'benign') => ({
  label,
  confidence: 0.9,
  riskyScore: label === 'benign' ? 0.1 : 0.9,
  warn: label !== 'benign',
  modelVersion: 'v-test',
});
const okUrl = (label: 'benign' | 'malicious' = 'benign') => ({
  label,
  confidence: 0.9,
  score: label === 'benign' ? 0.1 : 0.9,
  modelVersion: 'u-test',
});

function fakeEngine(over: Partial<InferenceEngine> = {}): InferenceEngine & { resets: number } {
  const e = {
    resets: 0,
    init: async () => ({ loadMs: 1 }),
    analyzeMessage: async () => okMsg(),
    analyzeUrl: async () => okUrl(),
    reset() {
      e.resets++;
    },
    dispose() {},
    ...over,
  };
  return e as InferenceEngine & { resets: number };
}

describe('createRiskAnalyzer', () => {
  it('chạy được: status ok kèm modelVersion và latency', async () => {
    const a = createRiskAnalyzer(fakeEngine(), { timeoutMs: 500 });
    const r = await a.analyzeMessage('xin chào');
    expect(r).toMatchObject({ status: 'ok', label: 'benign', modelVersion: 'v-test' });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(a.getState().phase).toBe('ready');
  });

  it('nạp model lỗi => unavailable (KHÔNG BAO GIỜ ok/benign)', async () => {
    const a = createRiskAnalyzer(
      fakeEngine({
        init: async () => {
          throw new Error('404');
        },
      }),
      { timeoutMs: 500 },
    );
    expect(await a.analyzeMessage('x')).toEqual({ status: 'unavailable' });
    expect(await a.analyzeUrl('https://a.com')).toEqual({
      status: 'unavailable',
      url: 'https://a.com',
    });
    expect(a.getState()).toMatchObject({ phase: 'failed', reason: '404' });
  });

  it('thiếu model con (ví dụ chưa có model URL) => unavailable', async () => {
    const a = createRiskAnalyzer(
      fakeEngine({
        analyzeUrl: async () => {
          throw new ModelNotLoadedError('x');
        },
      }),
      { timeoutMs: 500 },
    );
    expect((await a.analyzeUrl('https://a.com')).status).toBe('unavailable');
    expect((await a.analyzeMessage('x')).status).toBe('ok');
  });

  it('quá hạn => timeout, hủy engine và nạp lại ở lần sau', async () => {
    let slow = true;
    const engine = fakeEngine({
      analyzeMessage: () => (slow ? new Promise(() => {}) : Promise.resolve(okMsg())),
    });
    const a = createRiskAnalyzer(engine, { timeoutMs: 20 });
    expect((await a.analyzeMessage('x')).status).toBe('timeout');
    expect(engine.resets).toBe(1);
    slow = false;
    expect((await a.analyzeMessage('x')).status).toBe('ok');
  });

  it('engine ném lỗi bất kỳ => error', async () => {
    const a = createRiskAnalyzer(
      fakeEngine({
        analyzeMessage: async () => {
          throw new Error('boom');
        },
      }),
      { timeoutMs: 500 },
    );
    expect((await a.analyzeMessage('x')).status).toBe('error');
  });

  it('AI tắt => unavailable và không gọi engine', async () => {
    const engine = fakeEngine();
    const spy = vi.spyOn(engine, 'analyzeMessage');
    const a = createRiskAnalyzer(engine, { timeoutMs: 500, enabled: false });
    expect(await a.analyzeMessage('x')).toEqual({ status: 'unavailable' });
    expect(spy).not.toHaveBeenCalled();
    a.setEnabled(true);
    expect((await a.analyzeMessage('x')).status).toBe('ok');
  });

  it('init chỉ chạy một lần dù gọi đồng thời', async () => {
    const init = vi.fn(async () => ({ loadMs: 1 }));
    const a = createRiskAnalyzer(fakeEngine({ init }), { timeoutMs: 500 });
    await Promise.all([
      a.analyzeMessage('a'),
      a.analyzeMessage('b'),
      a.analyzeUrl('https://x.com'),
    ]);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('retryInit sau khi lỗi', async () => {
    let fail = true;
    const a = createRiskAnalyzer(
      fakeEngine({
        init: async () => {
          if (fail) throw new Error('x');
          return { loadMs: 1 };
        },
      }),
      { timeoutMs: 500 },
    );
    expect((await a.analyzeMessage('x')).status).toBe('unavailable');
    fail = false;
    await a.retryInit();
    expect((await a.analyzeMessage('x')).status).toBe('ok');
  });

  it('model đang nạp lâu => unavailable ngay sau initWaitMs, nạp vẫn tiếp tục ở nền', async () => {
    let finishLoad!: () => void;
    const loaded = new Promise<void>((r) => (finishLoad = r));
    const init = vi.fn(async () => {
      await loaded;
      return { loadMs: 4000 };
    });
    const engine = fakeEngine({ init });
    const a = createRiskAnalyzer(engine, { timeoutMs: 500, initWaitMs: 20 });

    const t0 = performance.now();
    expect(await a.analyzeMessage('x')).toEqual({ status: 'unavailable' });
    expect(performance.now() - t0).toBeLessThan(400); // không chờ đến khi model nạp xong
    expect(a.getState().phase).toBe('loading');
    expect(engine.resets).toBe(0); // đang nạp thì không hủy engine

    finishLoad();
    await a.init();
    expect(a.getState().phase).toBe('ready');
    expect((await a.analyzeMessage('x')).status).toBe('ok');
    expect(init).toHaveBeenCalledTimes(1); // các lần gọi dùng chung một lần nạp
  });

  it('model nạp xong trong initWaitMs => vẫn phân tích bình thường ở lần gọi đầu', async () => {
    const init = async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { loadMs: 10 };
    };
    const a = createRiskAnalyzer(fakeEngine({ init }), { timeoutMs: 500, initWaitMs: 300 });
    expect((await a.analyzeMessage('x')).status).toBe('ok');
  });

  it('initWaitMs mặc định bằng timeoutMs', async () => {
    const init = () => new Promise<{ loadMs: number }>(() => {}); // không bao giờ xong
    const a = createRiskAnalyzer(fakeEngine({ init }), { timeoutMs: 30 });
    const t0 = performance.now();
    expect(await a.analyzeMessage('x')).toEqual({ status: 'unavailable' });
    expect(performance.now() - t0).toBeLessThan(400);
  });
});

describe('assessRisk', () => {
  const analyzerWith = (e: Partial<InferenceEngine>) =>
    createRiskAnalyzer(fakeEngine(e), { timeoutMs: 500 });

  it('benign, không URL => none', async () => {
    expect((await assessRisk(analyzerWith({}), 'hẹn 9h nhé', { outgoing: true })).level).toBe(
      'none',
    );
  });
  it('nhãn scam => warn', async () => {
    const r = await assessRisk(analyzerWith({ analyzeMessage: async () => okMsg('scam') }), 'x', {
      outgoing: false,
    });
    expect(r.level).toBe('warn');
  });
  it('URL độc hại => warn, chạy model URL cho từng link', async () => {
    const analyzeUrl = vi.fn(async () => okUrl('malicious'));
    const r = await assessRisk(
      analyzerWith({ analyzeUrl }),
      'vào https://a.top/x và https://b.top/y',
      { outgoing: false },
    );
    expect(r.level).toBe('warn');
    expect(analyzeUrl).toHaveBeenCalledTimes(2);
  });
  it('dữ liệu nhạy cảm khi gửi đi => warn (kể cả AI tắt)', async () => {
    const a = createRiskAnalyzer(fakeEngine(), { timeoutMs: 500, enabled: false });
    const r = await assessRisk(a, 'mã OTP của tôi là 123456', { outgoing: true });
    expect(r.level).toBe('warn');
    expect(r.sensitive.map((s) => s.kind)).toContain('otp');
  });
  it('tin nhận về: không chạy luật nhạy cảm', async () => {
    const r = await assessRisk(analyzerWith({}), 'mã OTP là 123456', { outgoing: false });
    expect(r.sensitive).toEqual([]);
  });
  it('AI lỗi => unknown, KHÔNG phải none (không ngầm coi là an toàn)', async () => {
    const r = await assessRisk(
      analyzerWith({
        init: async () => {
          throw new Error('x');
        },
      }),
      'chào',
      { outgoing: false },
    );
    expect(r.level).toBe('unknown');
  });
  it('model tin nhắn ok nhưng model URL lỗi => unknown', async () => {
    const r = await assessRisk(
      analyzerWith({
        analyzeUrl: async () => {
          throw new Error('x');
        },
      }),
      'xem https://a.com',
      { outgoing: false },
    );
    expect(r.level).toBe('unknown');
  });
});
