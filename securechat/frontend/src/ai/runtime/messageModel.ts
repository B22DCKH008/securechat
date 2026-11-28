import type { MessageLabel } from '../contract';
import { analyze, tfidfSparse } from '../features/text';

export interface MessageModelArtifact {
  schema: string;
  modelVersion: string;
  labels: MessageLabel[];
  riskyLabels: MessageLabel[];
  threshold: number;
  featurizer: {
    specVersion: number;
    stripDiacritics: boolean;
    charNgram: [number, number];
    wordNgram: [number, number];
    sublinearTf: boolean;
  };
  vocab: string[];
  idf: number[];
  coef: number[][];
  intercept: number[];
}

export interface MessagePrediction {
  probs: number[];
  riskyScore: number;
  warn: boolean;
  label: MessageLabel;
  confidence: number;
}

const vocabCache = new WeakMap<MessageModelArtifact, Map<string, number>>();

function getVocabMap(model: MessageModelArtifact): Map<string, number> {
  let map = vocabCache.get(model);
  if (!map) {
    map = new Map<string, number>();
    for (let i = 0; i < model.vocab.length; i++) {
      map.set(model.vocab[i], i);
    }
    vocabCache.set(model, map);
  }
  return map;
}

export function predictMessageJson(model: MessageModelArtifact, text: string): MessagePrediction {
  const f = model.featurizer;
  const feats = analyze(text, {
    charNgram: f.charNgram,
    wordNgram: f.wordNgram,
    stripDiacritics: f.stripDiacritics,
  });

  const vocab = getVocabMap(model);
  const vec = tfidfSparse(feats, vocab, model.idf, f.sublinearTf);

  const logits: number[] = [];
  for (let k = 0; k < model.coef.length; k++) {
    const row = model.coef[k];
    let z = model.intercept[k];
    for (const [j, v] of vec) {
      z += v * row[j];
    }
    logits.push(z);
  }

  let probs: number[];
  if (logits.length === 1) {
    const p1 = 1 / (1 + Math.exp(-logits[0]));
    probs = [1 - p1, p1];
  } else {
    const m = Math.max(...logits);
    const exps = logits.map((z) => Math.exp(z - m));
    const sum = exps.reduce((a, b) => a + b, 0);
    probs = exps.map((e) => e / sum);
  }

  const riskySet = new Set(model.riskyLabels);
  let riskyScore = 0;
  for (let i = 0; i < model.labels.length; i++) {
    if (riskySet.has(model.labels[i])) {
      riskyScore += probs[i];
    }
  }

  const warn = riskyScore >= model.threshold;
  let label: MessageLabel = 'benign';
  let confidence = 1 - riskyScore;

  if (warn) {
    let bestProb = -1;
    for (let i = 0; i < model.labels.length; i++) {
      if (riskySet.has(model.labels[i]) && probs[i] > bestProb) {
        bestProb = probs[i];
        label = model.labels[i];
      }
    }
    confidence = riskyScore;
  }

  return { probs, riskyScore, warn, label, confidence };
}