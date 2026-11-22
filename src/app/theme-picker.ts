import { THEME_PRESETS } from "./theme-presets.ts";
import { escapeHtml } from "./format.ts";
import { icon } from "../icons.ts";

export function renderThemePicker(selectedId: string): string {
  return `<section class="theme-picker" aria-labelledby="theme-picker-title">
    <div class="settings-row-copy"><h4 id="theme-picker-title">Color theme</h4><p>Applies to the workspace and the default terminal palette. Terminal config colors take priority.</p></div>
    <div class="theme-grid">
      ${(["light", "dark"] as const).map(mode => `<div class="theme-options" role="group" aria-label="${mode === "light" ? "Light themes" : "Dark themes"}">
        <h5>${mode === "light" ? "Light" : "Dark"}</h5>
        ${THEME_PRESETS.filter(theme => theme.mode === mode).map(({ id, name, terminal }) => `<button type="button" class="theme-card" data-action="select-color-theme" data-theme-id="${id}" aria-pressed="${id === selectedId}">
          <span class="theme-card-label">${name}${id === selectedId ? icon("check") : ""}</span>
          <span class="theme-card-preview" aria-hidden="true" style="--preview-bg:${escapeHtml(terminal.background)};--preview-ink:${escapeHtml(terminal.foreground)};--preview-prompt:${escapeHtml(terminal.brightBlue)}">
            <span><b>$</b> ssh server</span><span class="theme-swatches">${["red", "green", "yellow", "blue", "magenta", "cyan"].map(color => `<i style="background:${escapeHtml(terminal[color])}"></i>`).join("")}</span>
          </span>
        </button>`).join("")}
      </div>`).join("")}
    </div>
  </section>`;
}
