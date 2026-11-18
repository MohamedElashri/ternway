import { applySidebarLayout, sidebarControls, sidebarSeparator } from "./sidebar-layout";
import { renderWorkspaceTab } from "./tab-view";
import { renderUpdateNotice } from "./update-view";
import { updates } from "./updater";
import { ConnectionList, ConnectionSearch } from "./connection-list";
import { folderPath, renderConnectionFolders } from "./connection-folders";
import { settingsFocusKey, restoreSettingsFocus } from "./settings-pages";

import { applyThemeTokens, themePreset } from "./theme-presets";
import { collapsedGroups } from "./connection-groups";
import { unavailableToolReason } from "./navigation";
import { icon } from "../icons";
import { AGENT_APPROVAL_HINT } from "./connection-lifecycle";
import type { ServerProfile } from "../types";
import { escapeHtml } from "./format";
import { profileRouteLabel, renderAppDialog, renderModal } from "./modals";
import { enhanceSelects } from "./select-controls";
import { focusModal, restoreConnectionForm } from "./modal-state";
import { activeCapabilities, activeDock, activeServer, activeServerIsConnected, activeTerminalGroup, activeTerminalGroups, connectedServerIds, dockShown, hasInteractiveSession, isLocalWorkspace, platform, quickMode, root, sidebarScrollPositions, state, viewScrollPositions } from "./state";
import { renderEmptyWorkspaceView, renderErrorView, renderInlineErrorView, renderLoadingView, renderTitlebarView, renderWelcomeView } from "./static-views";
import { groupTitle, mountTerminal } from "./terminal";
import { renderAppToast, renderTransferToast } from "./toasts";
import type { View } from "./types";
import { renderAccounts, renderAdministration, renderCommands, renderCron, renderNetwork, renderPackages, renderTunnels } from "./views/admin";
import { renderDisk } from "./views/disk";
import { renderDocker } from "./views/docker";
import { renderLogs } from "./views/logs";
import { groupExited, paneCount, renderDashboard, renderTabStrip, renderFiles, renderProcesses, renderServices, renderTerminal } from "./views/system";
import { scrollCommandResultsIntoView, scrollContainerLogsIntoView, viewTransitionIsCurrent } from "./workspace";

let tabSizeObserver: ResizeObserver | undefined;
let retainRail = false;
function revealActiveTabs(): void {
  root.querySelectorAll<HTMLElement>(".workspace-tabs .workspace-tab.active, .terminal-tab-list .term-tab.active").forEach(tab => tab.scrollIntoView({ block: "nearest", inline: "nearest" }));
}

