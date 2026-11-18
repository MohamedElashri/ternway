# Ternway user guide

## What it does

- Opens a local shell on launch: your login shell on a real PTY, with xterm.js and WebGL rendering.
- Connects to servers with password or private-key authentication, including SSH config import and
  bastion (ProxyJump-style) routes.
- Stores passwords, key passphrases and sudo credentials in an encrypted local vault protected by a
  master password.
- Verifies SSH host keys against `known_hosts`, showing fingerprints before trusting a new or changed key.
- Shows CPU, memory, disks, network interfaces, uptime and load.
- Manages processes, systemd services, logs, listening ports and active connections.
- Browses and edits files over SFTP, including uploads, downloads, permissions, ownership and
  recursive transfers.
- Explores disk usage, inode pressure, large files and directories, Docker storage and `/var/log`.
- Works with Docker and Podman containers, images, volumes, networks, logs, statistics and exec shells,
  and with Docker Compose projects.
- Manages crontabs, APT packages, users and groups, SSH authorized keys, and UFW or firewalld rules.
- Saves commands, keeps local server notes, and runs local, remote or SOCKS5 SSH tunnels.

Remote features detect what each server supports instead of assuming a distribution or init system.

## Organizing connections

Drag connections to change their order or drop them onto a folder heading to move them.
Drag folder headings to reorder folders at the same level. The default folder stays first.
With a connection or folder focused, **Alt+↑/↓** moves it using the keyboard.

Use **+** beside a folder heading to create a folder or subfolder. Click a folder’s name for
**Rename** and **Delete folder**. The permanent default folder can be renamed and cannot be
deleted. New connections go there unless you choose another folder; deleting a folder moves
its connections and its subfolders’ connections back to the default folder.

Empty folders are kept. Existing groups appear as folders automatically. Names, membership and
ordering are saved across restarts, shared between windows and included in library backups.

## Workspaces and tabs

Close any local terminal with its **×**, including the last one. Ternway leaves an empty terminal
workspace until you choose **New terminal**. The **×** on the **Local** workspace closes all its
local tabs and splits, with confirmation when jobs are running. Reopen it using the local-terminal
control in the workspace bar or **Local shells** in the command palette. Saved layouts remember
when Local is closed.

Workspace and terminal tabs use the same spacing and close controls. Use **←/→**, **Home** and
**End** when a tab has keyboard focus to navigate, **Delete** to close it, or **F2** to rename a
remote workspace or terminal tab. Double-clicking its title also opens rename. Drag tabs to
reorder them; Local stays first among workspaces.

The terminal engine is **xterm.js 6**, with Rust managing PTYs and SSH. Ghostty-style configuration
and keybindings are supported; Ghostty itself is not embedded.

## Keybindings

Ghostty's defaults on Linux and iTerm2's on macOS. Every other key goes to the shell.

| Action | Linux | macOS |
|---|---|---|
| Copy / paste | Ctrl+Shift+C / Ctrl+Shift+V | Cmd+C / Cmd+V |
| New tab | Ctrl+Shift+T | Cmd+T |
| Close pane | Ctrl+Shift+W | Cmd+W |
| Split right / down | Ctrl+Shift+O / Ctrl+Shift+E | Cmd+D / Cmd+Shift+D |
| Move between panes | Ctrl+Alt+Arrows | Cmd+Option+Arrows |
| Zoom pane | Ctrl+Shift+Enter | Cmd+Shift+Enter |
| Next / previous tab | Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+PgDn / Ctrl+PgUp | Cmd+Shift+] / Cmd+Shift+[ |
| Go to tab 1–8, last | Alt+1…8, Alt+9 | Cmd+1…8, Cmd+9 |
| Font size | Ctrl+= / Ctrl+- / Ctrl+0 | Cmd+= / Cmd+- / Cmd+0 |
| Select all | Ctrl+Shift+A | Cmd+A |
| Clear | | Cmd+K |
| Find in scrollback | Ctrl+Shift+F | Cmd+F |
| Command palette | Ctrl+Shift+P | Cmd+Shift+P, Cmd+Shift+O |
| Reload config | Ctrl+Shift+, | Cmd+Shift+, |
| Previous / next prompt | Ctrl+Shift+PgUp / Ctrl+Shift+PgDn | Cmd+Shift+↑ / Cmd+Shift+↓ |
| Copy last command's output | (palette) | Cmd+Shift+A |
| Broadcast input to all panes of the tab | Ctrl+Shift+Alt+I | Cmd+Option+I |
| Paste history | Ctrl+Shift+H | Cmd+Shift+H |
| Complete word from the pane's output | Ctrl+Shift+; | Cmd+; |

Pasting text with line breaks asks first unless the program enabled bracketed paste.

Ctrl+click (Cmd+click on macOS) opens URLs, and file paths printed in local panes, such as
`src/main.rs:12:5` from a compiler, in your editor at that line: terminal editors in a split, GUI
editors (VS Code, Zed, …) in their own window. Only paths that exist become links.

Dropping files on a local pane types their quoted paths; dropping them on an SSH pane uploads them
to that pane's directory (or the home directory) after asking. In a server's Network view, the
button on a listening TCP port forwards it to `localhost` in one click. Saved commands appear in the
command palette and are typed into the focused pane for you to run.
Bindings can be changed with `keybind =` lines in the config.

Use **Reconnect** in the remote terminal bar to open a fresh session in the focused pane,
including when the current connection is still running. The tab and split layout stay in place;
previous commands are not replayed. The button is disabled while a session is opening.

## Terminals beside server views

In a server's Files, Logs, Docker or any other view, `Ctrl+\`` (or the **Terminal** button in the
page header) docks that server's terminals beside the view, on the right or at the bottom, with
their tabs and splits. Drag the divider to resize. Views keep one set of state per server, so one
view at a time shares the screen with the terminals.

