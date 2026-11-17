# Native Ghostty and combined UX review

Scope: PR #39 plus its stacked desktop, connection-sidebar and workspace UX changes.
The release remains v0.4.0; this review does not merge or publish it.

## Findings corrected

| Area | Reproduced issue | Correction and regression coverage |
| --- | --- | --- |
| Command output | Copy lost a character when output ended exactly at the last column; a one-character final-column result could appear empty. | Preserve Ghostty's pending-wrap state at command boundaries; native regression tests cover full rows, a single final-column character, wide text and unfinished lines. |
| Search | Closing/reopening skipped the first match; invalid patterns left old highlights selected. | Reset search state and selection together. Superseded queries are discarded and large/expensive scans have bounded budgets. |
| Unicode | Search/completion assumed a grapheme fit in 32 codepoints. | Retry with the native required buffer size; a long combining cluster is tested. |
| Paste | Browser-originated paste was silently discarded. | Route it through the same multiline confirmation and native bracketed-paste encoder as shortcut paste. Real PTY capture verifies exact bytes; cancelling confirmation sends nothing. |
| Input methods | A final browser input event after compositionend could duplicate committed text. | Deduplicate the final commit. The native GUI test exercises both events and checks actual PTY UTF-8 bytes. |
| Selection | Rapid select-all/copy could use an old cached selection. | Fetch selection from Ghostty at copy time, invalidate erased selections, and use native word-selection semantics. |
| Atomic drawing | DEC synchronized output was ignored; an abandoned hold needed recovery without blocking flow-control acknowledgments. | Capture the pre-hold frame in Ghostty's synchronous callback, acknowledge hidden output separately, and expire a hold after one second. Input modes remain current during a drawing hold. |
| Scrollback | A partial bottom row made the scrollbar clamp and issue an unintended scroll, stopping output following. | Map the native row range to the exact widget range and cap enormous virtual pixel extents. A live 5 MiB flood exceeds the PTY backpressure threshold without losing following or deadlocking. |
| Images | Multiple placements retransmitted the same pixels in one packet; deep-background images were hidden or drawn above explicit backgrounds. | Deduplicate pixel transfers and preserve all three native image layers, leaving default cells transparent over background images. Native and canvas regressions verify transfer count, explicit backgrounds and drawing order, following the [Kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/). |
| Full-screen programs | Normal-shell command marks/copy coordinates could refer to unrelated alternate-screen content. | Hide shell marks and disable prompt jumping/output copying in the alternate screen. Native mouse press/drag/release is captured by a real program. |
| Resource/errors | Render errors were discarded, risking a silent stuck session; modifiers could snap a scrolled viewport to the bottom. | Surface rendering failures and close the originating PTY; only actual key input changes following. Unchanged geometry no longer causes native resize traffic. |
| Interface scale | Rapid scale/reset operations could complete out of order, leaving the wrong zoom and disabled reset controls. | Serialize native zoom changes while updating requested control state immediately; a live rapid-increase/reset test waits for the actual webview geometry. |
| Linux chrome | A light GTK menu row appeared above the custom dark titlebar. | Hide that redundant Linux menubar; retain the macOS application menu. |
| Connection folders | Locale-sensitive case conversion could merge distinct folders or misapply ordering under Turkish locales. | Use locale-independent identity folding consistent with Rust. A separate Turkish-locale process verifies folder identity and order. |

## Live test coverage

The native harness launches an isolated app with private config/data/cache directories,
a plain shell, disposable SSH/SFTP fixtures and an isolated display. It never uses saved
production connections. It covers:

- PTY Unicode output, application cursor keys, Ctrl+C, bracketed paste, confirmation cancellation,
  composition ordering, real SGR mouse reports, selection/clipboard sequencing and large output.
- Atomic rendering, timeout recovery, resizing, tab dragging and terminal reconnect/clear.
- All six Settings pages at 640×480 and desktop sizes, keyboard focus containment, enlarged UI,
  every built-in theme, button contrast, hover geometry and persistent theme selection.
- Folder/default-folder protection, nested rename/delete, drag ordering, imports and backup privacy.
- Real SSH authentication recovery, remote tools and binary SFTP pause/retry.
- Update progress, cancellation, multi-window readiness and the coordinated save barrier.
- Corrupt queue recovery and opt-in styled history restored into dormant panes without starting a process.

Screenshots and per-display checks are uploaded by the Native Linux GUI workflow.
Frontend regressions, native Rust tests, SSH fixtures, lifecycle soak and macOS bundle/signature
verification run separately in the platform workflow.

## Practical limits

This is risk-based coverage, not a claim to exhaust every possible input. Native GUI automation
runs on Linux X11 and headless Wayland. macOS receives build, core/SSH and bundle-signature checks;
its physical GUI and OS input methods still require device testing. Composition-order events are
injected into the real native app, not generated by a physical IME. Updater install responses use
controlled transport: the test does not replace an installed .deb or restart the physical OS.
