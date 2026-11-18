import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { SidebarLayout, sidebarControls, sidebarSeparator, sidebarWidths, type SidebarLayoutConfig } from "../src/app/sidebar-layout.ts";
import { DEFAULT_CONFIG, parseConfig } from "../src/app/config.ts";
import { renderConfigFields, updatesFromFields } from "../src/app/config-settings.ts";

const defaults: SidebarLayoutConfig = { sidebarWidth: 260, sidebarCollapsed: false, toolsSidebarWidth: 190, toolsSidebarCollapsed: false };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(persist?: (key: string, value: string) => Promise<void>) {
  const dom = new JSDOM(`<div id="app"><div class="app-shell"><aside class="server-rail" data-sidebar="connections">${sidebarControls('connections')}<div data-sidebar-expanded><input data-field="server-search"/><div class="server-list"><button>Server</button></div></div><div data-sidebar-compact hidden><button data-sidebar-search>Search</button><button data-action="add-server">New connection</button><button>Settings</button></div>${sidebarSeparator('connections')}</aside><aside class="sidebar" data-sidebar="tools">${sidebarControls('tools')}<div class="nav-section"><button data-view="terminal" aria-label="Terminal">Terminal</button></div>${sidebarSeparator('tools')}</aside><main class="content-area"><div class="terminal-host"><canvas></canvas></div><input value="draft"/></main></div></div>`);
  const root = dom.window.document.querySelector<HTMLElement>('#app')!;
  let viewport = 1200, capture: number | undefined;
  Object.defineProperty(root.querySelector('.app-shell'), 'clientWidth', { get: () => viewport });
  root.setPointerCapture = id => { capture = id; }; root.hasPointerCapture = id => capture === id; root.releasePointerCapture = () => { capture = undefined; };
  const writes: [string, string][] = [], errors: unknown[] = [];
  const layout = new SidebarLayout(root, { persist: async (key, value) => { writes.push([key, value]); await persist?.(key, value); }, error: error => { errors.push(error); } });
  layout.setConfig(defaults);
  const handle = (id = 'connections') => root.querySelector<HTMLElement>(`[data-sidebar-resize="${id}"]`)!;
  const pointer = (name: string, target: Element | Window, x: number, id = 1) => {
    const event = new dom.window.Event(name, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: id, button: 0, isPrimary: true, clientX: x }); target.dispatchEvent(event);
  };
  const key = (name: string, value: string, id = 'connections') => handle(id).dispatchEvent(new dom.window.KeyboardEvent(name, { key: value, bubbles: true, cancelable: true }));
  const click = (selector: string) => root.querySelector<HTMLElement>(selector)!.click();
  return { dom, root, layout, writes, errors, pointer, key, click, handle, capture: () => capture, viewport: (value: number) => { viewport = value; layout.sync(); } };
}

test('independent collapse/expand retains content DOM, draft, scroll and accessible compact actions', async () => {
  const f = fixture();
  const terminal = f.root.querySelector('.terminal-host'), content = f.root.querySelector<HTMLElement>('.content-area')!, list = f.root.querySelector<HTMLElement>('.server-list')!;
  content.scrollTop = 125; list.scrollTop = 88;
  f.root.querySelector<HTMLInputElement>('[data-field="server-search"]')!.focus();
  f.layout.toggle('connections');
  assert.equal(f.root.querySelector('[data-sidebar-expanded]')!.hasAttribute('hidden'), true);
  assert.equal(f.root.querySelector('[data-sidebar-toggle="connections"]')!.getAttribute('aria-expanded'), 'false');
  assert.equal(f.dom.window.document.activeElement, f.root.querySelector('[data-sidebar-toggle="connections"]'));
  assert.equal(f.handle().tabIndex, -1); assert.equal(f.handle().hidden, true);
  assert.equal(f.root.querySelector('[data-sidebar-compact]')!.hasAttribute('hidden'), false);
  assert.ok(f.root.querySelector('[data-sidebar-compact] [data-action="add-server"]'));
  assert.equal(f.layout.preferences.tools.collapsed, false);
  f.layout.toggle('tools');
  assert.equal(f.root.querySelector('[data-view="terminal"]')!.getAttribute('aria-label'), 'Terminal');
  f.click('[data-sidebar-search]');
  assert.equal(f.layout.preferences.connections.collapsed, false);
  assert.equal(f.dom.window.document.activeElement, f.root.querySelector('[data-field="server-search"]'));
  assert.equal(f.layout.preferences.tools.collapsed, true);
  assert.equal(f.root.querySelector('.terminal-host'), terminal); assert.equal(content.scrollTop, 125); assert.equal(list.scrollTop, 88);
  assert.equal(content.querySelector('input')!.value, 'draft');
  await tick(); assert.deepEqual(f.writes, [['sidebar-collapsed', 'true'], ['tools-sidebar-collapsed', 'true'], ['sidebar-collapsed', 'false']]); f.dom.window.close();
});

