/** DTO của REST — khớp backend/api/openapi.yaml. */
export interface Credentials {
  username: string;
  password: string;
  deviceId?: number;
}

export interface Tokens {
  userId: string;
  deviceId: number;
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO
}

export interface Conversation {
  id: string;
  kind: 'direct' | 'group';
  lastSeq: number;
  members: string[];
  createdAt: string;
}

export interface ApiMessage {
  messageId: string;
  clientMessageId: string;
  conversationId: string;
  seq: number;
  senderId: string;
  ciphertext: string; // base64
  protocolMeta?: Record<string, unknown>;
  clientCreatedAt?: string;
  createdAt: string;
}

export interface ApiReceipt {
  receiptSeq?: number;
  messageId: string;
  conversationId: string;
  seq: number;
  recipientId: string;
  senderId: string;
  state: 'delivered' | 'read';
  at: string;
}

export interface SendRequest {
  clientMessageId: string;
  ciphertext: string; // base64
  protocolMeta?: Record<string, unknown>;
  clientCreatedAt?: string;
}

export interface Accepted {
  messageId: string;
  clientMessageId: string;
  conversationId: string;
  seq: number;
  state: 'accepted';
  duplicate: boolean;
}

export interface SyncRequest {
  /** conversationId -> seq cuối cùng client đã có */
  cursors: Record<string, number>;
  /** conversationId -> receiptSeq cuối cùng đã lưu (độc lập với cursors) */
  receiptCursors?: Record<string, number>;
  limit?: number;
}

export interface SyncConversation {
  conversationId: string;
  messages: ApiMessage[];
  nextCursor: number;
  hasMore: boolean;
  receipts?: ApiReceipt[];
  nextReceiptCursor?: number;
  hasMoreReceipts?: boolean;
}

export interface SyncResponse {
  conversations: SyncConversation[];
}

/** Pre-key bundle CÔNG KHAI (SC2). Các trường byte là base64. */
export interface PublicKeyBundle {
  deviceId: number;
  registrationId: number;
  identityKey: string;
  signedPreKeyId: number;
  signedPreKey: string;
  signedPreKeySignature: string;
  oneTimePreKeys?: { keyId: number; publicKey: string }[];
}
