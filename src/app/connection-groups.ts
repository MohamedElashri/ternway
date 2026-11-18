// Presentation only; connection membership remains in SQLite.
export const collapsedGroups = new Set<string>();
try {
  const saved: unknown = JSON.parse(localStorage.getItem("collapsed-connection-groups") || "[]");
  if (Array.isArray(saved)) for (const key of saved) if (typeof key === "string") collapsedGroups.add(key);
} catch { /* A missing or corrupt preference must not prevent startup. */ }

export function rememberGroup(key: string, open: boolean): void {
  if (open) collapsedGroups.delete(key);
  else collapsedGroups.add(key);
  try { localStorage.setItem("collapsed-connection-groups", JSON.stringify([...collapsedGroups])); } catch { /* optional */ }
}

/** Reveal a moved connection or newly created subfolder, including collapsed ancestors. */
export function revealConnectionFolder(path: string): void {
  if (!path) collapsedGroups.delete("ungrouped");
  let current = "";
  for (const part of path.split("/").filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    collapsedGroups.delete(`folder:${current.toLowerCase()}`);
  }
  try { localStorage.setItem("collapsed-connection-groups", JSON.stringify([...collapsedGroups])); } catch { /* optional */ }
}

export function remapCollapsedFolders(source: string, destination: string | null): void {
  if (!source) return; // The permanent folder keeps its identity when renamed.
  const prefix = `folder:${source.toLowerCase()}`;
  for (const key of [...collapsedGroups]) {
    if (key !== prefix && !key.startsWith(`${prefix}/`)) continue;
    collapsedGroups.delete(key);
    if (destination !== null) collapsedGroups.add(`folder:${destination.toLowerCase()}${key.slice(prefix.length)}`);
  }
  try { localStorage.setItem("collapsed-connection-groups", JSON.stringify([...collapsedGroups])); } catch { /* optional */ }
}
