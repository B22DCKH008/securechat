import { createRiskAnalyzer, type ControllableAnalyzer } from './runtime/analyzer';
import { LocalEngine, type InferenceEngine } from './runtime/engine';
import { ORT_WASM_PATHS } from './runtime/ortAssets';
import { WorkerEngine } from './runtime/workerEngine';

export type {
  MessageAnalysis,
  UrlAnalysis,
  RiskAnalyzer,
  MessageLabel,
  UrlLabel,
} from './contract';
export { assessRisk, type RiskAssessment, type RiskLevel } from './risk';
export type { ControllableAnalyzer, AnalyzerState } from './runtime/analyzer';

export interface CreateAnalyzerOptions {
  /** Mặc định `${BASE_URL}models/`. */
  modelsUrl?: string;
  timeoutMs?: number;
  /** Mặc định: dùng Web Worker nếu trình duyệt có; ngược lại chạy trong luồng chính. */
  engine?: InferenceEngine;
  enabled?: boolean;
}

/** Timeout mặc định chỉ là điểm xuất phát; chốt sau khi đo (AI18) rồi ghi vào labels.yaml. */
export const DEFAULT_AI_TIMEOUT_MS = 1500;

export function createAnalyzer(opts: CreateAnalyzerOptions = {}): ControllableAnalyzer {
  const base = import.meta.env.BASE_URL ?? '/';
  const loadOpts = {
    baseUrl: opts.modelsUrl ?? `${base}models/`,
    ortPaths: ORT_WASM_PATHS,
  };
  const engine =
    opts.engine ??
    (typeof Worker !== 'undefined' ? new WorkerEngine(loadOpts) : new LocalEngine(loadOpts));
  const envTimeout = Number(import.meta.env.VITE_AI_TIMEOUT_MS);
  return createRiskAnalyzer(engine, {
    timeoutMs:
      opts.timeoutMs ??
      (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_AI_TIMEOUT_MS),
    enabled: opts.enabled,
  });
}
