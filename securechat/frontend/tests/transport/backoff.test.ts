import { describe, expect, it } from 'vitest';
import { nextDelay } from '../../src/transport/backoff';

describe('backoff', () => {
  it('tăng theo mũ, có giới hạn trên', () => {
    const max = (a: number) => nextDelay(a, { baseMs: 500, maxMs: 30_000, rng: () => 1 });
    expect([0, 1, 2, 3].map(max)).toEqual([500, 1000, 2000, 4000]);
    expect(max(20)).toBe(30_000);
  });
  it('jitter: luôn nằm trong [cap/2, cap]', () => {
    for (let a = 0; a < 10; a++) {
      const cap = Math.min(30_000, 500 * 2 ** a);
      for (const r of [0, 0.5, 0.999]) {
        const d = nextDelay(a, { rng: () => r });
        expect(d).toBeGreaterThanOrEqual(Math.floor(cap / 2));
        expect(d).toBeLessThanOrEqual(cap);
      }
    }
  });
});
