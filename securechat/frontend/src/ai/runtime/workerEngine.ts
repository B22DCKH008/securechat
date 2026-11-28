import {
  ModelNotLoadedError,
  type EngineInfo,
  type EngineMessageResult,
  type EngineUrlResult,
  type InferenceEngine,
} from './engine';
import type { LoadOptions } from './modelLoader';

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export type WorkerRequest =
  | { id: number; op: 'init'; options: Omit<LoadOptions, 'fetchFn' | 'importOrt'> }
  | { id: number; op: 'message'; text: string }
  | { id: number; op: 'url'; url: string };

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { name: string; message: string } };

/** Phần tối thiểu của Worker mà ta dùng (để giả lập khi test). */
export interface WorkerLike {
  postMessage(msg: WorkerRequest): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  onmessageerror: ((ev: MessageEvent) => void) | null;
}

export type WorkerFactory = () => WorkerLike;

/** Tạo Worker thật (Vite bundle worker.ts thành file riêng nhờ cú pháp `new URL(..., import.meta.url)`). */
export const defaultWorkerFactory: WorkerFactory = () =>
  new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
}

export class WorkerEngine implements InferenceEngine {
  private worker: WorkerLike | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(
    private readonly options: Omit<LoadOptions, 'fetchFn' | 'importOrt'>,
    private readonly factory: WorkerFactory = defaultWorkerFactory,
  ) {}

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const w = this.factory();
    w.onmessage = (ev) => {
      const r = ev.data;
      const p = this.pending.get(r.id);
      if (!p) return;
      this.pending.delete(r.id);
      if (r.ok) p.resolve(r.result);
      else {
        const e =
          r.error.name === 'ModelNotLoadedError'
            ? new ModelNotLoadedError(r.error.message)
            : new Error(`${r.error.name}: ${r.error.message}`);
        p.reject(e);
      }
    };
    const fail = (msg: string) => {
      this.rejectAll(new Error(msg));
      this.worker = null; // lần sau tạo worker mới
    };
    w.onerror = (ev) => fail(`worker lỗi: ${ev.message}`);
    w.onmessageerror = () => fail('worker trả dữ liệu không đọc được');
    this.worker = w;
    return w;
  }

  private call<T>(req: DistributiveOmit<WorkerRequest, 'id'>): Promise<T> {
    const w = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      w.postMessage({ ...req, id } as WorkerRequest);
    });
  }

  private rejectAll(e: Error): void {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  init(): Promise<EngineInfo> {
    return this.call<EngineInfo>({ op: 'init', options: this.options });
  }
  analyzeMessage(text: string): Promise<EngineMessageResult> {
    return this.call<EngineMessageResult>({ op: 'message', text });
  }
  analyzeUrl(url: string): Promise<EngineUrlResult> {
    return this.call<EngineUrlResult>({ op: 'url', url });
  }

  reset(): void {
    this.rejectAll(new Error('engine bị reset'));
    this.worker?.terminate();
    this.worker = null;
  }

  dispose(): void {
    this.reset();
  }
}
