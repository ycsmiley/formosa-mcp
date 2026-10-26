export class TtlCache<T> {
  private values = new Map<string, { value: T; expires: number }>();
  private pending = new Map<string, Promise<T>>();
  constructor(private ttl: number | ((value: T) => number) = 6 * 60 * 60 * 1000, private now = Date.now) {}
  getOrLoad(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = this.values.get(key);
    if (cached && cached.expires > this.now()) return Promise.resolve(cached.value);
    const active = this.pending.get(key);
    if (active) return active;
    const promise = Promise.resolve().then(loader).then(value => {
      const ttl = typeof this.ttl === 'function' ? this.ttl(value) : this.ttl;
      this.values.set(key, { value, expires: this.now() + ttl });
      return value;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}
