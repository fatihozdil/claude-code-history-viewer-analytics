/**
 * Keyed time-to-live cache for expensive local reads.
 *
 * Concurrent callers for the same key share one in-flight read, and a failed
 * read is never cached, so the next caller retries. `fresh: true` skips the
 * cached value (and any in-flight read) and stores the new result.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; at: number }>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string, read: () => Promise<T>, opts: { fresh?: boolean } = {}): Promise<T> {
    if (!opts.fresh) {
      const hit = this.entries.get(key);
      if (hit && this.now() - hit.at < this.ttlMs) return Promise.resolve(hit.value);
      const pending = this.inflight.get(key);
      if (pending) return pending;
    }
    const load: Promise<T> = read()
      .then((value) => {
        this.entries.set(key, { value, at: this.now() });
        return value;
      })
      .finally(() => {
        if (this.inflight.get(key) === load) this.inflight.delete(key);
      });
    this.inflight.set(key, load);
    return load;
  }
}
