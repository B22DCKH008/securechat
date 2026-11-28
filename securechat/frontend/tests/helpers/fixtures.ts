import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FetchLike } from '../../src/ai/runtime/modelLoader';

export const DEMO_DIR = join(__dirname, '..', 'fixtures', 'ai-demo');
export const REAL_DIR = join(__dirname, '..', 'fixtures', 'ai-real');

export const readJson = <T = any>(dir: string, file: string): T =>
  JSON.parse(readFileSync(join(dir, file), 'utf8')) as T;

/** fetch giả: đọc file từ thư mục `dir`; `overrides` cho phép thay manifest/file bằng đối tượng tự tạo. */
export function fsFetch(dir: string, overrides: Record<string, unknown> = {}): FetchLike {
  return async (url: string) => {
    const name = url.split('/').pop() as string;
    if (name in overrides) {
      const v = overrides[name];
      return {
        ok: true,
        status: 200,
        json: async () => v,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    try {
      const buf = readFileSync(join(dir, name));
      return {
        ok: true,
        status: 200,
        json: async () => JSON.parse(buf.toString('utf8')),
        arrayBuffer: async () =>
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      };
    } catch {
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
  };
}
