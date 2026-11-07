// EXP1 / EXP2 / EXP11 skeleton. Run: k6 run -e BASE=http://localhost:8081 -e VUS=10 bench/k6/send_messages.js
// Record: commit hash, machine spec, #instances, VUs, duration (doc §6).
import http from 'k6/http';
import ws from 'k6/ws';
import { check } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE = __ENV.BASE || 'http://localhost:8081';
const WS_BASE = BASE.replace('http', 'ws');

export const options = {
  vus: Number(__ENV.VUS || 10),
  duration: __ENV.DURATION || '1m',
  thresholds: { checks: ['rate>0.99'] },
};

function login(name) {
  const r = http.post(`${BASE}/v1/auth/dev-login`, JSON.stringify({ username: name }), { headers: { 'Content-Type': 'application/json' } });
  return r.json();
}

export function setup() {
  // TODO(BE2): create N user pairs + conversations, return them to VUs.
  const peer = login('k6-peer');
  return { peer };
}

export default function (data) {
  const me = login(`k6-user-${__VU}`);
  const auth = { headers: { Authorization: `Bearer ${me.accessToken}`, 'Content-Type': 'application/json' } };
  const conv = http.post(`${BASE}/v1/conversations`, JSON.stringify({ peerUserId: data.peer.userId }), auth).json();

  ws.connect(`${WS_BASE}/ws?access_token=${me.accessToken}`, { headers: { Origin: 'http://localhost' } }, (socket) => {
    socket.on('open', () => {
      for (let i = 0; i < 20; i++) {
        socket.send(JSON.stringify({
          type: 'send', ref: `${i}`,
          payload: { clientMessageId: uuidv4(), conversationId: conv.id, ciphertext: 'AAECAwQF', protocolMeta: { bench: true } },
        }));
      }
      socket.setTimeout(() => socket.close(), 3000);
    });
    socket.on('message', (raw) => {
      const f = JSON.parse(raw);
      if (f.type === 'accepted' || f.type === 'error') check(f, { accepted: (x) => x.type === 'accepted' });
    });
  });
  // TODO(BE2): measure end-to-end latency by having the peer VU listen for "message" frames.
}
