/**
 * Client WebSocket tới `GET /ws?access_token=`.
 *
 * Trách nhiệm: kết nối lại có backoff+jitter, heartbeat, ghép `ref` của khung `send` với `accepted`/`error`,
 * kiểm giới hạn kích thước, xử lý mã đóng. KHÔNG biết gì về mã hóa hay lưu trữ.
 *
 * Mã đóng (docs): 1001 server tắt → reconnect; 1008 vi phạm chính sách/token hỏng → refresh rồi reconnect (hết hạn thì dừng);
 * 1009 khung quá lớn → các lời gửi đang chờ bị từ chối, reconnect; 1013 quá tải → reconnect với backoff lớn hơn.
 */
import { Emitter } from '../lib/emitter';
import { uuid } from '../lib/uuid';
import { base64DecodedLength } from '../lib/base64';
import { nextDelay } from './backoff';
import {
  MAX_CIPHERTEXT_BYTES,
  MAX_FRAME_BYTES,
  MAX_PROTOCOL_META_BYTES,
  utf8Length,
} from './limits';
import type {
  AcceptedPayload,
  ClientFrame,
  MessageEvent,
  ReceiptEvent,
  SendPayload,
  ServerFrame,
} from './protocol';

export type WsStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'auth_failed' | 'stopped';

export interface WebSocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type WebSocketFactory = (url: string) => WebSocketLike;

export class WsSendError extends Error {
  override name = 'WsSendError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface WsClientOptions {
  url: string;
  /** Trả access token còn hạn, hoặc null nếu phiên đã chết. */
  getToken: () => Promise<string | null>;
  /** Gọi khi server đóng 1008: cố refresh; trả true nếu còn phiên hợp lệ. */
  onAuthRejected?: () => Promise<boolean>;
  factory?: WebSocketFactory;
  rng?: () => number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  sendTimeoutMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

type Events = {
  status: WsStatus;
  message: MessageEvent;
  receipt: ReceiptEvent;
  /** Server báo client nên đồng bộ lại (gap seq, hoặc backlog trượt). */
  resync: undefined;
  /** Vừa (tái) kết nối thành công — ChatService nên chạy sync. */
  open: undefined;
  error: { code: string; message: string; ref?: string };
};

const OPEN = 1;

interface Pending {
  resolve: (a: AcceptedPayload) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WsClient extends Emitter<Events> {
  private ws: WebSocketLike | null = null;
  private _status: WsStatus = 'idle';
  private attempt = 0;
  private wanted = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<string, Pending>();
  private slowNext = false;
  private readonly o: Required<
    Pick<
      WsClientOptions,
      'pingIntervalMs' | 'pongTimeoutMs' | 'sendTimeoutMs' | 'baseBackoffMs' | 'maxBackoffMs'
    >
  > &
    WsClientOptions;

  constructor(opts: WsClientOptions) {
    super();
    this.o = {
      pingIntervalMs: 25_000,
      pongTimeoutMs: 10_000,
      sendTimeoutMs: 15_000,
      baseBackoffMs: 500,
      maxBackoffMs: 30_000,
      ...opts,
    };
  }

  get status(): WsStatus {
    return this._status;
  }

  private setStatus(s: WsStatus) {
    if (this._status === s) return;
    this._status = s;
    this.emit('status', s);
  }

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    void this.connect();
  }

  stop(): void {
    this.wanted = false;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      detach(ws);
      try {
        ws.close(1000, 'client stop');
      } catch {
        /* đã đóng */
      }
    }
    this.failAllPending(new WsSendError('not_connected', 'kết nối đã dừng'));
    this.setStatus('stopped');
  }

