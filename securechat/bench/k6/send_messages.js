// EXP1 / EXP2 / EXP3 / EXP11: send throughput, accepted and end-to-end latency,
// missing/duplicate deliveries. Sender connects to BASE_A, recipient to BASE_B
// (set both to the same URL for the one-instance baseline).
//
//   k6 run -e BASE_A=http://localhost:8081 -e BASE_B=http://localhost:8082 \
//          -e VUS=10 -e DURATION=1m -e MSGS=20 bench/k6/send_messages.js
//
// Record commit, machine spec, instance count, VUS, duration and limits (doc §6).
// Keep VUS*MSGS/s below RATE_LIMIT_PER_SECOND per user or rate_limited errors
// are measured instead of throughput.
import { WebSocket } from 'k6/experimental/websockets';
import { setTimeout, clearTimeout } from 'k6/timers';
import { Counter, Trend } from 'k6/metrics';
import { BASE_A, BASE_B, ORIGIN, register, createConversation, fixtureCiphertext, uuid, wsURL } from './lib.js';

const VUS = Number(__ENV.VUS || 10);
const MSGS = Number(__ENV.MSGS || 20);           // messages per iteration
const GAP_MS = Number(__ENV.GAP_MS || 100);      // pacing between sends
const WAIT_MS = Number(__ENV.WAIT_MS || 10000);  // max wait for deliveries
const PAYLOAD = fixtureCiphertext(Number(__ENV.PAYLOAD_BYTES || 256));

export const options = {
  setupTimeout: '10m',
  scenarios: { chat: { executor: 'constant-vus', vus: VUS, duration: __ENV.DURATION || '1m' } },
  thresholds: { ws_missing: ['count==0'], ws_duplicate: ['count==0'], ws_send_errors: ['count==0'] },
};

const acceptLatency = new Trend('ws_accept_latency', true);
const e2eLatency = new Trend('ws_e2e_latency', true);
const sent = new Counter('ws_sent');
const delivered = new Counter('ws_delivered');
const missing = new Counter('ws_missing');
const duplicate = new Counter('ws_duplicate');
const sendErrors = new Counter('ws_send_errors');

export function setup() {
  const pairs = [];
  for (let i = 0; i < VUS; i++) {
    const alice = register(BASE_A, 'k6a', i);
    const bob = register(BASE_B, 'k6b', i);
    const conv = createConversation(BASE_A, alice.accessToken, bob.userId);
    pairs.push({ alice: alice.accessToken, bob: bob.accessToken, conv: conv.id });
  }
  return { pairs };
}

export default function (data) {
  const pair = data.pairs[(__VU - 1) % data.pairs.length];
  const pending = {};   // clientMessageId → send time
  const seen = {};      // messageId → true
  let accepted = 0;
  let received = 0;
  let finished = false;

  const bob = new WebSocket(wsURL(BASE_B, pair.bob), null, { headers: ORIGIN });
  const alice = new WebSocket(wsURL(BASE_A, pair.alice), null, { headers: ORIGIN });
  let opened = 0;
  let timer;

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    missing.add(Math.max(0, accepted - received));
    alice.close();
    bob.close();
  }

  function start() {
    let i = 0;
    const tick = () => {
      if (finished || i >= MSGS) return;
      const id = uuid();
      pending[id] = Date.now();
      alice.send(JSON.stringify({ type: 'send', ref: id, payload: {
        clientMessageId: id, conversationId: pair.conv, ciphertext: PAYLOAD, protocolMeta: { bench: 1 } } }));
      sent.add(1);
      i++;
      setTimeout(tick, GAP_MS);
    };
    tick();
    timer = setTimeout(finish, MSGS * GAP_MS + WAIT_MS);
  }

  const onOpen = () => { opened++; if (opened === 2) start(); };
  alice.onopen = onOpen;
  bob.onopen = onOpen;
  alice.onmessage = (e) => {
    const f = JSON.parse(e.data);
    if (f.type === 'accepted' && pending[f.ref] !== undefined) {
      accepted++;
      acceptLatency.add(Date.now() - pending[f.ref]);
    } else if (f.type === 'error') {
      sendErrors.add(1, { code: f.payload && f.payload.code });
    }
  };
  bob.onmessage = (e) => {
    const f = JSON.parse(e.data);
    if (f.type !== 'message') return;
    const p = f.payload;
    if (seen[p.messageId]) { duplicate.add(1); return; }
    seen[p.messageId] = true;
    if (pending[p.clientMessageId] === undefined) return; // replay from an earlier iteration
    received++;
    delivered.add(1);
    e2eLatency.add(Date.now() - pending[p.clientMessageId]);
    if (received === MSGS) finish();
  };
  alice.onerror = () => sendErrors.add(1, { code: 'socket' });
  bob.onerror = () => sendErrors.add(1, { code: 'socket' });
}
