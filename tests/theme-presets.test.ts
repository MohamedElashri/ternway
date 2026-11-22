import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { DEFAULT_THEME, terminalTheme } from "../src/app/config.ts";
import { THEME_PRESETS, THEME_STORAGE_KEY, applyThemeTokens, findTheme, namedTheme, oppositeTheme, rememberTheme, restoredTheme, themePreset } from "../src/app/theme-presets.ts";
import { renderThemePicker } from "../src/app/theme-picker.ts";

function contrast(a: string, b: string): number {
  const lum = (hex: string) => [1,3,5].map(i => parseInt(hex.slice(i,i+2),16)/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4).reduce((sum,v,i) => sum+v*[.2126,.7152,.0722][i],0);
  const [dark,light] = [lum(a),lum(b)].sort((x,y)=>x-y); return (light+.05)/(dark+.05);
}
const store = (entries: Record<string,string> = {}) => {
  const values = new Map(Object.entries(entries));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key,value); } };
};

test("GitHub Dark and Light are the defaults", () => {
  assert.equal(restoredTheme(store()).id, "github-dark");
  assert.equal(restoredTheme(store({"ternway-theme":"light"})).id, "github-light");
  assert.equal(DEFAULT_THEME.background, "#0d1117");
  assert.equal(DEFAULT_THEME.foreground, "#e6edf3");
  assert.equal(themePreset("github-light").terminal.background, "#ffffff");
  assert.equal(themePreset("github-dark").terminal.red, "#ff7b72");
  assert.equal(namedTheme("GitHub Dark")?.id, "github-dark");
  assert.equal(findTheme("unknown"), undefined);
});

test("all light ANSI colors remain legible on the default terminal background", () => {
  for (const theme of THEME_PRESETS.filter(theme => theme.mode === "light")) {
    const threshold = theme.id.includes("high-contrast") ? 7 : 4.5;
    for (const color of ["black","red","green","yellow","blue","magenta","cyan","white"]) {
      for (const key of [color, `bright${color[0].toUpperCase()}${color.slice(1)}`]) {
        assert.ok(contrast(String(theme.terminal[key]), theme.terminal.background!) >= threshold, `${theme.id}: ${key}`);
      }
    }
  }
});

test("all presets have complete terminal palettes, readable text and readable primary buttons", () => {
  const tokens = Object.keys(THEME_PRESETS[0].chrome).sort();
  assert.equal(THEME_PRESETS.length, 8);
  assert.equal(new Set(THEME_PRESETS.map(theme=>theme.id)).size, THEME_PRESETS.length);
  for (const theme of THEME_PRESETS) {
    assert.deepEqual(Object.keys(theme.chrome).sort(), tokens);
    for (const color of ["black","red","green","yellow","blue","magenta","cyan","white"]) {
      assert.match(String(theme.terminal[color]), /^#[0-9a-f]{6}$/i);
      assert.match(String(theme.terminal[`bright${color[0].toUpperCase()}${color.slice(1)}`]), /^#[0-9a-f]{6}$/i);
    }
    for (const background of ["paper","canvas","canvas-deep"]) {
      for (const text of ["ink","muted","faint"]) assert.ok(contrast(theme.chrome[text],theme.chrome[background])>=4.5, `${theme.id}: ${text} on ${background}`);
    }
    assert.ok(contrast(theme.chrome["on-accent"],theme.chrome.accent)>=4.5, `${theme.id}: button contrast`);
  }
});

test("preset preferences survive restoration and light/dark switches retain the chosen variants", () => {
  const storage = store(); const preset = themePreset("github-dark-dimmed");
  rememberTheme(storage,preset);
  assert.equal(restoredTheme(storage).id,preset.id);
  const light = oppositeTheme(preset); rememberTheme(storage,light);
  assert.equal(oppositeTheme(light,storage.getItem("ternway-last-dark-theme")).id,preset.id);
  assert.equal(oppositeTheme(themePreset("github-dark-high-contrast")).id,"github-light-high-contrast");
  assert.equal(restoredTheme(store({[THEME_STORAGE_KEY]:"invalid", "ternway-theme":"light"})).id,"github-light");
  assert.equal(restoredTheme({getItem:()=>{throw Error("denied");}}).id,"github-dark");
  assert.doesNotThrow(()=>rememberTheme({setItem:()=>{throw Error("full");}},preset));
});

test("terminal config and profile colors keep priority over the selected workspace preset", () => {
  const base = themePreset("github-light").terminal;
  const configured = terminalTheme(base,{background:"#123456",palette:{1:"#abcdef"}});
  assert.equal(configured.background,"#123456"); assert.equal(configured.red,"#abcdef");
  assert.equal(base.background,"#ffffff");
});

test("picker identifies the selected preset and applies all interface tokens", () => {
  const dom = new JSDOM(`<main>${renderThemePicker("github-light")}</main>`);
  const root=dom.window.document.querySelector("main")!;
  assert.equal(root.querySelectorAll('.theme-card').length,8);
  assert.equal(root.querySelectorAll('[aria-pressed="true"]').length,1);
  assert.equal((root.querySelector('[aria-pressed="true"]') as HTMLElement).dataset.themeId,"github-light");
  applyThemeTokens(root,themePreset("github-light"));
  assert.equal(root.style.getPropertyValue("--paper"),"#ffffff");
  assert.equal(root.style.colorScheme,"light");
  applyThemeTokens(root,themePreset("github-dark"));
  assert.equal(root.style.getPropertyValue("--paper"),"#0d1117");
  assert.equal(root.style.colorScheme,"dark");
  dom.window.close();
});
