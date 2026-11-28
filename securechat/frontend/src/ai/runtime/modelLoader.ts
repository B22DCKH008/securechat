/**
 * Nạp model theo manifest. Mọi lỗi (thiếu file, sai hợp đồng, WASM không nạp được) => ném lỗi
 * để lớp trên chuyển sang trạng thái "unavailable" — KHÔNG BAO GIỜ coi là "an toàn".
 */
import type { UrlSpec } from '../features/url';
import { parseManifest, type ModelManifest } from './manifest';
import { MessageModel, type MessageModelJson } from './messageModel';
import {
  UrlLrModel,
  UrlOnnxModel,
  type OrtModuleLike,
  type OrtSessionLike,
  type UrlLrJson,
  type UrlModel,
} from './urlModel';

export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface LoadedModels {
  manifest: ModelManifest;
  message?: MessageModel;
  url?: UrlModel;
}

/** Địa chỉ file mjs + wasm của onnxruntime-web (chuỗi thư mục, hoặc từng file). */
export type OrtWasmPaths = string | { mjs: string; wasm: string };

export interface OrtRuntime extends OrtModuleLike {
  env: { wasm: { wasmPaths?: OrtWasmPaths; numThreads?: number; proxy?: boolean } };
  InferenceSession: {
    create(model: Uint8Array, options?: Record<string, unknown>): Promise<OrtSessionLike>;
  };
}

export interface LoadOptions {
  /** Thư mục chứa manifest.json, ví dụ '/models/'. */
  baseUrl: string;
  /** Nơi lấy file .mjs/.wasm của onnxruntime-web (xem ortAssets.ts). Bỏ trống => ORT tự tìm. */
  ortPaths?: OrtWasmPaths;
  fetchFn?: FetchLike;
  /** Cho phép thay bằng bản giả lập khi test. */
  importOrt?: () => Promise<OrtRuntime>;
}

export class ModelLoadError extends Error {
  override name = 'ModelLoadError';
}

const join = (base: string, file: string) => (base.endsWith('/') ? base : base + '/') + file;

async function getJson<T>(fetchFn: FetchLike, url: string): Promise<T> {
  const r = await fetchFn(url);
  if (!r.ok) throw new ModelLoadError(`${url}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

async function defaultImportOrt(): Promise<OrtRuntime> {
  return (await import('onnxruntime-web/wasm')) as unknown as OrtRuntime;
}

export async function loadModels(opts: LoadOptions): Promise<LoadedModels> {
  const fetchFn: FetchLike = opts.fetchFn ?? ((u) => fetch(u));
  const manifest = parseManifest(await getJson(fetchFn, join(opts.baseUrl, 'manifest.json')));
  const out: LoadedModels = { manifest };

  if (manifest.message) {
    const json = await getJson<MessageModelJson>(
      fetchFn,
      join(opts.baseUrl, manifest.message.file),
    );
    out.message = new MessageModel(json);
  }

  if (manifest.url) {
    const u = manifest.url;
    const spec = await getJson<UrlSpec & { usedFeatureNames?: string[] }>(
      fetchFn,
      join(opts.baseUrl, u.specFile),
    );
    if (u.kind === 'lr') {
      out.url = new UrlLrModel(await getJson<UrlLrJson>(fetchFn, join(opts.baseUrl, u.file)), spec);
    } else {
      const r = await fetchFn(join(opts.baseUrl, u.file));
      if (!r.ok) throw new ModelLoadError(`${u.file}: HTTP ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const ort = await (opts.importOrt ?? defaultImportOrt)();
      // numThreads=1 + không proxy: không cần SharedArrayBuffer/COOP-COEP, chạy được trên host tĩnh.
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      if (opts.ortPaths) ort.env.wasm.wasmPaths = opts.ortPaths;
      const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
      const names = spec.usedFeatureNames ?? spec.featureNames;
      out.url = new UrlOnnxModel(session, ort, spec, names, u.modelVersion, u.threshold);
    }
  }
  return out;
}
