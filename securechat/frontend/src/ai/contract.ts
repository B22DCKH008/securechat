/**
 * AI interface contract (doc §7.2, AI15). Types only – no model code yet.
 *
 * Rules:
 *  - Runs on-device. Plaintext NEVER leaves the client (AI23).
 *  - status "unavailable" ≠ "safe". UI must say "AI không khả dụng / không thể phân tích" (AI22, AI24).
 *  - Labels must match ml/configs/labels.yaml.
 */

export type MessageLabel = 'benign' | 'phishing' | 'scam' | 'spam';
export type UrlLabel = 'benign' | 'malicious';

export type AnalysisStatus = 'ok' | 'unavailable' | 'timeout' | 'error';

export interface MessageAnalysis {
  status: AnalysisStatus;
  label?: MessageLabel;      // present only when status === 'ok'
  confidence?: number;       // 0..1
  modelVersion?: string;
  latencyMs?: number;        // for AI18 / AI21 measurements
}

export interface UrlAnalysis {
  status: AnalysisStatus;
  url: string;
  label?: UrlLabel;
  confidence?: number;
  modelVersion?: string;
  latencyMs?: number;
}

export interface RiskAnalyzer {
  /** Load / warm up models (cold start measured separately, AI18). */
  init(): Promise<void>;
  analyzeMessage(text: string): Promise<MessageAnalysis>;
  analyzeUrl(url: string): Promise<UrlAnalysis>;
}

// TODO(FE/AI 2): implement in src/ai/runtime/ (onnxruntime-web) and src/ai/rules/ (sensitive-data regex checks).
