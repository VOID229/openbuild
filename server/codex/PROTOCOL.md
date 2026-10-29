# Native Codex protocol evidence and integration

Inspected installed `/home/cloudy/.local/bin/codex`, `codex-cli 0.164.0`:

```
codex app-server --help
codex app-server generate-json-schema --help
codex app-server generate-json-schema --out /tmp/openbuild-codex-schema
codex app-server generate-ts --out /tmp/openbuild-codex-ts
```

The generated bundle's `ServerRequest`, `ServerNotification`, and `v2/{ThreadStartParams,ThreadResumeParams,TurnStartParams,ThreadItem,Model,ModelServiceTier,ThreadTokenUsage,CommandAction}` define this adapter. Transport is newline-delimited JSON over app-server stdio, not Content-Length framing or ACP. Envelopes use `id/method/params`, replies `id/result` or `id/error`. JSON-RPC version is not required by Codex.

Observed live, without running inference: initialize + initialized, model/list, account/read succeeded; model/list returned `data`, `nextCursor:null`, catalog model IDs distinct from model slugs, supportedReasoningEfforts and serviceTiers; account/read reported chatgpt. `status()` observed version 0.164.0. No Pi model APIs are used.

- initialize sends clientInfo and experimentalApi capability, then initialized notification.
- thread/start sends cwd/model plus the question-tool config/developer instructions described below: **no approvalPolicy/sandbox overrides**. Native user configuration remains authoritative unless the user picks a profile from `permissionProfile/list` in the composer; that id is sent as turn/start `permissions` (sticky on the native thread, so returning to Default restarts the process and resumes without it). Save returned thread.id immediately.
- thread/resume sends threadId/cwd plus the same question-tool config/developer instructions, does not send history. Full returned turns must match the saved count and have no active turn. A missing/mismatched mapping, rewind, fork, directory change, external append, or ambiguous interrupted history is rejected; no fresh replacement session or old-message replay.
- turn/start sends ONLY the new text/images, model, effort, and serviceTier (selected tier or explicit null to clear a previously sticky tier). UI off maps to native none; other efforts remain native strings. IDs are `codex/<model slug>`. The native schema marks serviceTier as a double-optional nullable override: omission inherits the previous setting, whereas explicit null clears it. Sending null for Standard avoids retaining a prior Fast selection.
- turn/started and turn/start response supply turn ID. Abort uses turn/interrupt with threadId/turnId, including aborts while awaiting turn/start. Interrupt failure/timeout terminates process; saved thread survives. Timed-out requests terminate the process and reject every pending request. Shutdown escalates SIGTERM to SIGKILL.
- item/agentMessage/delta, item/reasoning/{summaryTextDelta,textDelta}, item/{started,completed}, item/{commandExecution,fileChange}/outputDelta, turn/{plan,diff}/updated, thread/tokenUsage/updated, turn/completed are consumed. All native tool item variants have a generic visible fallback. Native item metadata is retained in args.codex, outputs and diffs are untruncated. Known child tools discovered through collab receiver IDs, subAgentActivity, or thread/started parent IDs use thread-namespaced item IDs; child completion/text/usage cannot terminate or corrupt the parent turn.
- CommandAction read/search/listFiles map to read/grep/glob; ordinary commands bash. Native file changes map edit/write; plans todo. Native tools are executed by Codex, never re-executed by OpenBuild. Unknown requests fail explicitly rather than silently disappearing or auto-granting permissions.
- commandExecution/fileChange requestApproval asks Allow once/Deny/Cancel turn and replies accept/decline/cancel. Additional permission request asks explicitly, grants only the turn's requested profile or nothing. User-input questions aggregate into answers keyed by question ID. Secret questions set the ask secret flag; answered notifications contain only [redacted], never the entered credential. Unknown delegated client tools are rejected, not fabricated.
- Usage is a delta of native cumulative token totals against persisted prior totals; context uses last.totalTokens and modelContextWindow. No prices or cost are invented.

