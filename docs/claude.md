# Claude Code runtime

Choose **Claude Code** in the runtime picker before the first message. The runtime belongs to the thread and cannot change after it starts.

## Install and sign in

Install [Claude Code](https://docs.claude.com/en/docs/claude-code) on the device where the workspace runs, then start it once to sign in:

```sh
curl -fsSL https://claude.ai/install.sh | bash
claude          # sign in, then exit
claude --version
```

OpenBuild drives the **installed** `claude` executable (or `CLAUDE_BIN`) through Anthropic's official Agent SDK (`@anthropic-ai/claude-agent-sdk`, `pathToClaudeCodeExecutable`), the same way t3code does. It never uses the SDK's bundled binary, never reads or copies Claude's credentials, and never calls the Anthropic API itself. Every request comes from your Claude Code, on your Claude subscription or API key, as if you'd typed it in the terminal. Paired devices need Claude Code installed and signed in on their own machine.

Claude Code loads its own configuration as it does in the terminal: `~/.claude/settings.json`, the project's `.claude/settings*.json`, `CLAUDE.md`, skills, hooks, plugins and MCP servers (`settingSources: user, project, local`; the `claude_code` system prompt and tool presets).

**Runtime isn't provider.** Choosing a Claude model in a **Pi** thread still runs Pi, with Pi's tools. The **Claude Code runtime** runs Claude Code's own agent, conversation and tools.

## Models, effort and fast mode

The model picker lists what the CLI reports for this sign-in (`supportedModels()`): its aliases (`default`, `opus`, `sonnet`, `haiku`, …) and pinned versions, as `claude/<value>`. **Thinking** offers the model's own effort levels, plus **Off** where the model supports turning thinking off (Off needs a fresh process, so OpenBuild restarts it between turns when you toggle it; the conversation is resumed, not resent).

**Speed → Fast** appears on models where Claude Code reports `supportsFastMode`. It turns on Claude Code's fast mode for the turn (`applyFlagSettings({ fastMode: true })`, the SDK's opt-in). **Standard** clears it (`fastMode: null`), so a previous Fast choice never sticks. Fast mode is billed by Anthropic at a higher rate. If Claude Code can't serve it (cooldown after a rate limit, your plan, org policy), the reply runs at standard speed and OpenBuild says so under the reply.

## Permissions

The shield pill above the composer sets the thread's **Claude Code permission mode**, applied with `setPermissionMode` before each turn:

| Mode | What Claude Code does |
| --- | --- |
| Ask (`default`) | Asks before edits, commands and any tool your rules don't allow |
| Accept edits | Edits files without asking; asks before commands |
| Plan | Read-only. When the plan is ready, you choose to proceed (accepting edits or asking), or keep planning |
| Auto | Claude Code's classifier approves safe actions and asks about the rest |
| Don't ask | Only what your allow rules permit; everything else is denied |
| Bypass permissions | Runs every tool without asking. Use only in a sandbox |

With nothing picked, the thread uses `permissions.defaultMode` from Claude's settings for that folder (else Ask). Modes your settings disable (`disableBypassPermissionsMode`, `disableAutoMode`, including managed settings) are greyed out. Claude Code still enforces your allow/deny rules and hooks in every mode.

When Claude Code needs a decision, the reply shows a question card: **Allow once**, **Allow for this session** (when Claude suggests a rule; it's added for this session only, and OpenBuild never writes your settings files), or **Deny**. Claude's own `AskUserQuestion` tool shows its options as choices, with a free-text answer. Stopping the reply cancels any open question.

## Tool calls

Claude Code's tools appear in OpenBuild's usual rows: `Bash` as commands with their output, `Read`, `Edit`/`MultiEdit`/`Write` with the diff Claude actually applied (from its structured patch), `Grep`/`Glob` as searches, `WebSearch`/`WebFetch`, `TodoWrite` as a checklist, `Task`/`Agent` subagents (with their tools nested in the same run), `ExitPlanMode` and MCP tools under their own names. Thinking streams as reasoning, text streams token by token. The native input and structured result stay on each row (`args.claude`). Claude Code runs every tool itself; OpenBuild never runs one again.

## Restarts and interruption

Claude Code runs inside OpenBuild's **detached agent worker** (`pi-worker/`, shared with Pi, Codex, Cursor and fx), not in the HTTP server. `openbuild stop`, `openbuild restart`, a server crash or SIGTERM leave a running turn running. While the server is down the worker keeps saving its output. The restarted server reattaches, replays it, and finishes the reply in the same message. Posting the same stream id again reattaches instead of starting another turn.

Each thread keeps a warm Claude process between turns (closed after 20 idle minutes). The thread's Claude session id is saved as `claude-session:<thread>`. A new process **resumes** that session (`resume`) and gets only the new message; OpenBuild never resends old messages. Claude Code keeps the history in `~/.claude/projects/` (or `CLAUDE_CONFIG_DIR`), so the session is also visible to `claude --resume`.

This is process isolation, **not automatic replay**. Killing the worker, a power loss or a reboot interrupts the active turn, and OpenBuild doesn't rerun it, because a command or edit may already have happened. Use `openbuild stop --all` only when you mean to stop the worker and its agents too.

A worker left running from an older OpenBuild doesn't know this runtime. OpenBuild replaces it once it's idle. If it's busy, it asks you to let it finish, then run `openbuild stop --all` and `openbuild start`.

## Retry and edit

Unlike Codex and Cursor, Claude Code threads can **retry or edit an earlier message**. OpenBuild remembers where each of your messages ended in Claude's transcript and **forks** the session there (`forkSession` + `resumeSessionAt`): the new branch carries the history up to that point, and nothing after it is replayed. The old transcript is left as it was. Retrying the first message starts a fresh session. Files Claude changed after that point are **not** reverted.

## Limits

- No Pi extensions, Pi slash commands, `/compact`, `!` shell commands or steering in Claude Code threads.
- Forking a thread into a new thread isn't supported; retry/edit within the thread instead.
- If Claude's saved transcript is deleted, the thread refuses to continue rather than starting over silently. Start a new thread.

## Offline tests

`bun test tests/claudeRuntime.test.ts tests/claudeServerRestart.test.ts`

A fake `CLAUDE_BIN` (`tests/claudeFixture.ts`) speaks the stream-json control protocol captured from Claude Code 2.1.311 under the Agent SDK. No model, network or sign-in is needed. The tests cover model/effort/fast-mode discovery and application, clearing fast mode, permission modes from the settings layers, approvals (including "for this session" scope), tool-row mapping and diffs, history guards, rewind, resume after a process restart, and a real HTTP server SIGTERM with offline completion, replay, de-duplicated admission and a resumed follow-up.