test('pointer resizing writes once on release, keeps capture on stable root, and applies matching ARIA range', () => {
  const f = fixture(), terminal = f.root.querySelector('.terminal-host');
  f.pointer('pointerdown', f.handle(), 260); f.pointer('pointermove', f.root, 320); f.pointer('pointermove', f.root, 350);
  assert.equal(f.capture(), 1); assert.equal(f.layout.preferences.connections.width, 350); assert.deepEqual(f.writes, []);
  assert.equal(f.handle().getAttribute('aria-valuenow'), '350'); assert.equal(f.handle().getAttribute('aria-valuemax'), '600');
  f.pointer('pointerup', f.dom.window, 350); f.pointer('pointerup', f.dom.window, 350);
  assert.deepEqual(f.writes, [['sidebar-width', '350']]); assert.equal(f.capture(), undefined);
  assert.equal(f.root.querySelector('.terminal-host'), terminal);
  f.pointer('pointerdown', f.handle('tools'), 540); f.pointer('pointermove', f.root, 590); f.pointer('pointerup', f.root, 590);
  assert.equal(f.layout.preferences.tools.width, 240); assert.equal(f.layout.preferences.connections.width, 350);
  assert.deepEqual(f.writes.at(-1), ['tools-sidebar-width', '240']); f.dom.window.close();
});

test('Escape, pointer cancel, capture loss and window blur roll back without persistence', () => {
  for (const cancellation of ['Escape', 'pointercancel', 'lostpointercapture', 'blur']) {
    const f = fixture(); f.pointer('pointerdown', f.handle(), 260); f.pointer('pointermove', f.root, 400);
    if (cancellation === 'Escape') f.key('keydown', 'Escape');
    else if (cancellation === 'blur') f.dom.window.dispatchEvent(new f.dom.window.Event('blur'));
    else f.pointer(cancellation, f.root, 400);
    assert.equal(f.layout.preferences.connections.width, 260, cancellation); assert.deepEqual(f.writes, []); assert.equal(f.capture(), undefined);
    f.pointer('pointerup', f.root, 400); assert.deepEqual(f.writes, []); f.dom.window.close();
  }
});

test('keyboard repeat commits at keyup, Home/End clamp, blur cancels, and GUI/double-click reset widths', () => {
  const f = fixture();
  f.key('keydown', 'ArrowRight'); f.key('keydown', 'ArrowRight'); assert.deepEqual(f.writes, []);
  f.key('keyup', 'ArrowRight'); assert.deepEqual(f.writes, [['sidebar-width', '280']]);
  f.key('keydown', 'Home', 'tools'); f.key('keyup', 'Home', 'tools'); assert.equal(f.layout.preferences.tools.width, 140);
  f.key('keydown', 'End', 'tools'); f.key('keyup', 'End', 'tools'); assert.equal(f.layout.preferences.tools.width, 400);
  f.key('keydown', 'ArrowLeft', 'tools'); f.dom.window.dispatchEvent(new f.dom.window.Event('blur')); assert.equal(f.layout.preferences.tools.width, 400);
  f.click('[data-sidebar-reset="tools"]'); assert.equal(f.layout.preferences.tools.width, 190);
  f.handle().dispatchEvent(new f.dom.window.MouseEvent('dblclick', { bubbles: true })); assert.equal(f.layout.preferences.connections.width, 260);
  assert.deepEqual(f.writes.at(-1), ['sidebar-width', '260']); f.dom.window.close();
});

