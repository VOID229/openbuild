# Performance

How fast OpenBuild and OpenBots load, switch and come back, how that's measured, and what's still slow.
Measured with the benchmarks in `scripts/bench`, in a real Chrome against a disposable server; never
against a real install.

## Measuring

```sh
# A data folder shaped like a long-used install: 740 threads (~890 MB, a few with tens of MB of
# pasted screenshots), 11 OpenBots chats (one group of 1,700 messages). The same shape every time.
mkdir -p /tmp/ob-bench/golden/{data,home}
HOME=/tmp/ob-bench/golden/home OPENCHAT_DATA_DIR=/tmp/ob-bench/golden/data bun scripts/bench/seed.ts

# An older server to compare against: its own checkout, and a copy of the data as its own database
# would be, without the `chats_listing` index (with it there, its thread listing gets that fix free).
git archive a9bd9b7 | tar -x -C /tmp/ob-base && (cd /tmp/ob-base && bun install --frozen-lockfile)
cp -a /tmp/ob-bench/golden /tmp/ob-bench/golden-base
bun -e 'new (require("bun:sqlite").Database)("/tmp/ob-bench/golden-base/data/openchat.db").run("DROP INDEX chats_listing")'

# Times the app, from a fresh copy of that folder per run. --repo runs another checkout's server.
bun scripts/bench/bench.ts --golden /tmp/ob-bench/golden [--runs 5] [--cpu 4] [--remote --latency 40 --kbps 40000] [--only cold,warm,switch,bots,restart] [--out after.json]
bun scripts/bench/bench.ts --golden /tmp/ob-bench/golden-base --repo /tmp/ob-base [...] [--out before.json]

# Results side by side, as the tables below; comma-separated results are interleaved rounds.
bun scripts/bench/compare.ts before.json after.json "Local, 1× CPU"
bun scripts/bench/compare.ts before-1.json,before-2.json after-1.json,after-2.json "Local, 1× CPU"

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

- **cold load**: a new browser profile (nothing cached) opening a thread's URL, to its last message
  shown; 5 loads;
- **warm reload**: reloading that page; 5 reloads;
- **thread switch**: clicking a sidebar row, to the thread's last message shown: six threads of
  189 KB–10.2 MB, first visit and again, and six others (228 KB–6.3 MB) pointed at for a quarter
  second before the click, as a hand does. Each row is the median of its six threads, so it says
  little about the largest ones (see below), and the two first-visit rows open different threads;
- **OpenBuild ↔ OpenBots**, 5 times each way, and switching OpenBots chats by clicking their rows
  (8 clicks over chats of 1,700, 400, 120 and 90 messages);
- **restart**: the server stopped, and started again 1.5 s later under an open tab: until the tab has
  the thread list again and OpenBots' live stream back; and a reload straight after a start. 3 each.

## Results

Base `a9bd9b7` against this work (`34354d8`; its app code is that of `37c3740`, later commits are
documentation and tests), medians in ms. Measured on 8 November 2026 in one 20-minute session, base
and this work one at a time and interleaved, in the order of the tables (the 1× pair twice). Linux,
16 cores, 60 GB; the machine wasn't otherwise idle (load average 1.1–2.7, other sessions' work, a test
suite at times). Chrome for Testing 156.0.8078.4, headless, swiftshader, 1440×900; the server on Bun
1.4.0. The seeded data above: 740 threads, 891 MB (median thread 329 KB, largest 17.5 MB, 78 in the
sidebar's open sections), the opened thread 337 KB, OpenBots' snapshot 4.7 MB. Each scenario starts
from a fresh copy of the data, 4 s after the server is up. Locally every API answer is uncompressed
(the browser asks for 127.0.0.1); `--remote` is where gzip shows.

| Local, 1× CPU (two rounds) | before | after | |
|---|---:|---:|---:|
| cold load: thread on screen | 935, 1002 | 450, 419 | 2.1–2.4× faster |
| warm reload: thread on screen | 691, 721 | 143, 173 | 4.2–4.8× faster |
| thread switch, first visit | 112, 111 | 108, 88 | same to 1.3× faster |
| thread switch, first visit pointed at 250 ms first | 74, 73 | 49, 49 | 1.5× faster |
| thread switch, again | 51, 54 | 49, 53 | same |
| OpenBuild → OpenBots | 141, 143 | 121, 133 | 1.1–1.2× faster |
| OpenBots → OpenBuild | 91, 92 | 89, 88 | same |
| OpenBots chat switch | 88, 90 | 92, 85 | same to 1.1× faster |
| server answering after a start | 1106, 1150 | 280, 300 | 3.8–4.0× faster |
| after a restart: thread list fresh | 389, 329 | 63, 44 | 6.2–7.5× faster |
| after a restart: OpenBots stream back | 214, 188 | 43, 40 | 4.7–5.0× faster |
| reload right after a restart | 901, 902 | 326, 318 | 2.8× faster |
| cold load: transferred | 12076 KB, 12076 KB | 7574 KB, 7532 KB | |
| warm load: transferred | 6643 KB, 6642 KB | 6637 KB, 6639 KB | |

| Local, 4× CPU slowdown | before | after | |
|---|---:|---:|---:|
| cold load: thread on screen | 2211 | 1386 | 1.6× faster |
| warm reload: thread on screen | 1296 | 534 | 2.4× faster |
| thread switch, first visit | 385 | 326 | 1.2× faster |
| thread switch, first visit pointed at 250 ms first | 184 | 82 | 2.2× faster |
| thread switch, again | 133 | 104 | 1.3× faster |
| OpenBuild → OpenBots | 455 | 387 | 1.2× faster |
| OpenBots → OpenBuild | 228 | 184 | 1.2× faster |
| OpenBots chat switch | 236 | 274 | 1.2× slower |
| server answering after a start | 1152 | 289 | 4.0× faster |
| after a restart: thread list fresh | 339 | 116 | 2.9× faster |
| after a restart: OpenBots stream back | 192 | 39 | 4.9× faster |
| reload right after a restart | 1594 | 648 | 2.5× faster |
| cold load: transferred | 12077 KB | 7574 KB | |
| warm load: transferred | 6642 KB | 6640 KB | |

| OpenBots alone, 4× CPU (three rounds) | before | after | |
|---|---:|---:|---:|
| OpenBuild → OpenBots | 458, 443, 505 | 376, 437, 460 | same to 1.2× faster |
| OpenBots → OpenBuild | 229, 232, 263 | 204, 226, 218 | same to 1.2× faster |
| OpenBots chat switch | 336, 330, 333 | 281, 287, 303 | 1.1–1.2× faster |

| Remote: 40 ms RTT, 40 Mbps | before | after | |
|---|---:|---:|---:|
| cold load: thread on screen | 2938 | 818 | 3.6× faster |
| warm reload: thread on screen | 1587 | 369 | 4.3× faster |
| thread switch, first visit | 215 | 169 | 1.3× faster |
| thread switch, first visit pointed at 250 ms first | 272 | 53 | 5.1× faster |
| thread switch, again | 44 | 47 | 1.1× slower |
| cold load: transferred | 12075 KB | 1526 KB | |
| warm load: transferred | 6642 KB | 451 KB | |

Reading them:

- **Noise.** Differences under ~10 % are noise: the two 1× rounds differ by up to 20 % from each
  other (warm reload after: 143 and 173), and an earlier session the same day with the same tools read
  cold 930 → 398 and warm 674 → 176. "Thread switch, again" (remote 44 → 47) and the OpenBots rows at 1×
  are unchanged. The first of the five cold loads is the slowest on both sides (before ~1.4 s, after
  ~700 ms), the first load against the started server.
- **The 4× "OpenBots chat switch: 1.2× slower"** is a median of 8 clicks that falls between two
  clusters (the 1,700- and 400-message chats at 434–535 ms, the others at 185–274); per chat that run
  is mixed, −11 to +42 ms. Run alone and interleaved three times, OpenBots chat switching reads
  330–336 → 281–303 ms at 4×: no regression.
- **The largest threads** gain more than the switch medians show: a first visit to the 10.2 MB one took
  394 and 369 → 158 ms at 1×, 1479 → 543 ms at 4×, with the main thread's blocking time (long tasks
  beyond 50 ms) 1110 → 248 ms. That's consistent with marking it read no longer serializing and
  uploading its whole history (change 8 below). Over the remote link, pointing at a thread first
  doesn't hide a big one: the 4.5 and 6.3 MB threads took 1020 and 1432 → 642 and 915 ms, as a quarter
  second isn't long enough to download them.
- **Restarts.** How long base took to see a restarted server depends on where its backoff (1, 2, 3 …
  s) falls against the outage: at 1× its first restart took 2.3 s in both rounds, the next two
  313–389 ms. After this work it was 43–165 ms in every restart measured.
- **Transferred.** Locally the cold load's assets fell from 5.4 MB to 1.0 MB; its API answers stay
  6.6 MB, uncompressed for 127.0.0.1 (OpenBots' snapshot 4.7 MB, the thread list's summaries 1.4 MB).
  A remote browser gets 12.1 → 1.5 MB on a cold load and 6.6 MB → 451 KB on a reload.

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

- **Going into OpenBots and switching its chats** (121–133 ms and 85–92 ms at 1× CPU; 376–460 ms and
  274–303 ms at 4×, the two big chats 410–553 ms). OpenBots stays mounted in a hidden `<Activity>`
  (`display: none`), so showing it lays out and restyles its whole open chat (200 messages) from
  scratch; BotChat's scroll-restoring layout effect is where that forced layout lands (45 ms self time
  in a profile). `content-visibility: auto` on its message groups, as threads do, would cut it to
  what's on screen, but BotChat restores places from `offsetTop`/`offsetHeight` while sizes are
  estimates, and `tests/botChatScroll.test.ts` fails five ways with it. Doing it needs ChatView's
  anchor-holding logic ported to BotChat, or a windowed message list.
- **OpenBots' snapshot on every page load**: the last 200 messages of every conversation, with images
  inline as base64 (4.7 MB here, mostly images), fetched even when OpenBots isn't opened, and the
  largest part of a local load's 6.6 MB of API answers. Serving images by URL (cacheable,
  deduplicated) and fewer messages up front would shrink it most.
- **Histories carry pasted screenshots inline** (base64 in the transcript JSON, up to 28 MB per thread on
  a real install): a first visit downloads and parses all of it, 158 ms locally and 543 ms at 4× for the
  10.2 MB thread here, 640–915 ms over the remote link for 4.5–6.3 MB ones even when pointed at first.
  Attachments by URL would fix it.
- **A revisit still remounts the thread** (`LoadedChat key={chat.id}`), Composer included: "thread
  switch, again" is 49–53 ms at 1× and 104 ms at 4×, the same as before this work.
- **After a sidebar edit of an opened thread**, its history is fetched again once (its version changed);
  correct, and no more than the full PUT's response used to send.
- **Startup is still a chain**: auth check → config → thread list (and the routed thread) → render; each
  link is a round trip on a remote link. Runtime probes may also hold the browser's six connections
  per host meanwhile: on the first page load against a freshly started server, answers a reload gets in
  1–30 ms (auth status, state, the thread list) took ~340 ms, arriving about when the slow probes did
  (Claude's models 489 ms, Pi's status 384 ms; Cursor's and Grok's models and the runtimes' status
  hadn't answered when the thread was on screen). That fits connections held by probes, but no trace
  confirms it yet. On reloads every answer took 30 ms or less.
- **Saving a large chat** re-serializes all of it on the server (synchronously), and rebuilds its summary.
- **Bun 1.3.8's bundler now and then never finishes a build**, spinning at full CPU instead: building
  the app with `server/client.ts`, as production does now, it did in 4 of 60 fresh processes; serving
  it through Bun's HTML route, as production did before, in 10 of 60. Either way the server answers
  the API but never the page until it's restarted. Never seen on Bun 1.4.0 (0 of 110). `install.sh`
  still accepts 1.3.8, so tests that build the app give up on a stuck build and start
  again (`serveFixture`, `tests/productionClient.test.ts`). Requiring Bun 1.4, or building in a process
  the server can kill and start again, would take it out of production.
- **`bun test` on many-core machines**: an HTML import route (or Bun.build inside the test process) can
  fail to resolve a large page's imports at random; Chrome fixtures are built by `bun build` in a process
  of their own (`serveFixture` in `tests/chromePage.ts`).