export function render(): void {
  tabSizeObserver?.disconnect();
  const previousFocus = document.activeElement;
  const previousRail = !quickMode && !state.loading ? root.querySelector<HTMLElement>(".server-rail") : null;
  const settingsFocus = settingsFocusKey(previousFocus);
  const previousConnectionForm = root.querySelector<HTMLFormElement>('form[data-form="server"]');
  const previousImportForm = root.querySelector<HTMLFormElement>('form[data-form="ssh-import"]');
  const previousPasswordForm = root.querySelector<HTMLFormElement>('form[data-form="ssh-password"]');
  const settingsPanel = root.querySelector<HTMLElement>(".settings-content[data-settings-page-panel]");
  const settingsScroll = settingsPanel ? { page: settingsPanel.dataset.settingsPagePanel, top: settingsPanel.scrollTop } : undefined;
  const previousContent = root.querySelector<HTMLElement>(".dock-main") ?? root.querySelector<HTMLElement>(".content-area");
  const previousServerList = root.querySelector<HTMLElement>(".server-list");
  const previousNavigation = root.querySelector<HTMLElement>(".nav-section");
  if (previousContent && state.renderedLocation) viewScrollPositions.set(state.renderedLocation, previousContent.scrollTop);
  if (previousServerList) sidebarScrollPositions.servers = previousServerList.scrollTop;
  if (previousNavigation) sidebarScrollPositions.navigation = previousNavigation.scrollTop;
  const nextLocation = state.activeWorkspaceTabId ? `${state.activeWorkspaceTabId}:${state.activeView}` : "welcome";
  applyThemeTokens(document.documentElement, themePreset(state.themeId));
  root.dataset.theme = state.darkMode ? "dark" : "light";
  root.dataset.colorTheme = state.themeId;
  root.dataset.platform = platform;
  retainRail = Boolean(previousRail);
  root.innerHTML = quickMode ? renderQuickShell() : `${renderTitlebar()}${state.loading ? renderLoading() : renderShell()}`;
  retainRail = false;
  const railSlot = root.querySelector("[data-retained-rail]");
  if (previousRail && railSlot) {
    railSlot.replaceWith(previousRail);
    const search = previousRail.querySelector<HTMLInputElement>('[data-field="server-search"]');
    if (search && search.value !== state.serverQuery) search.value = state.serverQuery;
    const themeButton = previousRail.querySelector<HTMLButtonElement>('[data-action="theme"]');
    const label = state.darkMode ? "Switch to light appearance" : "Switch to dark appearance";
    if (themeButton && themeButton.title !== label) {
      themeButton.title = label; themeButton.setAttribute("aria-label", label);
      themeButton.innerHTML = icon(state.darkMode ? "sun" : "moon");
    }
    renderConnectionSidebar();
  }
  applySidebarLayout(root);
  restoreConnectionForm(root, previousConnectionForm);
  restoreConnectionForm(root, previousPasswordForm);
  restoreConnectionForm(root, previousImportForm);
  const nextSettings = root.querySelector<HTMLElement>(".settings-content[data-settings-page-panel]");
  if (nextSettings && settingsScroll && settingsScroll.page === nextSettings.dataset.settingsPagePanel) nextSettings.scrollTop = settingsScroll.top;
  const nextContent = root.querySelector<HTMLElement>(".dock-main") ?? root.querySelector<HTMLElement>(".content-area");
  const nextServerList = root.querySelector<HTMLElement>(".server-list");
  const nextNavigation = root.querySelector<HTMLElement>(".nav-section");
  if (nextContent) nextContent.scrollTop = viewScrollPositions.get(nextLocation) ?? 0;
  if (nextServerList) nextServerList.scrollTop = sidebarScrollPositions.servers;
  if (nextNavigation) nextNavigation.scrollTop = sidebarScrollPositions.navigation;
  if (state.shouldScrollToContainerLogs && nextContent) {
    window.setTimeout(() => {
      if (scrollContainerLogsIntoView()) state.shouldScrollToContainerLogs = false;
    }, 0);
  }
  if (state.shouldScrollToCommandResults && nextContent) {
    window.setTimeout(() => {
      if (scrollCommandResultsIntoView()) state.shouldScrollToCommandResults = false;
    }, 0);
  }
  revealActiveTabs();
  tabSizeObserver ??= new ResizeObserver(revealActiveTabs);
  root.querySelectorAll(".workspace-tabs, .terminal-tab-list").forEach(list => tabSizeObserver!.observe(list));
  enhanceSelects(root);
  state.renderedLocation = nextLocation;
  mountTerminal();
  if (!state.modal && !state.appDialogPrompt && previousFocus instanceof HTMLInputElement && previousRail?.contains(previousFocus)) previousFocus.focus({ preventScroll: true });
  focusModal(root, previousFocus);
  restoreSettingsFocus(root, settingsFocus);
}

/** Organization changes must not rebuild terminals, dialogs, or the active tool view. */
let sidebarRenderDeferred = false;
const connectionLists = new WeakMap<HTMLElement, ConnectionList>();
const noFolderPaths: string[] = [];
export function renderConnectionSidebar(focus?: string): void {
  if (root.dataset.sidebarDragging) {
    if (!sidebarRenderDeferred) {
      sidebarRenderDeferred = true;
      root.addEventListener("sidebar-drag-ended", () => { sidebarRenderDeferred = false; renderConnectionSidebar(); }, { once: true });
    }
    return;
  }
  const list = root.querySelector<HTMLElement>(".server-list");
  if (!list) return;
  const active = document.activeElement as HTMLElement | null;
  const requestedFocus = focus;
  const retainedFocus = active && list.contains(active) ? active : null;
  if (!focus && active && list.contains(active)) {
    const server = active.closest<HTMLElement>("[data-server-id]");
    const folder = active.closest<HTMLElement>("[data-action=folder-actions]");
    if (server) focus = `.server-item[data-server-id="${CSS.escape(server.dataset.serverId!)}"]`;
    else if (folder) focus = `[data-action="folder-actions"][data-folder="${CSS.escape(folder.dataset.folder ?? "")}"]`;
  }
  const scroll = list.scrollTop;
  const servers = filteredServers();
  let controller = connectionLists.get(list);
  if (!controller) { controller = new ConnectionList(list); connectionLists.set(list, controller); }
  controller.update(state.snapshot.servers, servers, {
    paths: state.snapshot.connectionFolders ?? noFolderPaths,
    collapsed: collapsedGroups,
    searching: Boolean(state.serverQuery.trim()),
    defaultName: state.snapshot.defaultConnectionFolder,
    order: state.snapshot.connectionFolderOrder,
    menuFolder: state.folderMenuPath,
  }, renderServerItem, connectionRowRevision);
  list.scrollTop = scroll;
  if (!requestedFocus && retainedFocus?.isConnected) {
    if (document.activeElement !== retainedFocus) retainedFocus.focus({ preventScroll: true });
  } else if (focus) list.querySelector<HTMLElement>(focus)?.focus({ preventScroll: true });
}

