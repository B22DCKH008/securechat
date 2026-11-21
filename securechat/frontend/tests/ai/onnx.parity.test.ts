import { describe, expect, it } from 'vitest';
import { DEMO_DIR, fsFetch, readJson } from '../helpers/fixtures';
import { loadModels } from '../../src/ai/runtime/modelLoader';

const fx = readJson(DEMO_DIR, 'url_parity_fixtures.json');
const spec = readJson(DEMO_DIR, 'url_spec.json');

// Chạy onnxruntime-web (WASM) thật trong Node: kiểm file .onnx do skl2onnx xuất ra khớp sklearn.
describe.each(['gbdt', 'rf'] as const)('ONNX %s qua onnxruntime-web', (kind) => {
  it('xác suất khớp fixtures (<= 1e-4) và cùng quyết định', async () => {
    const want = fx.probabilities[kind];
    const manifest = {
      schema: 'securechat.models/1',
      url: {
        kind,
        file: `url_${kind}.onnx`,
        specFile: 'url_spec.json',
        modelVersion: spec.modelVersion,
        threshold: want.threshold,
      },
    };
    const { url } = await loadModels({
      baseUrl: '/models/',
      fetchFn: fsFetch(DEMO_DIR, { 'manifest.json': manifest }),
    });
    expect(url?.kind).toBe('onnx');
    let agree = 0;
    for (let i = 0; i < fx.urls.length; i++) {
      const p = await url!.predict(fx.urls[i]);
      expect(Math.abs(p.score - want.values[i])).toBeLessThanOrEqual(1e-4);
      if (p.score >= want.threshold === want.values[i] >= want.threshold) agree++;
    }
    expect(agree).toBe(fx.urls.length);
    url!.dispose();
  }, 60_000);
});
