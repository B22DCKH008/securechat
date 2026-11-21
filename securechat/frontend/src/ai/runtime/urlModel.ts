/**
 * Model URL: LR chạy bằng TypeScript (JSON), GBDT/RF chạy bằng onnxruntime-web (WASM).
 * Tham chiếu Python: ml/src/securechat_ml/export/url_export.py.
 */
import type { UrlLabel } from '../contract';
import { URL_SPEC_VERSION, extractFeatures, type UrlSpec } from '../features/url';
import { ModelContractError } from './messageModel';

export interface UrlLrJson {
  schema: string;
  modelVersion: string;
  featureNames: string[];
  threshold: number;
  mean: number[];
  scale: number[];
  coef: number[];
  intercept: number;
}

export interface UrlPrediction {
  /** Xác suất độc hại (0..1). */
  score: number;
  label: UrlLabel;
  /** Độ tin cậy của `label`. */
  confidence: number;
  modelVersion: string;
}

export interface UrlModel {
  readonly kind: 'lr' | 'onnx';
  readonly modelVersion: string;
  readonly threshold: number;
  predict(url: string): Promise<UrlPrediction>;
  dispose(): void;
}

function toPrediction(score: number, threshold: number, modelVersion: string): UrlPrediction {
  const malicious = score >= threshold;
  return {
    score,
    label: malicious ? 'malicious' : 'benign',
    confidence: malicious ? score : 1 - score,
    modelVersion,
  };
}

/** Lấy các feature mà model dùng (theo tên) từ vector đầy đủ của spec. */
export function pickFeatures(url: string, spec: UrlSpec, names: string[]): number[] {
  if (spec.specVersion !== URL_SPEC_VERSION) {
    throw new ModelContractError(`url spec ${spec.specVersion} != ${URL_SPEC_VERSION}`);
  }
  const all = extractFeatures(url, spec);
  return names.map((n) => {
    const i = spec.featureNames.indexOf(n);
    if (i < 0) throw new ModelContractError(`model dùng feature không có trong spec: ${n}`);
    return all[i] as number;
  });
}

export class UrlLrModel implements UrlModel {
  readonly kind = 'lr' as const;
  readonly modelVersion: string;
  readonly threshold: number;

  constructor(
    private readonly m: UrlLrJson,
    private readonly spec: UrlSpec,
  ) {
    if (!m.schema?.startsWith('securechat.url-lr/')) {
      throw new ModelContractError(`schema không hỗ trợ: ${m.schema}`);
    }
    this.modelVersion = m.modelVersion;
    this.threshold = m.threshold;
    pickFeatures('example.com', spec, m.featureNames); // fail sớm nếu lệch spec
  }

  async predict(url: string): Promise<UrlPrediction> {
    const x = pickFeatures(url, this.spec, this.m.featureNames);
    let z = this.m.intercept;
    for (let i = 0; i < x.length; i++) {
      z +=
        (this.m.coef[i] as number) *
        (((x[i] as number) - (this.m.mean[i] as number)) / (this.m.scale[i] as number));
    }
    return toPrediction(1 / (1 + Math.exp(-z)), this.threshold, this.modelVersion);
  }

  dispose(): void {}
}

/** Phần tối thiểu của onnxruntime-web mà ta dùng (để dễ giả lập khi test). */
export interface OrtSessionLike {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number> }>>;
  release?(): Promise<void>;
}
export interface OrtModuleLike {
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown;
}

export class UrlOnnxModel implements UrlModel {
  readonly kind = 'onnx' as const;

  constructor(
    private readonly session: OrtSessionLike,
    private readonly ort: OrtModuleLike,
    private readonly spec: UrlSpec,
    private readonly featureNames: string[],
    readonly modelVersion: string,
    readonly threshold: number,
  ) {}

  async predict(url: string): Promise<UrlPrediction> {
    const x = Float32Array.from(pickFeatures(url, this.spec, this.featureNames));
    const input = new this.ort.Tensor('float32', x, [1, x.length]);
    const out = await this.session.run({ features: input });
    const probs = out['probabilities']?.data;
    if (!probs || probs.length < 2) throw new Error('ONNX không trả về "probabilities"');
    return toPrediction(probs[1] as number, this.threshold, this.modelVersion);
  }

  dispose(): void {
    void this.session.release?.();
  }
}
