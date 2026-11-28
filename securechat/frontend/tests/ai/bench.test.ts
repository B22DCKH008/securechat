import { describe, expect, it } from 'vitest';
import { percentile, runBench, runOnOff, summarize } from '../../src/ai/bench/bench';
import type { ControllableAnalyzer, RiskAnalyzer } from '../../src/ai';

describe('percentile / summarize', () => {
  it('nearest-rank', () => {
    const s = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(s, 50)).toBe(50);
    expect(percentile(s, 95)).toBe(95);
    expect(percentile(s, 99)).toBe(99);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBeNaN();
  });
  it('summarize không phụ thuộc thứ tự đầu vào', () => {
    const st = summarize([5, 1, 3]);
    expect(st).toMatchObject({ n: 3, min: 1, max: 5, p50: 3, mean: 3 });
  });
});

describe('runBench', () => {
  it('analyzer hỏng hoàn toàn: báo notOkTotal, không bịa số đo', async () => {
    const dead: RiskAnalyzer = {
      init: async () => {},
      analyzeMessage: async () => ({ status: 'unavailable' }),
      analyzeUrl: async (url) => ({ status: 'unavailable', url }),
    };
    const rep = await runBench(dead, [{ name: 'm', kind: 'message', input: 'x' }], {
      warmup: 1,
      iterations: 5,
    });
    expect(rep.notOkTotal).toBe(5);
    expect(rep.cases[0]!.stats.n).toBe(0);
    expect(Number.isNaN(rep.cases[0]!.stats.p95)).toBe(true);
  });

  it('đếm số lần không ok và bỏ qua mẫu warmup khi thống kê', async () => {
    let t = 0;
    let calls = 0;
    const a: RiskAnalyzer = {
      init: async () => {
        t += 100;
      },
      analyzeMessage: async () => {
        t += ++calls <= 2 ? 1000 : 10; // 2 lần warmup chậm, không được tính
        return calls === 5
          ? { status: 'timeout' }
          : { status: 'ok', label: 'benign', confidence: 1, modelVersion: 'v', latencyMs: 1 };
      },
      analyzeUrl: async (url) => ({
        status: 'ok',
        url,
        label: 'benign',
        confidence: 1,
        modelVersion: 'v',
        latencyMs: 1,
      }),
    };
    const progress: number[] = [];
    const rep = await runBench(a, [{ name: 'm', kind: 'message', input: 'abc' }], {
      warmup: 2,
      iterations: 4,
      now: () => t,
      onProgress: (d) => progress.push(d),
    });
    expect(rep.coldLoadMs).toBe(100);
    expect(rep.cases[0]!.stats.max).toBe(10);
    expect(rep.cases[0]!.notOk).toBe(1);
    expect(rep.cases[0]!.stats.n).toBe(3); // lần không ok không được tính vào độ trễ
    expect(rep.notOkTotal).toBe(1);
    expect(progress.at(-1)).toBe(6);
    expect(rep.worstP95Ms).toBe(10);
  });
});

const okMsg = { status: 'ok', label: 'benign', confidence: 1, modelVersion: 'v' } as const;
const okUrl = (url: string) =>
  ({ status: 'ok', url, label: 'benign', confidence: 1, modelVersion: 'v' }) as const;

describe('trường hợp send (AI20)', () => {
  it('chạy cả model tin nhắn và model URL cho từng URL trong tin', async () => {
    const msgCalls: string[] = [];
    const urlCalls: string[] = [];
    const a: RiskAnalyzer = {
      init: async () => {},
      analyzeMessage: async (t) => (msgCalls.push(t), okMsg),
      analyzeUrl: async (u) => (urlCalls.push(u), okUrl(u)),
    };
    const rep = await runBench(
      a,
      [{ name: 's', kind: 'send', input: 'xem https://a.example/x và https://b.example/y' }],
      { warmup: 1, iterations: 2 },
    );
    expect(msgCalls).toHaveLength(3);
    expect(urlCalls).toHaveLength(6); // 2 URL x (1 warmup + 2 lần đo)
    expect(rep.cases[0]).toMatchObject({ kind: 'send', notOk: 0 });
    expect(rep.cases[0]!.stats.n).toBe(2);
  });

  it('một URL không ra ok thì cả lần gửi bị tính là không ok', async () => {
    const a: RiskAnalyzer = {
      init: async () => {},
      analyzeMessage: async () => okMsg,
      analyzeUrl: async (url) => ({ status: 'timeout', url }),
    };
    const rep = await runBench(a, [{ name: 's', kind: 'send', input: 'xem https://a.example/x' }], {
      warmup: 0,
      iterations: 4,
    });
    expect(rep.cases[0]!.notOk).toBe(4);
    expect(rep.notOkTotal).toBe(4);
    expect(rep.cases[0]!.stats.n).toBe(0);
  });
});