function activeGroupTitle(): string | undefined {
  const group = activeTerminalGroup();
  return group ? groupTitle(group) : undefined;
}

export function renderTitlebar(): string {
  const server = activeServer();
  const context = isLocalWorkspace()
    ? { title: "Local", detail: activeGroupTitle() ?? "shell" }
    : server ? { title: server.name, detail: server.host } : undefined;
  return renderTitlebarView({ platform, context });
}

export function renderLoading(): string {
  return renderLoadingView();
}

/** The quick terminal window: just the local terminal, plus dialogs and toasts. */
function renderQuickShell(): string {
  return `<div class="quick-shell"><section class="content-area content-area-local">${state.loading ? "" : renderTerminal()}</section></div>${state.appDialogPrompt ? renderAppDialog() : ""}${state.appToast ? renderAppToast() : ""}`;
}

export function renderShell(): string {
  return `<div class="app-shell ${(isLocalWorkspace() || !state.activeServerId) ? "no-sidebar" : ""}">
    ${renderServerRail()}
    ${isLocalWorkspace() || !state.activeServerId ? "" : renderSidebar()}
    <main class="main-area">
      ${renderTabBar()}
      <div class="update-notice-host" data-update-notice>${renderUpdateNotice(updates.state)}</div>
      ${isLocalWorkspace()
        ? `<section class="content-area content-area-local">${state.errorMessage ? `<div class="local-error">${renderInlineError()}</div>` : ""}${renderTerminal()}</section>`
        : dockShown()
          ? `<section class="content-area content-area-docked">${renderDockLayout()}</section>`
          : `<section class="content-area${state.activeServerId && state.activeView === "terminal" ? " content-area-terminal" : ""}">${state.activeServerId ? renderConnectedContent() : state.snapshot.servers.length ? renderEmptyWorkspace() : renderWelcome()}</section>`}
    </main>
  </div>${renderOperationBanner()}${state.modal ? renderModal() : ""}${state.appDialogPrompt ? renderAppDialog() : ""}${state.transfer && !state.transfer.done ? renderTransferToast() : ""}${state.appToast ? renderAppToast() : ""}`;
}

export function renderOperationBanner(): string {
  if (!state.activeOperation) return "";
  const server = state.activeOperation.serverId ? state.snapshot.servers.find((item) => item.id === state.activeOperation?.serverId) : activeServer();
  return `<div class="operation-banner" role="status" aria-live="polite"><span class="operation-spinner"></span><div class="operation-copy"><strong>${escapeHtml(state.activeOperation.label)}</strong><span>${escapeHtml(server?.host ? `SSH can take a moment on ${server.host}. Your workspace is still available.` : "Your workspace is still available while this finishes.")}</span></div><button class="operation-cancel" data-action="cancel-operation">Cancel</button></div>`;
}

