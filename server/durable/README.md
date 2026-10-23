# OpenBuild durable backend

Uses the published `@earendil-works/pi-durable`, `pi-ai`, and `chord` **1.4.0** APIs (exact dependencies). The upstream experimental README and installed npm declarations/source were checked, including `Harness.open/root/resume`, `Conversation.submit/watch/abort/compact`, JSONL storage, `CodingTools`, and `NodeExecutionEnv`.

## Integration

Import from `server/durable/index.ts`:

- `await recover()` **on server startup**, with error reporting/retry by the server if the metadata scan fails. This scans run manifests and starts pending submissions, without any connected client. Per-run open/admission errors are logged and isolated: other runs still resume. `findRun` surfaces an affected run's opening error rather than returning 404 or hanging, and retries recoverable open/admission failures at most once per five seconds on reconnect. Resubmitting its original request retries opening immediately. Failed model initialization promises are evicted so repaired Pi installations/configuration can be retried. Corrupt manifests require explicit repair and a process reopen.
- `await startRun(req)` (alias `run`): requires a stable `req.stream.id`. Returns `DurableRun`, extending the existing `Run` (`events`, `ended`, `stream()`, `stop()`). HTTP disconnect only cancels the stream, not execution.
- `await findRun(id)`: returns the replayable run, including finished runs, or undefined.
- `await stopRun(id)`: persists cancellation intent, aborts the conversation, returns whether the ID exists.
- `await stopThread(threadId)`: deletion API. Durably tombstones the thread before awaiting cancellation, aborts active work, and permanently rejects later admission/compaction. Startup recovery skips tombstoned threads and terminalizes their pending manifests without opening/resuming their Harness. Tombstones are independent of chat metadata, so unsaved chats are not mistaken for deleted chats. Keep immutable runtime claims in the parent storage even after deletion.
- `await compact(threadId, instructions?)`: returns the durable compaction task's **numeric ID**, not its result. A returned ID means scheduled, not completed.
- `steer(...)`: explicitly rejects `DurableUnsupportedError`, with `status = 409`.

`DurableRuntime(directory?, models?)` exposes the same methods plus `close()`, for isolated testing or host lifecycle ownership. Do not call `close()` for a disconnected client. The module singleton is preserved across Bun hot reloads.

## Persistence and recovery

Default location: `<dataDir()>/durable` (`OPENCHAT_DATA_DIR` respected).

Each thread has an upstream JSONL storage directory opened with `fsync: true`. Run manifests are 0600 JSON files, replaced atomically after fsync, with directory fsync. They contain the supported request fields (unknown HTTP properties, including credential fields, are stripped), baseline/seen transcript IDs, projected events, end state, and cancellation intent. They therefore contain user content and image data; treat the data directory as sensitive. Credentials are never copied into these files.

The manifest is durable **before** `submit({requestId: stream.id})`. Recovery retries that exact input with the same requestId. This covers both the manifest-only admission window and the submission-committed/host-not-yet-notified window. Upstream requestId deduplication prevents a second input. Admission is serialized (including across threads, to prevent reuse of a global run ID). Reusing an ID with a different request is rejected.

Model state is upstream's committed transcript/tasks, not the browser history. A second active turn on one thread is rejected. `prior` must equal the number of previous admitted turns; edits, rewinds, history imports, and `forkFrom` explicitly fail rather than silently duplicate or discard history. Thread runtime immutability is enforced by the route/storage layer, not this module.

Events are projected from **completed committed transcript entries**, not volatile model deltas. Each entry's events and seen ID are persisted together before emission. Reopening scans the current committed snapshot to fill any host projection gap, without repeating already projected text or tool events. This intentionally trades token-level streaming for stable replay across provider retries/restarts. A tool start becomes visible after its containing assistant message commits; tool output is shown when its result commits. The terminal `done` includes cumulative input/output/cost for committed assistant entries in this turn, selected model contextWindow, and a latest-request contextTokens estimate (input + cached read/write + output). These counters are committed with seen-entry projection and survive reopen without double-counting. Failed in-flight attempts not represented by completed entries are not included. Finished replay is retained indefinitely (no cleanup/retention policy yet). Tool output is not clipped by this adapter.

## Models and tools

Production dynamically loads the installed Pi's supported `ModelRuntime.create()` using the existing install discovery, explicitly passing Pi's `auth.json` and `models.json` paths, and disabling create-time network catalog refresh. This reuses API keys, OAuth/refresh, built-in providers, and custom models. A no-request smoke test under Bun successfully loaded the installed Pi ModelRuntime (42 providers, 1201 catalog models). An installed 1.4-compatible Pi SDK is required; missing/incompatible SDK errors are not replaced with guessed credentials. Pi extension-registered providers/prompts/hooks are not auto-loaded; only ModelRuntime's configuration is shared. Model configuration changes require a server restart.

`CodingTools` installs read/write/edit/bash, and `NodeExecutionEnv` runs them in the request's persisted workspace cwd. This is real host filesystem/process access, **not a security sandbox**. No Pi RPC process, Pi session import, extension dialogs, question tool, custom skills, or code-mode sandbox is installed here.

## Guarantees and limits

Only **one process** may own this storage. Upstream JSONL has no cross-process lock; run only one backend instance against a given data directory. JSONL also retains history in memory; large long-lived installations should migrate to a supported SQLite adapter. Atomic/fsync manifest implementation targets local POSIX filesystems (not Windows/network filesystems).

Durability is **not exactly-once arbitrary side effects**. Upstream commits tool intent before execution; interrupted tools follow their declared replay policy. A replay-safe tool can execute again after a crash, while a non-replay-safe interrupted tool reports interruption. External writes/processes can occur before their result is committed; neither this backend nor requestId makes those side effects transactional. Provider requests may also repeat after interruption. A process restart reopens pending work; storage failures in a running process leave work pending and require host reopen/restart. Crash-loop parking follows upstream's restart limit.

Offline verification: `bun test tests/durable.test.ts`. Tests use static model metadata and fake dispatch, no live keys. They cover committed bash tool/text replay, stable ID admission, cancellation, deletion fences (including a simulated crash after tombstoning and before finalization), isolation and reconnect retry of per-thread startup failures, transient model initialization retry, actual SIGKILL during unsafe in-flight bash (one filesystem side effect, interrupted error on reopen, no command replay), actual SIGKILL during the generation after a committed tool, and automatic recovery without calling startRun on the reopened instance.
