// Manual updates from GitHub releases. Nothing contacts GitHub until checkNow(), and nothing is
// downloaded or installed until install(). The updater plugin verifies each download against the
// public key in tauri.conf.json before install() runs.

function updateError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return String(error);
}

/** The part of the updater plugin's `Update` this controller uses. */
export interface UpdatePackage {
  version: string;
  body?: string;
  date?: string;
  download(onEvent: (event: DownloadEvent) => void, options?: { timeout?: number }): Promise<void>;
  install(): Promise<void>;
  close(): Promise<void>;
}
export type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export type UpdatePhase = "idle" | "checking" | "current" | "available" | "preparing" | "downloading" | "verifying" | "installing" | "installed" | "restarting" | "error";
export interface UpdateState {
  phase: UpdatePhase;
  version?: string;
  notes?: string;
  date?: string;
  downloaded: number;
  total?: number;
  error?: string;
}

const BUSY: UpdatePhase[] = ["checking", "preparing", "downloading", "verifying", "installing", "restarting"];
const PROGRESS_INTERVAL_MS = 100;

export class UpdateController {
  state: UpdateState = { phase: "idle", downloaded: 0 };
  private pending: UpdatePackage | null = null;
  private readonly check: () => Promise<UpdatePackage | null>;
  private readonly restart: () => Promise<void>;
  private readonly changed: () => void;
  private readonly prepareInstall: () => Promise<void>;

  constructor(check: () => Promise<UpdatePackage | null>, restart: () => Promise<void>, changed: () => void, prepareInstall: () => Promise<void> = async () => {}) {
    this.check = check;
    this.restart = restart;
    this.changed = changed;
    this.prepareInstall = prepareInstall;
  }

  get busy(): boolean {
    return BUSY.includes(this.state.phase);
  }

  private set(next: Partial<UpdateState>): void {
    this.state = { ...this.state, ...next };
    this.changed();
  }

  private release(): void {
    const previous = this.pending;
    this.pending = null;
    // Cleanup must not hold the UI in a busy phase if the IPC resource close stalls.
    try { void previous?.close().catch(() => undefined); } catch { /* best effort */ }
  }

  restoreInstalled(version: string): void {
    if (this.busy || this.state.phase === "installed") return;
    this.release();
    this.set({ phase: "installed", version, error: undefined });
  }

  async checkNow(): Promise<void> {
    if (this.busy || this.state.phase === "installed") return;
    this.set({ phase: "checking", version: undefined, notes: undefined, date: undefined, downloaded: 0, total: undefined, error: undefined });
    this.release();
    try {
      this.pending = await this.check();
      const update = this.pending;
      this.set(update ? { phase: "available", version: update.version, notes: update.body, date: update.date } : { phase: "current" });
    } catch (error) {
      this.set({ phase: "error", error: `Could not check for updates. Check your connection and try again. ${updateError(error)}` });
    }
  }

  async install(): Promise<void> {
    if (this.state.phase !== "available" || !this.pending) return;
    const update = this.pending;
    this.set({ phase: "preparing", downloaded: 0, total: undefined, error: undefined });
    let lastProgress = 0;
    try {
      await this.prepareInstall();
      this.set({ phase: "downloading" });
      await update.download((event) => {
        if (event.event === "Finished") this.set({ phase: "verifying" });
        else if (event.event === "Started") this.set({ total: event.data.contentLength });
        else if (event.event === "Progress") {
          this.state.downloaded += event.data.chunkLength;
          if (Date.now() - lastProgress >= PROGRESS_INTERVAL_MS) { lastProgress = Date.now(); this.changed(); }
        }
      }, { timeout: 300_000 });
      // download() resolves only after the signature check; never install on "Finished".
      this.set({ phase: "installing" });
      await update.install();
      this.set({ phase: "installed" });
    } catch (error) {
      const step = ({ preparing: "prepared", downloading: "downloaded", verifying: "verified", installing: "installed" } as Partial<Record<UpdatePhase, string>>)[this.state.phase] ?? "installed";
      this.set({ phase: "error", error: `The update could not be ${step}. Check again to retry, or download it from the releases page. ${updateError(error)}` });
    } finally {
      this.release();
    }
  }

  async restartNow(): Promise<void> {
    if (this.state.phase !== "installed") return;
    this.set({ phase: "restarting", error: undefined });
    try {
      await this.restart();
    } catch (error) {
      if (updateError(error) === "Restart cancelled; all windows remain open") { this.set({ phase: "installed", error: undefined }); return; }
      this.set({ phase: "installed", error: `Could not restart Ternway. Quit and reopen it to finish updating. ${updateError(error)}` });
    }
  }
}
