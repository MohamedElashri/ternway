import { rowText, type GhosttyCell } from "./ghostty-renderer.ts";
const previousRows = new WeakMap<HTMLElement, GhosttyCell[][]>();
/** Stable log rows avoid rebuilding the accessibility tree on every cursor/output frame. */
export function syncTerminalRows(root: HTMLElement, rows: GhosttyCell[][]): void {
  const previous = previousRows.get(root);
  while (root.children.length > rows.length) root.lastElementChild!.remove();
  for (let index = 0; index < rows.length; index++) {
    let line = root.children[index];
    const existing = Boolean(line);
    if (!line) { line = root.ownerDocument.createElement("div"); root.append(line); }
    if (existing && previous?.[index] === rows[index]) continue;
    const text = rowText(rows[index]).trimEnd();
    if (line.textContent !== text) line.textContent = text;
  }
  previousRows.set(root, rows);
}
