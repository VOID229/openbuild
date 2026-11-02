# Thread lifecycle investigation

Investigation: 2026-10-24, against `7a54125` plus the fixes in this worktree.

Scope: Pi RPC sessions, Durable admission/recovery, reply transport, browser cancellation,
steering/queues, persistence, and read-only inspection of the server's saved session history.
This audit did not resume live threads, edit user transcripts, or restart the server. The
server independently went down at 10:25:31 and restarted at 10:26:20 local time during the
audit, losing its in-process background-agent handles; saved code changes survived and
were subsequently reviewed and verified directly. The shared Pi comms extension was also
patched on the iMac, with explicit user approval.

## Evidence from the reported sessions

### Repeated one-line confirmations: confirmed cause in Pi

Saved Pi session `7c4cf8e6-f565-402f-966f-0b3b13a6df41` finishes its substantive answer
at **2026-10-23 18:50:42 UTC**. Seven subsequent assistant confirmations each follow a
`custom_message` with `customType: "comms-message"`; an eighth notification is followed by
an aborted response. The messages are old subagent progress reports, delayed by as much as
roughly sixteen minutes. Examples include “That Composer work is already complete and verified.”

The shared extension queued every incoming message while busy with
`{ triggerTurn: true, deliverAs: "followUp" }`. Pi's one-at-a-time follow-up processing
therefore ran the model once per stale progress report after the real task had finished.
This particular trace is a finite backlog, not proof of an infinite provider/model loop.
It also explains why important coordination could arrive too late to be useful.

**Changed outside OpenBuild:** `~/.pi/agent/extensions/comms.ts` and
`extensions/lib/comms-delivery.ts`. Busy progress is now context-only: Pi inserts it at a
safe tool-result boundary without scheduling a separate follow-up. An idle inbox drain is
one batched wakeup. After an aborted run, late coordination cannot wake the model until
an explicit user run re-enables it. Message content and sender metadata remain available.
The prompt also discourages user-facing acknowledgments and receipt-only peer replies.
Existing Pi processes retain their loaded extension until reload/replacement; they were not
restarted as part of this investigation.

### Reported Pi session `2568cbf9-cca0-4af2-8948-87cd23eb4fe4`

The saved transcript contains one user input, nine completed bash calls and no terminal
assistant result. Commands return in milliseconds; the final tool result commits at
**2026-10-24 06:57:49.983 UTC**. The systemd journal records OpenBuild stopping/restarting
at **09:57:50 local time (06:57:50 UTC)**, immediately afterward. No abort result was
committed before that restart.

Afterward, discovery's recent-file heuristic classifies a transcript ending in a tool result
as externally streaming for up to ten minutes. At 10:05 local time, this thread was still
stored as streaming even though its original server process was gone. Later it settled as
stopped. An externally discovered transcript is not a reconnectable OpenBuild run, so the
original UI's Stop/steer actions had no live local generation/controller to act on.

This establishes the post-restart ghost-working/control mismatch. It does **not** establish
why a control attempt before the restart failed: historical Stop/steer requests and RPC
responses were not logged, and token-level in-flight provider state was not persisted.
Do not interpret the absence of a final response as a still-running shell command, or infer
a provider deadlock from this transcript alone.

### Reported Pi session `72831213-34fa-427f-a708-24f2b8ac4a0f`

At approximately 10:30–10:31 local time, this session was not deadlocked: its transcript
continued appending tool results, a test run finished, and it made further README edits.
Its live Pi peer was in a terminal process, not a child controlled by the current OpenBuild
server. The browser stored it as `{ via: "external", id: "" }`: transcript observation,
not a live RPC control connection. This is direct evidence for the read-only/control mismatch,
not evidence that every apparent hang is a backend hang.

The composer now visibly identifies external observation, disables the misleading Stop
button and does not offer steering/interrupt actions for those sessions. Commands must be
controlled in their owning terminal. The change reuses the existing mode label, buttons,
icons and tooltip styling; isolated composer renders were checked in light and dark themes.
Real resumable runs discovered by polling now acquire their client controller immediately.

### Earlier Durable hangs

Saved Durable thread `95684148-ea54-4123-a8cc-6a4d532215ee` and its prior rescue thread
record two roughly 45-minute waits in diagnostic shell commands: a process retained by a
backup timer and an unbounded browser test. All inspected Durable run manifests were ended
at investigation time. Default/max bash timeouts and rejected-UI-turn admission handling
were **already present** at this worktree's base; they are not new fixes claimed by this audit.

## Reproduced application defects and fixes

### Pi control and history

- A throwing event subscriber (including enqueue into a canceled UI stream) could terminate
  the only RPC stdout reader. Pi might keep working, but all later steering/abort responses
  went unread: a shared failure path matching the simultaneous loss of controls. Subscribers
  are now isolated so one observer cannot kill the control reader; direct source-stream
  cancellation also releases ownership safely. Offline fake-RPC tests reproduce both paths.
- Stop previously sent only `abort`. Queued work could continue after abort, and a tool or
  extension ignoring cancellation had no bounded subprocess fallback. Stop now drains
  steering preflight, clears queued work before abort, dismisses blocking dialogs, and
  escalates shutdown for an unresponsive Pi child.
- Abort listeners survived some handled-command/error exits. An old run's cancellation
  could then abort a later run. Cleanup now covers every exit.
- Rewind selected by `get_fork_messages[prior]`, which is a UI-oriented list rather than
  the authoritative active branch. Abandoned branch entries and image-only prompts can
  select the wrong history point and make earlier actions appear forgotten. Selection
  now walks the active persisted branch and counts user messages, including image-only input.

### Stop arriving before admission

