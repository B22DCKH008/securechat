/** Địa chỉ backend. Mặc định cùng origin (Vite proxy `/v1` và `/ws` khi dev). */
export interface TransportConfig {
  /** '' = cùng origin. */
  apiBase: string;
  /** URL đầy đủ tới endpoint WebSocket, không kèm token. */
  wsUrl: string;
}

export function defaultTransportConfig(): TransportConfig {
  const apiBase = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
  let wsUrl = import.meta.env.VITE_WS_URL;
  if (!wsUrl) {
    const loc = globalThis.location;
    const proto = loc?.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl = loc ? `${proto}//${loc.host}/ws` : 'ws://localhost:8081/ws';
  }
  return { apiBase, wsUrl };
}