const connectionSearch = new ConnectionSearch();
export function filteredServers(): ServerProfile[] {
  const servers = connectionSearch.filter(state.snapshot.servers, state.snapshot.connectionOrder, state.serverQuery);
  if (state.sidebarCopyPlacement) {
    const sourceIndex = servers.findIndex((server) => server.id === state.sidebarCopyPlacement?.sourceId);
    const copyIndex = servers.findIndex((server) => server.id === state.sidebarCopyPlacement?.copyId);
    if (sourceIndex >= 0 && copyIndex >= 0 && groupKey(servers[sourceIndex].groupName) === groupKey(servers[copyIndex].groupName)) {
      const [copy] = servers.splice(copyIndex, 1);
      servers.splice(copyIndex < sourceIndex ? sourceIndex : sourceIndex + 1, 0, copy);
    }
  }
  return servers;
}

export function normalizedGroupName(groupName?: string): string {
  return folderPath(groupName);
}

export function groupKey(groupName?: string): string {
  const path = normalizedGroupName(groupName);
  return path ? `folder:${path.toLowerCase()}` : "ungrouped";
}

export function renderServerGroups(servers: ServerProfile[]): string {
  return renderConnectionFolders(servers, state.snapshot.connectionFolders ?? [], collapsedGroups, Boolean(state.serverQuery.trim()), renderServerItem, { defaultName: state.snapshot.defaultConnectionFolder, order: state.snapshot.connectionFolderOrder, menuFolder: state.folderMenuPath });
}

export function shortGroupLabel(group: string): string {
  return group.length <= 4 ? group : `${group.slice(0, 4)}...`;
}

export function renderServerRail(): string {
  if (retainRail) return '<aside data-retained-rail></aside>';
  const servers = filteredServers();
  const query = state.serverQuery.trim().toLowerCase();
  return `<aside class="server-rail" id="connections-sidebar" data-sidebar="connections" aria-label="Connections">
    ${sidebarControls("connections")}
    <div class="compact-library" data-sidebar-compact hidden>
      <button class="icon-button" type="button" data-sidebar-search aria-label="Search connections" title="Search connections">${icon("search")}</button>
      <button class="icon-button" type="button" data-action="add-server" aria-label="New connection" title="New connection">${icon("plus")}</button>
      <button class="icon-button" type="button" data-action="credential-settings" aria-label="Settings" title="Settings">${icon("settings")}</button>
    </div>
    <div class="server-rail-flyout" data-sidebar-expanded>
      ${platform === "linux" ? "" : `<div class="rail-brand"><span class="brand-mark">${icon("logo")}</span><span class="rail-brand-name">Ternway</span></div>`}
      <div class="sidebar-section server-section">
        <div class="section-label-row"><span class="section-label">Connections</span><span class="connection-drag-hint" title="Drag connections to reorder or move between folders. Alt+↑/↓ moves the focused item.">Drag to organize</span></div>
        <label class="sidebar-search"><span>${icon("search")}</span><input data-field="server-search" value="${escapeHtml(state.serverQuery)}" placeholder="Search connections…" aria-label="Search connections and notes"/><kbd>${platform === "macos" ? "⌘" : "Ctrl"} K</kbd></label>
        <div class="server-list">
          ${servers.length || !query ? renderServerGroups(servers) : `<div class="server-empty">${query ? "No matching connections" : "Add your first SSH connection"}</div>`}
        </div>
      </div>
      <div class="rail-utilities">
        <button class="icon-button" data-action="credential-settings" aria-label="Settings" title="Settings">${icon("settings")}</button>
        <button class="icon-button" data-action="theme" aria-label="${state.darkMode ? "Switch to light appearance" : "Switch to dark appearance"}" title="${state.darkMode ? "Switch to light appearance" : "Switch to dark appearance"}">${icon(state.darkMode ? "sun" : "moon")}</button>
      </div>
      <div class="server-rail-foot">
        <button class="button button-quiet library-add" data-action="import-ssh-config">Import SSH config</button><button class="button button-primary library-add" data-action="add-server">${icon("plus")} New connection</button>
      </div>
    </div>
    ${sidebarSeparator("connections")}
  </aside>`;
}

