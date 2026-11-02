# Offline Durable runtime audit

Scope: `server/durable/*` and Durable-specific tests. No live credentials, provider requests, service changes, or production storage were used. Dependencies examined are the installed, pinned `@earendil-works/pi-durable`, `pi-ai`, and `chord` 1.4.0 README/declarations/implementation.

## Confirmed failures and fixes

Each scenario below was run against the previous implementation and failed, then passed after the fix.

| Failure | Offline evidence | Fix |
| --- | --- | --- |
| Lost submit acknowledgement discarded real work | Inject `await realSubmit(); throw`. Manifest incorrectly ended with an error even though SDK had admitted the input. | Persist the may-have-submitted marker before calling SDK submit. Keep ambiguous admissions pending and replay their stable requestId. Clean up the admission watch on failure. |
| Stop ignored orphaned SDK work | The same acknowledgement fault left a live provider signal un-aborted after Stop. | Abort the opened conversation even when no host drive owns its waiter. |
| Stop reached the next turn | Pause conversation abort, let the old provider finish, admit a second input, release abort. Previously the second provider call started before cancellation finished and was aborted by the old Stop. | Fence cancellation with admission; recheck ended state inside the fence. |
| Persisted Stop replayed cancelled input | A manifest with stopping=true and no submitted input still called submit on recovery. | Abort/project/retire cancelled recovery before requestId replay. Recheck cancellation after configure/watch/history awaits. |
| Compaction lost prior actions from replay | Commit tool/text, append a compaction head, roll back only host projection metadata to the crash window, reopen. Previous replay contained no tool/text events. | Project ascending immutable transcript entries, not just active watch entries. Baseline maximum ID excludes hidden history belonging to earlier turns. Verify the next turn does not replay those older actions. |
| Completion watcher failure hung forever | Fail the final snapshot attachment once. Resubmitting returned the already-resolved drive promise and never completed the Run. | Release failed waiter ownership, surface a recoverable error, permit requestId reattachment without a new model call. |
| Final manifest failure ended only in RAM | Fail persistence once when ended=true. The Run stayed unfinished while retries used the ended-manifest fast path. | Persist a terminal manifest copy before changing live state; failed final writes remain pending/retryable. |
| Non-cooperative model stream made Stop hang | Fake provider ignored AbortSignal. Stop failed the bounded offline check; a late response carried a bash tool call. | Race SDK model iterator/result/compaction-completion/deferred-fetch waits with the SDK-owned abort signal. SDK then performs normal abort settlement; the late reply cannot execute tools. Original ModelRuntime receivers/configuration remain intact. |

Regressions: `tests/durableLifecycle.test.ts`, `tests/durableTerminal.test.ts`, `tests/durableCancellation.test.ts`, `tests/durableModels.test.ts`. `tests/durableCompaction.test.ts` additionally executes real SDK `compact()` / `waitForTask()` / summary submission placement, verifies that active context no longer includes the tool results, then proves crash-gap replay recovers those archived actions without another model call. The existing subprocess SIGKILL recovery tests still verify unsafe-tool interruption, no tool side-effect replay, and committed action preservation.

## SDK semantics relevant to diagnosis

- `Conversation.submit()` resumes scheduling itself, before its commit acknowledgement returns (`dist/harness/submissions.js`). Calling it is not an inert requestId lookup.
- `Conversation.abort()` is conversation-scoped, marks owned foreground work, and waits for idle (`dist/harness/scheduler.js`). It is not scoped to an OpenBuild request ID.
- Generation joins `for await` provider events and then `events.result()` before its phase returns (`dist/harness/generation.js`). Previously an ignored signal could prevent the abort handler from running.
- Watch views are active context and may coalesce frames. Compaction changes the active head but does not delete archived entries (`dist/harness/context.js`, upstream Watching/Storage docs). `CommittedWatch.#drain` awaits each listener serially, but `stop()` does not join an already-running callback (`dist/session/observation.js`). Independent final/abort scans can overlap; every archive page rechecks ended and rebuilds seen IDs after its storage await, and synchronous projection has no interleaving await. A regression interleaves two delayed paginated scans to verify exact-once events/usage and blocks a trailing read until after terminalization to verify no post-done leakage.
- BACKGROUND_CONTEXT is appropriate for host-owned durable work: cancelling an SDK wait does not cancel the task. Stop must use explicit conversation abort; browser disconnection must not cancel execution.
- Text-only final responses settle the submission. The SDK only continues with a tool round, queued input, or an onYield continuation. OpenBuild installs no continuation hook; a fake text-only model produces one request and one completion, not an autonomous confirmation loop.

## Unresolved / intentionally unchanged

- **Infinite one-line confirmations:** not reproduced as autonomous Durable behavior. There is no proof these adapter faults caused a particular real transcript. Durable currently installs tools without coding-persona or cwd prompt sections; the execution cwd is correct but is not itself communicated as a prompt section. Pi agent extensions, skills, AGENTS integration and prompt templates are not loaded here. No speculative prompt/continuation heuristics were added.
- **Automatic provider deadlines:** Stop now releases host waits even for an uncooperative provider; this does not forcibly terminate the underlying provider request or impose an automatic request deadline. Deferred cancellation or unrelated tool/environment code that itself ignores cancellation can still delay abort.
- **Failed Harness reopening:** SDK storage failure closes that Harness. Reattaching a host waiter can repair a transient host-snapshot failure, not reopen a closed SDK Harness; a process/runtime reopen is still required after storage failure. SDK parked tasks after its restart limit need explicit retry/operational visibility, which is not exposed by this adapter.
- **Stalled admission/storage:** Stop does not fix every wedged admission. A configure/submit promise that never settles can hold the global admission fence and block Stop acknowledgement and other admissions indefinitely. Stop intent is persisted before waiting on that fence; the bounded offline stalled-configure test verifies the acknowledgement remains blocked, and that once released the input is cancelled without model dispatch. Retiring the run or crossing the fence early would permit a late submit to execute after Stop or let the old conversation abort reach a new turn. SDK storage settlement deliberately ignores caller cancellation after admission (`session/session.js #runCommit`), so cancelling only its host wait cannot guarantee settlement was interrupted. A storage/host reopen is still needed for permanently nonsettling operations; no causal claim is made about the original live incident.
- **Ownership:** one process must still own a storage directory. Upstream JSONL has no cross-process lock; this audit did not add a process-lock protocol. The module singleton and installed Harness registries survive Bun hot reload, so runtime/tool implementation changes need a real reopen to affect already-created instances.
- **History provenance:** `prior` is a UI count, not model context. Higher counts are tolerated for rejected UI sends; it cannot detect/reconstruct imported or missing server-side history. Provider-visible compaction summaries may omit details even when the UI replay now retains every committed action.
- **Scale/retention:** JSONL retains history in memory; manifests/replay are retained indefinitely. Archive projection prioritizes correctness but scans the run's committed range on watch notifications. Large-run indexing/retention optimization is not included.
- **External side effects:** requestId dedupe is not exactly-once filesystem/process/network execution. Existing unsafe bash interruption policy and bounded bash timeout remain unchanged.

## Checks

- `bun test tests/durable*.test.ts`: **28 pass, 0 fail**, 129 assertions, including real subprocess SIGKILL tests.
- `bunx tsc --noEmit --pretty false`: passed.
- `git diff --check`: passed.
