interface CacheEntry<T> {
  revision: number;
  value: T;
}

export class ResultCache<T> {
  #entries = new Map<string, CacheEntry<T>>();
  hits = 0;
  misses = 0;
  invalidations = 0;

  constructor(private readonly maxEntries = 128) {}

  get(revision: number, key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry || entry.revision !== revision) {
      this.misses += 1;
      if (entry) this.#entries.delete(key);
      return undefined;
    }
    this.hits += 1;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(revision: number, key: string, value: T): void {
    this.#entries.set(key, { revision, value });
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  invalidate(): number {
    const size = this.#entries.size;
    if (size === 0) return 0;
    this.invalidations += size;
    this.#entries.clear();
    return size;
  }
}