export function renderSidebar(): string {
  if (activeServer()?.authMethod === "openSsh") {
    const ready = connectedServerIds.has(activeServer()!.id);
    const shared = activeServer()!.openSsh?.shareConnection !== false;
    return `<aside class="sidebar" id="tools-sidebar" data-sidebar="tools" aria-label="Connection tools">${sidebarControls("tools")}<div class="sidebar-section nav-section"><div class="section-label">OpenSSH connection</div>${[["terminal", "Terminal", "terminal"], ["files", "Files", "files"], ["tunnels", "SSH tunnels", "network"]].map(([view, label, glyph]) => `<button class="nav-item ${state.activeView === view ? "active" : ""}" data-view="${view}" aria-label="${label}" title="${label}" ${view !== "terminal" && !ready ? "disabled" : ""}>${icon(glyph as Parameters<typeof icon>[0])}<span>${label}</span></button>`).join("")}<p class="field-hint" data-sidebar-expanded>${!shared ? "Enable connection sharing in the connection editor to use files and tunnels." : ready ? "Terminal, files and tunnels share this authenticated connection." : "Authenticate in the terminal to enable files and tunnels."}</p></div>${renderSidebarBottom()}${sidebarSeparator("tools")}</aside>`;
  }
  const nav = [
    ["terminal", "Terminal", "terminal"],
    ["files", "Files", "files"],
    ["dashboard", "Overview", "dashboard"],
    ["processes", "Processes", "processes"],
    ["services", "Systemd services", "services"],
    ["disk", "Disk usage", "disk"],
    ["docker", "Container platform", "docker"],
    ["logs", "Logs", "logs"],
    ["network", "Network sockets", "network"],
    ["cron", "Cron jobs", "cron"],
    ["packages", "Packages", "packages"],
    ["accounts", "Users & groups", "users"],
    ["commands", "Saved commands", "terminalSmall"],
    ["tunnels", "SSH tunnels", "network"],
    ["administration", "Administration", "settings"],
  ] as const;
  const unsupported = (view: View): boolean => Boolean(unavailableToolReason(view, activeCapabilities(), activeServer()?.authMethod));
  return `<aside class="sidebar" id="tools-sidebar" data-sidebar="tools" aria-label="Connection tools">${sidebarControls("tools")}
    <div class="sidebar-section nav-section"><div class="section-label">Connection tools</div>${nav.map(([view, label, iconName]) => `<button class="nav-item ${state.activeView === view ? "active" : ""}" data-view="${view}" title="${unavailableToolReason(view, activeCapabilities(), activeServer()?.authMethod) ?? label}" aria-label="${label}" ${!activeServerIsConnected() || unsupported(view) ? "disabled" : ""}>${icon(iconName)}<span>${label}</span>${unsupported(view) ? `<small>Unavailable</small>` : ""}</button>`).join("")}</div>
    ${renderSidebarBottom()}
    ${sidebarSeparator("tools")}
  </aside>`;
}

function renderSidebarBottom(): string {
  return `<div class="sidebar-bottom">
      <button class="utility-link" data-action="credential-settings" aria-label="Settings" title="Settings">${icon("settings")}<span>Settings</span></button>
    </div>`;
}

function rowConnected(server: ServerProfile): boolean {
  return connectedServerIds.has(server.id) || state.terminalTabs.some(tab => tab.serverId === server.id && Boolean(tab.sessionId) && !tab.closed && !tab.connecting && (server.authMethod !== "openSsh" || tab.phase === "ready"));
}
function connectionRowRevision(server: ServerProfile): string {
  return JSON.stringify([server.name, server.host, server.username, server.authMethod, server.openSsh?.alias, server.favorite, server.id === state.activeServerId, rowConnected(server)]);
}

export function renderServerItem(server: ServerProfile): string {
  const initials = server.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  const connected = rowConnected(server);
  const tooltip = `${server.name}\n${server.host}`;
  return `<div class="server-item ${server.id === state.activeServerId ? "active" : ""}" data-server-id="${escapeHtml(server.id)}" data-connection-revision="${escapeHtml(connectionRowRevision(server))}" role="button" tabindex="0" aria-label="Open ${escapeHtml(server.name)} at ${escapeHtml(server.host)}" title="${escapeHtml(tooltip)}">
    <span class="server-avatar">${escapeHtml(initials)}</span><span class="server-item-copy"><strong>${server.favorite ? `${icon("star")} ` : ""}${escapeHtml(server.name)}</strong><small>${server.authMethod === "openSsh" ? `OpenSSH · ${escapeHtml(server.openSsh?.alias || server.host)}` : `${escapeHtml(server.username)}@${escapeHtml(server.host)}`}</small></span><span class="server-item-actions"><button class="server-action" data-server-action="new-tab" data-server-id="${escapeHtml(server.id)}" aria-label="Open another ${escapeHtml(server.name)} workspace" title="Open another workspace">${icon("plus")}</button><button class="server-action" data-server-action="duplicate" data-server-id="${escapeHtml(server.id)}" aria-label="Duplicate ${escapeHtml(server.name)}" title="Duplicate server">${icon("copy")}</button><button class="server-action" data-server-action="edit" data-server-id="${escapeHtml(server.id)}" aria-label="Edit ${escapeHtml(server.name)}" title="Edit connection">${icon("edit")}</button><button class="server-action server-action-delete" data-server-action="delete" data-server-id="${escapeHtml(server.id)}" aria-label="Delete ${escapeHtml(server.name)}" title="Delete server">${icon("trash")}</button></span><span class="connection-dot ${connected ? "online" : ""}" title="${connected ? "Connected" : "Idle or awaiting authentication"}"></span>
  </div>`;
}

