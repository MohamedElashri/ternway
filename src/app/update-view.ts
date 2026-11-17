import { escapeHtml, formatBytes } from "./format.ts";
import type { UpdateState } from "./updates.ts";

export interface UpdateMetadata { version: string; updateUnsupportedReason: string }

export function updateStatus({ phase, version, downloaded, total }: UpdateState): string {
  switch (phase) {
    case "checking": return "Checking GitHub releases…";
    case "current": return "Ternway is up to date.";
    case "available": return `Ternway ${version ?? ""} is available.`;
    case "preparing": return "Preparing the update…";
    case "downloading": return total ? `Downloading… ${Math.min(100, Math.floor((downloaded / total) * 100))}% of ${formatBytes(total)}` : `Downloading… ${formatBytes(downloaded)}`;
    case "verifying": return "Download complete. Verifying the update signature…";
    case "installing": return "Installing… Approve the system authentication prompt if one appears. Keep Ternway open until installation finishes.";
    case "installed": return `Ternway ${version ?? ""} is ready. Restart to finish updating.`;
    case "restarting": return "Saving your windows and restarting…";
    default: return "";
  }
}

function steps(state: UpdateState): string {
  const current = ({ preparing: 0, downloading: 0, verifying: 1, installing: 2, installed: 3, restarting: 3 } as Partial<Record<UpdateState["phase"], number>>)[state.phase];
  if (current === undefined) return "";
  return `<ol class="update-steps" aria-label="Update progress">${["Download", "Verify", "Install", "Restart"].map((label, index) => `<li ${index === current ? 'aria-current="step"' : ""} class="${index < current ? "complete" : ""}">${label}</li>`).join("")}</ol>`;
}

export function renderUpdateNotice(state: UpdateState): string {
  if (!["preparing", "downloading", "verifying", "installing", "installed", "restarting", "error"].includes(state.phase)) return "";
  const ready = state.phase === "installed";
  return `<aside class="update-notice" aria-label="Software update"><span role="status">${escapeHtml(state.phase === "error" ? "Update needs attention. Open update details to retry." : ready ? updateStatus(state) : "Ternway update in progress…")}</span><button class="button ${ready ? "button-primary" : "button-quiet"}" type="button" data-action="${ready ? "restart-update" : "check-updates"}">${ready ? "Restart to finish" : "Update details"}</button></aside>`;
}

export function renderUpdateView(state: UpdateState, metadata: UpdateMetadata | null, metadataError: string, standalone = false): string {
  const { phase, notes, error, downloaded, total } = state;
  const busy = ["checking", "preparing", "downloading", "verifying", "installing", "restarting"].includes(phase);
  const running = metadata ? `Running version: ${escapeHtml(metadata.version)}.` : metadataError ? "Running version unavailable." : "Loading version…";
  const hint = metadataError || metadata?.updateUnsupportedReason || "";
  const releases = '<button class="button button-quiet" type="button" data-action="open-releases">View GitHub releases</button>';
  let actions = `<button class="button button-quiet" type="button" data-action="check-updates" ${busy ? "disabled" : ""}>${busy ? "Update in progress…" : phase === "error" ? "Try again" : "Check for updates"}</button>${releases}`;
  if (phase === "available") actions = hint ? `${metadataError ? '<button class="button button-quiet" type="button" data-action="check-updates">Try again</button>' : ""}${releases}` : `<button class="button button-primary" type="button" data-action="install-update" ${metadata ? "" : "disabled"}>Download and install</button>${releases}`;
  if (phase === "installed") actions = '<button class="button button-primary" type="button" data-action="restart-update">Restart to finish update</button>';
  const progress = phase === "downloading" ? `<progress class="update-progress" aria-label="Update download" ${total ? `max="${total}" value="${Math.min(downloaded, total)}"` : ""}></progress>` : "";
  return `<section class="settings-section settings-section-stacked update-section" data-update-section data-update-standalone="${standalone}" ${standalone ? 'aria-label="Update status"' : 'aria-labelledby="update-settings-title"'}><div class="settings-section-copy">${standalone ? "" : '<h3 id="update-settings-title">Updates</h3>'}<p class="update-version">${running}</p><p>Download, verify, install, then restart to use the new version.</p>${steps(state)}<p class="update-status" role="status" aria-live="polite">${escapeHtml(updateStatus(state))}</p>${progress}${phase === "available" && notes ? `<div class="update-release-notes"><h4>What’s new</h4><pre class="update-notes">${escapeHtml(notes)}</pre></div>` : ""}${hint ? `<p class="update-hint">${escapeHtml(hint)}</p>` : ""}${error ? `<div class="inline-error" role="alert"><span>${escapeHtml(error)}</span></div>` : ""}</div><div class="config-actions">${actions}</div>${phase === "installed" ? '<p class="update-restart-hint">You can keep working and restart later. Active terminal programs end when you restart.</p>' : phase === "available" && !hint ? '<p class="update-restart-hint">Installation needs system permission on Linux. You choose when to restart; active terminal programs end on restart.</p>' : ""}</section>`;
}
