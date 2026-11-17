/** Serialize library writes and coalesce their change events into one fresh read. */
export class LibraryQueue<T> {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private revision = 0;
  private dirty = false;
  private refreshing: Promise<void> | null = null;

  private load: () => Promise<T>;
  private apply: (value: T) => Promise<void> | void;

  constructor(load: () => Promise<T>, apply: (value: T) => Promise<void> | void) { this.load = load; this.apply = apply; }

  changed(): Promise<void> {
    this.dirty = true;
    this.revision++;
    return this.refresh();
  }

  mutate(operation: () => Promise<void>): Promise<void> {
    this.pending++;
    this.revision++;
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result.finally(async () => {
      this.pending--;
      this.dirty = true;
      await this.refresh();
    });
  }

  private refresh(): Promise<void> {
    if (this.pending) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      while (this.dirty && !this.pending) {
        this.dirty = false;
        const revision = this.revision;
        const value = await this.load();
        if (revision === this.revision && !this.pending) await this.apply(value);
        else this.dirty = true;
      }
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
}
