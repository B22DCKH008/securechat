// EXP5 / RS16 skeleton: many clients reconnect at nearly the same time.
// Run after restarting one backend instance: k6 run -e BASE=http://localhost:8081 -e VUS=100 bench/k6/reconnect_storm.js
import ws from 'k6/ws';
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE || 'http://localhost:8081';

export const options = { vus: Number(__ENV.VUS || 100), iterations: Number(__ENV.VUS || 100) };

export default function () {
  const tok = http.post(`${BASE}/v1/auth/dev-login`, JSON.stringify({ username: `storm-${__VU}` }),
    { headers: { 'Content-Type': 'application/json' } }).json().accessToken;
  // TODO(BE2/FE1): replicate the real client backoff+jitter policy here, then compare
  // "no jitter" vs "full jitter" (reconnect success rate, p95 latency, CPU/RAM).
  sleep(Math.random() * Number(__ENV.JITTER_S || 0));
  const res = ws.connect(`${BASE.replace('http', 'ws')}/ws?access_token=${tok}`, { headers: { Origin: 'http://localhost' } },
    (s) => { s.on('open', () => s.setTimeout(() => s.close(), 2000)); });
  check(res, { upgraded: (r) => r && r.status === 101 });
}
