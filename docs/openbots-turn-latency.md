# OpenBots: what a turn costs, in seconds, requests and tokens

A new user asked a bot on Opus to "write a file in /tmp and read it" and waited over 50 seconds;
Claude Desktop does it in 5 to 10. This is where the time and the tokens went, what was changed,
and how to measure it again.

## Measuring a turn

`bun scripts/bot-turn-timeline.ts --model <provider/id>` starts the bots server from the checkout on
a throwaway data directory, a Pi set up like nobody's and an empty key store, sends the task through
the app's own route to a new bot (cold), then again (warm), and with `--idle` once more after the
bot's Pi was closed. It writes down every step: the route and the wake, each Pi process and RPC,
each model request (first token, end, tokens, cache), each tool call (in Pi and in the server's
handler), each `claude` process the Claude Code bridge starts, and each message. It runs real model
requests on the user's own sign-in, and prints times, token counts and tool names only.

For a `claude-code/…` model the bridge writes its own steps when `PI_CLAUDE_CODE_TRACE` names a
file (the script sets it): when `claude` was started, when it called the API, when the first bytes
came back, and how big the request's tool declarations, system prompt and messages were. Times
and sizes only.

`--cold n --warm n` repeat it, `--json` keeps the timelines, `--no-standby`, `--starter` and
`--search` switch single changes off or on to compare them. `bun scripts/bot-turn-metrics.ts`
(#268) reads the same waits from the turns an installation really ran.

## Where the time went

A new bot on Opus 5.5 at default effort, through the bundled Claude Code bridge, on a fresh
installation. Medians of 3 cold and 9 warm turns each, the two runs back to back on one machine
(16 cores, load average 20 to 36 throughout). "Before" is `origin/main` at #321.

| | Before | After |
| --- | ---: | ---: |
| **Cold: message to reply** | **20.3 s** | **8.7 s** |
| Cold: message to bot idle | 22.8 s | 8.7 s |
| Cold: model requests | 5 | 2 |
| **Warm: message to reply** | **12.1 s** | **5.9 s** |
| Warm: message to bot idle | 15.9 s | 5.9 s |
| Warm: model requests | 4 | 2 |
| After the bot's Pi idled out: message to reply | not measured | 8.3 s, 2 requests |

Step by step, cold:

| Step | Before | After | What changed |
| --- | ---: | ---: | --- |
| Route, wake | 0.03 s | 0.03 s | |
| A second Pi, started only to list context windows | 2.5 to 3.0 s | 0 | Windows are kept in the bots database and asked of the bot's own Pi after a turn |
| The bot's Pi up, model and effort set | 1.0 s | 2.0 s | It is the first process now, so nothing has warmed it |
| The extension's context call | 1.9 to 2.5 s | 0.00 s | The machines note no longer runs `podman info` |
| A request that only loads tools | 3.3 s | 0 | The shell is declared from the start |
| Starting `claude`, per request after a tool call | 0.7 to 1.0 s | 0.12 to 0.33 s | A process is kept on standby |
| The API, per request (first byte 1.9 s, then the stream) | 2.5 s | 2.5 s | The provider's own |
| write, read, bash themselves | 0.00 to 0.2 s | 0.00 to 0.2 s | |
| send_message | 1.7 s | 0.03 s | The first bubble isn't held as if typed |
| A request after the reply, only to end the turn | 2.5 to 3.1 s | 0 | The turn ends on the last message |

The 50 seconds weren't reproduced on this machine. They are the same shape on a slower one: half of
the cold turn was process start-up (two Pi starts, a `claude` per request, `podman info`), which
scales with the machine, and the rest was five model requests one after another.

## Round trips

Each model request through the bridge is about 2.5 seconds at the API, whatever it says, so the
number of requests decides the turn.

- **Loading tools.** Every bot's Pi now declares `bash` besides the core (`STARTER_TOOLS` in
  `server/bots/toolPreload.ts`), with its usual tools in what's left of the budget. In real turns
  on this installation `bash` is used in 34% of turns, `read` in 0.2%. Declaring `read` and `write`
  as well was tried and is slower: with them the model writes and reads in separate steps (3
  requests, 11.2 s cold), with the shell alone it does both in one command (2 requests).
  A bot still loads a tool by name once per session when it isn't the shell, isn't one of its usual
  tools (used in 2 turns of the last 7 days, within the budget) and wasn't loaded in that session
  before. A session lasts until 24 hours or 8 MiB, per chat, so that is at most a request a day per
  chat and set of tools; a restart of Pi or of the server keeps what the session had loaded. Over
  the last 7 days here 7.7% of turns loaded a tool first, 2.0% of all requests.
