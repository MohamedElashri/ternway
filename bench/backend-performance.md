Backend performance fixtures (2026-11-18)

Run the ignored, bounded fixtures from the repository root:

```sh
PKG_CONFIG=/usr/bin/pkg-config cargo test --manifest-path src-tauri/Cargo.toml --lib backend_perf -- --ignored --nocapture --test-threads=1
```

The benchmark-only commit `4d31c87` preserves the original production implementation with the same fixtures. To reproduce the before measurements without reverting your working files:

```sh
git worktree add --detach /tmp/ternway-backend-before 4d31c87
PKG_CONFIG=/usr/bin/pkg-config cargo test --manifest-path /tmp/ternway-backend-before/src-tauri/Cargo.toml --lib backend_perf -- --ignored --nocapture --test-threads=1
```

Set `CARGO_TARGET_DIR` to the same absolute directory for both runs to reuse dependencies; run builds sequentially. These are debug builds on the same Linux development machine, not packaged-release or end-to-end webview measurements. Exact times vary with host load. No benchmark uses real connection data, authentication services, SSH hosts, or user configuration. Storage fixtures create and remove a UUID-named temporary SQLite database; native terminal fixtures use in-memory synthetic text. Timing is printed for manual comparison, never asserted in unit tests.

| Operation | Before | After |
| --- | ---: | ---: |
| First search of 4,001 native rows / 4,000 matches | 219,967 µs | 216,776 µs |
| 20 subsequent Next requests, same unchanged text/query | 4,347,274 µs | 35 µs |
| 20 background tunnel scans, 2,000 profiles / 200 tunnels | 3,058,180 µs | 3,161 µs |

These before/after values are the initial consecutive runs. Later after runs ranged from 35–50 µs for 20 cached Next requests and 3,161–7,858 µs for 20 tunnel scans as machine load changed. Navigation timings measure `Engine::find`; frame capture, IPC, and browser painting add separate costs. Initial searches still scan native scrollback, as do searches after content changes. The cache stores at most 10,000 coordinate pairs and 2,000 highlight pairs, and releases the temporary text and per-byte positions. PTY output, alternate-screen changes, resizing/reflow, appearance/history-limit changes, and clearing search invalidate it. Regex size, query length, search deadlines, text bounds, match caps, Unicode mapping, selection, and next/previous behavior are preserved.

`background_activity` previously decoded every saved profile and queried tunnel definitions once for each profile. It now reads only tunnel IDs in one query, optionally scoped to one server. This improves quit/disconnect confirmation with large libraries; it is not a periodic terminal-output path.

The additional native-frame fixture confirms an existing optimization: 200 updates at 120 columns × 40 rows serialize 2,544,407 bytes and 201 changed rows with dirty frames, compared with 91,507,600 bytes and 8,000 rows with full frames. Capture plus serialization ranged from 187–404 ms with dirty frames versus 6,667–9,121 ms with full frames. Production already requests dirty frames, so no backend rendering rewrite was justified by this result.

The storage fixture also checks the current bounded connection-health lookup path: twenty batches of 64 profile reads and absent cached-transport checks took 135–247 ms total (roughly 6.7–12.3 ms per batch). This does not benchmark active network transports or OpenSSH control-master probes. Health checks retain their existing maximum batch sizes and nonblocking cached-client mutex behavior. Local PTY reader/writer and native engine workers already block on events while idle; the native hold timer runs only while a synchronized-output hold exists. Remote SSH terminals retain their existing adaptive 1–12 ms polling and immediate input wakeups; changing network readiness handling would require separate transport/latency measurements.

Regression validation: `cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=1` passed 137 tests, with 11 intentionally ignored tests (including these three manual benchmarks). Socket-based agent fixtures require a runner that permits local Unix sockets. Tests cover search options, navigation, missing matches followed by new output, Unicode selection through reflow, alternate screens, scrollback eviction, scoped/all tunnel IDs, and existing PTY flow control, native actor ownership, and dirty frames. No live-account tests were run.
