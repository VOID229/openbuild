# T3 Code orchestrator v2: runtime handoffs and OpenBuild

Reviewed 2026-10-29 against `pingdotgg/t3code` main at commit
`37fbefd147197fab9d88f9c120560c3f21b52cfc`. This is a source review, not a live interoperability test.
OpenBuild references describe the current working tree, including ongoing local changes.

## Conclusion

OpenBuild can implement the same behavior using its existing harness integrations,
detached worker, SQLite run journal, and reply projection. The necessary architectural
change is separating a visible chat from its native harness sessions. Removing the
current runtime lock alone would break history validation and leave returning agents
unaware of intervening work.

Two features should be distinguished:

- **Switching harnesses within one conversation:** one app chat, multiple native sessions,
  with an explicit context handoff before the next turn.
- **Cross-harness delegation:** a parent agent starts a separate child chat on another
  harness, then receives the child's result. This needs a task lifecycle and tool surface
  beyond the switching mechanism.

## What T3 actually implements

### Identity and execution

T3 distinguishes `AppThread`, counted app `Run`, `RunAttempt`, `ExecutionNode`,
`ProviderThread`, and `ProviderSession`. Native thread/turn/item ids are references
attached to app-owned identities. A provider session is the process/connection; a
provider thread is the native conversation, which can survive a process restart.
Child work has its own execution identity and cannot complete the parent's root run.

In T3 terminology, a provider driver can mean an entire harness such as Codex, Claude
Code, Pi, Cursor, or fx. A provider instance is a configured driver/account instance;
switching model providers inside Pi is a different operation from switching harnesses.

