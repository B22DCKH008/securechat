import { create } from 'zustand';

const KEY = 'securechat.settings';

interface Persisted {
  aiEnabled: boolean;
}

function load(): Persisted {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (raw) return { aiEnabled: true, ...(JSON.parse(raw) as Partial<Persisted>) };
  } catch {
    /* localStorage bị chặn */
  }
  return { aiEnabled: true };
}

interface SettingsState extends Persisted {
  setAiEnabled(v: boolean): void;
}

/** Cài đặt cục bộ của người dùng (chỉ lưu trong trình duyệt này). */
export const useSettings = create<SettingsState>((set, get) => ({
  ...load(),
  setAiEnabled(v) {
    set({ aiEnabled: v });
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify({ aiEnabled: get().aiEnabled }));
    } catch {
      /* bỏ qua */
    }
  },
}));