export function renderTabBar(): string {
  const remote = state.openServerTabs.map(tab => {
    const server = state.snapshot.servers.find(server => server.id === tab.serverId);
    return server ? renderWorkspaceTab({ id: tab.id, label: tab.label || server.name, active: tab.id === state.activeWorkspaceTabId, status: connectedServerIds.has(server.id) || hasInteractiveSession(server.id) ? "online" : undefined }) : "";
  }).join("");
  const local = state.localWorkspaceOpen ? renderWorkspaceTab({ id: "local", label: "Local", active: isLocalWorkspace(), local: true, status: state.terminalTabs.some(tab => tab.workspaceTabId === "local" && !tab.closed) ? "online" : undefined }) : "";
  return `<div class="workspace-tabbar"><button class="workspace-launcher" type="button" data-action="workspace-library" title="Saved workspaces" aria-label="Saved workspaces">${icon("dashboard")}</button><div class="workspace-tabs" role="tablist" aria-label="Open workspaces">${local}${remote}</div>${!state.localWorkspaceOpen ? `<button class="workspace-launcher" type="button" data-action="open-local" aria-label="New local terminal" title="New local terminal">${icon("terminalSmall")}</button>` : ""}${state.activeServerId && activeServerIsConnected() ? `<button class="workspace-disconnect" type="button" data-action="disconnect" title="Disconnect from server" aria-label="Disconnect from server">${icon("network")}<span>Disconnect</span></button>` : ""}</div>`;
}

export function renderWelcome(): string {
  return renderWelcomeView();
}

export function renderEmptyWorkspace(): string {
  return renderEmptyWorkspaceView();
}

/** The current server view with the server's terminals docked beside it (terminal.ts mounts them). */
function renderDockLayout(): string {
  const dock = activeDock()!;
  const controls = `<button class="term-tab-new" data-action="dock-position" title="Dock ${dock.position === "right" ? "below" : "on the right"}" aria-label="Move the terminal dock">${icon(dock.position === "right" ? "chevron" : "terminalSmall")}</button><button class="term-tab-new" data-action="toggle-dock" title="Hide terminals" aria-label="Hide terminals">${icon("close")}</button>`;
  return `<div class="dock-layout dock-${dock.position}" style="--dock-ratio: ${dock.ratio}"><div class="dock-main">${renderConnectedContent()}</div><div class="dock-divider" data-dock-divider role="separator" aria-orientation="${dock.position === "right" ? "vertical" : "horizontal"}"></div><section class="terminal-dock">${renderTabStrip(controls)}<div class="terminal-surface" data-terminal-surface></div></section></div>`;
}

