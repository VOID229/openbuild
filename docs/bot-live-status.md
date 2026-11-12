# Bot live status

A working bot's status (`BotStatus.activity`) names the step it is on right now. The runner reads it
off Pi's event stream (`server/bots/steps.ts`) and sends it in the same tick as the record that
changed it. It never says "Thinking".

## What the line says

In order of precedence:

1. **A tool call.** The bot's own `status` argument for the call ("Checking why the build failed"),
   else what the call reads, runs or opens ("Reading notes.md", "Opening example.com"), else the
   tool's name ("Using linear create issue").
2. **Pi's own waits.** "Summarizing the conversation so far" during compaction, "Trying again"
   while Pi waits to retry a failed model call, "Trying another model" when a fallback takes over.
3. **"Writing a reply"** while text streams, or a message is being written or sent. Not for a
   `[silent]` in the making, nor for text after a message already went out (that text is never
   posted).
4. **Plain working words** when nothing above applies: "Working on it", "Getting it done" and the
   rest of `WORKING_PHRASES` (`shared/bots.ts`). Each time a step ends, the line moves on to the
   next phrase, so it visibly changes at that moment.

Between turns, a bot with background jobs still running reads "Waiting on: …" with the job's own
line (`server/bots/jobs.ts`). A job takes that line from the status of the call it grew out of.

## When it changes

| Pi record | Status |
|---|---|
| Turn start (before Pi is asked) | "Working on it" |
| `toolcall_start` | The tool's generic line, as soon as the model starts writing the call |
| `toolcall_delta` | The call's own line once that argument is complete in the stream |
| `tool_execution_start` | The same line, now running |
| `tool_execution_end` | Gone at once: another tool still running, the next call, or plain words |
| `turn_end`, a new assistant `message_start`, `agent_settled` | Every step of the last response is dropped |
| `message_end` with `error` or `aborted` | Calls that were being written are dropped |

Steps are told apart by Pi's tool call id, never by tool name: tools from one response can run side
by side, and the same tool can run twice. With several running, the newest shows; when it ends, the
one still running shows again.

`status` leads every work tool's schema (`server/bots/extension.ts`), and a page's `title` leads
`html_render`, so the model writes them first and the line is specific while the rest of the call
(a whole file's text, a page's HTML) is still streaming. A model that writes them later only delays
the specific line to the end of the call; the generic one still shows from `toolcall_start`.

A status event goes out only when the line, its quietness or its thread changes, so a long stream
of deltas sends one or two events. A step starting or ending always sends one. Records that trail
in after the turn is over send nothing.

## In the app

The chat's working row, the header's line on a phone and the sidebar's preview read the same status
through `src/lib/bots/activity.ts` (`workingLine`, `liveLine`). A status with no activity, or the
"Thinking" a paired device's older server still sends, reads as "Working on it" (`statusLine`).
While a bot writes, the header and sidebar say "Writing a reply".
