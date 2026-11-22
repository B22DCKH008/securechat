import { afterEach, describe, expect, it, vi } from 'vitest';
import { uuid } from '../src/lib/uuid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => vi.unstubAllGlobals());

describe('uuid', () => {
  it('dùng crypto.randomUUID khi có', () => {
    expect(uuid()).toMatch(V4);
  });
  it('dự phòng bằng getRandomValues khi không ở secure context (không có randomUUID)', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: (a: Uint8Array<ArrayBuffer>) => real.getRandomValues(a),
    });
    const ids = new Set(Array.from({ length: 200 }, () => uuid()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(V4);
  });
});
