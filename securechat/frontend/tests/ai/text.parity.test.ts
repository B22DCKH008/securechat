import { describe, expect, it } from 'vitest';
import { DEMO_DIR, readJson } from '../helpers/fixtures';
import { analyze, extractUrls, normalizeText, tfidfSparse } from '../../src/ai/features/text';
import {
  MessageModel,
  ModelContractError,
  type MessageModelJson,
} from '../../src/ai/runtime/messageModel';

const fx = readJson(DEMO_DIR, 'message_parity_fixtures.json');
const modelJson = readJson<MessageModelJson>(DEMO_DIR, 'message_model.json');
const cfg = {
  charNgram: modelJson.featurizer.charNgram,
  wordNgram: modelJson.featurizer.wordNgram,
  stripDiacritics: modelJson.featurizer.stripDiacritics,
};

describe('normalizeText (spec Python)', () => {
  it.each([
    ['Đặng Thị Ưu', 'dang thi uu'],
    ['TÀI KHOẢN bị KHÓA', 'tai khoan bi khoa'],
    ['xem https://abc.top/x?y=1 nhé', 'xem urltoken nhe'],
    ['OTP 123456 và 12345', 'otp bignum va 12345'],
    ['  nhiều   khoảng\ttrắng\n', 'nhieu khoang trang'],
    ['', ''],
  ])('%j -> %j', (src, expected) => {
    expect(normalizeText(src)).toBe(expected);
  });

  it('giữ dấu khi stripDiacritics=false', () => {
    expect(normalizeText('Đi ăn', false)).toBe('đi ăn');
  });

  it('khoảng trắng kiểu Python: \\x85 và \\x1c bị gộp, \\ufeff thì không', () => {
    expect(normalizeText('a\u0085b\u001cc')).toBe('a b c');
    expect(normalizeText('a\ufeffb')).toBe('a\ufeffb');
  });
});

describe('analyze', () => {
  it('có tiền tố w:/c: và đệm khoảng trắng', () => {
    const f = analyze('ab cd', { charNgram: [2, 3], wordNgram: [1, 2], stripDiacritics: true });
    for (const x of ['w:ab', 'w:cd', 'w:ab cd', 'c: a', 'c:ab', 'c:b ', 'c: ab'])
      expect(f).toContain(x);
    expect(analyze('')).toEqual([]);
  });

  it('có dấu và không dấu cho cùng kết quả', () => {
    expect(analyze('Tài khoản bị khóa')).toEqual(analyze('tai khoan bi khoa'));
  });

  it('n-gram theo code point (emoji không bị cắt đôi)', () => {
    const f = analyze('a😀b', { charNgram: [2, 2], wordNgram: [1, 1], stripDiacritics: true });
    expect(f).toContain('c:a😀');
    expect(f).toContain('c:😀b');
  });
});

describe('parity với fixtures do ml/ sinh ra', () => {
  it('normalize: chuỗi giống hệt', () => {
    for (const c of fx.normalize)
      expect(normalizeText(c.input, cfg.stripDiacritics)).toBe(c.expected);
  });

  it('analyze: danh sách feature giống hệt', () => {
    for (const c of fx.analyze) expect(analyze(c.input, cfg)).toEqual(c.features);
  });

  it('predict: xác suất sai số <= tolerance, cùng quyết định cảnh báo', () => {
    const model = new MessageModel(modelJson);
    for (const c of fx.predict) {
      const p = model.predict(c.input);
      expect(p.labels).toEqual(fx.labels);
      p.probs.forEach((v, i) => expect(Math.abs(v - c.probs[i])).toBeLessThanOrEqual(fx.tolerance));
      expect(Math.abs(p.riskyScore - c.riskyScore)).toBeLessThanOrEqual(fx.tolerance);
      expect(p.warn).toBe(c.warn);
    }
  });
});

describe('tfidfSparse', () => {
  it('L2-chuẩn hóa và bỏ feature ngoài từ vựng', () => {
    const v = tfidfSparse(
      ['a', 'a', 'b', 'zzz'],
      new Map([
        ['a', 0],
        ['b', 1],
      ]),
      [1, 1],
      true,
    );
    const norm = Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 12);
    expect(v.size).toBe(2);
  });
});

describe('MessageModel: hợp đồng', () => {
  it('từ chối model có nhãn lạ (lệch labels.yaml/contract.ts)', () => {
    const bad = { ...modelJson, labels: [...modelJson.labels.slice(0, -1), 'phishing'] };
    expect(() => new MessageModel(bad)).toThrow(ModelContractError);
  });
  it('từ chối featurizer specVersion khác', () => {
    const bad = { ...modelJson, featurizer: { ...modelJson.featurizer, specVersion: 99 } };
    expect(() => new MessageModel(bad)).toThrow(/specVersion/);
  });
  it('nhãn trả về luôn thuộc contract', () => {
    const model = new MessageModel(modelJson);
    for (const c of fx.predict)
      expect(['benign', 'scam', 'spam']).toContain(model.predict(c.input).label);
  });
});

describe('extractUrls', () => {
  it('lấy URL, bỏ dấu câu cuối, khử trùng', () => {
    expect(extractUrls('xem https://a.com/x, và www.b.vn/y). lại https://a.com/x,')).toEqual([
      'https://a.com/x',
      'www.b.vn/y',
    ]);
    expect(extractUrls('không có link')).toEqual([]);
  });
});
