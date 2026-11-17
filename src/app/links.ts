// File path links in terminal output, like iTerm2's semantic history: `src/main.rs:12:5`,
// `./build.sh`, `/etc/hosts`, `~/notes.md`. Candidates are checked against the file system
// before they become links, so ordinary words are never underlined.

export interface PathCandidate {
  /** The path as printed, without the line and column. */
  path: string;
  line?: number;
  column?: number;
  /** UTF-16 offsets of the whole match (path plus :line:column) in the text. */
  start: number;
  end: number;
}

const PATH_PATTERN = /(?:~|\.{1,2})?\/?(?:[\w.+@-]+\/)*[\w.+@-]+(?::(\d+))?(?::(\d+))?/g;

export function findPathCandidates(text: string): PathCandidate[] {
  const candidates: PathCandidate[] = [];
  for (const match of text.matchAll(PATH_PATTERN)) {
    const start = match.index ?? 0;
    const before = text.slice(0, start);
    // Part of a longer token or of a URL (handled by the URL links).
    if (/[\w/.~-]$/.test(before) || /\w+:\/\/\S*$/.test(before)) continue;
    const full = match[0];
    const path = full.replace(/(?::\d+){1,2}$/, "");
    const hasDirectory = path.includes("/");
    const hasExtension = /[^./]\.[A-Za-z][\w-]{0,15}$/.test(path);
    if (!hasDirectory && !hasExtension) continue;
    if (/^\d[\d.]*$/.test(path)) continue; // version numbers, IP fragments
    candidates.push({
      path,
      line: match[1] ? Number(match[1]) : undefined,
      column: match[2] ? Number(match[2]) : undefined,
      start,
      end: start + full.length,
    });
  }
  return candidates;
}

// Native terminal path link actions.

export interface PathLinkOptions {
  /** Directory relative paths are resolved against (the pane's OSC 7 directory). */
  cwd: () => string | undefined;
  /** Which candidates exist, as absolute paths (or null). */
  resolve: (base: string | undefined, paths: string[]) => Promise<(string | null)[]>;
  open: (path: string, line?: number, column?: number) => void;
}

/** Links open with Ctrl+click (Cmd+click on macOS), so plain clicks still select text. */
export const opensLink = (event: MouseEvent): boolean => event.ctrlKey || event.metaKey;
