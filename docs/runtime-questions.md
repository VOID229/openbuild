# Questions across runtimes

All adapters emit the existing `ask` / `asked` stream events. The UI, replay, and thread answer endpoint are shared; a Pi extension is not loaded into other agents. Tool availability and native permission policy remain separate from permission approval cards.

| Runtime | Transport |
| --- | --- |
| Pi | OpenBuild's `question_ask` extension and extension dialogs over RPC. |
| Codex | Native `request_user_input`, enabled in ordinary agent mode with `features.default_mode_request_user_input`. App-server `item/tool/requestUserInput` replies aggregate by question ID. Developer guidance is appended to, not substituted for, configured instructions. |
| Claude Code | Native `AskUserQuestion` through Agent SDK `canUseTool`. Answers are keyed by question text. Bypass mode still delivers questions; native `dontAsk` and explicit deny rules intentionally prohibit them. |
| OpenCode | Native form events and form-reply API for the installed v2 protocol. Older `question.asked` endpoints must not be mixed into this adapter. |
| fx | Native ACP form elicitation, advertised with `clientCapabilities.elicitation.form`. Replies preserve schema field IDs and primitive types. Unsupported schemas and URL elicitation are declined. |
| Cursor | A per-turn, loopback MCP `question_ask` tool loaded through a temporary local plugin. No workspace/global configuration is modified, and no global MCP approval or force flag is added. Native tool policy can still deny it; a native scoped allow rule or the user's explicit unrestricted mode may be needed. |
| Durable | A registered tool with persisted question/answer state, rather than a Pi RPC extension. |

Adapters remind models to use their question tool and wait instead of writing a question as ordinary assistant text. This is tool guidance, not a guarantee that every model will comply. Choices and free text use the existing question UI; strict native form enum/type constraints remain binding.

## t3code reference

Reviewed the local t3code source at `/tmp/t3code`. Its generic ACP adapter (`packages/provider-acp/src/server/adapter.ts`) advertises form elicitation and handles native schema properties; `packages/effect-acp/src/client.ts` registers `elicitation/create`, `session/elicitation`, and `_session/elicitation`. Its Codex adapter handles `item/tool/requestUserInput`, and its Claude adapter uses native SDK callbacks. Its Cursor adapter (`packages/provider-cursor/src/server/adapter.ts`) uses SDK-injected MCP servers and explicitly declares no native structured-question support. OpenBuild's print-mode Cursor adapter therefore uses a scoped MCP bridge, not a nonexistent stdin reply protocol.

## Worker feature lanes

Native worker runtimes advertise `runtime-questions`. New Cursor/Claude/Codex/fx threads prefer a compatible `pi-worker`; new OpenCode threads prefer a compatible `opencode-worker`. If that worker lacks the runtime or question feature, admission uses `agent-worker-<feature-hash>` instead. The hash versions the sorted worker feature set. No retirement or signal is sent to the older worker, even when it is busy with other agents. Ordinary Pi and Durable routing are unchanged.

A thread belongs to the lane holding its latest run. Selection and admission are serialized per thread within the web server (the sole admission authority). A stable run-ID replay validates the original request and reattaches before checking features; a different turn while one is pending returns `busy`. A pending turn never moves. When an idle thread's owner lacks a required feature (an older worker that is still running after an update), the next turn is handed off: the owner releases the thread's idle native process (`/release`), then a compatible lane resumes the native session from its mapping in the shared database (`codex-session:…`, `claude-session:…`, etc.). The old lane keeps the thread's earlier runs for history. If that owner still has a `!` shell command running for the thread, the turn is refused as `busy` rather than cutting the shell off. No prompt is sent on refusal.

Snapshots, run lookup/replay, questions, stop/delete/release, ownership and recovery include the main worker, historical OpenCode lane and every journaled feature generation. Normal stop/restart leaves all lanes alive. `openbuild stop --all` explicitly signals all of them (and Durable), using the existing PID/command safety check; journal metadata is retained for recovery.

## Validation

Runtime fixtures exercise native request/reply shapes, free-text answers, cancellation, replay and restart boundaries. The Cursor fixture calls the actual loopback HTTP MCP endpoint. These tests do not spend subscription inference or claim a live model always follows tool instructions. Native runtime policy is never silently relaxed to make a question work.
