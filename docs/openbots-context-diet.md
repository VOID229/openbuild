# OpenBots: a bot's context on a diet

[The turn-latency pass](openbots-turn-latency.md) (#323) got a new bot's turn down to two model
requests and about 12,000 prompt tokens. This pass measured what bots really carry and wait on once
they have history, and cut what didn't earn its place. Everything below was measured first: on two
days of this installation's own turns (read-only, numbers only), and on throwaway instances started
from the checkout. The live server was never restarted or written to.

## What was measured, and how

- **Real turns**: `bots/usage.jsonl` (`bun scripts/bot-turn-metrics.ts --since …`) and copies of the
  session files written after #323 went live: 550 turns, 2,110 model requests, 13 bots, from
  2026-11-14 14:45 to 2026-11-16 05:19 UTC. Aggregates only: sizes, counts, times.
- **A turn on a throwaway instance**: `bun scripts/bot-turn-timeline.ts`, which now also takes
  `--device` (a paired device that never answers, as a sleeping laptop is), several `--task`s, and
  writes down what each turn's context was made of (characters per system prompt section, the
  prompt's size).
- **Summarizing**: `bun scripts/bot-compaction-bench.ts`, new. It starts a Pi exactly as the runner
  starts a bot's, hands it a long session (a made-up one with facts planted in it, or a copy of a
  real session file), asks it to compact, and reports seconds, the summary's size and the request's
  tokens. `OPENBOTS_SUMMARY=pi` gives Pi's own summary, as before.

"Before" is `main` at #352. Before and after ran interleaved, one fresh server each, on the same
machine, a new bot on Opus 5.5 through the bundled Claude Code bridge.

## What real turns looked like

| | Two days of real turns |
| --- | ---: |
| Model requests per turn: mean / p50 / p90 | 4.2 / 3 / 8 |
| Prompt tokens per request: mean / p90 | 74,000 / 119,000 |
| Prompt tokens per turn: mean | 307,000 |
| Read from cache / written to cache / uncached | 93.0% / 6.2% / 0.8% |
| Message → prompt sent: p50 / p90 | 2.7 s / 3.6 s |
| Message → first tool call: p50 | 9.3 s |
| Message → first reply: p50 | 14 s |
| Turns that summarized the session first | 6% (32 of 550) |
| One summary: median (range) | 59 s (32 to 130 s) |
| A summary's size: median (range) | 14,200 characters (5,200 to 23,000) |
| Turns whose last request said only `[silent]` or nothing | 43% (234 of 550), 11.4% of all prompt tokens |

