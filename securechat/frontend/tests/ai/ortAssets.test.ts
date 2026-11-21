import { describe, expect, it } from 'vitest';
import { ORT_WASM_PATHS } from '../../src/ai/runtime/ortAssets';

describe('ortAssets', () => {
  it('có đường dẫn tới cả .mjs và .wasm của onnxruntime-web (không dùng public/ — dev server cấm)', () => {
    expect(ORT_WASM_PATHS.mjs).toMatch(/ort-wasm-simd-threaded.*\.mjs/);
    expect(ORT_WASM_PATHS.wasm).toMatch(/ort-wasm-simd-threaded.*\.wasm/);
    expect(ORT_WASM_PATHS.mjs).not.toMatch(/^\/ort\//);
  });
});
