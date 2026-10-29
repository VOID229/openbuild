# Cursor runtime

Select **Cursor** before the first message. OpenBuild runs the locally installed **Cursor Agent CLI**, not the Cursor editor, Pi, fx, or Codex. Install using Cursor's official instructions (`curl https://cursor.com/install -fsS | bash`), then authenticate with `cursor-agent login` (or `agent login`). `CURSOR_API_KEY` and existing native CLI configuration are inherited. `CURSOR_BIN` may override executable discovery; otherwise `~/.local/bin/cursor-agent`, then `agent`, are searched on PATH.

## Permissions: important print-mode limitation

**Allow all tools** is an explicit Cursor thread option, **off by default**. Turning it on adds `--force` for that turn: Cursor may run shell commands and modify files without asking. Turning it off removes the flag on the next turn and preserves native policy. The option is saved per thread; it does not grant access to other threads or runtimes. This does not override native team restrictions.

OpenBuild never adds `--yolo`, `--approve-mcps`, or disables the sandbox. It passes `--trust` for the explicitly selected workspace. The CLI runs with the server user's privileges and is not an OpenBuild sandbox.

The inspected CLI (2026.10.22-27dcf5f) uses an **always-deny decision provider in print mode** unless its existing native `approvalMode` is `unrestricted` (and team autorun policy permits it). Consequently, tools requiring approval may be rejected even if they work interactively in a terminal. For a coding session requiring those tools, either explicitly enable **Allow all tools** in OpenBuild or configure Cursor\'s native Run Everything policy. Both authorize commands broadly; OpenBuild never silently enables them. Read/tool operations not requiring approval can still work. Native denials appear as failed tool results.

Print-mode interaction queries are answered/rejected by Cursor itself. There is no stdin approval/question response protocol in this adapter; OpenBuild cannot turn them into actionable approval dialogs. Web fetch/search approval, questions, mode changes, MCP approvals, and team policies remain subject to the CLI's own headless behavior. Use the native interactive CLI if you need interactive approval.

## Models and effort

`/api/cursor/status` uses `--version` and `status --format json`. `/api/cursor/models` runs the account's `models` command; discovery never submits a model prompt. Results cache for one minute.

The installed CLI exposes supported **legacy variant slugs**, rather than machine-readable parameter definitions, through `models`. OpenBuild groups observed `-low`, `-medium`, `-high`, `-xhigh`/`-extra-high`, `-max`, and `-none` variants into effort choices (`none` becomes UI `off`). Only actual listed variants become choices: a model family name never implies an effort is supported. Fast and Thinking variants remain separate groups. Unsupported/minimal-only variants can remain standalone models without an effort selector. Changing effort selects the exact discovered native variant slug; OpenBuild does not invent bracket overrides or silently substitute another effort.

Unknown models/efforts are rejected before prompt submission. `off` is accepted as the neutral UI value on models with no effort control. Speed overrides are rejected; choose a listed Fast model instead. Image attachments are not supported by this adapter and fail explicitly.

## Stream protocol

Implementation was checked against installed `agent --help`, `6436.index.js` (model formatting), `4945.index.js` (create-chat/state paths), `1623.index.js` (SQLite store), and `7000.index.js` (`headless.ts`, permissions/session startup). No paid test prompts were required.

The command is `--print --output-format stream-json --trust --workspace <cwd> --resume <UUID> --model <discovered slug> -- <new message>`. NDJSON events include:

- `system/init`, `user`: session metadata/input, not assistant text.
- `assistant.message.content[]`: text chunks flushed at tool/query/retry boundaries and at completion.
- `thinking/delta`: reasoning chunks.
- `tool_call/started|completed`: stable `call_id` plus protobuf JSON oneof `tool_call` (e.g. `shellToolCall`, `readToolCall`).
- `interaction_query/request|response`, retry/connection/system notices: native CLI control/status records.
- `result/success`: terminal result and optional `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`. The terminal result repeats aggregate assistant text and is **not** appended again.

