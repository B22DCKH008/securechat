// Shared helpers for SecureChat k6 scripts (BE2). Uses real register/login;
// dev-login is disabled by default. Ciphertext is opaque fixture bytes: these
// scripts measure transport/backend behavior, never Signal encryption.
import http from 'k6/http';
import { sleep } from 'k6';

export const BASE_A = __ENV.BASE_A || __ENV.BASE || 'http://localhost:8081';
export const BASE_B = __ENV.BASE_B || BASE_A;
// WS_ALLOWED_ORIGINS=localhost:* does not match a portless "http://localhost".
export const ORIGIN = { Origin: __ENV.ORIGIN || 'http://localhost:5173' };
const PASSWORD = __ENV.BENCH_PASSWORD || 'bench-password-0123456789';
const RUN = __ENV.RUN_ID || `${Date.now().toString(36)}`;

export const wsURL = (base, token) => `${base.replace(/^http/, 'ws')}/ws?access_token=${encodeURIComponent(token)}`;

function json(res) { try { return res.json(); } catch (_) { return null; } }

// register retries on 429 (auth limits are per IP) and fails loudly otherwise.
export function register(base, prefix, i) {
  const username = `${prefix}_${RUN}_${i}`.slice(0, 32);
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = http.post(`${base}/v1/auth/register`, JSON.stringify({ username, password: PASSWORD }),
      { headers: { 'Content-Type': 'application/json' }, tags: { name: 'register' } });
    if (res.status === 201) return json(res);
    if (res.status !== 429) throw new Error(`register ${username}: ${res.status} ${res.body}`);
    sleep(0.2 + Math.random() * 0.3);
  }
  throw new Error(`register ${username}: rate limited`);
}

export function createConversation(base, token, peerUserId) {
  const res = http.post(`${base}/v1/conversations`, JSON.stringify({ peerUserId }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, tags: { name: 'conversation' } });
  if (res.status !== 200 && res.status !== 201) throw new Error(`conversation: ${res.status}`);
  return json(res);
}

// Deterministic opaque bytes (base64) of the requested size.
export function fixtureCiphertext(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const n = 4 * Math.ceil(bytes / 3);
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[(i * 7) % 64];
  return s;
}

export function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
