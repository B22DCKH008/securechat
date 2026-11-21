/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL của REST (mặc định: cùng origin, qua proxy của Vite). */
  readonly VITE_API_URL?: string;
  /** Base URL của WebSocket (mặc định: suy ra từ origin hiện tại). */
  readonly VITE_WS_URL?: string;
  /** 'mock' (mặc định khi dev, KHÔNG an toàn) hoặc 'signal'. */
  readonly VITE_E2EE?: 'mock' | 'signal';
  /** Thời gian chờ tối đa cho một lần phân tích AI (ms). */
  readonly VITE_AI_TIMEOUT_MS?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
