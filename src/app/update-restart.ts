export const UPDATE_RESTART_KEY = "ternway-update-restart";
interface UpdateStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

/** Keep the restart reminder across webview reloads and share it with other windows.
 * A different running binary means the update has taken effect; never check the
 * network or infer installation success from a completed download. */
export function pendingRestartVersion(storage: UpdateStorage, runningVersion: string): string | null {
  try {
    const raw = storage.getItem(UPDATE_RESTART_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw);
    if (record?.runningVersion === runningVersion && typeof record?.version === "string" && record.version.length > 0 && record.version !== runningVersion) return record.version;
    storage.removeItem(UPDATE_RESTART_KEY);
  } catch { /* Storage may be unavailable or damaged. */ }
  return null;
}

export function rememberInstalledUpdate(storage: UpdateStorage, runningVersion: string, version: string): void {
  if (version === runningVersion) return;
  try { storage.setItem(UPDATE_RESTART_KEY, JSON.stringify({ runningVersion, version })); } catch { /* The in-memory notice still works. */ }
}
