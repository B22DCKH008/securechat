import { IndexedDbStorage } from './indexedDb';
import { MemoryStorage } from './memory';
import type { ChatStorage } from './types';

export type { ChatStorage, LocalMessage, MessageStatus, StoredRisk, Cursor } from './types';
export { MemoryStorage } from './memory';
export { IndexedDbStorage } from './indexedDb';

/**
 * Mỗi người dùng một DB riêng (tránh lẫn dữ liệu khi đổi tài khoản trên cùng trình duyệt).
 * IndexedDB không dùng được (chế độ riêng tư cũ, bị chặn) => RAM, mất khi đóng tab.
 */
export async function openStorage(
  userId: string,
): Promise<{ storage: ChatStorage; persistent: boolean }> {
  try {
    if (typeof indexedDB === 'undefined') throw new Error('no indexedDB');
    return { storage: await IndexedDbStorage.open(`securechat-${userId}`), persistent: true };
  } catch {
    return { storage: new MemoryStorage(), persistent: false };
  }
}
