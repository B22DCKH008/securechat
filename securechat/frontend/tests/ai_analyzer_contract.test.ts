import { describe, expect, it } from 'vitest';
import { LocalRiskAnalyzer } from '../src/ai/runtime/analyzer';

describe('LocalRiskAnalyzer contract (AI22, AI24, AI26)', () => {
  it('returns unavailable (never benign) before init', async () => {
    const analyzer = new LocalRiskAnalyzer();
    const res = await analyzer.analyzeMessage('Tài khoản của bạn sắp bị khóa');
    expect(res.status).toBe('unavailable');
    expect(res.label).toBeUndefined();
  });

  it('returns unavailable when AI toggle is disabled', async () => {
    const analyzer = new LocalRiskAnalyzer({ enabled: false });
    const res = await analyzer.analyzeMessage('Chào bạn');
    expect(res.status).toBe('unavailable');
    expect(res.label).toBeUndefined();
  });

  it('returns unavailable for URL analysis while URL artifact is absent', async () => {
    const analyzer = new LocalRiskAnalyzer();
    const res = await analyzer.analyzeUrl('https://vcb-xacminh.top/login');
    expect(res.status).toBe('unavailable');
    expect(res.url).toBe('https://vcb-xacminh.top/login');
    expect(res.label).toBeUndefined();
  });
});