- **The request after the reply.** After a tool's result Pi asks the model again, and after the
  bot's last message that request had nothing to say but that it was done: 2.5 to 3.1 seconds and
  the whole prompt once more, in every turn that replied. `send_message` takes `done: true`, and the
  extension marks that result terminating (Pi's `terminate`), so the run ends there. Only when the
  message really went out: one held back because something new arrived ends nothing. Pi stops only
  when every result of the step is terminating, so a last message sent beside other work doesn't
  cut that work off. A question card ends the turn the same way, by its own rule.
  The risk is a model that marks a first "on it" note as done and stops before the work. Opus 5.5
  and GPT 6.1 Sol both used it as meant here: GPT's note went out without `done`, and its turn
  carried on through the work to a last message with it.
- **The reply itself.** It has to follow the tool result it reports, so it is a request either way.
  With `done` it is the turn's last one: sending it through `send_message` costs no request more
  than a plain-text reply would.

## Tokens

The same two runs. Prompt tokens are input, cache reads and cache writes together.

| Per turn | Before | After |
| --- | ---: | ---: |
| Cold: prompt tokens | 34,227 | 12,079 |
| Cold: of them read from cache | 87% | 75% |
| Cold: output tokens | 417 | 255 |
| Warm: prompt tokens | 34,033 | 14,102 |
| Warm: of them read from cache | 97% | 96% |
| Warm: output tokens | 423 | 263 |

The cut is the round trips: each one re-sends the whole prompt. Caching was already hitting (97%
warm), and a cold turn's share is lower now only because its one uncached request is one of two
instead of one of five.

What a request is made of, for the first request of a new bot's first turn on a fresh installation
(characters of JSON as sent to the API, and tokens by share of the request's measured total):

| Part | Before | After |
| --- | ---: | ---: |
| Tool declarations | 7,383 chars, 7 tools, about 2,540 tok | 8,379 chars, 8 tools, about 2,920 tok |
| System prompt | 8,748 chars, about 3,010 tok | 7,159 chars, about 2,490 tok |
| Messages (the prompt, Claude Code's environment note) | 1,501 chars, about 515 tok | 1,542 chars, about 535 tok |
| The request | 6,064 tok | 5,944 tok |
| Each further turn adds to the history | about 2,200 chars, 750 tok | about 1,450 chars, 520 tok |

The after column declares the shell (990 characters) and `send_message`'s `done` (395), which
together save two requests a turn. What was cut:

- **The web search guide** (when to search, each provider, how to cite) was in every request of
  every bot: 2,089 characters with two providers set up. A bot that hasn't loaded `bot_web_search`
  now gets one line saying search is there and with which providers; the guide comes with the tool,
  in `load_tools`' result and in the context from then on. The extension's `context` call says
  which tools are active, and one that doesn't say gets everything, as before.
- **How apps work**, the same way: about 770 characters down to one line (86 with none connected,
  else the apps by name), until `apps` or `use_app` is loaded.
- **The machines note** explained choosing between machines to bots that have one: 716 characters
  down to about 230 when nothing is paired.
- **The rules for polls** (426 characters) go to a bot that is in a group, where polls are.
- **The status line's rule** was repeated in full in each of the 19 tools that take one (417
  characters each) and stated in the prompt as well. Each tool keeps what the call needs (231):
  declaring all 27 tools went from 39,710 characters to 36,571.
- **A bot's own messages** came back to it in the next prompt's transcript as lines it had "already
  seen", though they are in its session as the calls that sent them. They're left out now, until
  they change (a reaction, an answer). Only in the session that wrote them.
- **A sent message's result** was the whole id as JSON (197 characters); it's the short id every
  later reference uses (45).

Left as it is: the prompt's guidance on how to behave (about 5,400 characters), which is a question
of bot behaviour and not of size.

### Does a smaller prompt answer sooner?

Hardly. Across 6,039 model requests in this installation's own bot sessions (short replies, read
with the cache hitting), by prompt size:

| Model | 20 to 50k tokens | 50 to 100k | 100 to 200k | Cache missed |
| --- | ---: | ---: | ---: | ---: |
| Opus 5.5 (bridge) | 3.1 s | 3.3 s | 3.2 s | 5.0 to 5.4 s |
| Sonnet 5.5 (bridge) | 1.3 s | 1.4 s | 1.7 s | 1.9 to 2.1 s |
| GPT 6.1 Sol | 2.7 s | 3.2 s | 3.3 s | 3.1 to 3.7 s |

A thousand tokens fewer is worth about 5 milliseconds; a missed cache costs 0.7 to 2 seconds. So
the trims above are for the bill, and what matters for speed is that the cache keeps hitting and
that requests are few.

The larger number is the history. A request in these sessions carries 67,000 prompt tokens at the
median (117,000 at the 90th percentile), against about 6,000 for the always-on part: sessions grow
until they compact at 131,072 tokens. Compacting sooner would cut that and costs a model call and
detail each time; it isn't changed here.

## The Claude Code bridge: a process on standby

A request that follows a tool call can't carry on in the `claude` process that made the call, so
each one started a new process and waited for it to come up: 0.7 to 1.0 seconds here, more on a
slower machine, at every step. One process per session is now kept started and unused beside the
one in use (`server/bots/claude-code/claude-cli.ts`). A request that needs a new process takes it,
and its replacement starts while that request is at the API. A standby holds no conversation, so it
is the same as a process started on the spot. It is for one launch (model, system prompt, tools):
when those change, as after `load_tools`, it's closed and the request starts its own. It is closed
when a response ends the run without a tool call (the next request carries on in the kept process),
with its session, and after five minutes unused, which is how long a kept process lives. One that
died while it waited is passed over, and a request that fails on one before reaching the API is run
once more on a fresh process. `PI_CLAUDE_CODE_STANDBY=0` turns it off. It costs one more `claude`
process (about 250 MB) per bot while that bot is in a turn.

## A command that left something running

`sleep 6 & echo started` held its bash call for 6.2 seconds though the shell had exited after 0.2:
the call waited for the command's output to close, and a child that inherits it keeps it open. A
server started with `&` held the call until the timeout, which then killed the server and failed a
command that had worked; before that, at 9 seconds, the call was handed to the bot as a background
job "still running". Now the call returns when the shell exits (0.4 s for the command above), with
a note that something it started is still running; that keeps running, as from a terminal, and its
later output is read and dropped. The timeout still stops the whole group.

## Not changed

- **The API's own time**, about 2.5 seconds a request on Opus 5.5 at default effort. At `low` effort
  the same warm turn took 8.3 seconds before these changes against 12.3; the default is left alone.
- **Starting the bot's Pi when its chat is opened**, which would make a cold turn warm (2 seconds
  here). The app has no signal for it yet.
- **The login shell** each bash call starts in (`bash -lc`), 0.13 seconds of every call.
