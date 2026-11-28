/** Bộ phát sự kiện nhỏ, có kiểu. */
export class Emitter<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<(v: never) => void>>();

  on<K extends keyof Events>(event: K, cb: (v: Events[K]) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(cb as (v: never) => void);
    return () => set.delete(cb as (v: never) => void);
  }

  protected emit<K extends keyof Events>(event: K, value: Events[K]): void {
    for (const cb of [...(this.handlers.get(event) ?? [])]) {
      try {
        (cb as (v: Events[K]) => void)(value);
      } catch (e) {
        console.error(`[emitter] handler "${String(event)}" lỗi`, e);
      }
    }
  }
}
