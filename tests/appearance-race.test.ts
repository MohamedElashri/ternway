import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { JSDOM } from "jsdom";
import * as themes from "../src/app/theme-presets.ts";
import * as config from "../src/app/config.ts";

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/** Load the actual application modules with only their desktop/DOM boundaries replaced. */
function fixture() {
  const dom = new JSDOM('<main id="app"></main>', { url: 'https://ternway.test' });
  const storage = dom.window.localStorage;
  themes.rememberTheme(storage, themes.themePreset('github-dark-dimmed'));
  const state = { themeId: 'github-dark-dimmed', darkMode: true, interfaceScale: 1,
    terminalConfig: { config: structuredClone(config.DEFAULT_CONFIG), profiles: new Map(), errors: [] } };
  const root = dom.window.document.querySelector<HTMLElement>('main')!;
  const writes: { value: string; finish: ReturnType<typeof deferred> }[] = [];
  const reads: string[] = [], renders: string[] = [];
  let savedTheme = state.themeId;
  const invoke = async (command: string, args?: { updates: { values: string[] }[] }) => {
    if (command === 'load_config') {
      reads.push(savedTheme);
      return { path: 'fixture', revision: String(writes.length), includes: [], errors: [], profiles: [],
        entries: [{ file: 'fixture', line: 1, key: 'app-theme', value: savedTheme }] };
    }
    if (command === 'save_config_settings') {
      const write = { value: args!.updates[0].values[0], finish: deferred() };
      writes.push(write);
      await write.finish.promise;
      savedTheme = write.value;
      return;
    }
    throw Error(`Unexpected IPC: ${command}`);
  };
  const dependencies: Record<string, unknown> = {
    './theme-presets': themes, './config': config, '@tauri-apps/api/core': { invoke },
    './state': { state, root, platform: 'linux', quickMode: true },
    './render': { render: () => { renders.push(state.themeId); root.dataset.colorTheme = state.themeId; } },
    './command-client': { errorText: String },
    './keybindings': { LINUX_DEFAULTS: [], MACOS_DEFAULTS: [], parseKeybindings: () => [], quickTerminalShortcut: () => '' },
    './terminal': { applyTerminalAppearance: () => {} },
    './toasts': { setInterfaceScale: async () => {}, waitForInterfaceScaleChanges: async () => {}, showToast: () => {} },
    './sidebar-layout': { configureSidebarLayout: () => {} },
    './window-config': { applyWindowConfig: async () => {} }, './updater': { configureAutomaticUpdates: () => {} },
  };
  function load(name: string): Record<string, (...args: any[]) => Promise<void>> {
    const source = readFileSync(new URL(`../src/app/${name}.ts`, import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const module = { exports: {} };
    runInNewContext(compiled, { module, exports: module.exports, localStorage: storage,
      window: dom.window, document: dom.window.document, console,
      require: (id: string) => { assert.ok(id in dependencies, `Unexpected import: ${id}`); return dependencies[id]; } }, { filename: name });
    return module.exports;
  }
  const terminal = load('terminal-config');
  dependencies['./terminal-config'] = terminal;
  const appearance = load('appearance');
  return { dom, state, root, writes, reads, renders, storage, terminal, appearance, savedTheme: () => savedTheme };
}

test('two immediate theme toggles return to the original variant while their writes remain pending', async () => {
  const f = fixture();
  try {
    const first = f.appearance.toggleColorTheme();
    assert.equal(f.state.themeId, 'github-light');
    const second = f.appearance.toggleColorTheme();
    assert.equal(f.state.themeId, 'github-dark-dimmed');
    assert.deepEqual(f.renders, ['github-light', 'github-dark-dimmed']);
    await tick();
    assert.equal(f.writes.length, 1);
    const watcher = f.terminal.loadTerminalConfig();
    await tick();
    assert.equal(f.reads.length, 1, 'watcher must not read the intermediate saved preference');
    f.writes[0].finish.resolve();
    await tick();
    assert.equal(f.writes.length, 2);
    assert.equal(f.storage.getItem(themes.THEME_STORAGE_KEY), 'github-dark-dimmed', 'intermediate light choice must not publish a cross-window storage event');
    assert.equal(f.state.themeId, 'github-dark-dimmed');
    f.writes[1].finish.resolve();
    await Promise.all([first, second, watcher]);
    assert.equal(f.savedTheme(), 'github-dark-dimmed');
    assert.equal(f.state.themeId, 'github-dark-dimmed');
    assert.equal(f.root.dataset.colorTheme, 'github-dark-dimmed');
  } finally { f.dom.window.close(); }
});

test('a failed latest theme choice rolls back to the preceding successful write', async () => {
  const f = fixture();
  try {
    const first = f.appearance.setColorTheme('github-light');
    const failed = f.appearance.setColorTheme('dracula');
    const rejection = assert.rejects(failed, /disk unavailable/);
    await tick();
    f.writes[0].finish.resolve();
    await tick();
    f.writes[1].finish.reject(Error('disk unavailable'));
    await Promise.all([first, rejection]);
    assert.equal(f.savedTheme(), 'github-light');
    assert.equal(f.state.themeId, 'github-light');
    assert.equal(f.state.darkMode, false);
    assert.equal(f.state.terminalConfig.config.appTheme, 'github-light');
    assert.equal(f.storage.getItem(themes.THEME_STORAGE_KEY), 'github-light');
  } finally { f.dom.window.close(); }
});

test('a superseded failed write cannot roll back a newer optimistic theme', async () => {
  const f = fixture();
  try {
    const failed = f.appearance.setColorTheme('github-light');
    const rejection = assert.rejects(failed, /disk unavailable/);
    const latest = f.appearance.setColorTheme('dracula');
    await tick();
    f.writes[0].finish.reject(Error('disk unavailable'));
    await tick();
    assert.equal(f.state.themeId, 'dracula');
    f.writes[1].finish.resolve();
    await Promise.all([rejection, latest]);
    assert.equal(f.savedTheme(), 'dracula');
    assert.equal(f.state.themeId, 'dracula');
  } finally { f.dom.window.close(); }
});
