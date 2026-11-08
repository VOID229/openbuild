# Performance

How fast OpenBuild and OpenBots load, switch and come back, how that's measured, and what's still slow.
Measured with the benchmarks in `scripts/bench`, in a real Chrome against a disposable server; never
against a real install.

## Measuring

```sh
# A data folder shaped like a long-used install: 740 threads (~890 MB, a few with tens of MB of
# pasted screenshots), 11 OpenBots chats (one group of 1,700 messages). Deterministic.
mkdir -p /tmp/ob-bench/golden/{data,home}
HOME=/tmp/ob-bench/golden/home OPENCHAT_DATA_DIR=/tmp/ob-bench/golden/data bun scripts/bench/seed.ts

# Times the app, from a fresh copy of that folder per run. --repo runs another checkout's server
# (e.g. `git archive main | tar -x -C /tmp/ob-base`) for a before/after.
bun scripts/bench/bench.ts --golden /tmp/ob-bench/golden [--runs 5] [--cpu 4] [--remote --latency 40 --kbps 40000] [--repo /tmp/ob-base] [--out result.json]

# Two results side by side, as the tables below.
bun scripts/bench/compare.ts before.json after.json "Local, 1× CPU"

# DevTools traces (and, with --profile, CPU profiles) of a reload, a switch and going into OpenBots.
bun scripts/bench/trace.ts --golden /tmp/ob-bench/golden --out /tmp/ob-bench/traces [--profile]
```

The sandbox (`sandbox.ts`) runs the server in production mode with its own `HOME`, data folder and
loopback port, so it never touches the real install, its workers, sessions or runtimes' accounts;
everything it starts carries its data folder in its environment, which is how it cleans up after
itself. `--remote` has Chrome reach it by a name that isn't this machine's, as a browser on a phone or
another computer does over Tailscale (so it gets what such a browser gets, compressed answers
included); `--latency`/`--kbps` shape that link, `--cpu` slows the page's CPU (4 ≈ a laptop on battery).

What's timed, from Chrome's side, to the first frame where the result is on screen:

- **cold load**: a new browser profile (nothing cached) opening a thread's URL, to its last message shown;
- **warm reload**: reloading that page;
- **thread switch**: clicking a sidebar row, to the thread's last message shown, first visit and again,
  and first visits pointed at for a quarter second before the click (as a hand does);
- **OpenBuild ↔ OpenBots**, and switching OpenBots chats by clicking their rows;
- **restart**: the server stopped and started again under an open tab: until the tab is talking to it,
  has the thread list again and OpenBots' live stream back; and a reload straight after a start.

## Results

Base `a9bd9b7` against this work (`37c3740`), measured in one session, medians in ms (5 runs; 3 at
4× CPU). Linux, 16 cores, Chrome for Testing 156 headless (swiftshader), 1440×900, the server on Bun
1.4.0; the seeded data above (740 threads, 891 MB; median thread 379 KB, largest 15 MB; OpenBots'
snapshot 4.8 MB). Each scenario starts from a fresh copy of the data, 4 s after the server is up.
Locally every answer is uncompressed (the browser asks for 127.0.0.1); `--remote` is where gzip shows.

| Local, 1× CPU | before | after | |
|---|---:|---:|---:|
| cold load: thread on screen | 930 | 398 | 2.3× faster |
| warm reload: thread on screen | 674 | 176 | 3.8× faster |
| thread switch, first visit | 102 | 90 | 1.1× faster |
| thread switch, first visit pointed at 250 ms first | 73 | 54 | 1.4× faster |
| thread switch, again | 55 | 47 | 1.2× faster |
| OpenBuild → OpenBots | 130 | 147 | 1.1× slower |
| OpenBots → OpenBuild | 94 | 93 | same |
| OpenBots chat switch | 88 | 87 | same |
| server answering after a start | 1134 | 323 | 3.5× faster |
| after a restart: thread list fresh | 376 | 42 | 9.0× faster |
| after a restart: OpenBots stream back | 195 | 19 | 10.3× faster |
| reload right after a restart | 921 | 314 | 2.9× faster |
| cold load: transferred | 12166 KB | 7661 KB | |
| warm load: transferred | 6733 KB | 6728 KB | |

| Local, 4× CPU slowdown | before | after | |
|---|---:|---:|---:|
| cold load: thread on screen | 2200 | 1278 | 1.7× faster |
| warm reload: thread on screen | 1342 | 482 | 2.8× faster |
| thread switch, first visit | 341 | 303 | 1.1× faster |
| thread switch, first visit pointed at 250 ms first | 147 | 87 | 1.7× faster |
| thread switch, again | 116 | 105 | 1.1× faster |
| OpenBuild → OpenBots | 462 | 371 | 1.2× faster |
| OpenBots → OpenBuild | 226 | 192 | 1.2× faster |
| OpenBots chat switch | 263 | 248 | 1.1× faster |
| server answering after a start | 1181 | 319 | 3.7× faster |
| after a restart: thread list fresh | 301 | 97 | 3.1× faster |
| after a restart: OpenBots stream back | 158 | 26 | 6.1× faster |
| reload right after a restart | 1595 | 745 | 2.1× faster |
| cold load: transferred | 12167 KB | 7662 KB | |
| warm load: transferred | 6733 KB | 6730 KB | |

| Remote: 40 ms RTT, 40 Mbps | before | after | |
|---|---:|---:|---:|
| cold load: thread on screen | 3100 | 786 | 3.9× faster |
| warm reload: thread on screen | 1658 | 363 | 4.6× faster |
| thread switch, first visit | 209 | 155 | 1.3× faster |
| thread switch, first visit pointed at 250 ms first | 288 | 55 | 5.2× faster |
| thread switch, again | 46 | 47 | same |
| cold load: transferred | 12165 KB | 1528 KB | |
| warm load: transferred | 6733 KB | 453 KB | |

