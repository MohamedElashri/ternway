import { icon } from "../icons.ts";
import { escapeHtml } from "./format.ts";

export interface TitlebarViewData {
  platform: string;
  /** What the active workspace is: the local machine or a server. */
  context?: { title: string; detail: string };
}

export function renderTitlebarView({ platform, context }: TitlebarViewData): string {
  if (platform === "linux" || platform === "macos") return "";
  return `<header class="titlebar" data-tauri-drag-region data-platform="${platform}">
    <div class="titlebar-brand"><span class="titlebar-mark">${icon("logo")}</span><span>Ternway</span></div>
    ${context ? `<div class="titlebar-caption"><div class="titlebar-context"><strong>${escapeHtml(context.title)}</strong><span>${escapeHtml(context.detail)}</span></div></div>` : ""}
    <div class="window-controls" aria-label="Window controls">
      <button class="window-control window-control-minimize" data-window="minimize" title="Minimize window" aria-label="Minimize window">${icon("minus")}</button>
      <button class="window-control window-control-maximize" data-window="maximize" title="Maximize window" aria-label="Maximize window">${icon("square")}</button>
      <button class="window-control window-control-close" data-window="close" title="Close window" aria-label="Close window">${icon("close")}</button>
    </div>
  </header>`;
}

export function renderLoadingView(): string {
  return `<main class="boot-screen" aria-busy="true"><div class="boot-card"><div class="brand-mark" aria-hidden="true"></div><h1>Opening Ternway…</h1><div class="loading-line" aria-hidden="true"><span></span></div></div></main>`;
}

export function renderWelcomeView(): string {
  return `<div class="welcome-page"><div class="brand-mark" aria-hidden="true"></div><h1>Open a terminal</h1><p class="welcome-copy">Start a local shell or add a connection to a remote machine.</p><div class="welcome-actions"><button class="button button-primary" data-action="open-local">${icon("terminalSmall")} Open local shell</button><button class="button button-quiet" data-action="add-server">${icon("plus")} New connection</button></div></div>`;
}

export function renderEmptyWorkspaceView(): string {
  return renderWelcomeView();
}

export function renderErrorView(error: string): string {
  return `<div class="error-state"><div class="error-icon">${icon("info")}</div><div><strong>Ternway couldn't complete that request</strong><p>${escapeHtml(error)}</p><button class="button button-quiet" data-action="retry">${icon("refresh")} Refresh this view</button></div></div>`;
}

export function renderInlineErrorView(error: string): string {
  return `<div class="inline-error" role="alert">${icon("info")}<span>${escapeHtml(error)}</span><button data-action="dismiss-error" aria-label="Dismiss error">${icon("close")}</button></div>`;
}

export function renderUnsupportedView(title: string, copy: string): string {
  return `<div class="unsupported"><div class="unsupported-art">${icon("shield")}</div><div class="eyebrow">Capability not detected</div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(copy)}</p><button class="button button-quiet" data-action="refresh">${icon("refresh")} Check again</button></div>`;
}
