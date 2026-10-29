# Native Codex runtime

Choose **Codex** in the runtime picker before the first message. The runtime belongs to the thread and cannot change after it starts; start a new thread to switch runtimes.

## Install and sign in

Install the [Codex CLI](https://github.com/openai/codex) on the device where the workspace runs, then sign in there:

```sh
npm install -g @openai/codex
codex login
codex --version
```

OpenBuild uses the installed `codex` executable, or the executable path in `CODEX_BIN`. It does not bundle Codex or copy your login between devices. Paired workspaces need Codex installed and authenticated on their own device. Codex owns its credentials, configuration, model availability, instructions and tools.

**Runtime is not provider.** Choosing a Codex/OpenAI model in a **Pi** thread still runs Pi with Pi's tools and session. Choosing the **Codex runtime** runs the native Codex agent, its conversation and its tools. Its model picker comes from Codex's `model/list`, not Pi's provider catalog; the reasoning control maps to Codex's reasoning effort.

## How it works

OpenBuild starts `codex app-server` and speaks JSON-RPC over stdio. A new OpenBuild thread creates a Codex thread with `thread/start`. Later messages send only the new input with `turn/start`; OpenBuild does not resend the entire visible conversation. The Codex thread id is saved as `codex-session:<thread>`. When a fresh app-server process is needed, OpenBuild uses `thread/resume` with that saved id.

Codex text, reasoning, command execution, file changes and turn status are normalized into OpenBuild's existing message and tool rows. Commands appear as `bash` tools, with streamed output and completion status. Codex remains responsible for executing the tools; OpenBuild does not execute them again when replaying output.

## Restarts and interruption

Codex runs inside OpenBuild's **detached agent worker** (a compatible `pi-worker/` or feature-versioned lane), not inside the HTTP server. `openbuild stop`, `openbuild restart`, server SIGTERM or a server crash leave an admitted turn running. While the server is down, the worker keeps collecting and persisting output. The restarted server reattaches, replays the stream and projects the completed reply into the same message. Posting the same stream id again reattaches to that run instead of starting another Codex turn.

This is process isolation, **not automatic checkpoint recovery**. Killing the worker, losing power or rebooting the machine interrupts an active turn. OpenBuild does not automatically replay that turn: a command or file edit may already have happened, so retrying could duplicate unsafe side effects. Output already saved can be recovered, but unfinished work is not silently rerun. A subsequent message resumes the saved Codex thread if its history is consistent and idle; an active or inconsistent saved turn is rejected rather than automatically continued.

Use **`openbuild stop --all`** when you explicitly want to stop the detached worker and its agents too. Ordinary server restarts are intentionally different.

New threads use a feature-versioned lane when the shared worker lacks required features, without interrupting other agents. Existing threads remain pinned to their journal owner; see [worker feature lanes](runtime-questions.md#worker-feature-lanes) for explicit legacy-owner upgrades.

## Limits

- Codex threads do not load Pi extensions or Pi slash commands. Shell shortcuts and manual compaction are not native Codex controls.
- Steering works: a queued message's Steer button hands it to the running reply through Codex's `turn/steer`, and Codex reads it at its next step. It shows in the reply where Codex took it. Steered images are sent too.
- Editing an earlier message or regenerating a reply does not rewind Codex's saved conversation. Send a follow-up or start a new thread instead.
- This integration uses Codex's app-server protocol; an installed CLI must support it. It is not a wrapper around `codex exec` or Pi's Codex provider.

The restart integration test (`tests/codexServerRestart.test.ts`) uses a fake `CODEX_BIN` speaking the installed CLI's app-server v2 protocol. It requires no model credentials and checks offline shell execution, replay, duplicate admission, runtime immutability and saved-thread resume.