test('live config changes cannot clobber a gesture or a pending commit; persisted reload adopts both preferences', async () => {
  let finish!: () => void; const pending = new Promise<void>(resolve => { finish = resolve; });
  const f = fixture(() => pending);
  f.pointer('pointerdown', f.handle(), 260); f.pointer('pointermove', f.root, 330);
  f.layout.setConfig({ ...defaults, sidebarWidth: 180, toolsSidebarCollapsed: true });
  assert.equal(f.layout.preferences.connections.width, 330); assert.equal(f.layout.preferences.tools.collapsed, true);
  f.pointer('pointerup', f.root, 330); f.layout.setConfig(defaults);
  assert.equal(f.layout.preferences.connections.width, 330, 'stale watcher while save is pending');
  finish(); await tick();
  f.layout.setConfig({ ...defaults, sidebarWidth: 330, sidebarCollapsed: true });
  assert.deepEqual(f.layout.preferences.connections, { width: 330, collapsed: true }); f.dom.window.close();
});

test('a failed commit restores the last durable width and reports the error', async () => {
  const f = fixture(async () => { throw Error('disk unavailable'); });
  f.key('keydown', 'ArrowRight'); f.key('keyup', 'ArrowRight'); await tick();
  assert.equal(f.layout.preferences.connections.width, 260); assert.match(String(f.errors[0]), /disk unavailable/); f.dom.window.close();
});

test('both sidebars fit at 640px, widths recover when enlarged, collapsed track stays fixed, local-only layout uses one track', () => {
  const f = fixture(); f.layout.setConfig({ ...defaults, sidebarWidth: 600, toolsSidebarWidth: 400 });
  f.viewport(640); const shell = f.root.querySelector<HTMLElement>('.app-shell')!;
  const connections = Number.parseFloat(shell.style.getPropertyValue('--connections-width')), tools = Number.parseFloat(shell.style.getPropertyValue('--tools-width'));
  assert.ok(connections >= 160 && tools >= 140); assert.ok(640 - connections - tools >= 320);
  assert.ok(Math.abs(Number(f.handle().getAttribute('aria-valuemax')) - connections) <= 1);
  f.pointer('pointerdown', f.handle(), connections); f.pointer('pointermove', f.root, 2000); f.pointer('pointerup', f.root, 2000);
  assert.ok(f.layout.preferences.connections.width <= connections + 1);
  f.layout.toggle('tools'); assert.equal(shell.style.getPropertyValue('--tools-width'), '48px');
  f.viewport(1600); assert.equal(shell.style.getPropertyValue('--tools-width'), '48px');
  assert.deepEqual(sidebarWidths({ connections: { width: 600, collapsed: false }, tools: { width: 400, collapsed: false } }, 1600, true), { connections: 600, tools: 400 });
  assert.deepEqual(sidebarWidths({ connections: { width: 260, collapsed: false }, tools: { width: 190, collapsed: false } }, 640, false), { connections: 260, tools: 0 });
  assert.deepEqual(sidebarWidths({ connections: { width: 260, collapsed: false }, tools: { width: 190, collapsed: false } }, 480, true), { connections: 48, tools: 48 });
  f.dom.window.close();
});

test('sidebar GUI values round-trip to the main config and are disabled in profiles', () => {
  const fields: [string, string][] = [['sidebar-width', '310'], ['sidebar-collapsed', 'true'], ['tools-sidebar-width', '220'], ['tools-sidebar-collapsed', 'true']];
  const updates = updatesFromFields(fields, DEFAULT_CONFIG);
  const parsed = parseConfig(updates.flatMap(update => update.values.map(value => ({ key: update.key, value, file: 'test', line: 1 }))));
  assert.deepEqual(parsed.errors, []); assert.equal(parsed.config.sidebarWidth, 310); assert.equal(parsed.config.toolsSidebarWidth, 220); assert.equal(parsed.config.sidebarCollapsed, true); assert.equal(parsed.config.toolsSidebarCollapsed, true);
  for (const [key, value] of [['sidebar-width', '159'], ['sidebar-width', '601'], ['tools-sidebar-width', '139'], ['tools-sidebar-width', '401'], ['sidebar-collapsed', 'yes']]) assert.throws(() => updatesFromFields([[key, value]], DEFAULT_CONFIG));
  const dom = new JSDOM(renderConfigFields(parsed.config, undefined, true));
  for (const [key] of fields) assert.equal(dom.window.document.querySelector<HTMLInputElement>(`[data-config-key="${key}"]`)!.disabled, true);
  dom.window.close();
});
