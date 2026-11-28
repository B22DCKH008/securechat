import type { MessageAnalysis, MessageLabel, RiskAnalyzer, UrlAnalysis } from '../contract';
import {
  compileRules,
  matchRules,
  type CompiledRule,
  type MessageRulesArtifact,
} from '../rules/messageRules';
import { predictMessageJson, type MessageModelArtifact } from './messageModel';

export interface AnalyzerConfig {
  messageModelUrl?: string;
  messageRulesUrl?: string;
  enabled?: boolean;
}

export interface DetailedInspection {
  analysis: MessageAnalysis;
  labels: MessageLabel[];
  probs: number[];
  riskyScore: number;
  threshold: number;
  matchedRules: string[];
}

export class LocalRiskAnalyzer implements RiskAnalyzer {
  private model: MessageModelArtifact | null = null;
  private rules: CompiledRule[] = [];
  private initError: Error | null = null;
  private enabled: boolean;
  private readonly messageModelUrl: string;
  private readonly messageRulesUrl: string;

  constructor(cfg: AnalyzerConfig = {}) {
    this.messageModelUrl = cfg.messageModelUrl ?? '/models/message_model.json';
    this.messageRulesUrl = cfg.messageRulesUrl ?? '/models/message_rules.json';
    this.enabled = cfg.enabled ?? true;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  isReady(): boolean {
    return this.model !== null && this.initError === null;
  }

  loadArtifacts(model: MessageModelArtifact, rulesArtifact?: MessageRulesArtifact): void {
    this.model = model;
    this.initError = null;
    this.rules = rulesArtifact ? compileRules(rulesArtifact) : [];
  }

  async init(): Promise<void> {
    this.initError = null;
    try {
      const [modelRes, rulesRes] = await Promise.all([
        fetch(this.messageModelUrl),
        fetch(this.messageRulesUrl),
      ]);
      if (!modelRes.ok) {
        throw new Error(`Failed to load message model: HTTP ${modelRes.status}`);
      }
      this.model = (await modelRes.json()) as MessageModelArtifact;
      if (rulesRes.ok) {
        const rulesArtifact = (await rulesRes.json()) as MessageRulesArtifact;
        this.rules = compileRules(rulesArtifact);
      }
    } catch (err) {
      this.model = null;
      this.initError = err instanceof Error ? err : new Error(String(err));
      throw this.initError;
    }
  }

  async analyzeMessage(text: string): Promise<MessageAnalysis> {
    if (!this.enabled || !this.model) {
      return { status: 'unavailable' };
    }
    const t0 = performance.now();
    try {
      const pred = predictMessageJson(this.model, text);
      return {
        status: 'ok',
        label: pred.label,
        confidence: pred.confidence,
        modelVersion: this.model.modelVersion,
        latencyMs: performance.now() - t0,
      };
    } catch {
      return { status: 'error', latencyMs: performance.now() - t0 };
    }
  }

  async inspectMessage(text: string): Promise<DetailedInspection> {
    if (!this.enabled || !this.model) {
      return {
        analysis: { status: 'unavailable' },
        labels: ['benign', 'scam', 'spam'],
        probs: [],
        riskyScore: 0,
        threshold: 0,
        matchedRules: [],
      };
    }
    const t0 = performance.now();
    try {
      const pred = predictMessageJson(this.model, text);
      const latencyMs = performance.now() - t0;
      return {
        analysis: {
          status: 'ok',
          label: pred.label,
          confidence: pred.confidence,
          modelVersion: this.model.modelVersion,
          latencyMs,
        },
        labels: this.model.labels,
        probs: pred.probs,
        riskyScore: pred.riskyScore,
        threshold: this.model.threshold,
        matchedRules: this.getMatchedRules(text),
      };
    } catch {
      return {
        analysis: { status: 'error', latencyMs: performance.now() - t0 },
        labels: this.model.labels,
        probs: [],
        riskyScore: 0,
        threshold: this.model.threshold,
        matchedRules: [],
      };
    }
  }

  getMatchedRules(text: string): string[] {
    if (!this.enabled || this.rules.length === 0) {
      return [];
    }
    const strip = this.model?.featurizer.stripDiacritics ?? true;
    return matchRules(text, this.rules, strip);
  }

  async analyzeUrl(url: string): Promise<UrlAnalysis> {
    return { status: 'unavailable', url };
  }

  getLoadedRulesCount(): number {
    return this.rules.length;
  }
}