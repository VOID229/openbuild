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

Non-Pi worker runtimes advertise `runtime-questions`. An older detached worker is upgraded only through the existing idle-retirement fence; an active turn is never killed to enable new question support.

## Validation

Runtime fixtures exercise native request/reply shapes, free-text answers, cancellation, replay and restart boundaries. The Cursor fixture calls the actual loopback HTTP MCP endpoint. These tests do not spend subscription inference or claim a live model always follows tool instructions. Native runtime policy is never silently relaxed to make a question work.