describe('báo cáo bổ sung (AI18, AI19)', () => {
  it('ghi độ trễ lần gọi đầu theo loại, không lẫn vào thống kê các lần sau', async () => {
    let t = 0;
    let calls = 0;
    const a: RiskAnalyzer = {
      init: async () => {},
      analyzeMessage: async () => {
        t += ++calls === 1 ? 500 : 10; // lần đầu chậm (chưa ấm)
        return okMsg;
      },
      analyzeUrl: async (url) => okUrl(url),
    };
    const rep = await runBench(a, [{ name: 'm', kind: 'message', input: 'abc' }], {
      warmup: 2,
      iterations: 3,
      now: () => t,
      getMeta: () => ({ modelBytes: 1624, urlVersion: 'url-x', demo: false }),
    });
    expect(rep.firstCallMs.message).toBe(500);
    expect(rep.firstCallMs.url).toBeUndefined();
    expect(rep.cases[0]!.stats.max).toBe(10);
    expect(rep.meta).toEqual({ modelBytes: 1624, urlVersion: 'url-x', demo: false });
  });
});

function fakeControllable(
  clock: { t: number },
  costOnMs: number,
): ControllableAnalyzer & {
  enabled: boolean;
} {
  const self = {
    enabled: true,
    init: async () => {},
    analyzeMessage: async () => {
      if (!self.enabled) return { status: 'unavailable' } as const;
      clock.t += costOnMs;
      return okMsg;
    },
    analyzeUrl: async (url: string) => {
      if (!self.enabled) return { status: 'unavailable', url } as const;
      return okUrl(url);
    },
    getState: () => ({ phase: self.enabled ? ('ready' as const) : ('disabled' as const) }),
    subscribe: () => () => {},
    setEnabled: (v: boolean) => {
      self.enabled = v;
    },
    retryInit: async () => {},
  };
  return self;
}

describe('runOnOff (AI21)', () => {
  const sendCase = { name: 'gửi', kind: 'send', input: 'xin chào' } as const;

  it('chênh lệch bật/tắt là chi phí của AI, chỉ đo trường hợp send, và bật lại AI khi xong', async () => {
    const clock = { t: 0 };
    const a = fakeControllable(clock, 7);
    const res = await runOnOff(a, [{ name: 'm', kind: 'message', input: 'x' }, sendCase], {
      warmup: 1,
      iterations: 5,
      now: () => clock.t,
    });
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      name: 'gửi',
      overheadP50Ms: 7,
      overheadP95Ms: 7,
      onNotOk: 0,
      offUnexpectedOk: 0,
    });
    expect(res[0]!.off.p50).toBe(0);
    expect(a.enabled).toBe(true);
  });

  it('công tắc không tắt thật thì báo offUnexpectedOk', async () => {
    const clock = { t: 0 };
    const a = fakeControllable(clock, 3);
    a.setEnabled = () => {}; // công tắc hỏng: luôn bật
    const res = await runOnOff(a, [sendCase], { warmup: 0, iterations: 4, now: () => clock.t });
    expect(res[0]!.offUnexpectedOk).toBe(4);
  });

  it('lỗi giữa chừng vẫn bật lại AI', async () => {
    const clock = { t: 0 };
    const a = fakeControllable(clock, 1);
    let n = 0;
    const orig = a.analyzeMessage;
    a.analyzeMessage = async (t: string) => {
      if (++n > 3) throw new Error('boom');
      return orig(t);
    };
    await expect(
      runOnOff(a, [sendCase], { warmup: 0, iterations: 5, now: () => clock.t }),
    ).rejects.toThrow('boom');
    expect(a.enabled).toBe(true);
  });
});
