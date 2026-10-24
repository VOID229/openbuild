# Durable runtime

Before the first send, choose **Pi** or **Durable** in the dropdown above the composer, next to the checkout controls. This also works for scratch folders. The choice is saved on the thread and cannot change mid-thread. Existing threads default to Pi.

## What Durable means

[Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable) is a separate, experimental harness. It commits conversations, model turns and tool tasks to storage before publishing them. Reopening that storage and starting its scheduler resumes unfinished work.

OpenBuild pins its Durable dependencies rather than following an unversioned API. Ordinary Pi threads still use the installed Pi RPC process. Durable uses Pi's configured model runtime and credentials, but does **not** load Pi coding-agent extensions, skills, MCP servers or prompt templates. Its initial tool set is Durable's `read`, `write`, `edit` and `bash` in the thread's workspace. The same local authentication gate protects both runtimes; neither is a sandbox.

## Restart recovery

Durable data lives in `durable/` inside OpenBuild's data directory (`OPENCHAT_DATA_DIR` if set):

- Harness transcripts/checkpoints use append-only JSONL storage with `fsync: true`.
- Run manifests preserve the submitted request, stable request ID and replayable UI events, using atomic, synced file replacement.
- The manifest is written before submission. Repeating the same request ID reattaches to the original submission instead of sending a second prompt.
- Server startup reopens unfinished runs and starts their scheduler without waiting for a browser. Reconnecting clients replay the saved events.

**No work executes while OpenBuild is stopped.** Starting it again resumes durable work; this does not install a service manager or automatically restart a dead server. Use your existing supervisor if you need automatic server restart. Ordinary Pi replies still stop on server restart.

Recovery is not an exactly-once guarantee for arbitrary shell commands or external services. Finished, committed tool results are retained. A crash during a tool declared unsafe to replay produces an interrupted tool result, allowing the model to assess what happened instead of blindly repeating side effects. A model request cut off before a committed response may be made again and may incur additional provider charges. Keep the workspace, Durable data and model credentials available across restarts.

Only **one OpenBuild process** may own a Durable data directory. Do not open its harness storage from a second process while OpenBuild is using it. Back up the entire `durable/` directory while stopped; the existing `openchat.db` snapshots alone do not include Durable checkpoints.

## Initial limitations

- Pi extensions and their question dialogs are not available in Durable threads.
- The initial UI adapter publishes completed model/tool entries, not token-by-token partial text or live shell output.
- Steering, Pi slash commands and manual compaction are not exposed in the Durable UI; queued messages can be sent after the current reply.
- History rewind (retry/edit of an earlier turn) and importing/forking a Pi transcript are not supported by the initial Durable adapter. These requests fail explicitly rather than silently using the wrong model history; start a new thread instead.
- Durable's upstream API is experimental. Upgrade the pinned packages together and test restart recovery before deploying.

Sources: upstream [README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md), especially Persist and Resume, Tools, Environment, Watching a Conversation, and Storage.
