import { describe, expect, it } from 'vitest';
import { DEMO_DIR, readJson } from '../helpers/fixtures';
import {
  DEFAULT_URL_SPEC,
  FEATURE_NAMES,
  domainOfUrl,
  extractFeatures,
  parseUrl,
  registeredDomain,
  type UrlSpec,
} from '../../src/ai/features/url';
import { UrlLrModel, type UrlLrJson } from '../../src/ai/runtime/urlModel';

const fx = readJson(DEMO_DIR, 'url_parity_fixtures.json');
const spec = readJson<UrlSpec>(DEMO_DIR, 'url_spec.json');
const feat = (u: string) =>
  Object.fromEntries(FEATURE_NAMES.map((n, i) => [n, extractFeatures(u)[i]]));

describe('parseUrl / registeredDomain', () => {
  it('tách các phần', () => {
    const p = parseUrl('HTTPS://User:pw@Sub.Example.CO.UK:8443/a/b?x=1#f');
    expect(p).toMatchObject({
      host: 'sub.example.co.uk',
      port: '8443',
      userinfo: 'user:pw',
      path: '/a/b',
      query: 'x=1',
      fragment: 'f',
    });
  });
  it('miền đăng ký', () => {
    expect(registeredDomain('a.b.example.co.uk')).toBe('example.co.uk');
    expect(registeredDomain('shop.vietcombank.com.vn')).toBe('vietcombank.com.vn');
    expect(registeredDomain('192.168.1.1')).toBe('192.168.1.1');
    expect(domainOfUrl('shopee.vn/product/1')).toBe('shopee.vn');
  });
});

describe('extractFeatures', () => {
  it('tín hiệu cơ bản', () => {
    expect(feat('http://192.168.1.10:8080/admin/login')).toMatchObject({
      is_ip_host: 1,
      has_nonstd_port: 1,
    });
    expect(feat('https://xn--vitcombank-hsb.com/verify').is_punycode).toBe(1);
    expect(feat('https://user:pass@secure-update.example.com/a').has_at).toBe(1);
    const f = feat('http://vietcombank.com.vn.xacminh-taikhoan.top/login.php?id=1');
    expect(f.brand_in_subdomain).toBe(1);
    expect(f.tld_suspicious).toBe(1);
    expect(f.n_susp_keywords).toBeGreaterThanOrEqual(2);
    expect(feat('https://bit.ly/abc').has_shortener).toBe(1);
    expect(feat('https://www.google.com/').has_www).toBe(1);
  });
  it('bỏ qua scheme (không có tín hiệu is_https)', () => {
    expect(extractFeatures('http://example.com/path')).toEqual(
      extractFeatures('https://example.com/path'),
    );
  });
  it('luôn hữu hạn và đúng độ dài', () => {
    for (const u of [
      '',
      'a',
      'http://',
      'https://[::1]/x',
      'ftp://x.y/z',
      'https://a..b/c',
      'http://a:80\n/p',
    ]) {
      const v = extractFeatures(u);
      expect(v).toHaveLength(FEATURE_NAMES.length);
      expect(v.every(Number.isFinite)).toBe(true);
    }
  });
  it('hằng số mặc định trùng url_spec.json của ml/', () => {
    expect({ ...DEFAULT_URL_SPEC }).toMatchObject({
      featureNames: spec.featureNames,
      suspiciousTlds: spec.suspiciousTlds,
      shorteners: spec.shorteners,
      keywords: spec.keywords,
      brands: spec.brands,
      multiSuffix: spec.multiSuffix,
    });
  });
});

describe('parity với fixtures do ml/ sinh ra', () => {
  it('allFeatures: sai số <= 1e-9', () => {
    expect(fx.featureNamesAll).toEqual(FEATURE_NAMES);
    fx.urls.forEach((u: string, i: number) => {
      const got = extractFeatures(u, spec);
      got.forEach((v, j) => expect(Math.abs(v - fx.allFeatures[i][j])).toBeLessThanOrEqual(1e-9));
    });
  });

  it('LR (JSON, tự tính bằng TS): xác suất sai số <= 1e-6', async () => {
    const lr = new UrlLrModel(readJson<UrlLrJson>(DEMO_DIR, 'url_lr.json'), spec);
    const want = fx.probabilities.lr;
    for (let i = 0; i < fx.urls.length; i++) {
      const p = await lr.predict(fx.urls[i]);
      expect(Math.abs(p.score - want.values[i])).toBeLessThanOrEqual(1e-6);
      expect(p.label).toBe(want.values[i] >= want.threshold ? 'malicious' : 'benign');
    }
  });
});
