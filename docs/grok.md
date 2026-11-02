# Grok runtime

Before the first send, choose **Grok** in the runtime dropdown above the composer. The choice is saved on the thread and cannot change mid-thread.

OpenBuild doesn't bundle Grok Build: it runs the `grok` installed on the device the thread works on (`~/.local/bin/grok`, anything on `PATH`, or `GROK_BIN`).

```sh
curl -fsSL https://x.ai/cli/install.sh | bash
grok login
```

Grok brings its own models, sign-in, permission mode, skills, hooks, MCP servers and `AGENTS.md` handling, and OpenBuild leaves those settings alone. Pi extensions, Pi slash commands, `!` shell commands and `/compact` aren't available in Grok threads.

## How it works

Each Grok thread gets a `grok agent --no-leader stdio` process ([Agent Client Protocol](https://agentclientprotocol.com) over stdio) in the thread's workspace, with its own Grok session. `--no-leader` matters: a thread must not depend on a shared leader process, even when `config.toml` enables one. Grok saves the session under `~/.grok/sessions`, so `grok -r <id>` opens it in a terminal too. Grok owns the conversation, so a turn sends only the new message. The session id is stored as `grok-session:<thread>`. A session that can't be resumed is an error on the thread; it is never replaced by an empty one.

The model picker lists `grok models` as `grok/<id>`. Effort levels and context windows come from the agent's `initialize` response and the `_x.ai/models/update` it pushes right after, with no session created. The effort control maps onto Grok's `reasoning_effort` config option.

The protocol below was recorded from Grok Build 1.0.70. Its published docs show `set_config_option` with `{ "value": { "value": … } }`; the agent rejects that, and takes a plain string.

## Tools

`session/update` events map onto the stream events Pi turns produce, using Grok's own name from `_meta["x.ai/tool"].name`: `run_terminal_command` → `bash`, `read_file` → `read`, `search_replace` → `edit` (`write` when `old_string` is empty, which creates the file), `grep` → `grep`, `list_dir` → `ls`, `web_search`, `web_fetch` → `fetch`. Other tools keep their names.

- Each `in_progress` update carries all of a command's output so far, not a delta.
- Grok reports a command that exits nonzero as `completed`; it is shown as failed, from `rawOutput.exit_code`.
- A `tool_call_update` with no `status` carries Grok's description of the call in `content`. It isn't output.
- `todo_write` has no row of its own: the `plan` update draws the list.

## Permissions and questions

Grok's own `permission_mode` applies (`[ui]` in `~/.grok/config.toml`). OpenBuild doesn't change it and has no picker for it. Anything Grok asks through `session/request_permission` appears as a question card. Rejecting one **ends Grok's turn** (`cancellationCategory: PermissionRejected`); that's Grok's behavior, and the thread says so. Reply to tell it what to do instead.

Clarifying questions use Grok's native `ask_user_question` tool, which reaches the client as `_x.ai/ask_user_question`. Questions are asked in turn with free text allowed, and answered as `{ outcome: "accepted", answers: { "<question>": "<answer>" } }`; dismissing one sends `{ outcome: "cancelled" }`, which Grok treats as a declined question and carries on. The adapter reminds the model to use the tool instead of asking in prose. Other agent requests, such as MCP elicitation and plan approval, are refused.

## Steering

A queued message's **Steer** button sends `_x.ai/interject` with the message as `interjectionId`, and any images as `content`. Grok reads it at its next safe point between tools or model calls, without interrupting a running tool. `_x.ai/session/interjection` announces it, which is where the thread shows it and counts it toward history.

An interjection that reaches Grok once it's idle starts a turn of its own, named `interject-fallback-…`. That can happen when a message races the end of a turn, so the reply stays attached until that turn finishes and its text lands in the same reply.

**Limitation:** Grok announces an interjection when it takes it, before the model reads it. If you press Stop in between, the thread shows the message as delivered even if the model hasn't read it yet.

## Restarts

Grok turns run in OpenBuild's detached agent worker (a compatible `pi-worker/` or feature-versioned lane). `openbuild stop` / `restart` / a crash of the server do **not** interrupt them. Grok keeps working, its output is persisted by the worker, and the restarted server reattaches and replays it to the app. Re-posting the same reply (same stream id) reattaches instead of prompting Grok again. `openbuild stop --all` terminates the worker and its Grok processes.

Like ordinary Pi, this is process isolation, not checkpoint recovery. If the worker or the machine dies mid-turn, the turn is marked interrupted and is not rerun. Grok's session on disk keeps whatever it committed, and the next message resumes it.

New threads use a feature-versioned lane when the shared worker lacks required features, without interrupting other agents. Idle existing threads move to a compatible lane on their next turn; see [worker feature lanes](runtime-questions.md#worker-feature-lanes).

## Limits

- No rewind: Retry/regenerate and editing an earlier message don't roll Grok's context back. Send a follow-up instead.
- No session import yet, and no per-thread accounts: threads use the device's `~/.grok` sign-in.
- Paired devices: the thread uses the `grok` installed on the device its workspace lives on.

## Offline tests

`bun test tests/grokRuntime.test.ts tests/grokServerRestart.test.ts`

`tests/grokFixture.ts` reproduces the recorded event shapes without a model or network. It can't prove what a real model chooses to do, so the shapes need rechecking against a live agent when Grok's protocol changes.