## Quick terminal

A drop-down terminal (Ghostty's quick terminal, iTerm2's hotkey window) with local shells. Give it
a global hotkey in the config, as in Ghostty:

```
keybind = global:super+grave_accent=toggle_quick_terminal
quick-terminal-position = top        # bottom, left, right, center
quick-terminal-size = 40%            # or 40%,1200px or 600px
quick-terminal-autohide = true       # hide when it loses focus
```

GNOME on Wayland does not let apps grab global keys (and ignores window positions). There, add a
custom shortcut in Settings → Keyboard that runs `ternway --toggle-quick`; that also works on
every other desktop. Closing the main window quits Ternway, quick terminal included.

## Triggers and inline images

Triggers (from iTerm2) act on output lines that match a regular expression:

```
trigger = highlight:#ff5555 /error|failed/i     # color the match
trigger = notify:Build finished /^Finished/     # desktop notification
trigger = mark /WARN/                           # mark in the scrollbar
```

Inline images work with sixel and iTerm2's protocol (`imgcat`); `image-storage-limit` (bytes, as in
Ghostty, `0` turns them off) caps their memory. Ghostty's kitty graphics protocol is not supported.

## Shell integration

Local zsh, bash and fish shells get integration automatically: zsh through a temporary `ZDOTDIR`
that then restores yours, bash through an rcfile that does what a login shell does (`/etc/profile`
and your first profile file) and then loads the integration, fish through `XDG_DATA_DIRS`. It marks
prompts and commands (OSC 133) and reports the working directory (OSC 7), which gives:

- a green or red mark next to each prompt for the command's exit status, also in the scrollbar
- jumping between prompts and copying the last command's output
- new tabs and splits that open in the focused pane's directory (`working-directory = inherit`)
- tab names that follow the running command or directory
- a desktop notification when a long command finishes, with `notify-on-command-finish = unfocused`
  (or `always`) and `notify-on-command-finish-after = 10s`

SSH sessions get the same with `remote-shell-integration = true`. Ternway then installs the
scripts on each server once per version, in `~/.cache/ternway/shell-integration/` (over SFTP),
and starts your login shell through them; SSH splits and tabs open in the remote directory. Without
SFTP the shell starts as usual.

Set `shell-integration = none` to turn it off. Shells already integrated for Ghostty, iTerm2 or
VS Code emit the same sequences and work too.

## Editing remote files locally

In a server's Files view, the terminal button on a file opens it in your editor in a local pane
(`$VISUAL`/`$EDITOR` from your login shell, or `editor = …` in the config, e.g. `editor = code --wait`).
Every save is uploaded with the same atomic write as the built-in editor. If the file changed on
the server since you opened it, Ternway asks before overwriting. The local copy lives in a
private temporary directory and is removed when the editor exits.

## Updates

