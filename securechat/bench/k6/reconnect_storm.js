// EXP5 / RS16: many clients (re)connect at nearly the same time, e.g. right
// after restarting one backend. Compare JITTER_S=0 with JITTER_S=2..5.
//
//   k6 run -e BASE=http://localhost:8081 -e VUS=100 -e JITTER_S=0 bench/k6/reconnect_storm.js
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { BASE_A, ORIGIN, register, wsURL } from './lib.js';

const VUS = Number(__ENV.VUS || 100);
export const options = {
  setupTimeout: '10m',
  scenarios: { storm: { executor: 'per-vu-iterations', vus: VUS, iterations: Number(__ENV.ROUNDS || 1) } },
};

const connectOK = new Rate('ws_connect_success');
const resyncLatency = new Trend('ws_connect_to_resync', true);

export function setup() {
  const tokens = [];
  for (let i = 0; i < VUS; i++) tokens.push(register(BASE_A, 'storm', i).accessToken);
  return { tokens };
}

export default function (data) {
  const token = data.tokens[(__VU - 1) % data.tokens.length];
  sleep(Math.random() * Number(__ENV.JITTER_S || 0)); // full jitter before connecting
  const t0 = Date.now();
  let gotResync = false;
  const res = ws.connect(wsURL(BASE_A, token), { headers: ORIGIN }, (s) => {
    s.on('message', (raw) => {
      if (!gotResync && JSON.parse(raw).type === 'resync') {
        gotResync = true;
        resyncLatency.add(Date.now() - t0);
        s.close();
      }
    });
    s.setTimeout(() => s.close(), Number(__ENV.HOLD_MS || 5000));
  });
  const ok = check(res, { upgraded: (r) => r && r.status === 101 }) && gotResync;
  connectOK.add(ok);
}