Runs vary by ±15–20 % between sessions (base's warm reload was 762 ms in an earlier one), so before
and after come from the same session. "OpenBuild → OpenBots" read 130 → 147 in this one; interleaved
A/B runs of 15 each put it at 126/126 before and 120/114 after: no change beyond noise at 1× CPU.
The traces and CPU profiles behind the changes below come from `trace.ts`.

## What changed, and why

Each is its own commit; the benchmark that motivated it is in its message.

1. **The thread listing read every transcript** (`server/storage.ts`). `chatIndex()` selects id and
   version ordered by `updated_at`, but those columns are stored after each chat's `data`, so SQLite
   walked every transcript's overflow pages: 88 ms per call on a real 590 MB database, twice per
   `/api/chats` poll (every 5 s, per tab), blocking the event loop meanwhile, so every other request
   waited too. A covering index answers it in 0.2 ms. Durable threads for usage were found by parsing
   every transcript (520 ms); the summaries answer that now (2 ms). Summaries are spliced into their
   response as stored instead of parsed and serialized again (154 → 3 ms).
2. **Back within a probe of a restart** (`LocalAccess`, `lib/serverOutage.ts`). An open tab didn't
   notice a restart until something failed, then backed off 1, 2, 3 … s, and each retry loop (replies,
   OpenBots' stream, the outbox, the thread list) kept its own schedule. A dropped long-lived
   connection now has the app look at once, every 300 ms for the first seconds, and one "server back"
   event wakes all of them.
3. **Fonts out of the stylesheet, compressed assets** (`server/client.ts`). Bun's HTML route inlined
   every font into the render-blocking CSS: 2.1 of its 2.35 MB, mostly subsets and woff/ttf fallbacks
   no browser uses. Production builds the app itself: the same single bundle, fonts as immutable files
   (the page preloads the ones its font setting paints with), text gzip/brotli-compressed once, off the
   event loop. Development keeps Bun's HTML route with hot reloading. Still one script, so a tab left
   open across an update never needs a chunk the new server doesn't have.
4. **No rows for a shut sidebar section** (`Sidebar.tsx`). "Closed" is most threads; its rows (~3,900
   SVG icons for 740 threads) were most of a page load's render though nobody could see them.
5. **Gzip for large JSON across a network** (`server/compress.ts`): summaries, histories and OpenBots'
   snapshot were megabytes sent as is. Decided by the address the browser asked for, not the
   connection's, so a reverse proxy on the same machine still counts as remote; streams pass through.
6. **History before the click** (`lib/db.ts`). Pointing at a row (after 80 ms) or pressing it loads its
   history; the click opens straight onto its messages. Used only while the list says it's the current
   version, and never to rebuild a history a save writes back. A page load also loads the routed
   thread alongside the list, and gets the summaries with the index: two round trips fewer.
7. **A briefer message entrance** (180 ms instead of 260 ms), and none with reduced motion, which it
   ignored before.
8. **Sidebar edits without the history** (`PATCH /api/chats/:id`). Marking a thread read by opening
   it, pinning or closing it while the browser had only its summary downloaded the whole history and
   uploaded it back (tens of MB for a thread with screenshots, plus a main-thread `JSON.stringify`),
   with a window where messages written meanwhile could be overwritten. The server now merges the
   metadata into the history it has, through the same path as a PUT.

Safety: nothing new is kept in browser storage. The prefetched histories live in memory, are
version-checked against the thread list and expire; compression never applies to streams; the
production build keeps the old route's 404 for scripts from an older build.

## Still slow, with what's known

- **Going into OpenBots and switching its chats** (~90–150 ms at 1× CPU, 250–370 ms at 4×). OpenBots stays mounted in a
  hidden `<Activity>` (`display: none`), so showing it lays out and restyles its whole open chat (200
  messages) from scratch; BotChat's scroll-restoring layout effect is where that forced layout lands
  (45 ms self time in a profile). `content-visibility: auto` on its message groups, as threads do, would
  cut it to what's on screen, but BotChat restores places from `offsetTop`/`offsetHeight` while sizes
  are estimates, and `tests/botChatScroll.test.ts` fails five ways with it. Doing it needs ChatView's
  anchor-holding logic ported to BotChat, or a windowed message list.
- **OpenBots' snapshot on every page load**: the last 200 messages of every conversation, with images
  inline as base64 (4–5 MB here, mostly images), fetched even when OpenBots isn't opened. Serving images
  by URL (cacheable, deduplicated) and fewer messages up front would shrink it most.
- **Histories carry pasted screenshots inline** (base64 in the transcript JSON, up to 28 MB per thread on
  a real install): a first visit downloads and parses all of it. Attachments by URL would fix it.
- **A revisit still remounts the thread** (`LoadedChat key={chat.id}`), Composer included: ~45–105 ms
  (1×–4× CPU).
- **After a sidebar edit of an opened thread**, its history is fetched again once (its version changed);
  correct, and no more than the full PUT's response used to send.
- **Startup is still a chain**: auth check → config → thread list (and the routed thread) → render; each
  link is a round trip on a remote link. Runtime model probes (Cursor, Grok, Pi status: 200–500 ms each
  when the runtime is missing) also hold some of the browser's six connections per host meanwhile.
- **Saving a large chat** re-serializes all of it on the server (synchronously), and rebuilds its summary.
- **`bun test` on many-core machines**: an HTML import route (or Bun.build inside the test process) can
  fail to resolve a large page's imports at random; Chrome fixtures are built by `bun build` in a process
  of their own (`serveFixture` in `tests/chromePage.ts`).
