import { icon } from "../icons.ts";
import type { TerminalTab } from "../types.ts";

export function renderReconnectAction(tab: TerminalTab): string {
  return `<button class="text-button terminal-session-action" data-action="reconnect-terminal" title="Open a fresh session in this pane" ${tab.connecting ? "disabled" : ""}>${icon("restart")} ${tab.phase === "dormant" ? "Start session" : "Reconnect"}</button>`;
}

interface ReconnectEffects {
  close: (sessionId: string) => Promise<unknown>;
  replace: () => Promise<void>;
  present: () => void;
  exists: () => boolean;
}

const pending = new WeakSet<TerminalTab>();

/** One explicit restart per pane. Never replay a command or retry a failed close. */
export async function reconnectSession(tab: TerminalTab, effects: ReconnectEffects): Promise<void> {
  if (tab.connecting || pending.has(tab)) return;
  pending.add(tab);
  const wasClosed = tab.closed;
  tab.connecting = true;
  tab.closed = true; // Ignore late output/exit notifications from the retired session.
  effects.present();
  try {
    if (tab.sessionId) await effects.close(tab.sessionId);
    if (effects.exists()) await effects.replace();
  } catch (error) {
    tab.closed = wasClosed;
    throw error;
  } finally {
    pending.delete(tab);
    tab.connecting = false;
    if (effects.exists()) effects.present();
  }
}