Text streams at native flush boundaries, **not token-by-token**. `--stream-partial-output` is deliberately omitted: this build emits individual assistant deltas **and the same accumulated assistant text again**. Some query/retry flush records have the same shape as deltas, making unconditional deduplication liable to swallow legitimate repeated text. The safe non-partial protocol avoids duplication without guessing.

Tools map to existing UI names (bash, read, edit/write, ls/find/grep, todo, web_search/web_fetch, task/MCP); unknown tool kinds retain their native name. Structured native arguments **and results** remain under `args.cursor.toolCall`. Human-readable output, shell stdout/stderr, failure state, and available diffs are projected separately. Tool failures do not masquerade as successful output. Missing terminal results, malformed streams, nonzero exit codes, and authentication diagnostics produce explicit errors.

## Persistence, cancellation, and restart

Cursor runs in the **existing shared detached Pi worker**, alongside Pi/fx/Codex. No second Cursor daemon or HTTP-owned process is introduced. Stable run IDs and the worker SQLite event journal make reconnect/duplicate admission replay existing output without resubmitting the prompt. `openbuild stop`/restart only disconnects watchers: the worker and Cursor continue, and tool effects can finish while the HTTP server is down. See [durable.md](durable.md) for ordinary worker versus Durable guarantees. Use `openbuild stop --all` only when you intend to interrupt workers.

The worker advertises a `cursor` feature. An older worker is retired/replaced only through its atomic idle-retirement endpoint; busy/unsafe-to-upgrade workers are never signalled automatically.

Mappings use persistent OpenBuild storage keys `cursor-session:<threadId>` and retain native UUID, resolved workspace, UI turn count, in-flight reservation, and a conservative native history fingerprint. Native chats live under `<CURSOR_CONFIG_DIR or XDG_CONFIG_HOME/cursor or ~/.cursor>/chats/<md5(resolved cwd)>/<UUID>/store.db`.

A UUID is reserved before the first submission and passed to `--resume`: the inspected CLI opens an empty SQLite store for a new UUID. Its `create-chat` command was not used because this build prints a UUID without materializing the lazy store, and may linger instead of exiting. Subsequent nonempty resumes require the saved native database and matching fingerprint. Only the **new user message** is passed; OpenBuild never reconstructs/replays old messages.

- Rewind/retry of consumed history, fork/import, mismatched `prior`, a missing mapping, another workspace, or external native history changes fail explicitly. Start a new thread rather than silently diverging.
- The fingerprint hashes SQLite database and nonempty WAL bytes, ignoring SHM. This is deliberately conservative: opening/checkpointing/editing the native database externally can invalidate it even if semantic history seems unchanged. Do not share an active OpenBuild-managed native chat with another client.
- Stop sends SIGINT so Cursor can cancel tools and flush native state. After ten seconds, escalation kills only that CLI's process tree, never other worker turns. A confirmed graceful cancellation allows the next new message; a hard kill or ambiguous failure stays blocked as uncertain.
- A worker/machine crash interrupts pending work and records an interrupted reply; it does **not** automatically replay the prompt. Its saved in-flight mapping refuses further appends because acceptance/side effects may be ambiguous. Check files/tool effects and start a new thread.
- Finished mappings and completed journals survive worker replacement. Credential/configuration, workspace and native Cursor chat files must remain available.

This is ordinary detached execution, not a checkpointable Durable runtime or an exactly-once guarantee for arbitrary tools.

## Offline tests

`bun test tests/cursorRuntime.test.ts tests/cursorServerRestart.test.ts`

Fixtures reproduce inspected NDJSON/protobuf shapes without a model/network dependency. Tests cover catalog validation, no duplicate aggregate text, structured/failed tools, prior/fork/workspace/native-history guards, malformed streams, graceful cancellation, real HTTP shutdown, once-only shell effects while offline, output projection/replay, stable-ID deduplication, runtime locking, and saved native resume after a fresh worker starts.
