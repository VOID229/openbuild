// Small, bounded cache for command discovery. Keep the last good list while revalidating;
// concurrent callers share one lookup, including slow Pi starts.
interface Entry<T> {
  value?: T;
  freshUntil: number;
  retryAt: number;
  pending?: Promise<T>;
}

export class CommandCache<T> {
  private entries = new Map<string, Entry<T>>();

  constructor(private ttl: number, private limit = 64, private now = Date.now) {}

  peek(key: string): T | undefined {
    return this.entries.get(key)?.value;
  }

  get(key: string, load: () => Promise<T>, stale = true): Promise<T> {
    let entry = this.entries.get(key);
    if (!entry) entry = { freshUntil: 0, retryAt: 0 };
    // Touch for LRU eviction.
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    if (entry.value !== undefined && this.now() < Math.max(entry.freshUntil, entry.retryAt)) return Promise.resolve(entry.value);
    if (!entry.pending) {
      const current = entry;
      current.pending = Promise.resolve().then(load).then(
        (value) => {
          current.value = value;
          current.freshUntil = this.now() + this.ttl;
          current.pending = undefined;
          return value;
        },
        (error) => {
          current.pending = undefined;
          if (current.value !== undefined) current.retryAt = this.now() + 10_000;
          else if (this.entries.get(key) === current) this.entries.delete(key);
          throw error;
        },
      );
    }
    if (stale && entry.value !== undefined) {
      void entry.pending!.catch(() => {});
      return Promise.resolve(entry.value);
    }
    return entry.pending!;
  }

  clear() {
    this.entries.clear();
  }
}
