# OpenBots session and context budgets

The runner serializes turns per bot, but persists Pi sessions per **bot + full conversation id + execution lane**.
Direct, group, and any friend conversation with a distinct conversation id have separate lanes.
Friends use their explicit friend lane, with the existing restricted tool/auth scope retained.
Changing a conversation's lane cannot reuse its earlier session or delivery ledger. The old bot-wide JSONL sessions are retained and never resumed by the
new lane scheme. Auth, tools, extension selection, model/fallback selection and the durable
SQLite assignment/change-note records remain shared as before; transcript context is isolated.

Each lane has retained generations. The defaults are 8 MiB of JSONL or 24 hours per generation.
These are soft caps: rotation is allowed only after a successful settled turn, with queue release
completed. A failed or ambiguous turn removes the settled marker and suppresses rotation until
successful recovery and a completed turn. A single large turn can exceed the size cap. Files are
never deleted. A fresh generation receives the latest compaction summary (up to 12,000 characters)
and recent assistant text (up to 8,000 characters), explicitly labeled historical. This is a bounded
handoff, not a full reconstruction of old reasoning/tool results. Durable pending requests are
still injected by full message id, including requests outside the latest transcript window.
Session-local information needed long term should be saved through remember; chat search remains
available. Old generations are retained for operator inspection, not exposed as bot filesystem tools.

Bot-only `.pi/settings.json` enables automatic compaction. Pi compacts once context exceeds
`contextWindow - reserveTokens`, and uses reserveTokens for nothing else, so the runner sets a
per-model override (`compaction.modelOverrides["provider/id"]`) that triggers compaction at 3/4 of
the window or 131,072 tokens, whichever is smaller: a 1M-window model compacts at 128k rather
than about 984k. Keep-recent is 1/16 of the window, capped at 8,000. Models without a known
window use a 16,384 reserve and 8,000 keep-recent. Pi defaults at inspection were 16,384/20,000.
Context windows come from one model listing per extension set, cached for 10 minutes and dropped
when Pi forgets its models, so a fresh per-conversation mind doesn't cost a second Pi start. The
runner explicitly approves its managed bot working directory so Pi 1.5 loads these settings. It
does not change global Pi settings or credentials. Settings are generated when a process starts.
The real-Pi test verifies effective settings, including a model override, without an inference.

Transcript delivery fingerprints use the full message object and conversation id, not truncated
chat ids, cursors or text matching. Edits, reactions and poll changes produce new fingerprints.
Only a successfully settled initial prompt commits its candidate fingerprints. Queued direct
steers contribute fingerprints only after queue release proves they were read. Dropped and failed
steers remain replayable. Pending assigned requests are always explicit, even if their context
was previously shown. This is conservative context suppression, not replacement of the existing
assignment/steer/recovery exactly-once machinery. Crashes before a ledger commit may repeat
context; they must not cause a request to disappear. Ledger hashes contain no plaintext.

Injected memory is limited to 6,000 UTF-8 bytes over at most 40 items. Oversized items are skipped,
not deleted or truncated in storage. This is a conservative byte budget, not an actual tokenizer
count. The remember/search interfaces and complete memory storage remain available.

`bots/usage.jsonl` logs one numeric aggregate per runner turn: opaque bot id, random turn id, timestamp,
assistant call count and provider-reported input/output/cache-read/cache-write fields. No text,
model error, tool arguments, URLs, names, credentials or conversation contents are logged. Missing
usage is labeled unmeasured. These records **exclude compaction usage** and are not a complete
billing ledger; fields retain provider-specific meanings and must not be confused with uncached
input alone. The file is private (0600); operators control its retention. Logging failure cannot fail delivery.

## Offline baseline (2026-11-08)

Read-only inspection confirmed the largest session was 85,712,089 bytes (81.74 MiB), with 15
compactions and 3,553 assistant usage records. Its latest observed input included approximately
463k cached tokens. Five largest sessions were copied into an isolated /tmp directory and analyzed
without a model call. Run `bun scripts/bot-session-baseline.ts <copied-session-directory>` to reproduce
this diagnostic. The script outputs only numeric aggregates.

| Session size (bytes) | Compactions | Peak reported input including cache | Estimated duplicate row bytes |
| ---: | ---: | ---: | ---: |
| 85,712,089 | 15 | 845,434 | 2,618,700 |
| 40,752,784 | 6 | 962,560 | 1,128,018 |
| 8,268,210 | 1 | 580,747 | 119,460 |
| 5,915,586 | 0 | 403,945 | 158,719 |
| 1,073,882 | 0 | 212,022 | 11,214 |

Duplicate-row numbers are an offline before/after suppression **estimate**, normalized for the
old already-seen label. The historical format used short ids, so these numbers are diagnostic
only and never drive delivery tracking. Dividing by four estimates tokens; it is not provider
usage or measured savings. The originally reported 575k/295k/231k turn totals were not reproduced
as exact turn aggregates: session records are per assistant call, while tool turns contain several
calls. No paid model replay or production configuration/session mutation was performed.

Remaining measurement limits: production-after usage and compaction charges require a future
rollout/observation; friend-lane isolation is included after integrating the newly merged Friends feature. This change requires deployment and a server restart to take effect. Do not restart
production as part of validation.

Multiple direct steers within one turn may repeat newly queued context until release confirms
consumption. The handoff cannot guarantee preservation of arbitrary notes found only in old tool
results; such notes must be saved durably rather than relying on session equivalence.
