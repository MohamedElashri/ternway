#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  x11)
    export GDK_BACKEND=x11
    xvfb-run -a -s '-screen 0 1440x900x24' dbus-run-session -- python3 tools/native-gui-smoke.py src-tauri/target/debug/ternway
    ;;
  wayland)
    # Weston headless has no input seat. Nest Weston in a private Xvfb so it
    # supplies a real Wayland seat/clipboard; the application gets no DISPLAY.
    if [[ "${TERNWAY_NESTED_DISPLAY_READY:-}" != 1 ]]; then
      exec xvfb-run -a -s '-screen 0 1600x1000x24' env TERNWAY_NESTED_DISPLAY_READY=1 bash "$0" wayland
    fi
    export XDG_RUNTIME_DIR="$RUNNER_TEMP/ternway-wayland-runtime"
    mkdir -m 700 "$XDG_RUNTIME_DIR"
    export WAYLAND_DISPLAY=wayland-ternway
    weston --backend=x11-backend.so --renderer=pixman --socket="$WAYLAND_DISPLAY" --idle-time=0 --width=1440 --height=900 --no-config > "$RUNNER_TEMP/weston.log" 2>&1 &
    compositor_pid=$!
    trap 'kill "$compositor_pid" || true' EXIT
    for attempt in $(seq 1 100); do
      [[ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]] && break
      sleep 0.1
    done
    test -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY"
    export GDK_BACKEND=wayland
    unset DISPLAY
    dbus-run-session -- python3 tools/native-gui-smoke.py src-tauri/target/debug/ternway
    ;;
  *) echo 'Choose x11 or wayland.' >&2; exit 1 ;;
esac
