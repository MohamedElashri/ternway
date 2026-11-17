import { icon } from "../icons.ts";
import { escapeHtml } from "./format.ts";

interface TabView {
  id: string;
  label: string;
  active: boolean;
  status?: "online" | "closed" | "saved";
  local?: boolean;
  paneId?: string;
  details?: string;
}

export function renderWorkspaceTab(tab: TabView): string {
  const label = escapeHtml(tab.label), id = escapeHtml(tab.id);
  return `<div class="workspace-tab ${tab.local ? "workspace-tab-local" : ""} ${tab.active ? "active" : ""}" data-workspace-tab="${id}" ${tab.local ? 'data-workspace-fixed data-action="open-local"' : ""} role="tab" tabindex="${tab.active ? 0 : -1}" aria-selected="${tab.active}" title="${label}${tab.local ? "" : " · Double-click or F2 to rename"}"><span class="tab-symbol ${tab.status ?? ""}" aria-hidden="true">${icon("terminalSmall")}</span><span class="workspace-tab-copy">${label}</span><button type="button" class="workspace-tab-action workspace-tab-close" data-workspace-tab-action data-workspace-close="${id}" tabindex="-1" aria-label="Close ${tab.local ? "local workspace" : `${label} workspace`}" title="Close workspace">${icon("close")}</button></div>`;
}

export function renderTerminalTab(tab: TabView): string {
  const label = escapeHtml(tab.label);
  return `<div class="term-tab ${tab.active ? "active" : ""}" role="tab" tabindex="${tab.active ? 0 : -1}" aria-selected="${tab.active}" data-terminal-tab="${escapeHtml(tab.paneId)}" data-tab-group="${escapeHtml(tab.id)}" title="${label} · Double-click or F2 to rename"><span class="tab-symbol ${tab.status ?? "online"}" aria-hidden="true">${icon("terminalSmall")}</span><span class="term-tab-title">${label}</span>${tab.details ?? ""}<button type="button" class="term-tab-close" data-terminal-close="${escapeHtml(tab.id)}" tabindex="-1" aria-label="Close ${label}" title="Close terminal tab">${icon("close")}</button></div>`;
}

export interface TabNavigation {
  select(id: string): Promise<unknown> | void;
  close(id: string): Promise<unknown> | void;
  rename(id: string): Promise<unknown> | void;
}

/** Roving focus follows the visible order after drag-reordering. */
export function installTabNavigation(root: HTMLElement, kind: "workspace" | "terminal", actions: TabNavigation): void {
  const selector = kind === "workspace" ? ".workspace-tab[data-workspace-tab]" : ".term-tab[data-tab-group]";
  const id = (tab: HTMLElement) => kind === "workspace" ? tab.dataset.workspaceTab! : tab.dataset.tabGroup!;
  root.addEventListener("keydown", event => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>(selector);
    if (!tab || (event.target as HTMLElement).closest("button") || event.altKey || event.ctrlKey || event.metaKey) return;
    const tabs = [...root.querySelectorAll<HTMLElement>(selector)];
    let next: HTMLElement | undefined;
    if (event.key === "ArrowRight") next = tabs[(tabs.indexOf(tab) + 1) % tabs.length];
    else if (event.key === "ArrowLeft") next = tabs[(tabs.indexOf(tab) - 1 + tabs.length) % tabs.length];
    else if (event.key === "Home") next = tabs[0];
    else if (event.key === "End") next = tabs.at(-1);
    else if (event.key === "Delete") { event.preventDefault(); event.stopImmediatePropagation(); void actions.close(id(tab)); return; }
    else if (event.key === "F2" && !tab.hasAttribute("data-workspace-fixed")) { event.preventDefault(); event.stopImmediatePropagation(); void actions.rename(id(tab)); return; }
    else if (event.key === "Enter" || event.key === " ") next = tab;
    if (!next) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const targetId = id(next);
    void Promise.resolve(actions.select(targetId)).then(() => [...root.querySelectorAll<HTMLElement>(selector)].find(element => id(element) === targetId)?.focus({ preventScroll: true }));
  }, true);
  if (kind === "workspace") root.addEventListener("dblclick", event => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>(selector);
    if (tab && !tab.hasAttribute("data-workspace-fixed") && !(event.target as HTMLElement).closest("button")) void actions.rename(id(tab));
  });
}
