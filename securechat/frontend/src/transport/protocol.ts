/**
 * WebSocket frame types – mirror of backend/internal/gateway/protocol.go.
 * See docs/api/websocket-protocol.md.
 */

export type ClientFrame =
  | { type: 'send'; ref: string; payload: SendPayload }
  | { type: 'ack'; ref?: string; payload: { messageId: string; state: 'delivered' | 'read' } }
  | { type: 'ping'; ref?: string };

export type ServerFrame =
  | { type: 'accepted'; ref: string; payload: AcceptedPayload }
  | { type: 'message'; payload: MessageEvent }
  | { type: 'receipt'; payload: ReceiptEvent }
  | { type: 'error'; ref?: string; payload: { code: string; message: string } }
  | { type: 'pong'; ref?: string }
  | { type: 'resync' };

export interface SendPayload {
  clientMessageId: string;   // uuid; REUSE on retry (idempotency)
  conversationId: string;
  ciphertext: string;        // base64 – produced by the Signal library, never plaintext
  protocolMeta: Record<string, unknown>;
  clientCreatedAt?: string;
}

export interface AcceptedPayload {
  clientMessageId: string;
  messageId: string;
  conversationId: string;
  seq: number;
  duplicate: boolean;
  state: 'accepted';
}

export interface MessageEvent {
  messageId: string;
  clientMessageId: string;
  conversationId: string;
  seq: number;               // client orders by seq; gap ⇒ call POST /v1/sync
  senderId: string;
  recipients: string[];
  ciphertext: string;
  protocolMeta: Record<string, unknown>;
  acceptedAt: string;
}

export interface ReceiptEvent {
  receiptSeq?: number;         // additive durable receipt cursor (new servers)
  messageId: string;
  conversationId: string;
  seq: number;
  recipientId: string;
  senderId: string;
  state: 'delivered' | 'read';
  at: string;
}
