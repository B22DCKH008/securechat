/// <reference lib="webworker" />
/**
 * Web Worker: nạp và chạy model, tách khỏi luồng giao diện.
 * Giao thức: xem WorkerRequest / WorkerResponse trong workerEngine.ts.
 */
import { LocalEngine, ModelNotLoadedError, type InferenceEngine } from './engine';
import type { WorkerRequest, WorkerResponse } from './workerEngine';

let engine: InferenceEngine | null = null;

function reply(msg: WorkerResponse): void {
  (self as unknown as Worker).postMessage(msg);
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.op === 'init') {
      engine?.dispose();
      engine = new LocalEngine(req.options);
      reply({ id: req.id, ok: true, result: await engine.init() });
    } else if (!engine) {
      throw new ModelNotLoadedError('worker chưa init');
    } else if (req.op === 'message') {
      reply({ id: req.id, ok: true, result: await engine.analyzeMessage(req.text) });
    } else {
      reply({ id: req.id, ok: true, result: await engine.analyzeUrl(req.url) });
    }
  } catch (e) {
    const err = e as Error;
    reply({ id: req.id, ok: false, error: { name: err.name, message: err.message } });
  }
};
