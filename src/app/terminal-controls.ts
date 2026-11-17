import { renderReconnectAction } from "./terminal-reconnect.ts";
import type { TerminalTab } from "../types.ts";
import { phaseLabels } from "./connection-lifecycle.ts";
import { escapeHtml } from "./format.ts";

/** Session actions stay alongside the tabs, leaving the terminal its full height. */
export function renderTerminalControls(current?: TerminalTab): string {
  if (!current) return "";
  const status = phaseLabels[current.phase ?? (current.closed ? "disconnected" : current.connecting ? "launching" : "ready")];
  return `<div class="terminal-session-controls" role="group" aria-label="Terminal session controls"><span class="terminal-session-status" role="status">${escapeHtml(status)}</span>${renderReconnectAction(current)}<button class="text-button terminal-session-action" data-action="clear-terminal" title="Clear terminal">Clear</button></div>`;
}