  private clearTimers() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.reconnectTimer = this.pingTimer = this.pongTimer = null;
  }

  private async connect(): Promise<void> {
    if (!this.wanted) return;
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    let token: string | null;
    try {
      token = await this.o.getToken();
    } catch {
      token = null;
      // lỗi tạm thời khi lấy token: thử lại theo backoff
      this.scheduleReconnect();
      return;
    }
    if (!this.wanted) return;
    if (!token) {
      this.wanted = false;
      this.setStatus('auth_failed');
      return;
    }
    const url = `${this.o.url}?access_token=${encodeURIComponent(token)}`;
    const factory = this.o.factory ?? ((u) => new WebSocket(u) as unknown as WebSocketLike);
    const ws = factory(url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.setStatus('open');
      this.startHeartbeat();
      this.emit('open', undefined);
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => {
      /* chi tiết lỗi không có; onclose sẽ theo sau */
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      void this.onClosed(ev.code);
    };
  }

  private startHeartbeat() {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState !== OPEN) return;
      this.rawSend({ type: 'ping' });
      this.pongTimer ??= setTimeout(() => {
        // không có pong: coi như kết nối chết
        this.pongTimer = null;
        this.ws?.close(4000, 'pong timeout');
      }, this.o.pongTimeoutMs);
    }, this.o.pingIntervalMs);
  }

  private async onClosed(code: number): Promise<void> {
    this.clearTimers();
    this.failAllPending(
      new WsSendError(
        code === 1009 ? 'frame_too_large' : 'connection_lost',
        `kết nối đóng (${code})`,
      ),
    );
    if (!this.wanted) return;

    if (code === 1008) {
      let ok = false;
      try {
        ok = (await this.o.onAuthRejected?.()) ?? false;
      } catch {
        ok = false;
      }
      if (!ok) {
        this.wanted = false;
        this.setStatus('auth_failed');
        return;
      }
    }
    if (code === 1013) this.slowNext = true;
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (!this.wanted) return;
    this.setStatus('reconnecting');
    const base = this.slowNext ? this.o.baseBackoffMs * 4 : this.o.baseBackoffMs;
    this.slowNext = false;
    const delay = nextDelay(this.attempt++, {
      baseMs: base,
      maxMs: this.o.maxBackoffMs,
      rng: this.o.rng,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private onMessage(data: unknown) {
    if (typeof data !== 'string') return;
    let f: ServerFrame;
    try {
      f = JSON.parse(data) as ServerFrame;
    } catch {
      return; // khung hỏng: bỏ qua
    }
    switch (f.type) {
      case 'accepted': {
        const p = this.pending.get(f.ref);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(f.ref);
          p.resolve(f.payload);
        }
        break;
      }
      case 'message':
        this.emit('message', f.payload);
        break;
      case 'receipt':
        this.emit('receipt', f.payload);
        break;
      case 'resync':
        this.emit('resync', undefined);
        break;
      case 'pong':
        if (this.pongTimer) {
          clearTimeout(this.pongTimer);
          this.pongTimer = null;
        }
        break;
      case 'error': {
        const p = f.ref ? this.pending.get(f.ref) : undefined;
        if (p && f.ref) {
          clearTimeout(p.timer);
          this.pending.delete(f.ref);
          p.reject(new WsSendError(f.payload.code, f.payload.message));
        }
        this.emit('error', { ...f.payload, ref: f.ref });
        break;
      }
    }
  }

  private rawSend(f: ClientFrame): string {
    const text = JSON.stringify(f);
    this.ws?.send(text);
    return text;
  }

  private failAllPending(err: Error) {
    for (const [ref, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(ref);
    }
  }

  /** Kiểm giới hạn trước khi gửi. Ném WsSendError('too_large' | 'meta_too_large'). */
  static validate(payload: SendPayload): void {
    // 1:1 có `ciphertext`; nhóm có `ciphertexts` (mỗi thành viên một bản). Giới hạn tính trên tổng.
    // Chưa tính `protocolMeta` của từng bản vì giao diện chưa gửi tin nhóm.
    const copies = [
      ...(payload.ciphertext !== undefined ? [payload.ciphertext] : []),
      ...(payload.ciphertexts ?? []).map((c) => c.ciphertext),
    ];
    if (copies.length === 0) throw new WsSendError('invalid', 'thiếu ciphertext');
    if (copies.reduce((n, c) => n + base64DecodedLength(c), 0) > MAX_CIPHERTEXT_BYTES)
      throw new WsSendError('too_large', 'tin nhắn quá lớn (tối đa 64 KiB sau khi mã hóa)');
    if (utf8Length(JSON.stringify(payload.protocolMeta ?? {})) > MAX_PROTOCOL_META_BYTES)
      throw new WsSendError('meta_too_large', 'protocolMeta vượt 4096 byte');
  }

  /** Gửi một tin. Giải quyết khi server `accepted` (kể cả `duplicate`). */
  send(payload: SendPayload): Promise<AcceptedPayload> {
    try {
      WsClient.validate(payload);
    } catch (e) {
      return Promise.reject(e);
    }
    if (this.ws?.readyState !== OPEN) {
      return Promise.reject(new WsSendError('not_connected', 'chưa kết nối'));
    }
    const ref = uuid();
    const frame: ClientFrame = { type: 'send', ref, payload };
    const text = JSON.stringify(frame);
    if (utf8Length(text) > MAX_FRAME_BYTES) {
      return Promise.reject(new WsSendError('too_large', 'khung gửi vượt 128 KiB'));
    }
    return new Promise<AcceptedPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(ref);
        reject(new WsSendError('timeout', 'server không phản hồi'));
      }, this.o.sendTimeoutMs);
      this.pending.set(ref, { resolve, reject, timer });
      try {
        this.ws?.send(text);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(ref);
        reject(new WsSendError('not_connected', (e as Error).message));
      }
    });
  }

  /** Báo delivered/read qua WS (best effort; nếu không mở thì trả false để caller dùng REST). */
  ack(messageId: string, state: 'delivered' | 'read'): boolean {
    if (this.ws?.readyState !== OPEN) return false;
    this.rawSend({ type: 'ack', payload: { messageId, state } });
    return true;
  }
}

function detach(ws: WebSocketLike) {
  ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
}
