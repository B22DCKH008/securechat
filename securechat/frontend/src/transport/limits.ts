/** Giới hạn của backend (docs/api/websocket-protocol.md). Kiểm phía client để báo lỗi sớm, rõ ràng. */
export const MAX_CIPHERTEXT_BYTES = 64 * 1024; // sau khi giải mã base64
export const MAX_FRAME_BYTES = 128 * 1024; // toàn bộ khung JSON gửi lên
export const MAX_PROTOCOL_META_BYTES = 4096;

const enc = new TextEncoder();
export const utf8Length = (s: string): number => enc.encode(s).length;
