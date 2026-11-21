/** Các singleton dùng chung cả ứng dụng (không phụ thuộc người dùng cụ thể). */
import { createAnalyzer } from '../ai';
import { ApiClient } from '../transport/rest';
import { defaultTransportConfig } from '../transport/config';
import { WebStorageTokenStore } from '../transport/tokenManager';
import { useSettings } from './settings';

/**
 * Token lưu ở sessionStorage: mất khi đóng tab (an toàn hơn localStorage nếu có XSS, đổi lại phải đăng nhập lại).
 * Muốn "ghi nhớ đăng nhập" thì đổi sang localStorage và nêu rõ đánh đổi trong báo cáo.
 */
export const api = new ApiClient({
  baseUrl: defaultTransportConfig().apiBase,
  tokenStore: new WebStorageTokenStore(
    globalThis.sessionStorage ?? { getItem: () => null, setItem() {}, removeItem() {} },
  ),
});

export const analyzer = createAnalyzer({ enabled: useSettings.getState().aiEnabled });

useSettings.subscribe((s, prev) => {
  if (s.aiEnabled !== prev.aiEnabled) analyzer.setEnabled(s.aiEnabled);
});
