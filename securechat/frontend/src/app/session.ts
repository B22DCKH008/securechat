/**
 * Session: gom mọi dịch vụ gắn với MỘT người dùng đã đăng nhập (storage, crypto, ws, chat, analyzer).
 * Đăng xuất => stop() và xóa dữ liệu cục bộ.
 */
import type { ControllableAnalyzer } from '../ai';
import { createCryptoProvider, type CryptoProvider } from '../crypto';
import { ChatService } from '../features/messages/chatService';
import { openStorage, type ChatStorage } from '../storage';
import type { ApiClient } from '../transport/rest';
import { defaultTransportConfig } from '../transport/config';
import { AuthExpiredError } from '../transport/tokenManager';
import type { Tokens } from '../transport/types';
import { WsClient } from '../transport/ws';

export interface Session {
  user: { userId: string; deviceId: number };
  chat: ChatService;
  ws: WsClient;
  crypto: CryptoProvider;
  storage: ChatStorage;
  persistentStorage: boolean;
  analyzer: ControllableAnalyzer;
  stop(): void;
  /** Xóa toàn bộ dữ liệu cục bộ (dùng khi đăng xuất). */
  wipe(): Promise<void>;
}

export interface StartSessionDeps {
  api: ApiClient;
  analyzer: ControllableAnalyzer;
}

export async function startSession(
  tokens: Tokens,
  { api, analyzer }: StartSessionDeps,
): Promise<Session> {
  const user = { userId: tokens.userId, deviceId: tokens.deviceId };
  const { storage, persistent } = await openStorage(user.userId);
  const crypto = createCryptoProvider();

  // Đăng ký khóa công khai (SC2). Lỗi ở đây không chặn đăng nhập: tin vẫn nhận/gửi được ở chế độ mock.
  try {
    await api.putKeyBundle(await crypto.init(user));
  } catch (e) {
    console.warn('[session] không đăng ký được key bundle:', (e as Error).message);
  }

  const cfg = defaultTransportConfig();
  const ws = new WsClient({
    url: cfg.wsUrl,
    getToken: () => api.tokens.getAccessToken(),
    onAuthRejected: async () => {
      try {
        await api.tokens.refresh();
        return true;
      } catch (e) {
        if (e instanceof AuthExpiredError) return false;
        return true; // lỗi tạm thời: cứ thử kết nối lại theo backoff
      }
    },
  });
  const chat = new ChatService({ me: user, api, ws, crypto, storage, analyzer });
  await chat.start();

  return {
    user,
    chat,
    ws,
    crypto,
    storage,
    persistentStorage: persistent,
    analyzer,
    stop: () => chat.stop(),
    wipe: async () => {
      chat.stop();
      await storage.clear();
      await crypto.wipe();
    },
  };
}
