import type { MessageLabel } from '../contract';
import { normalizeText } from '../features/text';

export interface MessageRulesArtifact {
  specVersion: number;
  normalization: string;
  rules: Array<{
    id: string;
    label: MessageLabel;
    pattern: string;
  }>;
}

export interface CompiledRule {
  id: string;
  label: MessageLabel;
  re: RegExp;
}

export function compileRules(artifact: MessageRulesArtifact): CompiledRule[] {
  return artifact.rules.map((r) => ({
    id: r.id,
    label: r.label,
    re: new RegExp(r.pattern),
  }));
}

export function matchRules(text: string, compiled: CompiledRule[], stripDiacritics = true): string[] {
  const s = normalizeText(text, stripDiacritics);
  return compiled.filter((r) => r.re.test(s)).map((r) => r.id);
}

export function predictRules(text: string, compiled: CompiledRule[], stripDiacritics = true): MessageLabel {
  const matchedIds = new Set(matchRules(text, compiled, stripDiacritics));
  const labels = new Set(compiled.filter((r) => matchedIds.has(r.id)).map((r) => r.label));
  if (labels.has('scam')) return 'scam';
  if (labels.has('spam')) return 'spam';
  return 'benign';
}