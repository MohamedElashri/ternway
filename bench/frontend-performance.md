# Frontend performance checks

Run from a checkout with dependencies installed:

```sh
node bench/frontend.ts
node bench/connection-list.ts
npm run test:frontend
```

`frontend.ts` optionally accepts an absolute checkout path, so the same fixture
can measure the pre-change implementation at `713594c`. `connection-list.ts`
compares HTML replacement and keyed reconciliation in the same process. These
are synthetic CPU/DOM measurements, not native FPS or release throughput claims.

On Node 26.13.1, six searches over 1,000 profiles took 1,845 ms with HTML
replacement and 145 ms with reconciliation. Reconciliation regenerated no row
HTML and retained all 1,000 original row nodes. Repeating a broad search with
unchanged results took about 1 ms. Queries that change the visible result set
still insert/remove nodes and incur native layout work.

Thirty single-row terminal updates previously drew 120,000 glyphs; the updated
renderer draws 360. Cursor-only updates leave the canvas and accessibility rows
intact. Resize, scrolling, style changes, and inline images still force full
painting. A 1,600-span search fixture went from 76 ms to 1–5 ms across local runs
by indexing and merging spans before walking cells. Timings vary with system
load; operation counts and correctness tests are the stronger comparisons.

Collapsed folders now generate no connection-row HTML: the 10,000-profile
fixture produces about 2.9 KB instead of 621 KB (using deliberately small row
markup). Folder-tree construction still walks the library. Fully expanded
libraries still create one DOM row per visible connection; this change does not
virtualize or truncate results. Detached cached rows are bounded by the current
library and pruned when profiles are removed.

The native baseline on private X11 and Wayland displays confirmed the connection
list bottleneck: a broad search over 1,000 profiles took approximately 0.5–0.7 s,
mostly layout, with about 20,450 DOM nodes. Repeat native measurements are needed
after integration; debug builds and software graphics are diagnostic rather than
representative release hardware. Native smoke checks also cover terminal images,
search, selection, resize, and retained terminal DOM.

Ordinary path-link scanning and idle scheduling did not warrant changes in these
fixtures. See `backend-performance.md` for terminal-search and database results.
