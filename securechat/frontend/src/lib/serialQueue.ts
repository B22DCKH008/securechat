/**
 * Hàng đợi tuần tự theo khóa: các tác vụ cùng khóa chạy lần lượt, khác khóa chạy song song.
 * Dùng để xử lý tin của MỖI hội thoại theo đúng thứ tự (giải mã Signal cần đúng thứ tự, và tránh race giữa WS với sync).
 */
export class KeyedSerialQueue {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
