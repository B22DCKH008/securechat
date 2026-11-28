import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze, normalizeText } from '../src/ai/features/text';
import { predictMessageJson, type MessageModelArtifact } from '../src/ai/runtime/messageModel';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const artifactsDir = path.resolve(__dirname, '../../ml/models/artifacts/message');

const model = JSON.parse(
  fs.readFileSync(path.join(artifactsDir, 'message_model.json'), 'utf-8'),
) as MessageModelArtifact;

const fixtures = JSON.parse(
  fs.readFileSync(path.join(artifactsDir, 'message_parity_fixtures.json'), 'utf-8'),
) as {
  tolerance: number;
  modelVersion: string;
  labels: string[];
  normalize: Array<{ input: string; expected: string }>;
  analyze: Array<{ input: string; features: string[] }>;
  predict: Array<{ input: string; probs: number[]; riskyScore: number; warn: boolean }>;
};

describe(`Message ML parity Python <-> TypeScript (${fixtures.modelVersion})`, () => {
  it('matches model version and labels', () => {
    expect(model.modelVersion).toBe(fixtures.modelVersion);
    expect(model.labels).toEqual(fixtures.labels);
  });

  it(`normalizeText matches all ${fixtures.normalize.length} fixtures exactly`, () => {
    const strip = model.featurizer.stripDiacritics;
    for (const tc of fixtures.normalize) {
      expect(normalizeText(tc.input, strip)).toBe(tc.expected);
    }
  });

  it(`analyze matches all ${fixtures.analyze.length} fixtures exactly`, () => {
    const f = model.featurizer;
    for (const tc of fixtures.analyze) {
      const got = analyze(tc.input, {
        charNgram: f.charNgram,
        wordNgram: f.wordNgram,
        stripDiacritics: f.stripDiacritics,
      });
      expect(got).toEqual(tc.features);
    }
  });

  it(`predictMessageJson matches all ${fixtures.predict.length} fixtures within tolerance ${fixtures.tolerance}`, () => {
    let maxDiff = 0;
    for (const tc of fixtures.predict) {
      const got = predictMessageJson(model, tc.input);
      expect(got.probs.length).toBe(tc.probs.length);
      for (let i = 0; i < tc.probs.length; i++) {
        const diff = Math.abs(got.probs[i] - tc.probs[i]);
        if (diff > maxDiff) maxDiff = diff;
        expect(diff).toBeLessThanOrEqual(fixtures.tolerance);
      }
      expect(Math.abs(got.riskyScore - tc.riskyScore)).toBeLessThanOrEqual(fixtures.tolerance);
      expect(got.warn).toBe(tc.warn);
    }
    console.log(`[Parity TS] n=${fixtures.predict.length}, max_abs_prob_diff=${maxDiff.toExponential(3)}`);
  });
});