Source: [core model](https://github.com/pingdotgg/t3code/blob/37fbefd147197fab9d88f9c120560c3f21b52cfc/docs/orchestration-v2/core-graph-and-data-model.md),
[adapter contract](https://github.com/pingdotgg/t3code/blob/37fbefd147197fab9d88f9c120560c3f21b52cfc/packages/provider-core/src/server/ProviderAdapter.ts).

### Session transition policy

`ProviderSwitchService` and `ProviderSessionTransitionPolicy` classify a selection
change as `reuse`, `switch_model_in_session`, `restart_and_resume`,
`create_with_handoff`, or `reject`. They compare driver, continuation identity,
workspace, runtime permissions, and the adapter's model-selection transition policy.
Compatible account overlays can resume the same native history; an instance-id change
does not automatically require a portable handoff. Incompatible harnesses do.

Source: [switch service](https://github.com/pingdotgg/t3code/blob/37fbefd147197fab9d88f9c120560c3f21b52cfc/apps/server/src/orchestration-v2/ProviderSwitchService.ts),
[transition policy](https://github.com/pingdotgg/t3code/blob/37fbefd147197fab9d88f9c120560c3f21b52cfc/apps/server/src/orchestration-v2/ProviderSessionTransitionPolicy.ts).

### Selecting context for a switch

`Orchestrator.ts` finds an existing root provider thread for the target instance, if
one exists. It computes the run range since that thread last received app work:

```text
App chat:
  runs 1–5: Codex native thread C1
  runs 6–8: Claude native thread L1, with handoff covering 1–5
  run 9:    resume C1, with handoff covering 6–8
```

A new target thread receives `full_thread_summary`; an existing target generally
receives `delta_since_target_last_seen`. Some combinations, such as pending merge-back,
require full context. The source selection includes completed, failed, and interrupted
runs, because failed/interrupted runs may still have produced relevant work. It checks
provider-turn evidence when calculating an existing thread's last delivered run.

The switch persists both a `ContextTransfer` describing the relationship and a
`ContextHandoff` carrying materialized context, linked to the consuming run. A visible
handoff activity item makes the transfer inspectable. Forks and merge-back use related
transfer records; native forks are preferred when the adapter can honor the source point.

Source: [orchestrator](https://github.com/pingdotgg/t3code/blob/37fbefd147197fab9d88f9c120560c3f21b52cfc/apps/server/src/orchestration-v2/Orchestrator.ts),
especially `isHandoffSourceRun`, `lastDeliveredRunForProviderThread`, and the
`providerSwitchCoveredRuns`/`providerSwitchHandoff` startup path.

### The “summary” is currently selected history

The docs discuss model-generated summaries, but the reviewed provider-switch path
does **not** call a summarization model. `prepareProviderHandoff` deterministically
converts canonical activity into attributed historical messages and selects intact
items within a budget. It includes user/assistant text, command input/output and exit
status, file names, proposed plans, errors, and interruption results. It excludes
reasoning and does not replay native tool calls or attached files.

Selection prefers the latest user item, latest assistant item, first user item, then
remaining items newest first; selected items retain chronological order. Oversized
items are omitted whole. Handoffs store selected and omitted item ids, source ids,
run statuses, and coverage. A recovery instruction points to paginated
`t3_thread_read(view=activity)` for missing or long items.

The default configured cap is 16,000. Actual budgeting conservatively uses UTF-8/JSON
byte costs, caps imported context at 64,000 bytes, subtracts existing native occupancy,
current user input and attachments, and reserves at least 16,000 or one quarter of the
context window for further work. This is a conservative estimate rather than exact
model tokenization.

Source: [context preparation](https://github.com/pingdotgg/t3code/blob/37fbefd147197fab9d88f9c120560c3f21b52cfc/apps/server/src/orchestration-v2/ContextHandoffService.ts),
[history selection and budget](https://github.com/pingdotgg/t3code/blob/37fbefd147197fab9d88f9c120560c3f21b52cfc/packages/provider-core/src/server/handoffBudget.ts).

### Transport and delivery recovery

The orchestrator prepares context separately from the real user message. Delivery
uses the adapter's optional `injectHistory` method, or falls back to rendering historical
context before `User message:` in the next prompt. Codex implements injection through
`thread/inject_items`, using role-preserving message items. Only an unknown-method
error (`-32601`) permits fallback; other failures might have mutated native history.

Delivery is recorded against the **native thread id**, with `pending`, `injected`, or
`inline` state and delivered item ids. Already delivered items are deduplicated.
If injection succeeds but the next turn is refused, injection remains recorded. Inline
delivery is recorded after acceptance; refusal before prompt consumption restores
the prior handoff state. An ambiguous pending delivery causes a fresh native thread
and reconstruction on a later start, rather than blind reinjection.

`ProviderTurnStartService` also reconstructs context in a fresh native thread if resume
fails, and can replace a resumed thread when its remaining budget cannot accommodate
the transfer. There are checks against discarding pending background work. This is
context recovery; it is not a guarantee that replaying an interrupted agent's tool
side effects is safe.

Source: [delivery](https://github.com/pingdotgg/t3code/blob/37fbefd147197fab9d88f9c120560c3f21b52cfc/apps/server/src/orchestration-v2/ContextHandoffDelivery.ts),
[turn startup](https://github.com/pingdotgg/t3code/blob/37fbefd147197fab9d88f9c120560c3f21b52cfc/apps/server/src/orchestration-v2/ProviderTurnStartService.ts),
[Codex adapter](https://github.com/pingdotgg/t3code/blob/37fbefd147197fab9d88f9c120560c3f21b52cfc/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts).

### Cross-harness child tasks

T3 exposes app-owned MCP tools including `orchestrator_capabilities`, `delegate_task`,
`task_status`, and `task_cancel`. Local delegation requires a live parent run owned by
the caller's provider session. It resolves the target harness/model and permitted modes,
then dispatches `delegated_task.request` with parent thread/run/root-node references.
A stable `clientRequestId` maps to command receipts to avoid duplicate tasks on retry.

The child starts with **only the supplied task**, not an automatic copy of parent
history. It can share the checkout or use an explicitly prepared worktree. Wait mode
returns the result through the blocking tool call; async mode arranges a completion
wake. Timed-out waits upgrade their wake policy so later completion still reaches the
parent. Result transfers and completion-delivery state are durable. A child's root
turn finishing while its own children/background work remain active is not yet a
finished task.

Source: [MCP service](https://github.com/pingdotgg/t3code/blob/37fbefd147197fab9d88f9c120560c3f21b52cfc/apps/server/src/mcp/OrchestratorMcpService.ts),
[tool descriptions](https://github.com/pingdotgg/t3code/blob/37fbefd147197fab9d88f9c120560c3f21b52cfc/apps/server/src/mcp/toolkits/orchestrator/tools.ts),
[delegation guide](https://github.com/pingdotgg/t3code/blob/37fbefd147197fab9d88f9c120560c3f21b52cfc/docs/orchestration-v2/orchestrator-mcp-server.md).

## OpenBuild's existing pieces and gaps

| Area | Current OpenBuild | Required change |
| --- | --- | --- |
| Chat identity | `server/threadRuntime.ts` permanently claims one runtime; chat PUT also rejects changes | Make runtime the next-run selection; preserve immutable runtime identity on each admitted run/session binding |
| Native history | Each harness already has an independent `*-session:<chatId>` mapping | Introduce explicit binding ids/generations so one runtime can have replacement native sessions without losing provenance |
| Turn validation | `PiChatRequest.prior` counts all app user messages and steers; Codex/Cursor validate against native counters | Compute harness-local expected position on the server; track app coverage separately |
| Execution | `PiWorkerRuntime` persists requests/events, rejects concurrent turns, and deduplicates run ids | Add binding/handoff references to admission; retain one active root per app chat |
| Recovery | Detached worker survives web-server restart; unfinished ordinary turns are interrupted after worker loss | Persist handoff acceptance/uncertainty; preserve the current no-blind-rerun behavior |
| Conversation | `server/pi/projection.ts` reconstructs visible replies from authoritative worker logs | Export attributed transfer context from canonical projected output/logs; exclude thought parts |
| Feature detection | `server/runtimes.ts` reports executable availability | Add explicit resume, history injection, inline handoff, fork, rewind, steer, and delegation capabilities |
| Tools/results | Per-harness ask/steer routing; no comparable app-owned delegation task layer in the reviewed paths | Bind requests to run/session ownership; add MCP or harness-native app tools plus durable child task/result records |
| Durable | Separate checkpointed worker and special projection/recovery handling | Defer until switching is coordinated with Durable admission and recovery; two workers must never run one chat concurrently |
| Devices | Existing paired-device routing | Keep first slice on one device/workspace; machine handoff additionally needs workspace synchronization/ownership |

Key OpenBuild source paths: `server/threadRuntime.ts`, `server/pi/routes.ts`,
`server/pi/workerRuntime.ts`, `server/pi/projection.ts`, `server/codex/sessions.ts`,
`server/claude/sessions.ts`, `server/cursor/sessions.ts`, `shared/types.ts`,
`src/lib/chat.ts` (`piRequest`), and `server/index.ts` (chat PUT/runtime checks).

## Recommended implementation sequence

1. **Add server-owned runtime bindings and run attribution.** Store app chat/run ids,
   binding id, runtime, device/workspace, native identity/generation, local history
   position, and covered app runs. Import existing mappings as initial bindings.
   Keep run admission, binding selection, and handoff preparation coordinated in the
   worker; a mutable browser chat field must not choose a different native history on retry.
2. **Implement idle, same-workspace switching for Pi, Codex, and Claude.** Resume an
   existing target binding with a delta; otherwise start a new binding with full selected
   history. Retain each harness's existing history-integrity checks, now using binding-local
   positions. Permission modes must be resolved for the target harness rather than copied
   as opaque strings. Leave active/pending questions settled before admitting a switch.
3. **Persist context transfers and delivery state.** Store source run/item ids, selected
   and omitted items, target native identity, and delivery status. Begin with inline
   history context where supported; add Codex native injection only after checking the
   installed app-server protocol. Provide a scoped, paginated history-reading tool so
   omission remains recoverable. Show the consumed handoff in the chat.
4. **Add cross-harness delegation separately.** Build app-owned child threads with
   parent/run links, idempotent creation, capability-based targets, explicit task prompts,
   wait/async results, and durable result delivery. Reuse existing workers and workspace
   preparation. Add optional worktree isolation before encouraging concurrent writers.
5. **Extend to other harnesses and Durable after capability checks.** Add forks/merge-back
   and rollback invalidation once history lineage is explicit. A changed conversation
   boundary must invalidate native coverage and handoffs that include discarded work.

A complete T3 execution graph rewrite or adoption of Effect is unnecessary for the
first switching feature. Explicit bindings, per-run identity, transfer records, and
delivery recovery are necessary. A graph becomes useful as OpenBuild adds nested
delegation and richer lifecycle visibility.

Acceptance tests should cover Pi → Codex → Claude → Codex delta coverage; multiple
tabs racing runtime selection; idempotent run retries; server and worker restarts at
each delivery boundary; native resume failure; missing injection support; ambiguous
injection; bounded multilingual history with recoverable omissions; target-specific
permissions; interrupted tool work; and edits invalidating previously transferred history.
Delegation additionally needs duplicate-request, timeout/completion, child-background-work,
parent-cancellation, and result-delivery recovery cases.

No OpenBuild runtime behavior was changed for this review. T3's source tests were
inspected, not executed; installed harness compatibility remains to be probed during
implementation.
