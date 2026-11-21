/**
 * Backoff mũ có jitter (RS15, RS36): tránh hàng loạt client reconnect cùng lúc ("reconnect storm").
 * Dùng "equal jitter": nửa cố định + nửa ngẫu nhiên, nên luôn chờ ít nhất cap/2.
 */
export interface BackoffOptions {
  baseMs?: number; // mặc định 500
  maxMs?: number; // mặc định 30000
  rng?: () => number; // để test
}

export function nextDelay(
  attempt: number,
  { baseMs = 500, maxMs = 30_000, rng = Math.random }: BackoffOptions = {},
): number {
  const cap = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(cap / 2 + rng() * (cap / 2));
}
