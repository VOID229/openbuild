# OpenBots: steering between steps, and tool calls that outlive a turn

The aim is turn uptime: a bot should almost always be free to read the user's next message. Two
things kept it from that. A message that arrived mid-turn wasn't always handed to the turn at its
next step, and a turn inside a long tool call can't read anything until the call returns.

## Steering between steps

A message for the chat a bot is working in is steered into the running turn (Pi's `steer`): Pi hands
it to the model once the tool calls of the current step have returned, before the next model call.
Three gaps were left for messages to bots.

- **Pi handed over one queued message per model call.** That's its default (`steeringMode:
  "one-at-a-time"`): a second message written during the same tool call waited a whole further model
  call, and cost one. Each bot's `.pi/settings.json` now sets `steeringMode: "all"`, so everything
  that arrived while the tools ran goes in together. Checked on Pi 1.5.1: two steers during one call
  arrive in one request with `all`, in two with the default.
- **The window before the prompt.** Between a turn reading the transcript and sending Pi its prompt
  (setting the model and effort, which is several RPCs and can be slow), a new message was neither in
  the prompt nor steerable, so it queued for a turn of its own after this one. It's now held and
  steered in right behind the prompt (`Mind.starting`, `held`). If the turn never reaches a prompt
  the held message gets its own turn; a stop drops it, as it does a queued one.
- **The tool call itself.** Pi can't hand a steer over until the step's calls return, and that is
  where the wait is long. This is what the job board below is for.

Left as they are on purpose: a message in another chat than the one the turn is in (each chat has its
own session, so it can't join that turn; it now frees the call holding the turn instead), unscoped
group wakes, and notes such as a job's result, which get a turn of their own.

The runner also follows which steered messages Pi has actually handed over (Pi announces each as a
`message_start` with role `user`), as `Mind.unread`. That is what "someone is waiting" means below.

## Jobs

A call to a tool that can run long (`DETACHABLE` in `server/bots/jobs.ts`: bash, read, write, edit,
browser, process, openbuild, use_app, bot_web_search) races a threshold on the server. If it returns
first, nothing changes. If not, the bot's Pi gets `{ job: N, state: "running", note }` as the tool's
result at once, the call carries on, and when it returns its result wakes the bot in the chat the call
was made from. There is no second session and no other model: the work is the same handler, still
running on the server.

Never detached: `send_message`, `question`, `poll`, `vote_poll`, `html_render`, `react`, `memory`,
`search`, and everything else that isn't in the list. Calls in a friend's chat and in a helper session
are waited out as before.

A detached call still acts where it was made: the conversation is pinned to the call's async context
(`getFocus` in `agent.ts`), so an `openbuild start` that finishes after the turn posts its line in the
right chat.

### The board

`jobs.board()` rides with every prompt and direct steer, like the clock, and is empty (zero tokens)
when nothing is running:

```
Your job board: what you have running in the background. …
- job 1, running for 14s: bot_web_search “flights to Lisbon”, for “Finding flights to Lisbon”
  then 1. Book a hotel in Lisbon for the same dates
```

"For" is the status line the bot wrote for the call. Follow-ups are the bot's own, queued with the
`jobs` tool (`follow_up`), and come back with the job's result. The `jobs` tool also lists, reads a
result and cancels; it is declared automatically from the request after a call detaches, and for half
an hour after a job ends.

### A result

The wake note says what the job was, hands over the result, and then what to read it against: the
follow-ups queued behind it, and how many messages the user wrote in that chat since the call was
made, by id. A result for a plan that has changed is to be dropped, not acted on. A cancelled job
reports nothing. The wake is a note, so a turn that ends `[silent]`, or only says there's nothing
new, posts nothing.

### Status

Between turns with jobs running, the bot's status is `working` with `jobs: n` and `activity:
"Waiting on: <the job's own line>"`, in the chat the job was started from. Other chats don't show it
as busy elsewhere, and `manage_bot status` reports it idle with `runnerState: "waiting"`.

### Cancelling, limits, restarts

- The bot cancels with `jobs cancel` (one, or all). A command or a web search is really stopped; an
  app call, a browser step or a merge can't be interrupted, so its result is dropped and the bot is
  told it may still go through.
- The user's stop (the word or the button) cancels a bot's jobs, and now also stops a command still
  holding the turn.
- At most `JOB_CAP` (4) jobs per bot. With four out, a further call holds its turn like any call used to.
- A job that hasn't returned after `JOB_MAX_MS` (30 minutes) is reported as failed and stopped if it can be.
- The board is kept in the bots database, results in `bots/jobs/<bot>/<n>.txt` (the last 12). A job
  that was running when the server went down has no result coming: on start its bot is told once.

## The numbers

Measured on this installation's own bot sessions with `bun scripts/bot-tool-latency.ts` (read-only,
numeric output only): 68 session files, 7,948 tool calls and 10,004 model calls, on 2026-11-12. A
model call takes 3.4 s at the median (p75 6.1 s, mean 4.9 s). That is the price of a detach: the
turn has to answer "started", and the result is handled one call later than it would have been.

### How long calls take

Of the 4,362 calls to tools that can detach, half return in under 0.3 s and 87.6% within 3 s. The
long tail is bash (p90 8.4 s, p99 93 s, max 420 s) and `openbuild merge` (p50 6.3 s, p90 8.8 s).
Everything else is under a second at the median. The bot's own messaging, reactions and memory never
come near either threshold (`send_message` p99 2.4 s, which was its typing delay: since 2026-11-14
only a bubble written right behind another is held, see [turn latency](openbots-turn-latency.md)).

### Detaching when nobody is waiting: 9 s

`left` is how much longer a call still running at T goes on. `wasted` is the share that would have
returned within one median model call of T anyway.

| T | detached | of calls | left p50 | left mean | tool time freed | wasted |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 3 s | 539 | 12.4% | 4.0 s | 13.7 s | 65.9% | 42.1% |
| 5 s | 422 | 9.7% | 3.2 s | 15.3 s | 57.5% | 51.2% |
| 6 s | 346 | 7.9% | 4.3 s | 17.5 s | 54.0% | 46.5% |
| 7 s | 267 | 6.1% | 6.6 s | 21.5 s | 51.3% | 36.3% |
| 8 s | 216 | 5.0% | 9.4 s | 25.5 s | 49.2% | 25.0% |
| **9 s** | **190** | **4.4%** | **11.1 s** | **27.9 s** | **47.4%** | **20.0%** |
| 10 s | 174 | 4.0% | 11.8 s | 29.4 s | 45.7% | 21.3% |
| 12 s | 159 | 3.6% | 12.1 s | 30.1 s | 42.8% | 23.3% |
| 15 s | 124 | 2.8% | 16.5 s | 35.3 s | 39.1% | 16.9% |
| 30 s | 64 | 1.5% | 30.2 s | 47.7 s | 27.3% | 12.5% |

With nobody waiting, a detach buys availability that nothing is using yet, so the bar is not to
detach a call that was about to return. The wasted share falls from 51% at 5 s to 20% at 9 s and
then stops falling: the cluster it clears is the merges, which at 5 to 8 s would be detached moments
before they finish. At 9 s a call still running typically has 11 s to go, three model calls' worth;
4.4% of these calls detach (2.4% of all tool calls); and 47% of all their tool time is freed, against
57% at 5 s. Waiting longer than 9 s gives time back without reducing waste.

### Detaching when someone is waiting: 3 s

A message arrives when it arrives, so the calls it lands in are sampled by how long they run. Over
the same calls, for a message landing at a random moment of that tool time:

| W | wait, mean | wait p90 | wait max | detaches | wasted |
| ---: | ---: | ---: | ---: | ---: | ---: |
| never (before) | 30.4 s | 86.8 s | 415.9 s | | |
| 0 s | 0 | 0 | 0 | 100% | 36.0% |
| 1 s | 0.08 s | 0.35 s | 1.0 s | 93.7% | 31.9% |
| 2 s | 0.21 s | 0.94 s | 2.0 s | 86.8% | 27.3% |
| **3 s** | **0.36 s** | **1.50 s** | **3.0 s** | **80.3%** | **23.8%** |
| 5 s | 0.69 s | 2.68 s | 5.0 s | 76.3% | 24.5% |
| 8 s | 1.22 s | 4.56 s | 7.9 s | 64.6% | 14.5% |

W counts from when the call started, not from the message: a call already past W is freed the
moment someone writes. Here a detach buys a waiting person their answer, so W is as low as the waste
allows. The wasted share falls until 3 s and is flat from there to 5 s, while the wait keeps growing.
At 3 s the worst case is 3 s plus a model call, against a mean of 30 s and a tail of minutes before.

How often it matters, from the same data joined with the chats: of the user's messages, 85% (direct)
to 94% (group deliveries) found the bot idle, 5 to 11% arrived during a model call, and 1 to 4%
inside a tool call. The 21 group deliveries that landed inside a call that can detach waited 9.3 s at
the median and 104 s at the 90th percentile (the 3 in direct chats, 1.9 s). It is rare, and long when
it happens.

### The shape of a result: whole up to 6,000 characters

An inline result is read by the turn that asked for it, at the moment it wants it. A job's result
arrives later, as a prompt, possibly after the plan changed, and stays in the session. Of the 216
results of calls that ran past 8 s: p50 560 characters, p75 2,037, p90 5,327, p95 8,733, p99 20,419,
max 50,275.

| whole up to | else a summary of | come whole | mean per wake | most per wake | of all characters |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 2,000 | 2,000 | 75.0% | 870 | 2,000 | 42.2% |
| 4,000 | 2,000 | 86.6% | 979 | 3,959 | 47.5% |
| **6,000** | **2,000** | **92.6%** | **1,166** | **5,977** | **56.6%** |
| 8,000 | 2,000 | 94.9% | 1,287 | 7,696 | 62.4% |
| 12,000 | 2,000 | 97.7% | 1,521 | 11,881 | 73.8% |
| always whole | | 100% | 2,062 | 50,275 | 100% |

Whole up to 6,000 characters (about 1,500 tokens, the 90th percentile rounded up): more than nine
results in ten need no second call. The rest hold half of all the characters, and come as a summary:
the size and line count, the first 500 characters and the last 1,500. The end gets more because four
in five of these are commands, which say how they went at the end. The summary is made by cutting,
not by a model. The whole output is one call away: `jobs` with `action: "result"` returns 20,000
characters a call, which covers 99% of results in one.

Raising the cap to 8,000 would spare 2.3% of wakes the second call, and cost 10% more characters
across all wakes; lowering it to 4,000 would send 6% more of them back for one.

## What this doesn't do

- Pi hands steers over after all the tool calls of a step, not after each. Several calls in one step
  each get their own threshold.
- A tool an extension of the user's brought doesn't go through OpenBots, so it can't detach. A message
  that arrives during one still gets the helper's quick reply, as before; for the bot's own tools that
  reply is gone, since the bot now answers itself.
- A job's partial output can't be read while it runs.
- Jobs don't survive a restart; their bots are told.

This needs the server restarted to take effect.
