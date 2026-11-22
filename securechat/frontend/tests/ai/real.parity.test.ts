/**
 * Parity TS ↔ Python trên model THẬT (sau `npm run models:sync`, fixtures nằm ở tests/fixtures/ai-real/).
 * Chưa sync model thật thì các test ở đây được bỏ qua (skip), không làm hỏng `npm test`.
 *
 * Đây là kiểm tra an toàn quan trọng nhất sau mỗi lần train lại: nếu featurizer TS lệch dù một ký tự thì
 * model cho kết quả sai MỘT CÁCH IM LẶNG (không lỗi, chỉ dự đoán sai).
 *
 * Lưu ý: dữ liệu được đọc LAZY trong từng test (describe.skipIf vẫn chạy phần thân describe lúc thu thập test).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REAL_DIR, fsFetch, readJson } from '../helpers/fixtures';
import { analyze, normalizeText } from '../../src/ai/features/text';
import { FEATURE_NAMES, extractFeatures, type UrlSpec } from '../../src/ai/features/url';
import { loadModels } from '../../src/ai/runtime/modelLoader';
import { MessageModel, type MessageModelJson } from '../../src/ai/runtime/messageModel';
import type { ModelManifest } from '../../src/ai/runtime/manifest';

const PUBLIC_DIR = join(__dirname, '..', '..', 'public', 'models');
const has = (f: string) => existsSync(join(REAL_DIR, f));
const sameBytes = (a: string, b: string) => readFileSync(a).equals(readFileSync(b));

describe.skipIf(!has('manifest.json'))('model THẬT: manifest và file được serve', () => {
  it('ai-real không phải model demo', () => {
    const m = readJson<ModelManifest>(REAL_DIR, 'manifest.json');
    expect(
      m.demo,
      'tests/fixtures/ai-real đang chứa model DEMO: chạy `npm run models:sync` (không kèm --demo)',
    ).not.toBe(true);
  });

  it('public/models khớp đúng bộ đã kiểm parity (không lẫn demo/thật, không bản cũ)', () => {
    const real = readJson<ModelManifest>(REAL_DIR, 'manifest.json');
    const served = readJson<ModelManifest>(PUBLIC_DIR, 'manifest.json');
    expect(served.demo, 'public/models đang là model DEMO').not.toBe(true);
    expect(served.message?.modelVersion).toBe(real.message?.modelVersion);
    expect(served.url?.modelVersion).toBe(real.url?.modelVersion);
    if (real.message) {
      expect(
        sameBytes(join(PUBLIC_DIR, real.message.file), join(REAL_DIR, real.message.file)),
        'message_model.json trong public/models khác bản đã kiểm',
      ).toBe(true);
    }
    if (real.url) {
      expect(
        sameBytes(join(PUBLIC_DIR, real.url.file), join(REAL_DIR, real.url.file)),
        `${real.url.file} trong public/models khác bản đã kiểm`,
      ).toBe(true);
    }
  });
});

describe.skipIf(!has('message_parity_fixtures.json') || !has('message_model.json'))(
  'model THẬT: tin nhắn',
  () => {
    const load = () => {
      const fx = readJson(REAL_DIR, 'message_parity_fixtures.json');
      const modelJson = readJson<MessageModelJson>(REAL_DIR, 'message_model.json');
      const cfg = {
        charNgram: modelJson.featurizer.charNgram,
        wordNgram: modelJson.featurizer.wordNgram,
        stripDiacritics: modelJson.featurizer.stripDiacritics,
      };
      return { fx, modelJson, cfg };
    };

    it('có đủ ca kiểm tra (không rỗng)', () => {
      const { fx } = load();
      expect(fx.normalize.length).toBeGreaterThan(0);
      expect(fx.analyze.length).toBeGreaterThan(0);
      expect(fx.predict.length).toBeGreaterThan(0);
    });

    it('normalize giống hệt', () => {
      const { fx, cfg } = load();
      for (const c of fx.normalize)
        expect(normalizeText(c.input, cfg.stripDiacritics)).toBe(c.expected);
    });

    it('analyze giống hệt', () => {
      const { fx, cfg } = load();
      for (const c of fx.analyze) expect(analyze(c.input, cfg)).toEqual(c.features);
    });

    it('predict: xác suất sai số <= tolerance, cùng quyết định cảnh báo', () => {
      const { fx, modelJson } = load();
      const model = new MessageModel(modelJson);
      for (const c of fx.predict) {
        const p = model.predict(c.input);
        expect(p.labels).toEqual(fx.labels);
        p.probs.forEach((v, i) =>
          expect(Math.abs(v - c.probs[i])).toBeLessThanOrEqual(fx.tolerance),
        );
        expect(Math.abs(p.riskyScore - c.riskyScore)).toBeLessThanOrEqual(fx.tolerance);
        expect(p.warn).toBe(c.warn);
      }
    });
  },
);

describe.skipIf(!has('url_parity_fixtures.json') || !has('url_spec.json') || !has('manifest.json'))(
  'model THẬT: URL',
  () => {
    it('đặc trưng URL: sai số <= 1e-9', () => {
      const fx = readJson(REAL_DIR, 'url_parity_fixtures.json');
      const spec = readJson<UrlSpec>(REAL_DIR, 'url_spec.json');
      expect(fx.urls.length).toBeGreaterThan(0);
      expect(fx.featureNamesAll).toEqual(FEATURE_NAMES);
      fx.urls.forEach((u: string, i: number) => {
        extractFeatures(u, spec).forEach((v, j) =>
          expect(Math.abs(v - fx.allFeatures[i][j])).toBeLessThanOrEqual(1e-9),
        );
      });
    });

    it('model được chọn (LR hoặc ONNX): xác suất khớp và cùng quyết định', async () => {
      const fx = readJson(REAL_DIR, 'url_parity_fixtures.json');
      const manifest = readJson<ModelManifest>(REAL_DIR, 'manifest.json');
      const kind = manifest.url!.kind;
      const want = fx.probabilities[kind];
      const tol = kind === 'lr' ? 1e-6 : 1e-4;
      // Nạp đúng như app: qua manifest thật + fetch giả đọc từ thư mục fixtures.
      const { url } = await loadModels({ baseUrl: '/models/', fetchFn: fsFetch(REAL_DIR) });
      expect(url, 'không nạp được model URL thật').toBeDefined();
      let agree = 0;
      for (let i = 0; i < fx.urls.length; i++) {
        const p = await url!.predict(fx.urls[i]);
        expect(Math.abs(p.score - want.values[i])).toBeLessThanOrEqual(tol);
        if (p.score >= want.threshold === want.values[i] >= want.threshold) agree++;
      }
      expect(agree).toBe(fx.urls.length);
      url!.dispose();
    }, 60_000);
  },
);
