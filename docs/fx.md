# fx runtime

Before the first send, choose **fx** in the runtime dropdown above the composer. The choice is saved on the thread and cannot change mid-thread, like Pi and Durable.

[fx](https://fx.sh) is Vercel Labs' coding agent. OpenBuild doesn't bundle it: it runs the `fx` installed on the device the thread works on (`~/.local/bin/fx`, anything on `PATH`, or `FX_BIN`).

```sh
curl -fsSL https://fx.sh/setup.sh | bash
fx login          # Vercel AI Gateway, Codex or Grok
```

It's the out-of-the-box option. fx brings its own models, sign-in, permission mode, skills, MCP servers and `AGENTS.md` handling, and OpenBuild leaves those settings alone. Pi extensions, Pi slash commands, `!` shell commands, steering and `/compact` aren't available in fx threads.

## How it works

Each fx thread gets an `fx acp` process ([Agent Client Protocol](https://agentclientprotocol.com) over stdio) in the thread's workspace, with its own fx session. fx saves that session under `~/.fx/sessions`, so `fx session resume <id>` opens it in a terminal too. fx owns the conversation, so a turn sends only the new message. The session id is stored as `fx-session:<thread>`.

fx's ACP events are mapped onto the same stream events Pi turns produce. Its tools get the names the thread UI already draws: `shell` → `bash`, `read_file` → `read`, `edit_file` → `edit` (with a diff), `write_file` → `write`, `grep_files` → `grep`, `glob_files` → `find`. So text, thinking, tool rows, live shell output, diffs, usage and context fill look the same as in a Pi thread. fx's own permission mode applies (`fx status`). If fx asks before an action, the request appears as a question card in the thread.

Clarifying questions use fx's native `request_user_input` tool, not a Pi extension. OpenBuild advertises ACP form elicitation and handles `elicitation/create`, `session/elicitation`, and `_session/elicitation`, following t3code's ACP adapter. String, boolean, numeric and enum fields appear as question cards; answers are returned with their native types and field IDs. Native enum constraints still apply. Dismissing or stopping cancels the pending form; URL and unsupported complex forms are declined rather than silently accepted. The adapter reminds the model to use its tool instead of asking in prose.

The model picker lists `fx models` for the device as `fx/<id>`. The thinking control maps onto fx's reasoning effort.

## Restarts

fx turns run in OpenBuild's detached agent worker (a compatible `pi-worker/` or feature-versioned lane). `openbuild stop` / `restart` / a crash of the server do **not** interrupt them. fx keeps working, its output is persisted by the worker, and the restarted server reattaches and replays it to the app. Re-posting the same reply (same stream id) reattaches instead of prompting fx again. `openbuild stop --all` terminates the worker and its fx processes.

Like ordinary Pi, this is process isolation, not checkpoint recovery. If the worker or the machine dies mid-turn, the turn is marked interrupted and is not rerun. fx's session on disk keeps whatever fx committed.

New threads use a feature-versioned lane when the shared worker lacks required features, without interrupting other agents. Idle existing threads move to a compatible lane on their next turn; see [worker feature lanes](runtime-questions.md#worker-feature-lanes).

## Limits

- No rewind: Retry/regenerate and editing an earlier message don't roll fx's context back. Send a follow-up instead.
- No Pi extensions (`question_ask`, `html_render`), slash commands, steering, `!` commands or manual compaction.
- Paired devices: the thread uses the `fx` installed on the device its workspace lives on.
