# Hermes runtime

Install Hermes on the device that runs your threads and run `hermes setup` to configure its providers. Enable Hermes in Settings → Harnesses, then select it for a new thread. OpenBuild discovers models through Hermes's ACP session model catalog. `HERMES_BIN` can point to a specific executable.

Each thread owns a `hermes acp` process inside OpenBuild's detached agent worker. Replies continue when the OpenBuild server shuts down or restarts; output is journaled and the server reattaches without replaying prompts. This does not keep processes running through a machine shutdown or worker crash. An interrupted worker reports the interruption instead of repeating tool effects.

Hermes owns conversation history, configuration, tools, skills and provider credentials. OpenBuild saves the ACP session ID and reloads that session when an idle process is retired. Failed loads are reported rather than silently replacing history. Tool calls, diffs, reasoning and permission requests stream into the existing thread UI.

Steering sends a concurrent ACP `session/prompt`. Hermes redirects the active turn when its provider supports redirection, otherwise queues the correction and drains it before the original prompt returns. Text steering is supported; images must be queued as a follow-up. Stop sends `session/cancel`.

Rewinding and forking do not clone or rewind Hermes history. Manual Pi compaction and standalone shell shortcuts are unavailable for Hermes threads. Use Hermes's `/compress` command for compaction. Hermes is not offered as a background short-text generation runtime.

Protocol reference: https://github.com/NousResearch/hermes-agent/tree/main/acp_adapter
