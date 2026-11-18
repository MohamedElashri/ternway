export interface TerminalClipboardRequest { read: boolean; selection: string; text?: string }
type Permission = "allow" | "deny" | "ask";
export interface TerminalClipboardAccess {
  session: () => string | null;
  permission: (read: boolean) => Permission;
  confirm: (read: boolean) => Promise<boolean>;
  read: () => Promise<string>;
  write: (text: string) => Promise<void>;
  reply: (session: string, data: string) => void;
}

/** Preserve OSC 52 request order while binding every answer to its originating session. */
export class TerminalClipboardRequests {
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private readonly access: TerminalClipboardAccess;
  constructor(access: TerminalClipboardAccess) { this.access = access; }

  enqueue(request: TerminalClipboardRequest): Promise<void> {
    const session = this.access.session();
    // Bound queued remote data and prompts; unsupported primary selections stay inert.
    if (!session || this.pending >= 16 || this.access.permission(request.read) === "deny" || !["", "c"].includes(request.selection) || (request.text?.length ?? 0) > 65536) return Promise.resolve();
    this.pending++;
    const task = this.queue.then(async () => {
      const permission = this.access.permission(request.read);
      const current = (): boolean => this.access.session() === session && this.access.permission(request.read) === permission;
      if (permission === "deny" || !current()) return;
      if (permission === "ask" && !(await this.access.confirm(request.read))) return;
      if (!current()) return;
      if (request.read) {
        const text = await this.access.read();
        if (!current()) return;
        const bytes = new TextEncoder().encode(text);
        if (bytes.length > 48000) return;
        const encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));
        this.access.reply(session, `\x1b]52;${request.selection};${encoded}\x07`);
      } else if (typeof request.text === "string") await this.access.write(request.text);
    }).finally(() => { this.pending--; });
    this.queue = task.catch(() => undefined);
    return task;
  }
}
