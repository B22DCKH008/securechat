import { describe, expect, it } from 'vitest';
import { percentile, runBench, summarize } from '../../src/ai/bench/bench';
import type { RiskAnalyzer } from '../../src/ai';

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
