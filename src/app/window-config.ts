import { invoke } from "@tauri-apps/api/core";
import type { TerminalConfig } from "./config";

export interface WindowMetrics { cellWidth: number; cellHeight: number; chromeWidth: number; chromeHeight: number; dark: boolean; defaultDecorations?: boolean }
export interface WindowConfigState {
  title: string | null; fullscreen: boolean | null; windowDecoration: boolean | null;
  windowTheme: TerminalConfig["windowTheme"]; windowWidth: number | null; windowHeight: number | null;
}
/** Only changed geometry is reapplied: saving an unrelated preference must not resize a window. */
export function windowSettings(config: TerminalConfig, previous: WindowConfigState | undefined, metrics: WindowMetrics): object {
  return {
    title: config.title ?? "Ternway",
    fullscreen: previous?.fullscreen === config.fullscreen ? null : config.fullscreen ?? (previous?.fullscreen !== undefined && previous.fullscreen !== null ? false : null),
    decorations: previous?.windowDecoration === config.windowDecoration ? null : config.windowDecoration ?? (previous?.windowDecoration !== undefined && previous.windowDecoration !== null ? metrics.defaultDecorations ?? true : null),
    theme: config.windowTheme === "auto" ? (metrics.dark ? "dark" : "light") : config.windowTheme,
    width: config.windowWidth !== null && previous?.windowWidth !== config.windowWidth ? Math.max(640, config.windowWidth * metrics.cellWidth + metrics.chromeWidth) : config.windowWidth === null && previous?.windowWidth != null ? 1200 : null,
    height: config.windowHeight !== null && previous?.windowHeight !== config.windowHeight ? Math.max(480, config.windowHeight * metrics.cellHeight + metrics.chromeHeight) : config.windowHeight === null && previous?.windowHeight != null ? 780 : null,
  };
}
/** Compute deltas after the previous IPC finishes, so a late old response cannot reset them. */
export class WindowConfigQueue {
  private previous: WindowConfigState | undefined;
  private pending: Promise<void> = Promise.resolve();
  private readonly apply: (settings: object) => Promise<void>;
  constructor(apply: (settings: object) => Promise<void>) { this.apply = apply; }
  enqueue(config: TerminalConfig, metrics: WindowMetrics): Promise<void> {
    const task = this.pending.then(async () => {
      await this.apply(windowSettings(config, this.previous, metrics));
      this.previous = { ...config };
    });
    this.pending = task.catch(() => undefined);
    return task;
  }
}
const windowConfigs = new WindowConfigQueue(settings => invoke("configure_terminal_window", { settings }));
export async function applyWindowConfig(config: TerminalConfig, fontSize: number, fontFamily: string, dark: boolean, defaultDecorations: boolean): Promise<void> {
  const context = document.createElement("canvas").getContext("2d");
  if (context) context.font = `${fontSize}px ${fontFamily}`;
  const sidebar = document.querySelector<HTMLElement>(".sidebar");
  await windowConfigs.enqueue(config, {
    cellWidth: context?.measureText("M").width ?? fontSize * .6,
    cellHeight: Math.ceil(fontSize * 1.25),
    chromeWidth: (sidebar?.getBoundingClientRect().width ?? 250) + 22,
    chromeHeight: 100,
    dark,
    defaultDecorations,
  });
}
