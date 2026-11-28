/**
 * Manifest của bộ model được serve tĩnh ở `public/models/manifest.json` (AI14, AI17).
 * Do `npm run models:sync` tạo từ `ml/models/artifacts/`; không sửa tay.
 */
export interface ModelManifest {
  schema: 'securechat.models/1';
  generatedAt?: string;
  /** true nếu là model demo (số đo vô nghĩa) — UI nên hiện cảnh báo. */
  demo?: boolean;
  message?: {
    file: string;
    modelVersion: string;
    bytes?: number;
  };
  url?: {
    kind: 'lr' | 'gbdt' | 'rf';
    file: string;
    specFile: string;
    modelVersion: string;
    threshold: number;
    /** model đã đạt ngưỡng chất lượng đặt trước hay chưa (null = chưa xác định) */
    meetsBar?: boolean | null;
    bytes?: number;
  };
}

export function parseManifest(raw: unknown): ModelManifest {
  const m = raw as Partial<ModelManifest> | null;
  if (!m || m.schema !== 'securechat.models/1') throw new Error('manifest không hợp lệ');
  return m as ModelManifest;
}
