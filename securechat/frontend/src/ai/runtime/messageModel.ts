/**
 * Model tin nhắn: TF-IDF + Logistic Regression, chạy thuần TypeScript từ JSON do `ml/` xuất ra.
 * Tham chiếu Python: ml/src/securechat_ml/export/message_json.py (predict_message_json).
 */
import type { MessageLabel } from '../contract';
import {
  FEATURIZER_SPEC_VERSION,
  analyze,
  tfidfSparse,
  type FeaturizerConfig,
} from '../features/text';

export interface MessageModelJson {
  schema: string;
  modelVersion: string;
  labels: string[];
  riskyLabels: string[];
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
  /** Xác suất theo thứ tự `labels` của model. */
  probs: number[];
  labels: string[];
  /** Tổng xác suất các nhãn rủi ro (spam + scam). */
  riskyScore: number;
  /** riskyScore >= ngưỡng (đã chọn trên validation). */
  warn: boolean;
  /** benign nếu không cảnh báo; nếu cảnh báo: nhãn rủi ro có xác suất cao nhất. */
  label: MessageLabel;
  /** Độ tin cậy của `label`: warn ? riskyScore : 1 - riskyScore. */
  confidence: number;
  modelVersion: string;
}

const ALLOWED_LABELS: ReadonlySet<string> = new Set<MessageLabel>(['benign', 'scam', 'spam']);

export class ModelContractError extends Error {
  override name = 'ModelContractError';
}

export class MessageModel {
  readonly modelVersion: string;
  readonly threshold: number;
  private readonly vocab: Map<string, number>;
  private readonly featurizer: FeaturizerConfig;
  private readonly sublinear: boolean;

  constructor(private readonly m: MessageModelJson) {
    if (!m.schema?.startsWith('securechat.message-model/')) {
      throw new ModelContractError(`schema không hỗ trợ: ${m.schema}`);
    }
    if (m.featurizer.specVersion !== FEATURIZER_SPEC_VERSION) {
      throw new ModelContractError(
        `featurizer specVersion ${m.featurizer.specVersion} != ${FEATURIZER_SPEC_VERSION}: cần cập nhật code TS`,
      );
    }
    // Hợp đồng nhãn (labels.yaml <-> contract.ts): lệch thì từ chối nạp, KHÔNG đoán.
    for (const l of m.labels) {
      if (!ALLOWED_LABELS.has(l)) throw new ModelContractError(`nhãn lạ trong model: ${l}`);
    }
    if (!m.labels.includes('benign')) throw new ModelContractError('model không có nhãn benign');
    if (m.coef.length !== m.labels.length && !(m.coef.length === 1 && m.labels.length === 2)) {
      throw new ModelContractError('số hàng coef không khớp số nhãn');
    }
    this.modelVersion = m.modelVersion;
    this.threshold = m.threshold;
    this.vocab = new Map(m.vocab.map((t, i) => [t, i]));
    this.featurizer = {
      charNgram: m.featurizer.charNgram,
      wordNgram: m.featurizer.wordNgram,
      stripDiacritics: m.featurizer.stripDiacritics,
    };
    this.sublinear = m.featurizer.sublinearTf;
  }

  get vocabSize(): number {
    return this.vocab.size;
  }

  predict(text: string): MessagePrediction {
    const m = this.m;
    const vec = tfidfSparse(analyze(text, this.featurizer), this.vocab, m.idf, this.sublinear);
    const logits = m.coef.map((row, k) => {
      let z = m.intercept[k] as number;
      for (const [j, v] of vec) z += v * (row[j] as number);
      return z;
    });
    let probs: number[];
    if (logits.length === 1) {
      const p1 = 1 / (1 + Math.exp(-(logits[0] as number)));
      probs = [1 - p1, p1];
    } else {
      const mx = Math.max(...logits);
      const e = logits.map((z) => Math.exp(z - mx));
      const s = e.reduce((a, b) => a + b, 0);
      probs = e.map((x) => x / s);
    }
    let riskyScore = 0;
    let bestRisky: { label: string; p: number } | null = null;
    m.labels.forEach((lb, i) => {
      if (!m.riskyLabels.includes(lb)) return;
      const p = probs[i] as number;
      riskyScore += p;
      if (!bestRisky || p > bestRisky.p) bestRisky = { label: lb, p };
    });
    const warn = riskyScore >= m.threshold;
    const risky = bestRisky as { label: string; p: number } | null;
    const label = (warn && risky ? risky.label : 'benign') as MessageLabel;
    return {
      probs,
      labels: m.labels,
      riskyScore,
      warn,
      label,
      confidence: warn ? riskyScore : 1 - riskyScore,
      modelVersion: m.modelVersion,
    };
  }
}
