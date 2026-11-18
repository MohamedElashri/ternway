# Native WebKit performance checks

`native-performance.py` measures the real Linux WebKitGTK application in a new
isolated XDG profile. It seeds 1,000 synthetic `.invalid` connection profiles in
the app-created SQLite database while the app is stopped. It never connects to
those profiles or starts an SSH fixture. Its only process workload is the owned
local `/bin/sh` terminal and bounded Python output commands.

Requirements: Python 3, the compiled application, matching WebKitGTK and
`/usr/bin/WebKitWebDriver`, plus a private X11 or Wayland display. Python uses
only the standard library. Build the native test binary with:

```sh
npm run tauri -- build --debug --no-bundle --config '{"productName":"Ternway CI","identifier":"dev.elashri.ternway.ci","bundle":{"createUpdaterArtifacts":false}}'
```

For X11, install `xvfb`, `xauth`, `dbus-x11` and `webkit2gtk-driver`, then run:

```sh
GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  xvfb-run -a -s '-screen 0 1440x900x24' dbus-run-session -- \
  python3 bench/native-performance.py src-tauri/target/debug/ternway \
    --root /tmp/ternway-perf-candidate-x11 --expect-retained
```

The output root must not already exist. For a baseline that replaces rows, omit
`--expect-retained`. Preserve the baseline binary before rebuilding; run baseline
and candidate consecutively with the same display, viewport and renderer while
builds, tests and other benchmarks are idle.

For a matched idle pair, use the preserved baseline and candidate in that order:

```sh
GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  xvfb-run -a -s '-screen 0 1440x900x24' dbus-run-session -- \
  python3 bench/native-performance.py /tmp/ternway-baseline \
    --root /tmp/ternway-perf-idle-baseline-x11
GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  xvfb-run -a -s '-screen 0 1440x900x24' dbus-run-session -- \
  python3 bench/native-performance.py src-tauri/target/debug/ternway \
    --root /tmp/ternway-perf-idle-candidate-x11 --expect-retained
```

For Wayland, run the same Python command inside a private nested Weston desktop
session with `GDK_BACKEND=wayland` and `DISPLAY` unset for the application. Follow
the seat-enabled Xvfb/Weston setup in `tools/run-native-gui.sh`; a headless Weston
backend without an input seat is insufficient. Use a separate output root.

The runner reuses the native smoke harness bootstrap and safe WebDriver helpers,
stopping before its SSH fixture and correctness scenarios. It reports:

- DOM node count and sidebar HTML bytes for the initial 1,000-profile library.
- Input-handler dispatch and forced-layout time for full, exact, partial and
  absent searches, plus retained row/terminal identity.
- Settings open, page navigation and close time, with list/row identity.
- Idle 10 ms timer lateness and animation-frame intervals.
- Completion time and event-loop lateness for 100, 1,000 and 5,000 lines of real
  local PTY output, using encoded completion markers and native Enter events.

Raw results and screenshots are under `<root>/artifacts/`. Search and Settings
timings measure synchronous handler/layout work, not the complete visible paint.
PTY completion includes process launch, IPC, rendering, WebDriver and bounded
polling overhead. Debug builds and software rendering are diagnostic conditions;
these numbers are not release throughput or network/SSH performance claims.
