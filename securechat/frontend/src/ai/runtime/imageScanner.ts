import type { MessageAnalysis } from '../contract';
import type { LocalRiskAnalyzer } from './analyzer';

interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): {
    detect(source: ImageBitmapSource): Promise<Array<{ rawValue: string }>>;
  };
}

export interface ImageScanResult {
  qrPayloads: string[];
  qrSupported: boolean;
  analysis: MessageAnalysis;
  matchedRules: string[];
  note: string;
}

export async function scanImageOnDevice(
  file: File,
  analyzer: LocalRiskAnalyzer,
): Promise<ImageScanResult> {
  const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor })
    .BarcodeDetector;

  if (!Detector) {
    return {
      qrPayloads: [],
      qrSupported: false,
      analysis: { status: 'unavailable' },
      matchedRules: [],
      note: 'Trình duyệt không hỗ trợ BarcodeDetector (nên dùng Chrome/Edge) và chưa bật OCR tesseract.js nên không thể đánh giá rủi ro hình ảnh.',
    };
  }

  try {
    const bitmap = await createImageBitmap(file);
    const detector = new Detector({ formats: ['qr_code'] });
    const detected = await detector.detect(bitmap);
    bitmap.close();

    const qrPayloads = detected
      .map((d) => d.rawValue?.trim())
      .filter((v): v is string => Boolean(v));

    if (qrPayloads.length === 0) {
      return {
        qrPayloads: [],
        qrSupported: true,
        analysis: { status: 'unavailable' },
        matchedRules: [],
        note: 'Không phát hiện mã QR trong ảnh. Để quét chữ tiếng Việt trong ảnh chụp màn hình, cần bổ sung module OCR (tesseract.js) on-device.',
      };
    }

    const joined = qrPayloads.join(' ');
    const analysis = await analyzer.analyzeMessage(joined);
    const matchedRules = analyzer.getMatchedRules(joined);
    return {
      qrPayloads,
      qrSupported: true,
      analysis,
      matchedRules,
      note: `Đã giải mã ${qrPayloads.length} mã QR cục bộ trên trình duyệt và quét bằng mô hình ${analysis.modelVersion ?? 'on-device'}.`,
    };
  } catch {
    return {
      qrPayloads: [],
      qrSupported: true,
      analysis: { status: 'error' },
      matchedRules: [],
      note: 'Không thể giải mã hình ảnh trên trình duyệt.',
    };
  }
}