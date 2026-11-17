/** Serialize session writes so periodic saves and quit cannot race on the temporary file. */
export class SessionWriter {
  private pending: Promise<void> = Promise.resolve();
  private lastSaved = "";
  private readonly persist: (contents: string) => Promise<void>;

  constructor(persist: (contents: string) => Promise<void>) {
    this.persist = persist;
  }

  save(contents: string | (() => Promise<string | null>)): Promise<void> {
    const next = this.pending.then(async () => {
      // Native snapshots are asynchronous. Capture inside the same queue as the
      // write so an older slow snapshot cannot overwrite a newer layout at quit.
      const value = typeof contents === "function" ? await contents() : contents;
      if (value === null || value === this.lastSaved) return;
      await this.persist(value);
      this.lastSaved = value;
    });
    this.pending = next.catch(() => undefined);
    return next;
  }
}
