import { invoke } from "@tauri-apps/api/core";
import type { TerminalConfig } from "./config";

export interface WindowConfigState {
  title: string | null; fullscreen: boolean | null; windowDecoration: boolean | null;
  windowTheme: TerminalConfig["windowTheme"]; windowWidth: number | null; windowHeight: number | null;
}
/** Only changed geometry is reapplied: saving an unrelated preference must not resize a window. */
export function windowSettings(config: TerminalConfig, previous: WindowConfigState | undefined, metrics: { cellWidth: number; cellHeight: number; chromeWidth: number; chromeHeight: number; dark: boolean; defaultDecorations?: boolean }): object {
  return {
    title: config.title ?? "Ternway",
    fullscreen: previous?.fullscreen === config.fullscreen ? null : config.fullscreen ?? (previous?.fullscreen !== undefined && previous.fullscreen !== null ? false : null),
    decorations: previous?.windowDecoration === config.windowDecoration ? null : config.windowDecoration ?? (previous?.windowDecoration !== undefined && previous.windowDecoration !== null ? metrics.defaultDecorations ?? true : null),
    theme: config.windowTheme === "auto" ? (metrics.dark ? "dark" : "light") : config.windowTheme,
    width: config.windowWidth !== null && previous?.windowWidth !== config.windowWidth ? Math.max(640, config.windowWidth * metrics.cellWidth + metrics.chromeWidth) : config.windowWidth === null && previous?.windowWidth != null ? 1200 : null,
    height: config.windowHeight !== null && previous?.windowHeight !== config.windowHeight ? Math.max(480, config.windowHeight * metrics.cellHeight + metrics.chromeHeight) : config.windowHeight === null && previous?.windowHeight != null ? 780 : null,
  };
}
let previous: WindowConfigState | undefined;
export async function applyWindowConfig(config: TerminalConfig, fontSize: number, fontFamily: string, dark: boolean): Promise<void> {
  const context = document.createElement("canvas").getContext("2d");
  if (context) context.font = `${fontSize}px ${fontFamily}`;
  const sidebar = document.querySelector<HTMLElement>(".sidebar");
  const settings = windowSettings(config, previous, {
    cellWidth: context?.measureText("M").width ?? fontSize * .6,
    cellHeight: Math.ceil(fontSize * 1.25),
    chromeWidth: (sidebar?.getBoundingClientRect().width ?? 250) + 22,
    chromeHeight: 100,
    dark,
    defaultDecorations: /linux/i.test(navigator.platform || navigator.userAgent),
  });
  await invoke("configure_terminal_window", { settings });
  previous = { ...config };
}