What a request carried, by share of the characters in the session files (tool declarations, about
4,000 tokens a request, aren't in those files):

| Part | Share |
| --- | ---: |
| Tool results | 38% (the shell 22%, apps 10%) |
| Thinking signatures (opaque; the Claude bridge doesn't replay them) | 22% |
| The turns' prompts (transcripts, notes) | 14% |
| System prompt | 7% |
| Tool call arguments | 6% |
| The summary of what was compacted | 4% |
| System prompt sections sent again because they changed | 4% |
| The model's own text and thinking | 4% |

Three things stood out, and none of them was the always-on prompt:

1. **Every turn waited 2.5 seconds before its first model request**, on a Pi that was already
   running too (p10 2.52 s, p50 2.54 s, p90 2.68 s over 341 turns). See the machines note below.
2. **Summarizing took a minute**, in front of the user, in one turn of sixteen.
3. **Two turns in five spent a whole model request on ending**: about 3 seconds each and the entire
   context once more, to say `[silent]`.

## What changed

### 1. A turn never waits on a paired device that doesn't answer

A bot's context lists the machines it can reach, and asked every paired device what it allows
before each turn's first model request. A device that doesn't answer (a laptop that's asleep)
takes 5 seconds per address to give up on; the note waited 2.5 seconds for it, then went ahead and
listed **every** device as "not checked yet". On this installation that was every turn of every
bot: all 28 machines sections sent in those two days said "not checked yet".

Now the note is said from what each device last answered, and they're asked again behind the turn
(`server/bots/machines.ts`): at most once a minute, given 150 ms, and the server asks once as it
starts. Only the first note after a start, with nothing known yet, can wait. How bots are kept
apart on a machine and which devices are paired are still read at the moment of the note.

| With a paired device that doesn't answer | Before | After |
| --- | ---: | ---: |
| The extension's context call, every turn | 2.50 s | 0.00 s |
| What the bot is told of its devices | "not checked yet", all of them | what each last answered |

### 2. Summarizing: a third of the time, under a third of the size

Pi's own compaction is a request at the bot's full thinking level, with a prompt written for coding
sessions that tells the model to "preserve all existing information" of the last summary, so
summaries only grow. The bots extension now answers Pi's `session_before_compact` itself
(`server/bots/extension.ts`, `summarize`): the bot's own model with the least thinking it takes, a
prompt for what a bot needs to carry on (what it's in the middle of, what it's waiting on, facts
it would otherwise have to ask for again, a line each for the rest), at most 750 words, told to
fold the last notes in and drop what's settled. The summarizer reads the session as a transcript
with each tool result cut to its start and end. If the model fails, runs out of room or writes
something that isn't notes, Pi's own summary takes over, as before. `OPENBOTS_SUMMARY_TRACE` names
a file that's told why (the reason only); it's best-effort, and a path that can't be written never
gets in the way of that hand-over.

Six of this installation's real compactions, replayed on copies of the session files cut right
before each one, and a made-up 100,000-token session with eight facts planted in it:

| Session | Before: time | summary | tokens written | After: time | summary | tokens written |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Real, its 1st compaction (Opus) | 55.3 s | 12,040 chars | 6,097 | 20.4 s | 4,423 chars | 1,913 |
| Real, its 1st (Opus) | 63.8 s | 16,756 | 7,102 | 23.7 s | 5,442 | 2,271 |
| Real, its 2nd (Opus) | 47.5 s | 8,934 | 3,981 | 22.9 s | 4,611 | 2,167 |
| Real, its 3rd (Opus) | 63.8 s | 12,643 | 7,230 | 17.4 s | 3,967 | 1,753 |
| Real, its 3rd (Opus) | 85.2 s | 19,888 | 10,040 | 20.1 s | 4,019 | 1,821 |
| Real, its 12th (Opus) | 76.2 s | 19,077 | 9,353 | 12.1 s | 2,500 | 1,173 |
| **Median of the six** | **63.8 s** | **14,700** | **7,166** | **20.3 s** | **4,221** | **1,867** |
| Real, its 5th (GPT 6.1 Sol) | 129.7 s | 23,015 | 6,227 | 36.0 s | 4,235 | 1,066 |
| Made up, 100k tokens (Opus) | 23.6 s | 5,141 | 2,063 | 10.0 s | 1,833 | 688 |

"Before" for the real ones is what the live server took at the time; three of them replayed here
with Pi's own summary took 57.7, 70.4 and 71.0 seconds, so it isn't the machine. The summarizing
request reads about as much as before (29,000 to 76,000 tokens; the extension's transcript is a
little shorter than Pi's). Both summaries of the made-up session kept all eight planted facts. On
the real ones, the short summaries keep 23 to 63% of the ids, paths, links and numbers the long
ones had, and about half to nine tenths of those from the newest part of the session: by design,
they drop what's finished.

**A smaller model was tried and left out.** The one a Claude bot has through the bundled bridge is
Haiku 4.5: 7 to 11 seconds a summary, twice as fast again, but 2 of 9 summaries of real sessions
weren't summaries (it tried to call a tool, or answered as itself). `OPENBOTS_SUMMARY_MODEL` names
a model to try first for anyone who wants one; the bot's own is always the fallback.

### 3. A session compacts at 80,000 tokens, not 128,000

Every request reads the whole session, and a session grows until it compacts, so the compaction
point decides what a request costs. Replaying the growth of those 2,110 real requests under other
settings (`context` is the mean of what a request carries):

| | Context per request | Compactions |
| --- | ---: | ---: |
| 128k, as it was (the replay; really: 74,358 and 32) | 73,800 | 32 |
| 80k | 51,100 | 69 |
| 80k, with the shorter summaries | 48,700 | 66 |
| 80k, shorter summaries, long tool output cut (below) | 49,500 | 58 |

A third fewer prompt tokens per request, for 1.8 times as many compactions, each a third as long:
about 19 minutes of summarizing over those two days instead of 32. Lower than this the summaries
start to cost more than the context they save. It also costs detail sooner, which is what the
summary's "Facts" and "Open" headings, the bot's memory and its message search are for.

### 4. A turn ends on its last call, whatever that call is

Since #323 a last message with `done: true` ends the turn. But 234 of 550 real turns still ended
on a request that said only `[silent]`: 114 of them after a reaction, a memory or a routine that
was the turn's last act and had no way to say so, 51 after a message sent without `done`.

- `react`, `memory`, `todo` and `routine` take `done` too. The call ends the turn when it went
  through and came back with nothing the bot has to read (a memory much like an older one comes
  back with something to check, and doesn't end anything).
- A call that says `done` speaks for the bookkeeping calls beside it: a memory saved in the same
  step as the last message no longer keeps the turn going. A call that does work (the shell, a
  coding thread) never ends a turn, so its result is always read.
- The prompt says it once ("A turn ends on its last call when that call says done true…"), and
  `send_message`'s own `done` says to set it every time.

With the real model (medians of four fresh servers each, a paired device asleep; the card without one):

| Turn | Before | After |
| --- | --- | --- |
| "thanks!" (the bot reacts) | 2 requests, 13,774 prompt tokens, idle after 10.1 s | 1 request, 6,894 tokens, 4.1 s |
| "great, that's all for now" | 2 requests, 16,350 tokens, 10.2 s | 1 request, 7,996 tokens, 4.3 s |
| "remember that I prefer tea over coffee" | 2 requests, 14,444 tokens, 10.6 s | 2, 2, 1 and 1 requests (10,826 tokens), 6.6 s |
| "ask me with a question card…" | 2 requests, 12,533 tokens | 1 request, 6,273 tokens |

The last row is a regression this pass found on `main` and fixed: a card's result always comes
with a note ("stop here and wait"), and since #322 any note kept the turn going, so every card cost
a request that said `[silent]` (6 of the 8 card-only steps in the two days). A card ends the turn
again; a message's note (an @tag that reached nobody) still doesn't.

### 5. Long tool output reaches a bot as its two ends

Tool results were 38% of what a request carried, and most of that came from a few long ones: one
shell call in eight printed over 10,000 characters and those were half of all shell output; an
app's answer could be 60,000.

- **The shell**: output up to 13,200 characters comes back whole. A longer one comes back as its
  first 4,000 and last 8,000 characters (where a command says how it went), and all of it (up to
  200,000) is kept in `~/.outputs/bash-N.txt` in the bot's own home on that machine, where it can
  `grep` it. Twenty files per bot, reused in turn.
- **Its result is plain text**: what the command printed, then only what isn't the usual (a failing
  exit code, something left running, another machine). It was JSON around the output, with every
  newline and quote escaped and `"exitCode": 0` each time: 4% more characters over 631 real results.
  A background job's result is said the same way.
- **An app's answer** (`use_app`): the first 13,000 and last 3,000 characters, the whole kept in
  `~/.outputs/app-N.txt`.
- **`read`** returns a file's first 24,000 characters by default (it was 80,000) and now says how
  much is left and where to read on from: a part of a file was never told apart from all of it.

Applied to the tool results of those two days: 6.78 million characters become 4.27 million, 37%
fewer (the shell's 36%, apps' 46%).

With the real model, told to run `seq 1 20000` as written, then asked for its 12,345th line, then
thanked (two fresh servers each, the same every time):

| | Before | After |
| --- | ---: | ---: |
| What the command put in the session | 137,129 characters | 14,557 |
| Prompt tokens of every later request | about 80,000 | about 13,000 |
| The three turns together | 325,500 prompt tokens | 57,550 |
| "What was the 12,345th line?" | read off its 80,000-token context | `sed -n '12345p' ~/.outputs/bash-1.txt` |

One thing the measuring caught: saying in the shell tool's description that long output gets cut
made the model stop filtering its own (`seq 1 20000` where it had run `seq 1 20000 | tail -n 1`).
The description now asks for only what's needed and says nothing of the cut.

### 6. What a bot adds itself isn't sent to it again

Pi sends a whole system prompt section into the conversation again whenever its text changes. A
bot's own writes changed two of them constantly: its memory section went again 121 times in those
two days (2,800 characters each) and its routines 120 times, and each copy stayed in the session
until it compacted: 4% of what a request carried. The bot already has what it just wrote, as the
call that wrote it.

A section now stays as the session last got it while the only difference is something that same
session added, and still is exactly as it added it (`server/bots/agent.ts`, `steady`). Only the add
is held back, not the item: anything else sends the section afresh, at once. That's a memory
written in another chat's turn, one changed, replaced or forgotten, a routine paused, resumed,
removed or run, the user's edits, and all of those just the same when the memory or routine is one
the session added itself (pausing a routine it just added sends the section with `[paused]`). So
does a Pi that just started or just summarized its session, which may no longer hold those calls.

### 7. Smaller things

- **What every turn's prompt ends on** was 214 characters, 7% of all the prompts said in those two
  days. It's 90: "Reply with send_message, done true on your last call. Nothing to say: reply only
  [silent]."
- **The primary bot's paragraph** listed each `manage_bot` action and its parameters (1,070
  characters, every request); those are in the tool's own description, which the bot reads when it
  loads the tool. It's 640 now.

## The result, on a throwaway instance

A new bot on Opus 5.5 through the bundled bridge, with a paired device that doesn't answer (as
this installation has). Five turns in a row; medians of four fresh servers each, before and after
interleaved. "First status" is the chat showing the bot at work; "first token" the model's first
sign of life.

| Turn | | Requests | Prompt tokens | From cache | Context call | First status | First token | First reply | Bot idle |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| "write a file in /tmp and read it" (first turn, Pi not started) | Before | 2 | 12,882 | 75% | 2.5 s | 0.01 s | 7.0 s | 11.0 s | 11.0 s |
| | After | 2 | 13,084 | 69% | 0.0 s | 0.02 s | 4.0 s | 9.6 s | 9.6 s |
| "thanks!" | Before | 2 | 13,774 | 97% | 2.5 s | 0.01 s | 6.4 s | (a reaction) | 10.1 s |
| | After | 1 | 6,894 | 96% | 0.0 s | 0.01 s | 3.5 s | (a reaction) | 4.1 s |
| "remember that I prefer tea over coffee" | Before | 2 | 14,444 | 96% | 2.5 s | 0.02 s | 5.3 s | 10.6 s | 10.6 s |
| | After | 1.5 | 10,826 | 97% | 0.0 s | 0.02 s | 3.7 s | 6.6 s | 6.6 s |
| "run seq 1 20000 … tell me the last number" | Before | 2 (3 once) | 15,531 | 65% | 2.5 s | 0.02 s | 4.7 s | 10.9 s | 11.0 s |
| | After | 2 | 15,327 | 97% | 0.0 s | 0.02 s | 3.7 s | 9.6 s | 9.6 s |
| "great, that's all for now" | Before | 2 | 16,350 | 99% | 2.5 s | 0.02 s | 6.2 s | (a reaction) | 10.2 s |
| | After | 1 | 7,996 | 96% | 0.0 s | 0.01 s | 3.7 s | (a reaction) | 4.3 s |
| **All five turns** | Before | **10** | **73,156** | | 12.5 s | | | | **55.3 s** |
| | After | **7.5** | **54,142** | | 0.0 s | | | | **33.9 s** |

In one of the four "before" runs the bot printed all 20,000 lines instead of piping through `tail`,
and each later request of that run carried 81,000 tokens (that run's five turns: 373,000 prompt
tokens); the medians above hide it. The cold turn's lower cache share is its one uncached request
being one of two; the cache hits as before on every warm turn.

What the first request of a new bot's first turn is made of hardly moved, and wasn't the target:

| Part | Before | After |
| --- | ---: | ---: |
| Tool declarations (8 tools) | 8,990 chars | 9,309 chars |
| System prompt | 7,736 chars | 7,879 chars |
| Messages (the prompt, Claude Code's environment note) | 1,547 chars | 1,423 chars |
| The request | 6,344 tokens | 6,452 tokens |

It's 108 tokens more: `done` on `react` and `memory` and the sentence on how a turn ends, against
the shorter closing line. A primary bot's always-on text (`bun scripts/bot-prompt-size.ts`) went
from 11,118 to 10,859 characters.

## What to expect on a real installation

From the two days of real turns, replayed:

| | Before | After (replayed or measured as said) |
| --- | ---: | ---: |
| Wait before a turn's first model request (a paired device asleep) | 2.5 s, every turn | 0 |
| Prompt tokens per request | 74,000 | about 49,000 (the replay above) |
| One summary | 59 s | about 20 s (six replays) |
| A summary's size | 14,200 characters | about 4,200 |
| Summarizing, over the two days | 32 min (32 times) | about 19 min (58 times) |
| Turns that spend a request only on ending | 43% | about 27%, if bots say done on these calls as often as they do on messages (65% of the time); in the runs here they did every time |

`bun scripts/bot-turn-metrics.ts --split <when this went live>` shows the real thing afterwards:
each turn's line now also says whether the turn ended on a call and how long it spent summarizing.

## Not changed, and why

- **The always-on prompt's guidance** (about 5,400 characters) and the tool descriptions, beyond the
  two trims above. Together they're about 7,000 of a request's 74,000 tokens, read from the cache.
- **The transcript a turn's prompt carries**: the roster of a group and its to-do list go with every
  prompt there (about 1.2% and 1.5% of a request). Leaving them out when unchanged would need the
  runner to know when a session compacted them away.
- **A small model for summaries**: see above. Worth trying again when the bridge offers a newer one.
- **Summarizing between turns**, when nobody is waiting, so a turn never stops for it. It needs the
  runner to hold a new message until the summary is in or to cancel it cleanly, and would only move
  the wait: left for a pass of its own.
- **Cache misses after an hour idle** (75% of turns that start then): that's the provider's cache
  lifetime. Under an hour, 6 to 9% of turns start on a miss, with no single cause.
- **Starting a bot's Pi before the user sends** (a third of turns start one: 0.7 to 1.4 s). It would
  hold a process per chat that was merely opened.
