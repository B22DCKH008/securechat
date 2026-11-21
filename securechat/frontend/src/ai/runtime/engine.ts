/**
 * InferenceEngine: nơi thật sự chạy model. Có 2 bản:
 *  - LocalEngine: chạy ngay trong luồng gọi (dùng khi test hoặc môi trường không có Worker).
 *  - WorkerEngine: chạy trong Web Worker để không làm đứng giao diện (xem worker.ts).
 */
import type { MessageLabel, UrlLabel } from '../contract';
import { loadModels, type LoadOptions, type LoadedModels } from './modelLoader';

export interface EngineMessageResult {
  label: MessageLabel;
  confidence: number;
  riskyScore: number;
  warn: boolean;
  modelVersion: string;
}
export interface EngineUrlResult {
  label: UrlLabel;
  confidence: number;
  score: number;
  modelVersion: string;
}
export interface EngineInfo {
  messageVersion?: string;
  urlVersion?: string;
  demo?: boolean;
  /** Dung lượng model (byte) theo manifest, để báo cáo AI21. */
  bytes?: number;
  /** Thời gian nạp model (ms), để báo cáo cold-start (AI18). */
  loadMs: number;
}

export class ModelNotLoadedError extends Error {
  override name = 'ModelNotLoadedError';
}

export interface InferenceEngine {
  init(): Promise<EngineInfo>;
  analyzeMessage(text: string): Promise<EngineMessageResult>;
  analyzeUrl(url: string): Promise<EngineUrlResult>;
  /** Hủy mọi việc đang chạy (dùng sau timeout) — lần gọi sau phải init() lại. */
  reset(): void;
  dispose(): void;
}

export class LocalEngine implements InferenceEngine {
  private models: LoadedModels | null = null;

  constructor(private readonly opts: LoadOptions) {}

  async init(): Promise<EngineInfo> {
    const t0 = performance.now();
    this.models?.url?.dispose();
    this.models = await loadModels(this.opts);
    const { manifest, message, url } = this.models;
    return {
      messageVersion: message?.modelVersion,
      urlVersion: url?.modelVersion,
      demo: manifest.demo,
      bytes: (manifest.message?.bytes ?? 0) + (manifest.url?.bytes ?? 0) || undefined,
      loadMs: performance.now() - t0,
    };
  }

  async analyzeMessage(text: string): Promise<EngineMessageResult> {
    const m = this.models?.message;
    if (!m) throw new ModelNotLoadedError('model tin nhắn chưa nạp');
    const p = m.predict(text);
    return {
      label: p.label,
      confidence: p.confidence,
      riskyScore: p.riskyScore,
      warn: p.warn,
      modelVersion: p.modelVersion,
    };
  }

  async analyzeUrl(url: string): Promise<EngineUrlResult> {
    const m = this.models?.url;
    if (!m) throw new ModelNotLoadedError('model URL chưa nạp');
    const p = await m.predict(url);
    return {
      label: p.label,
      confidence: p.confidence,
      score: p.score,
      modelVersion: p.modelVersion,
    };
  }

  reset(): void {
    this.models?.url?.dispose();
    this.models = null;
  }

  dispose(): void {
    this.reset();
  }
}
