# Bots' minions

A bot hands a task to a **minion**: a temporary worker bot of its own, in place of the coding agent
thread it used to start. Build (the user's own coding threads) is separate from bots now: a bot no
longer starts a thread there. Ported from KodBot (dkod-ai/kodbot #342, #346, #362, #364, #388, #397).

## What a minion is

A bot record with `minion` set (`shared/bots.ts` `Minion`: owner, task, chat, from, closedAt) and one
side chat with its owner (`Conversation.minion`). It runs as any bot does: the owner's message there
wakes it, the runner gives it a turn in a Pi of its own, its calls go through the same door. It
differs by:

- **Its prompt** (`server/bots/minions.ts` `sections`): do the task, sum up the result, send it to the
  owner. No team, memory, routines or instructions. Its turn ends on `MINION_CLOSING`, never `[silent]`.
- **Its tools** (`MINION_TOOLS`): `send_message`, `load_tools`, `bash`, `read`, `write`, `edit`,
  `bot_web_search`, `apps`, `use_app`, `jobs`. Its Pi registers no others (`OPENBOTS_MINION`), and the
  server refuses the rest (`minions.refusal`, in `agent.dispatch`).
- **Where it works**: on its owner's computers, on every machine (`machines.ts` `computerOn`). It has
  none of its own, so nothing is left behind when it goes.
- **Its settings**: its owner's model, effort and fallbacks as they were when it was made, check-ins
  off. `updateBot` refuses a change to any of them (`MINION_FIXED`); its name and look can change.

## The `minion` tool

`start` (task, name), `send` (minion, text), `list` (closed: true adds the closed ones), `close`
(minion) and `reopen` (minion). `retire` and `retired: true` are taken as close, the words KodBot uses.

- A name is required: a name for what it does ("Dashboard maker"), not the task. At most 4 words and
  32 characters, and no other bot's, closed minions' included.
- A bot has 5 open at a time (`MINION_LIMIT`). A minion can't make minions.
- `openbuild start` is refused for every bot (`NO_THREAD_START`), saying where the work goes. The
  rest of `openbuild` (list, read, send, answer, stop, close, pr, merge) is as it was, so threads a
  bot has from before can be followed and closed.

## Ownership

The bot that made it owns it. What the minion writes wakes its owner with a note, in the chat the
task came from (`service.ts` `tellOwner`); so does a turn of its that failed, was stopped or said
nothing (`minionWentQuiet`). A chat shared with a friend is never that chat. No other bot can name a
minion (`resolveBot`), no group, side chat or friend's chat takes one (`noMinions`), a `@mention`
doesn't reach it, and the user reads its chat without writing in it.

## Closing and reopening

Its owner closes it once its work is done (`closeMinion`): its Pi stops, its chat takes no more
messages, and every wake for it is dropped. Its owner reopens it for more of the same
(`reopenMinion`), within the limit, and it carries on in the same chat. The primary bot lists every
bot's minions and can close or reopen any; the owner is woken with a note when it does.

A minion closed for a week (`MINION_KEEP_CLOSED_MS`) is deleted on the clock's tick
(`cleanUpMinions`), with its chat, its session and its Pi's folder. Retiring a bot closes its open
minions; deleting a bot deletes its minions.

"Closed", not "retired" as KodBot says: here a retired bot is a team member the user paused
(`Bot.retiredAt`), and a minion is never that.

## In the app

- **Sidebar**: a "Minions" section, between the user's sections and "Between bots"
  (`sidebarOrder.ts` `minions`). A row is the minion's name tagged with its owner's ("Dashboard maker
  · Scout's"), its mascot with its owner's small at the corner. The collapsed rail has them as a group
  of their own. A closed minion's chat is in no list, the search included (`leavesSidebar`); a link to
  it still opens it, and its header says "Closed".
- **A minion's chat** has nothing at its bottom: no composer and no note. Its menu has no Delete: the
  chat goes with the minion.
- **Details panel**: a bot's and a group's Threads tab is **Minions**: the open minions, each opening
  its chat. Threads a bot still has going from before are listed under them, and open in the panel
  as they did.
- **Permissions** (a bot's Advanced tab, and Settings → Bots): two switches in place of the access to
  the user's threads.
  - **Spawn minions**: on for every bot; only "off" is saved (`Bot.spawnMinions`).
  - **Merge PRs**: off until the user turns it on, as merging always was. It's the same saved value
    (`BotThreadAccess.merge`), so a bot that could merge before still can. Off, `gh pr merge` in
    `bash` and `process` is refused for the bot and for its minions (`agent.ts` `mergeSwitch`), as
    `openbuild merge` already was.
- Settings → Bots → Harnesses stays (which harnesses the bots' `openbuild` tool offers), though with
  no thread to start it now changes only what `openbuild options` lists.

## What stayed

Build itself: its sidebar, threads, settings and server are untouched. A bot's saved grant over the
user's threads (`BotThreadAccess.enabled` and its projects) is still read by the remaining
`openbuild` actions and by the `plugins` tool, though the app no longer shows or changes it.