export function renderConnectedContent(): string {
  const server = activeServer();
  if (!server) return renderWelcome();
  if (state.activeView === "terminal") return renderView();
  const titles: Record<Exclude<View, "terminal">, [string, string]> = {
    dashboard: ["Overview", "A clear read on how this machine is doing."],
    processes: ["Processes", "See what is using the machine right now."],
    services: ["Systemd services", "Keep systemd units healthy and moving."],
    files: ["Files", "Browse, edit, and move files over SFTP."],
    disk: ["Disk usage", "Find what is consuming space before it becomes an outage."],
    docker: ["Container platform", "Runtime resources and Compose applications in one place."],
    logs: ["System logs", "The recent story behind what is happening."],
    network: ["Network sockets", "Listening ports and active connections."],
    cron: ["Cron jobs", "Scheduled commands for this server."],
    packages: ["Packages", "Installed software and pending APT upgrades."],
    accounts: ["Users & groups", "Linux identities, access, and membership."],
    administration: ["Administration", "Firewall, SSH access, security posture, and maintenance."],
    commands: ["Saved commands", "Reusable commands for this server or your whole workspace."],
    tunnels: ["SSH tunnels", "Local, remote, and SOCKS5 forwarding managed by Ternway."],
  };
  const [title, subtitle] = titles[state.activeView];
  const snapshotNotice = state.activeView === "dashboard"
    ? `<span class="overview-snapshot-note">${icon("info")} Snapshot metrics · not live</span>`
    : "";
  return `<div class="page-head"><div><div class="eyebrow">${escapeHtml(server.name)} <span class="eyebrow-separator">/</span> ${title}</div><h1>${title}</h1><p>${escapeHtml(subtitle)}</p></div><div class="page-actions">${snapshotNotice}<button class="button button-quiet ${dockShown() ? "active" : ""}" data-action="toggle-dock" title="Terminals beside this view (Ctrl+\`)">${icon("terminalSmall")} Terminal</button><button class="button button-quiet" data-action="refresh">${icon("refresh")} Refresh</button></div></div>${renderView()}`;
}

export function renderView(): string {
  if (viewTransitionIsCurrent()) return renderViewLoading();
  if (state.activeView === "dashboard" && !state.activeOperation && !state.dashboard && !activeServerIsConnected()) return `${state.errorMessage ? renderInlineError() : ""}${renderConnectPrompt()}`;
  if (state.errorMessage && state.activeView !== "dashboard") return `${renderError()}${renderViewBody()}`;
  return `${state.errorMessage ? renderInlineError() : ""}${renderViewBody()}`;
}

export function renderConnectPrompt(): string {
  const server = activeServer();
  if (!server) return renderWelcome();
  const bastion = state.snapshot.servers.find((candidate) => candidate.id === server.jumpHostId);
  const route = bastion
    ? ` The connection routes through ${escapeHtml(profileRouteLabel(bastion))}.`
    : "";
  return `<div class="connect-prompt"><div class="connect-prompt-art">${icon("shield")}</div><div class="eyebrow">Connection is idle</div><h2>Ready when you are.</h2><p>Choose Connect to open an SSH session with ${escapeHtml(server.host)}. Ternway reads saved credentials only when connecting.${route}</p><button class="button button-primary" data-action="connect">${icon("play")} Connect to ${escapeHtml(server.name)}</button></div>`;
}

export function renderViewBody(): string {
  switch (state.activeView) {
    case "dashboard": return renderDashboard();
    case "terminal": return renderTerminal();
    case "processes": return renderProcesses();
    case "services": return renderServices();
    case "files": return renderFiles();
    case "disk": return renderDisk();
    case "docker": return renderDocker();
    case "logs": return renderLogs();
    case "network": return renderNetwork();
    case "cron": return renderCron();
    case "packages": return renderPackages();
    case "accounts": return renderAccounts();
    case "administration": return renderAdministration();
    case "commands": return renderCommands();
    case "tunnels": return renderTunnels();
  }
}

export function renderViewLoading(): string {
  const server = activeServer();
  const firstConnection = !activeServerIsConnected();
  const title = state.activeOperation?.label ?? (firstConnection ? "Establishing a secure connection…" : "Loading this view…");
  const detail = firstConnection
    ? `Connecting to ${server?.host ?? "the server"} and reading its overview. ${server?.authMethod === "sshAgent" ? AGENT_APPROVAL_HINT : "SSH can take a moment on the first connection."}`
    : `Reading fresh information from ${server?.host ?? "the server"}. You can switch views or cancel at any time.`;
  return `<div class="view-loading" role="status" aria-live="polite" aria-busy="true"><div class="view-loading-card"><div class="view-loading-mark"><div class="spinner"></div>${icon("logo")}</div><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(detail)}</p></div></div><div class="view-loading-skeleton" aria-hidden="true"><span></span><span></span><span></span><span></span></div></div>`;
}

export function renderError(): string {
  return renderErrorView(state.errorMessage);
}

export function renderInlineError(): string {
  return renderInlineErrorView(state.errorMessage);
}
