# Native OpenCode 2 runtime

This adapter uses **OpenCode 2 HTTP/SSE**, tested against 2.0.32. It does not use the v1 SDK, OpenCode Zen API keys, or OpenBuild's older hosted OpenCode plans. A server reporting anything other than `2.x` is rejected explicitly.

## Configuration and ownership

- Binary: `OPENCODE_BIN`, then `~/.opencode/bin/opencode`, then `opencode` on PATH.
- Local launch: `opencode serve --hostname=127.0.0.1 --port=0`. A random in-memory `OPENCODE_PASSWORD` is supplied; inherited `OPENCODE_SERVER_PASSWORD` is removed from the child environment. Readiness comes from the printed listening URL and verified `GET /api/info`.
- Optional external server: `OPENCODE_SERVER_URL`, with only `OPENCODE_SERVER_PASSWORD` used for authentication. Local generated passwords are never forwarded externally. HTTP Basic uses username `opencode`; redirects are rejected.
- `status()` and `listModels(fresh)` own ephemeral connections and always stop their locally spawned server. External servers are never stopped.
- New OpenCode threads run in a separate detached agent worker (`opencode-worker/worker.json`), using the same worker protocol/journal as Pi. This lets OpenCode start while an older shared worker is still running other agents. Existing OpenCode threads already admitted to the shared worker remain there; run lookups, snapshots, answers, stopping and restart recovery cover both locations. `openbuild stop --all` explicitly stops both agent worker locations as well as Durable.
- `runTurn()` shares one worker-owned server until worker exit. The server child is **not detached**: it inherits the detached worker's process group, so `stop --all` reaches both. Releasing a session or losing an OpenBuild HTTP watcher does not kill this server. The worker journal handles HTTP restart/replay; this adapter does not recover a killed worker's unfinished native execution.
- Startup is bounded to 20 seconds, JSON requests/SSE headers to 15 seconds, interrupt completion to 10 seconds, and missing SSE activity to 60 seconds. SSE loss fails visibly; there is no automatic reconnect or prompt resend.

## Discovery and model selection

`GET /api/model?location[directory]=<cwd>` returns `{data:[...]}`; `GET /api/model/default` returns `{data:model|null}`. Discovery uses the home workspace; turn validation uses the actual thread workspace. Only enabled native models are listed. IDs are `opencode/<providerID>/<id>` (the native model ID may contain slashes). The shared provider field stays the native provider ID for branding.

Reasoning effort choices are only native advertised variant IDs that fit OpenBuild's effort vocabulary. No variants are fabricated. Unadvertised non-default effort is rejected; default `off` without an actual `off` variant means omit the variant, preserving native default behavior. Other native variants are not exposed by the shared effort picker.

## Native sessions and protocol

OpenBuild stores `opencode-session:<thread>` as `{id,cwd,turns}` (plus an internal `pending` reservation). It never replays prior prompts. Forks, rewinds/retries, missing mappings with nonzero prior history, workspace changes, active native sessions, external native user-count drift, native revert/fork state, and ambiguous unfinished turns are rejected rather than silently replacing history.

1. `POST /api/session` with `{location:{directory:cwd},model:{providerID,id,variant?}}` creates the native mapping. On later turns verify the session, `GET /api/session/active`, and paginated `GET /api/session/:id/message?type=user`; then `POST /api/session/:id/model` with `{model:{...}}`.
2. Subscribe to `GET /api/event` **before** sending the new prompt.
3. Reserve the user-message count durably before `POST /api/session/:id/prompt` with `{text,files?:[{uri:"data:..."}]}`. `text` includes scoped client question guidance before the original user message (see below). Prompt acceptance is never retried, including ambiguous HTTP failures.
4. Consume native SSE JSON `{type,data,created}`. `session.text.*` and `session.reasoning.*` are tracked by assistant message ID and ordinal. The full text on `ended` contributes only the suffix missing from deltas; divergent final text fails visibly.
5. `session.tool.input.started`, `.called`, `.progress`, `.success`, and `.failed` map to shared tool events. `shell` maps to `bash`; read/edit/write and aliases map to their shared equivalents. Native input, metadata and event evidence remain in `args.opencode`; text content and failures become output.
6. `session.step.ended` accumulates native input/output/reasoning/cache token counts and optional cost. Output includes reasoning tokens. `session.execution.succeeded`, `.failed`, or `.interrupted` terminate **only the root session**. `session.created` descendants expose namespaced child tools but never overwrite root text/usage or terminate it.
7. Abort posts `/api/session/:id/interrupt` exactly once, waits for native terminal confirmation, and closes the stream within a bounded deadline. An ambiguous interruption retains the pending reservation and blocks continuation.

## Permissions and questions

Native policy is preserved: no allow-all rules or automatic approval are installed. Per-turn permission overrides are unsupported.

Every new native prompt includes a scoped `<openbuild-question-instructions>` block telling the model to use its native **question** tool/forms for decisions or missing information, wait for the answer, allow custom text, and not invent an answer or immediately repeat a cancelled question. It requests simple fields the adapter can represent, rather than multiselect/conditional forms. OpenCode 2's session/prompt schemas have no system-prompt override, so guidance is prepended to `text` on each submission (including resumed sessions); it is visible in the native transcript, but does not mutate the stored OpenBuild user message or workspace configuration. No Pi extension or tool shim is loaded. Instructions encourage native questions, not guaranteed model compliance; native policy may still block the tool.

- `permission.asked` produces a shared select ask: **Allow once / Deny**. Only explicit approval sends `POST /api/session/:sid/permission/:request/reply` with `{decision:"once"}`; denial/cancellation sends `reject`.
- `form.created` presents simple string, numeric/integer, boolean, and single-choice fields sequentially. Labels map back to native option values and answers retain their native types. Submit `{answer:{key:value,...}}` to `/api/session/:sid/form/:fid/reply`; cancellation uses `DELETE /api/session/:sid/form/:fid`.
- Complex forms (multiselect, external, conditional/hidden fields, or constraints the shared ask cannot represent) are visibly rejected and deleted rather than leaving the native run waiting forever. Invalid typed answers also cancel the native form and fail visibly.

## Adapter exports and checks

- `install.ts`: `OPENCODE_INSTALL`, `opencodeBin`, `status`, `listModels(fresh)`, `forgetModels`.
- `sessions.ts`: `runTurn(req,signal)`, `answer`, `hasAsk`, `release`, `restartIdle`, `isSessionLive`. No steering support.
- `connection.ts`: transport/owned server lifecycle; `tools.ts`: native tool projection.

Offline tests: `bun test tests/opencodeAdapter.test.ts tests/opencodeTools.test.ts tests/opencodeConnection.test.ts tests/opencodeServerRestart.test.ts`. They use fake HTTP/SSE servers and isolated native session fixtures, never real home sessions. Question coverage includes per-turn guidance, sequential typed fields, custom free text, duplicate form events/replies, cancellation without submission, and visibly rejected complex forms. The protocol suite runs in a subprocess with a temporary `OPENCHAT_DATA_DIR`; lifecycle tests also verify discovery reaps owned children and removes inherited credentials. The restart fixture checks that a detached worker finishes a tool while the HTTP server is absent and that pending approvals remain answerable after HTTP restart.
