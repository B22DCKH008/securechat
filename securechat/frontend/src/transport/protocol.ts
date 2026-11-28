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
  clientMessageId: string;   // uuid; REUSE on retry (idempotency); "sys:" prefix reserved
  conversationId: string;
  ciphertext?: string;       // direct: base64 – produced by the Signal library, never plaintext
  ciphertexts?: RecipientCiphertext[]; // group: one pairwise copy per member except me
  protocolMeta: Record<string, unknown>;
  clientCreatedAt?: string;
}

/** Group pairwise fan-out: encrypt with the existing 1:1 Signal session per member. */
export interface RecipientCiphertext {
  recipientId: string;
  deviceId?: number;         // default 1
  ciphertext: string;        // base64
  protocolMeta?: Record<string, unknown>;
}

export type SystemEventType =
  | 'group_created' | 'members_added' | 'member_removed' | 'member_left' | 'title_changed';

export interface SystemEvent {
  type: SystemEventType;
  actorId: string;
  userIds?: string[];
  title?: string;
  newOwnerId?: string;
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
  ciphertext: string;        // group: MY pairwise copy only; system: empty (do not decrypt)
  protocolMeta: Record<string, unknown>;
  acceptedAt: string;
  kind?: 'message' | 'system'; // absent = message
  system?: SystemEvent;      // kind === 'system'
}

// Error codes added for groups: 'membership_changed' → GET /v1/conversations/{id}/members,
// re-encrypt for the new member set and send again (nothing was stored).

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
