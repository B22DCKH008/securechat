import type { WebSocketLike } from '../../src/transport/ws';
import type { Tokens } from '../../src/transport/types';

export class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  sent: string[] = [];
  closedWith: number | undefined;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close(code?: number) {
    this.closedWith = code;
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1005 });
  }
  // --- điều khiển từ test
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  recv(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  frames() {
    return this.sent.map((s) => JSON.parse(s) as { type: string; ref?: string; payload?: any });
  }
  static reset() {
    FakeWebSocket.instances = [];
  }
  static get last() {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
  }
}

export const tokens = (n: number, expiresAt = '2999-01-01T00:00:00Z'): Tokens => ({
  userId: 'u1',
  deviceId: 1,
  accessToken: `acc${n}`,
  refreshToken: `ref${n}`,
  expiresAt,
});

export const jsonRes = (status: number, body?: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
