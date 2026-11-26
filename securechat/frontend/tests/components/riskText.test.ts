import { describe, expect, it } from 'vitest';
import { notesForOutgoing, notesForStored } from '../../src/components/warnings/riskText';
import type { RiskAssessment } from '../../src/ai';

const base = (over: Partial<RiskAssessment>): RiskAssessment => ({
  level: 'none',
  message: { status: 'ok', label: 'benign', confidence: 0.9, modelVersion: 'v', latencyMs: 1 },
  urls: [],
  sensitive: [],
  ...over,
});

describe('notesForStored (tin nhận)', () => {
  it('không bao giờ hiện "an toàn": tin sạch => không có ghi chú', () => {
    expect(notesForStored({ level: 'none', label: 'benign' })).toEqual([]);
    expect(notesForStored(undefined)).toEqual([]);
  });
  it('scam = nguy hiểm, spam = cảnh báo nhẹ, URL xấu = nguy hiểm', () => {
    expect(notesForStored({ level: 'warn', label: 'scam' })[0]!.kind).toBe('danger');
    expect(notesForStored({ level: 'warn', label: 'spam' })[0]!.kind).toBe('warning');
    expect(notesForStored({ level: 'warn', badUrls: ['http://x'] })[0]!.kind).toBe('danger');
  });
  it('AI không chạy được => nói thẳng là chưa kiểm tra', () => {
    const n = notesForStored({ level: 'unknown' });
    expect(n).toHaveLength(1);
    expect(n[0]!.kind).toBe('info');
    expect(n[0]!.text).toMatch(/chưa kiểm tra/i);
  });
});

describe('notesForOutgoing (tin sắp gửi)', () => {
  it('dữ liệu nhạy cảm → danger, nêu loại', () => {
    const n = notesForOutgoing(base({ level: 'warn', sensitive: [{ kind: 'otp' }] }));
    expect(n[0]!.kind).toBe('danger');
    expect(n[0]!.text).toContain('OTP');
  });
  it('không lộ giá trị nhạy cảm trong câu chữ', () => {
    const n = notesForOutgoing(base({ level: 'warn', sensitive: [{ kind: 'card_number' }] }));
    expect(n.map((x) => x.text).join(' ')).not.toMatch(/\d{6,}/);
  });
  it('URL bị model đánh dấu: nói "đáng ngờ", không khẳng định "độc hại" (model chưa đạt ngưỡng)', () => {
    const n = notesForOutgoing(
      base({
        level: 'warn',
        urls: [
          {
            url: 'http://x.test',
            status: 'ok',
            label: 'malicious',
            confidence: 0.9,
            modelVersion: 'v',
            latencyMs: 1,
          },
        ],
      }),
    );
    expect(n).toHaveLength(1);
    expect(n[0]!.text).toMatch(/đáng ngờ/);
    expect(n[0]!.text).not.toMatch(/độc hại/);
  });
  it('AI timeout → chỉ ghi chú info (không chặn gửi)', () => {
    const n = notesForOutgoing(base({ level: 'unknown', message: { status: 'timeout' } }));
    expect(n.every((x) => x.kind === 'info')).toBe(true);
  });
  it('tin sạch → không ghi chú', () => {
    expect(notesForOutgoing(base({}))).toEqual([]);
  });
});
