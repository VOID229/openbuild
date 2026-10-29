# Durable runtime

Before the first send, choose **Pi** or **Durable** in the dropdown above the composer, next to the checkout controls. This also works for scratch folders. The choice is saved on the thread and cannot change mid-thread. Existing threads default to Pi.

## What Durable means

[Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable) is a separate, experimental harness. It commits conversations, model turns and tool tasks to storage before publishing them. Reopening that storage and starting its scheduler resumes unfinished work.

OpenBuild pins its Durable dependencies rather than following an unversioned API. Ordinary Pi threads still use the installed Pi RPC process. Durable uses Pi's configured model runtime and credentials, but does **not** load Pi coding-agent extensions, skills, MCP servers or prompt templates. Its tool set is Durable's `read`, `write`, `edit` and `bash` in the thread's workspace, plus OpenBuild's restart-safe `question_ask`. The same local authentication gate protects both runtimes; neither is a sandbox.

## Restart recovery

Durable data lives in `durable/` inside OpenBuild's data directory (`OPENCHAT_DATA_DIR` if set):

- Harness transcripts/checkpoints use append-only JSONL storage with `fsync: true`.
- Run manifests preserve the submitted request, stable request ID and replayable UI events, using atomic, synced file replacement.
- The manifest is written before submission. Repeating the same request ID reattaches to the original submission instead of sending a second prompt.
- Server startup reopens unfinished runs and starts their scheduler without waiting for a browser. Reconnecting clients replay the saved events.

### Turns run in a worker process

The Durable runtime itself runs in a separate worker process (`server/durable/worker.ts`), started detached by the server and reached over a private Unix socket (`/tmp/openbuild-durable-<hash>.sock`, mode 0600). Its pid and socket are in `durable/worker.json`, and its output in `durable/worker.log`.

That is what makes a **restart** not interrupt a turn: the server only drops its connection; the model request, tools and checkpoints keep going, and the new server process reattaches to the same worker and replays the run's events. A browser that lost its stream during the restart reconnects on its own. If a message is sent to a thread whose previous turn is still running, it reports "still working" with `code: "busy"`; the app then waits for the current turn and sends it rather than failing.

`openbuild stop` leaves both the Durable worker and the ordinary Pi worker running, just like `openbuild restart`: turns can finish while the server is down, with output persisted for reconnection. Use `openbuild stop --all` to terminate both workers explicitly, even if the server is already stopped. A Durable worker that died has its pending runs recovered from the manifests when the next one starts. A worker running older code (after an update) is replaced; its pending runs are resumed by the new one. **No work executes while both server and worker are stopped**, and none of this installs a service manager — use your existing supervisor if you need automatic server restart. Configure systemd units with `[Service] KillMode=process` so service stop/restart does not kill the workers; existing units are not updated automatically ([setup](../README.md)).

Ordinary Pi turns also survive server stop/restart via their detached worker (`pi-worker/worker.json`), but are **not Durable**: a Pi worker/machine crash or `stop --all` interrupts unfinished execution without automatically replaying it. Previously persisted output and the Pi session remain on disk. Check tool side effects before asking Pi to continue; turns needing a user answer still require that answer.

Recovery is not an exactly-once guarantee for arbitrary shell commands or external services. Finished, committed tool results are retained. A crash during a tool declared unsafe to replay produces an interrupted tool result, allowing the model to assess what happened instead of blindly repeating side effects. A model request cut off before a committed response may be made again and may incur additional provider charges. Keep the workspace, Durable data and model credentials available across restarts.

Only **the worker** may own a Durable data directory. Do not open its harness storage from a second process while the worker is using it: the server reaches it over the socket instead. Back up the entire `durable/` directory while stopped; the existing `openchat.db` snapshots alone do not include Durable checkpoints.

## Initial limitations

- Pi extensions are not loaded in Durable threads. OpenBuild separately registers `question_ask` in Durable's Harness registry: the usual question cards support choices, free text, and dismissal, with pending questions and replies persisted across worker restarts.
- The initial UI adapter publishes completed model/tool entries, not token-by-token partial text or live shell output.
- Steering, Pi slash commands and manual compaction are not exposed in the Durable UI; queued messages can be sent after the current reply.
- History rewind (retry/edit of an earlier turn) and importing/forking a Pi transcript are not supported by the initial Durable adapter. These requests fail explicitly rather than silently using the wrong model history; start a new thread instead.
- Durable's upstream API is experimental. Upgrade the pinned packages together and test restart recovery before deploying.

Sources: upstream [README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md), especially Persist and Resume, Tools, Environment, Watching a Conversation, and Storage.