Settings → **Updates**, or "Check for updates" in the command palette, asks GitHub for the latest
release. Ternway never checks on its own. When a newer version exists it shows the release
notes; **Download and install** downloads it, verifies its signature and installs it. The progress
steps distinguish installation from the restart needed to run the new version. Once installation
finishes, choose **Restart to finish update**, or keep working and restart later. A reminder
stays in your workspace and other open windows even after closing Settings. Restarting ends
the programs running in your terminals, so Ternway asks before restarting.

AppImage, `.deb`, `.rpm` and macOS installs update in place; for `.deb` and `.rpm` your system asks
for your password. Builds from source show a link to the releases page instead.

## Session restore

Saved terminal tabs come back dormant after a restart: layout, each pane's directory (with shell integration) and
profile, and up to 1,000 lines of scrollback per pane. Running programs are not resumed, and no commands are replayed. Local remains closed when
you saved the layout that way. Set `window-save-state = never` to turn it off.

## Configuration

Terminal settings live in `~/.config/ternway/config`, in
[Ghostty's config format](https://ghostty.org/docs/config). The file is created on first run and
includes your Ghostty config with `config-file = ?~/.config/ghostty/config`, so what you set for
Ghostty applies here too; lines after the include override it for Ternway. Changes apply when
the file is saved. Settings shows the file, any errors, and the Ghostty keys Ternway ignores.

Supported so far: `font-family`, `font-size`, `theme` (including `light:…,dark:…`, resolved from
Ghostty's theme directories), `background`, `foreground`, `palette`, `cursor-color`, `cursor-text`,
`selection-background`, `selection-foreground`, `cursor-style`, `cursor-style-blink`,
`copy-on-select`, `clipboard-paste-protection`, `clipboard-paste-bracketed-safe`,
`clipboard-trim-trailing-spaces`, `scrollback-limit`, `wait-after-command`, `keybind`,
`config-file`, `command`, `working-directory`, `env`, `shell-integration`,
`notify-on-command-finish`, `notify-on-command-finish-after`, `window-save-state`,
`image-storage-limit`, `quick-terminal-position`, `quick-terminal-size`, `quick-terminal-autohide`
and `keybind = global:…`, plus Ternway's own `editor`, `trigger` and (in profiles) `match-host`.

Additional terminal and window settings: `title`, `fullscreen`, `adjust-underline-position`
(in pixels), `clipboard-read`, `clipboard-write`, `click-repeat-interval` (milliseconds),
`window-height` (rows), `window-width` (columns), `window-theme`, `window-decoration`,
`window-inherit-font-size`, and `resize-overlay`. Window dimensions include space for the
workspace controls and respect the screen bounds and minimum window size. Saving unrelated
settings preserves a window you resized manually.

`clipboard-read` and `clipboard-write` control programs' OSC 52 clipboard requests, with
`deny` (the default), `allow`, or `ask`. They do not disable your own Copy and Paste actions. `copy-on-select = true` and
`copy-on-select = clipboard` both copy to the system clipboard in Ternway.
Clipboard requests in restored scrollback never run. `click-repeat-interval = 0` disables
repeated-click selection; otherwise double-click selects a word and triple-click selects a row.

`auto-update` accepts `off` (the default), `check`, or `download`. Enabled checks run on startup
and every six hours in the main workspace; automatic downloads are signature-verified and wait
for you to choose Install. Restart is always your choice. `auto-update-channel = stable` selects
Ternway's published release channel; other channels report a configuration error.

**Profiles** are files in `~/.config/ternway/profiles/`, in the same format, layered on top of the
main config. Open one with "New tab: <name>" in the command palette. A profile with
`match-host = prod-*` is used for SSH tabs to servers whose host or name matches, for example to
give production a different background:

```
# ~/.config/ternway/profiles/prod
match-host = prod-*
background = 3a1418
```

## Safety and privacy

Ternway runs on your computer and talks to servers over SSH only. Secrets are encrypted locally.
Disruptive operations such as firewall changes, account deletion or service actions ask for
confirmation first; keep an independent recovery path before changing remote access or critical services.

## About Ternway

Open Settings → About Ternway to view the version, platform, credits and license,
or copy build details when reporting an issue. Copied details contain only the
version, OS/architecture, build type and source commit.

## SSH agents

In Settings → SSH identities, the default endpoint is `env:SSH_AUTH_SOCK`.
Ternway resolves it from the application's environment each time it connects.
Use an absolute socket path (or `~/…`) when selecting a different agent or when
a desktop launch does not inherit SSH_AUTH_SOCK. The UI explains when the
environment variable is unavailable.

All endpoints use the same standard SSH-agent client for key enumeration and
authentication signing. OpenSSH and compatible password-manager agents share
this path. The agent controls access to its keys and any signing approval.
The optional 1Password shortcut only finds a socket; it does not select a
different signing implementation.

For an explicitly authorized live check against your own test host, run:

```sh
TERNWAY_TEST_SSH_HOST=your-test-host TERNWAY_TEST_SSH_USER=your-test-user TERNWAY_TEST_SSH_AGENT_SOCKET=/absolute/path/to/agent.sock cargo test --manifest-path src-tauri/Cargo.toml --lib live_agent_login_and_read_only_command -- --ignored
```

TERNWAY_TEST_SSH_PORT is optional (default 22). If the agent socket override is
omitted, the test uses SSH_AUTH_SOCK. The check enforces known_hosts, runs a fixed
read-only printf command, disconnects and removes its temporary profile store.
A separate opt-in 1Password regression remains available. Protocol support does
not guarantee support for every provider policy, key type or agent extension.

Settings uses separate Appearance, Terminal, Connections, Security, Updates and About pages.
Choose a page in the navigation; only that page is shown. Arrow keys, Home and End also switch
pages when the navigation has focus. The page scrolls independently while navigation and Done stay visible.

Choose a workspace color preset in Settings → Appearance. GitHub Dark and GitHub Light are the
defaults; dimmed, high-contrast, colorblind and Dracula presets are also included. Previews apply
live to the workspace and fallback terminal palette. The light/dark shortcut remembers your last
choice in each mode. Explicit terminal config and profile colors keep priority. See [theme details](docs/THEMES.md).

## Sidebar layout

The Connections library and connection tools each have a collapse/expand button at the top.
Compact Connections keeps Search, New connection and Settings available; compact tools keeps
its navigation icons. Search (or Ctrl+K / ⌘K outside a terminal) expands the library and focuses
its search field. Collapsing either sidebar leaves the active terminal or tool view in place.

Drag a sidebar's right edge to change its width. You can also focus that edge with Tab and use
Left/Right arrows (10 pixels), Shift+Left/Right (40 pixels), Home (minimum), or End (available
maximum). Release the pointer or key to save; Escape, lost pointer capture or window focus
cancels an unfinished resize. Double-click the edge or use its top Reset width button to
restore the default width. Narrow windows temporarily reduce the displayed widths to leave
room for the workspace; enlarging the window restores your preferred widths. If the
interface is too small to expand a rail, Expand and Search explain that you need to enlarge
the window or reduce Interface scale; their controls remain keyboard-discoverable.

Widths and collapsed states are stored in the main configuration and can also be edited in
Settings → Terminal → Workspace:

```ini
sidebar-width = 260
sidebar-collapsed = false
tools-sidebar-width = 190
tools-sidebar-collapsed = false
```

Connections accepts 160–600 pixels, and tools accepts 140–400 pixels. These settings apply
across profiles and do not change the quick terminal window.

## Editing terminal settings

Settings → Terminal provides controls for every supported config key, including fonts,
colors and palettes, clipboard behavior, shortcuts, environment variables, output triggers,
window behavior, notifications, quick terminal and updates. Expand a group, edit values and
choose **Save settings**. **Use inherited / default value** removes a local override when you
save; included files then supply the value. Shell options apply to new sessions. Window
preferences apply when saved; changing dimensions also resizes the current window. Clipboard history and saved scrollback remain opt-in.

The same settings are readable and editable in `~/.config/ternway/config`. GUI saves preserve
comments, unknown options and included Ghostty files. If an external editor changes the file
while your form is open, saving asks you to reload instead of overwriting the external changes.
Workspace appearance and zoom are stored as `app-theme` and `interface-scale` too.

Use the configuration selector to edit a profile, or **New profile** and **Delete profile** to
manage files in the adjacent `profiles/` directory. Profiles inherit the main configuration;
`match-host` applies a profile automatically to matching SSH hostnames or connection names.
**Included config files** edits `config-file` entries: one path per line, with an optional `?`
prefix for files that need not exist. GUI overrides apply after those includes.