An offline route reproduction confirmed another lost-control race: Stop returned `{ ok: true }`
while the original POST was still parsing its body, then that POST admitted a new Pi prompt
with an un-aborted signal. A bounded, hot-reload-safe stop-intent registry now remembers
cancellation even when no run exists yet. Late local admission returns a terminal aborted run
without invoking its producer; Durable persists cancellation on its eventual manifest and
settles it before submitting input. Tests cover both runtimes and cancellation while Durable
is awaiting its admission baseline. Intents have the same fifteen-minute retention window
as local reply replay; they are not cross-process distributed cancellation records.

### Browser execution and reconnect

- Waiting for workspace setup or a stalled response could prevent local cancellation from
  completing. Cancellation now has an independent abortable wait, header deadlines and
  raw-byte silence detection; blank transport heartbeats still count as healthy activity.
- An ordinary Stop automatically drained the pending message queue, immediately starting
  another action. Only an explicit interrupt opts into this behavior now.
- A second direct send could replace the per-thread run owner and orphan its old streaming
  message. Concurrent direct sends are rejected.
- Delayed stream/animation updates could overwrite an answer another writer had already
  completed. Updates now check message status, stream identity and generation ownership.
- Replaying the same prefix reset the reconnect failure deadline. A repeated “I'll
  investigate” prefix could therefore keep a failed reply alive indefinitely. Only progress
  beyond the replay high-water mark resets that deadline.
- Steering receipts can arrive after the reply ends. Finalization now accounts for in-flight
  steering admission so an already-handled instruction is not blindly sent again as a new turn.

### Durable recovery and ownership

- A submit could commit and then lose its acknowledgment. Marking the submission only after
  acknowledgment misclassified it as unsubmitted and could retire committed work. The
  recoverable/ambiguous boundary is now persisted **before** the submit call.
- Stop could retire orphaned host state without aborting the SDK submission, or cross into
  a newly admitted turn while conversation-scoped abort was in flight. Cancellation now
  aborts orphaned work and is fenced against admission.
- Replay projection used the active context snapshot. Compaction can hide committed entries
  from that snapshot, making earlier tools/text disappear from replay. Projection now scans
  committed storage entries after the run baseline.
- A failed asynchronous completion watcher retained a resolved drive-ownership promise,
  preventing reattachment. Failed waiters now release ownership for safe recovery.
- A failed terminal-manifest write could mark a run ended only in RAM and strand its live
  handle. Terminal state is now persisted before it replaces the live manifest.
- A provider stream ignoring AbortSignal could prevent the SDK from reaching abort settlement.
  Provider iteration/result, compaction completion and deferred-fetch waits now respect the
  SDK-owned signal; late model replies cannot proceed into tools after cancellation.

### Persistence and queued actions

- Queued and not-yet-consumed steering actions were memory-only and vanished on reload.
  They are now persisted locally, hydrated before replay, deduplicated by action ID and
  retained until consumption is confirmed. User choices after an uncertain interruption
  still require care: this does not make Pi side effects exactly-once.
- The outbox compared a saved sequence and deleted it in separate IndexedDB transactions.
  Another tab could insert a newer edit between those operations and have it erased by
  the older acknowledgment. Compare/delete is now one transaction.
- Settings PUTs could overlap and let an old write land last. They are now serialized.
- Cloud sync marked records as known before successful download/decryption/application.
  A transient failure could then skip that record permanently. Acknowledgment now follows
  successful application, failed pulls retry, and merging distinguishes separate retry runs
  sharing the same message ID.

### Shared transport

- NDJSON iterator cleanup only released the lock; it did not cancel an abandoned body or
  unblock a pending read. Abort/early exit now cancel the reader without waiting for an
  uncooperative source.
- Disconnecting a run watcher, or losing a heartbeat race, left waiters behind. Watcher
  cancellation and heartbeat completion now remove their own waiter without stopping work.
- Stop while upstream response headers were pending could leak the eventual response body.
  A late response is now canceled instead of being left open.

## Verification and limits

The original suite passed **159 tests**; passing existing tests did not rule out these races.
Final verification: **227 OpenBuild tests pass**, TypeScript checks pass for app/server and
Convex, and `git diff --check` passes. **Five shared Pi extension tests pass** separately.
New offline regressions cover the failure paths above, with isolated databases, fake
transports/providers and fake Pi subprocesses. They do not use real credentials or send
provider requests. The shared extension also has policy tests and an actual Pi SDK test
with fake dispatch: busy progress adds zero model requests, one idle batch adds one, and
post-Stop delivery adds zero while preserving context. An isolated real RPC startup smoke
check successfully loaded the patched extension without a provider call.

Remaining distinctions:

- Steering is cooperative, not preemptive: Pi consumes it at a turn/tool boundary. Interrupt
  means Stop then start the chosen queued instruction. Durable steering remains explicitly
  unsupported, not silently implemented by this audit.
- A genuinely external terminal/subagent session is observable through its transcript; that
  does not make it safe to kill or steer through an unrelated OpenBuild run ID. Its composer
  now presents read-only external status instead of advertising functional controls.
- A missing `/api/config` response still falls back to local mode without a server identity
  for that page load. Header waits are bounded, but a full configuration-retry/identity
  recovery protocol is not part of this patch.
- Pi runs are not durable across server death. Durable can recover committed work, but does
  not make arbitrary filesystem/network side effects transactional or exactly-once.
- A provider can be slow while transport heartbeats remain healthy. The silence watchdog is
  a connection-health bound, not a maximum reasoning duration.
- Forcefully stopping a process cannot roll back tools that already changed files or services.
- Intermittent pre-restart failures without recorded control requests remain unproven. The
  trace supports multiple distinct bugs; it does not justify attributing every symptom to
  one runtime or claiming all possible hangs have been eliminated.
