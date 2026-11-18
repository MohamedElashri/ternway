// The Updates section of Settings, driving UpdateController with the updater plugin.
import { invoke } from "@tauri-apps/api/core";

import { check } from "@tauri-apps/plugin-updater";
import { root, appWindow } from "./state";
import type { TerminalConfig } from "./config";
import { UpdateController } from "./updates";
import { BRAND } from "./brand";
import { renderUpdateNotice, renderUpdateView, type UpdateMetadata } from "./update-view";
import { pendingRestartVersion, rememberInstalledUpdate, UPDATE_RESTART_KEY } from "./update-restart";

export const RELEASES_URL = BRAND.releases;

let metadata: UpdateMetadata | null = null;
let metadataError = "";

/** Re-renders only the Updates section, so download progress does not rebuild the whole app. */
function refreshSection(): void {
  if (updates.state.phase === "installed" && metadata && updates.state.version) rememberInstalledUpdate(localStorage, metadata.version, updates.state.version);
  const focused = document.activeElement as HTMLElement | null;
  const focusAction = focused?.closest("[data-update-section], [data-update-notice]") ? focused.dataset.action : undefined;
  const notice = root.querySelector<HTMLElement>("[data-update-notice]");
  if (notice) notice.innerHTML = renderUpdateNotice(updates.state);
  const section = root.querySelector<HTMLElement>("[data-update-section]");
  if (section) {
    const notesScroll = section.querySelector<HTMLElement>(".update-notes")?.scrollTop;
    const standalone = section.dataset.updateStandalone === "true";
    section.outerHTML = renderUpdateSection(standalone);
    const notes = root.querySelector<HTMLElement>(".update-notes");
    if (notes && notesScroll !== undefined) notes.scrollTop = notesScroll;
  }
  if (focusAction) root.querySelector<HTMLElement>(`[data-update-section] [data-action="${focusAction}"], [data-update-notice] [data-action="${focusAction}"]`)?.focus({ preventScroll: true });
}

function restoreRestartNotice(): void {
  if (!metadata) return;
  const version = pendingRestartVersion(localStorage, metadata.version);
  if (version) updates.restoreInstalled(version);
}

async function loadMetadata(): Promise<void> {
  try {
    metadata = await invoke<UpdateMetadata>("app_metadata");
    metadataError = "";
    restoreRestartNotice();
  } catch {
    metadata = null;
    metadataError = "Installation details are unavailable. Check again to retry.";
  }
  refreshSection();
}

export const updates = new UpdateController(() => check({ timeout: 20_000 }), async () => {
  await invoke("request_app_restart");
}, refreshSection, async () => {
  await loadMetadata();
  if (!metadata) throw new Error(metadataError);
  if (metadata.updateUnsupportedReason) throw new Error(metadata.updateUnsupportedReason);
});

void loadMetadata();
window.addEventListener("storage", event => {
  if (event.key === UPDATE_RESTART_KEY) restoreRestartNotice();
});

export async function checkForUpdates(): Promise<void> {
  await Promise.all([loadMetadata(), updates.checkNow()]);
  restoreRestartNotice();
}

export function renderUpdateSection(standalone = false): string {
  return renderUpdateView(updates.state, metadata, metadataError, standalone);
}

let automaticMode: TerminalConfig["autoUpdate"] = "off";
let automaticTimer: number | undefined;
let automaticGeneration = 0;
/** Automatic downloads are verified but installation and restart remain explicit actions. */
export function configureAutomaticUpdates(config: TerminalConfig): void {
  if (appWindow.label !== "main" || automaticMode === config.autoUpdate) return;
  automaticMode = config.autoUpdate;
  const generation = ++automaticGeneration;
  window.clearTimeout(automaticTimer);
  if (automaticMode === "off") return;
  const run = async (): Promise<void> => {
    const mode = automaticMode;
    if (mode === "off") return;
    await loadMetadata();
    if (automaticMode !== mode) return;
    if (metadata && !metadata.updateUnsupportedReason && !updates.busy && updates.state.phase !== "installed") {
      await updates.checkNow();
      if (automaticMode === "download") await updates.downloadAvailable();
    }
    if (generation === automaticGeneration) automaticTimer = window.setTimeout(() => { void run(); }, 6 * 60 * 60 * 1000);
  };
  automaticTimer = window.setTimeout(() => { void run(); }, 1000);
}
