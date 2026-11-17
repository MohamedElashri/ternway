// Directory reports are emitted by the native Ghostty engine.
/** Parses an OSC 7 `file://host/path` report. */
export function parseDirectoryReport(data: string): { host: string; path: string } | null {
  const match = /^file:\/\/([^/]*)(\/.*)$/.exec(data);
  if (!match) return null;
  try {
    return { host: match[1], path: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}