## Reliable question asking (Codex 0.165.0)

Research: `/tmp/t3code/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts` handles `item/tool/requestUserInput` with a pending answer deferred, then replies `{ answers: { [questionId]: { answers: string[] } } }`. Its thread runtime parameters use dotted config overrides, but its `CODEX_THREAD_CONFIG` does not enable default-mode questions. Handling incoming requests alone does not make the model tool available.

Verified against installed `codex-cli 0.165.0`: `codex features list` and app-server `experimentalFeature/list` report `default_mode_request_user_input` supported, **disabled by default**. Regenerated TypeScript schemas confirm `ThreadStartParams` and `ThreadResumeParams` accept `config` and `developerInstructions`; `ToolRequestUserInputQuestion` includes `id/header/question/isOther/isSecret/options`. A live, no-inference app-server probe accepted an ephemeral thread/start with `config: { "features.default_mode_request_user_input": true }` and developer instructions.

OpenBuild now sends that override on **both start and resume**, including permission-profile process resets. It does not switch to Plan mode, modify global config, or change approvals/sandbox policy. It reads the workspace's `config/read` first and retains configured `developer_instructions` before appending the requirement to call `request_user_input` for decisions/clarifications (and explicit requests to use the question tool), await the actual answer, and permit free text. No `baseInstructions` override is used.

Native requests remain pending until every question has an answer. Select questions always expose OpenBuild's free-text entry, even when native `isOther` is false; optionless questions use input. Arbitrary text is returned verbatim in the native answer array, not as a new user turn. Cancellation returns an empty answer array; abort cancels all pending asks and interrupts the turn. Secret answers remain redacted in streamed/journaled events.

This uses the supported **native tool**, not a fabricated dynamic-tool callback or prose-to-question parser. No dynamic-tool fallback is installed: this integration targets the verified Codex feature/schema above. A model can still disobey instructions; offline protocol tests cannot prove inference compliance. Older Codex builds without this feature need upgrading.

## Integration API

`install.ts`: codexBin, codexEnv, CODEX_INSTALL, status, listModels(fresh?), forgetModels. `listModels` returns `{models,defaultModel,checkedAt}` with native catalog effort/speed choices.

`sessions.ts`: runTurn(PiChatRequest, AbortSignal): ReadableStream<Uint8Array> (NDJSON StreamEvent); answer(threadId,askId,{value?,confirmed?,cancelled?}); hasAsk; release; restartIdle; isSessionLive; sessionDir. Persistent mapping storage key `codex-session:<OpenBuild thread id>`; one native process per warm thread. Host this module in the existing detached Pi worker, not the HTTP server, so server restarts only detach watchers. Parent integration owns runtime routing, models/status endpoints, worker ask/abort routing, UI picker/runtime registration, and forbidding Pi-only operations for Codex.

## Conservative failure behavior

Before writing turn/start, reserve the next native turn count durably. Explicit JSON-RPC rejection rolls the native-turn reservation back but retains the consumed UI-message count; the next new UI message can continue without replaying the rejected request. Rewinding/retrying old UI messages remains unsupported. Transport loss is ambiguous and retains the native reservation. This prevents duplicate inference/actions. A native acceptance that cannot be matched on resume fails closed with a history error; starting a new OpenBuild thread is the recovery path. Counts detect external appends/deletions, not same-count edits made directly in native rollout files. Existing API supplies only a prior user-message count, not the full prior history to fingerprint. No attempt is made to reconstruct native context from frontend messages.

Tests: `tests/codexRuntime.test.ts` exercises real subprocess NDJSON with fake CODEX_BIN, resume/new-input-only, policy preservation, question-tool enablement/instructions on start and resume, configured instruction retention, per-turn usage, multi-question aggregation, free-text selection replies, cancellation/abort, secret redaction, ask/answer, crashes, explicit rejection, model/list, and hung-process deadlines. `tests/codexServerRestart.test.ts` covers detached-worker HTTP restart/replay/resume.
