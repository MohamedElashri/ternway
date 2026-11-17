# Built-in color themes

GitHub Dark and GitHub Light are Ternway's default dark/light palettes. Settings → Appearance
also offers GitHub Dark Dimmed, Dark/Light High Contrast, Dark/Light Colorblind, and the previous
Dracula palette. A theme changes both the workspace chrome and the fallback terminal colors.

The light/dark shortcut remembers the last selected preset in each mode. Preferences survive
restarts and update other open windows. Existing light/dark preferences migrate automatically.
Terminal config files and profile colors take priority. Built-in theme names can be used in
`theme = GitHub Dark`, including `theme = light:GitHub Light,dark:GitHub Dark`; a user theme file
with the same name still wins.

## Sources and licenses

GitHub palettes and ANSI colors are adapted from [GitHub's official VS Code themes](https://github.com/primer/github-vscode-theme)
and the exact [Primer Primitives 7.10.0](https://www.npmjs.com/package/@primer/primitives/v/7.10.0)
palettes pinned by that repository. GitHub Dark/Light include the foreground/accent overrides
in the official theme's `src/colors.js`. `src/app/theme-data.json` contains the selected values,
so using these presets requires no download or runtime dependency.

Ternway maps Primer's semantic colors to its interface tokens. Muted interface text is adjusted
toward the main foreground where necessary to reach 4.5:1 contrast on its surfaces.
Primary button text uses a contrasting foreground as well. Terminal
ANSI values are kept as published. The existing Dracula palette is retained from Ternway.

The upstream MIT notices are bundled in `licenses/GitHub-Theme-MIT.txt` and
`licenses/Primer-Primitives-MIT.txt`, and are available in About Ternway.
