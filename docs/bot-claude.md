# Claude for bots

Bots can run on a Claude Pro or Max subscription. OpenBuild ships the
[pi-claude-code](https://github.com/earendil-works/pi-claude-code) bridge (MIT, vendored in
`server/bots/claude-code`, see its README for the revision and OpenBuild's changes) and loads it
into every bot's Pi itself. There's no Pi package to install or switch on under Custom extensions.

The bridge routes each model request through the **installed Claude Code CLI** on the server.
Pi still owns the conversation, compaction and tools; Claude Code only answers. Use counts
against the Claude plan's limits like any other Claude Code use.

## Logins

Every Claude Code login on the server is its own provider, so a bot (or a fallback) can pick
which subscription it runs on:

| Login | Provider | Where Claude Code keeps it |
| --- | --- | --- |
| The default | `claude-code` ("Claude") | `CLAUDE_CONFIG_DIR`, else `~/.claude` |
| Another one | `claude-code-2` ("Claude (2)"), `claude-code-work`, … | its own directory |

Other logins are the Claude Code accounts OpenBuild already knows: ones added with **Add harness**
in Settings → Harnesses, a `claude2` wrapper or alias that sets `CLAUDE_CONFIG_DIR`, or a signed-in
sibling such as `~/.claude-2`. The provider ids match the pi-claude-code package's, so a bot set to
`claude-code-2/…` keeps its model.

## Settings → Bots → Claude

Each login shows whether bots use it, its email and plan as `claude auth status` reports them, and
its directory.

- **Connect** on a signed-in login lets bots use it again.
- **Connect** on a signed-out one runs Claude Code's own sign-in (`claude auth login --claudeai`
  for that directory). Open Claude, approve, and paste the code Claude shows. The code goes to the
  CLI's standard input and nowhere else: it isn't logged, saved or sent back. A sign-in that isn't
  finished in ten minutes ends.
- **Disconnect** takes the login away from bots. A bot set to one of its models moves on to a
  fallback. Claude Code stays signed in, because Claude Code threads and the terminal use the same
  login. Tick **Also sign Claude Code out** to run `claude auth logout` for that directory too.

OpenBuild never reads, copies or stores Claude's credentials. Claude Code keeps them where it
always does. Only the server's own session can use these routes; paired devices can't.

A change here (connect, sign in, disconnect) applies from each bot's next reply. The bots' model
list is asked again straight away.

## The user's own pi-claude-code

If the user switches their own pi-claude-code package on for bots under **Custom extensions**,
OpenBuild's copy stays out, because both would register the same providers. Settings → Bots →
Claude says so. Other Claude bridges with their own provider ids (such as pi-claude-bridge's
`pi-claude`) load alongside it as before.

Pi threads (not bots) are unchanged. They load whatever the user's Pi settings load.

## Limitations

- Claude Code must be installed on the server that runs the bots, and paired devices sign in on
  their own machine. Signing in uses Claude's copy-the-code page, so it also works from a phone.
- Adding a new Claude login (another config directory) is done in Settings → Harnesses, not here.
- The bridge is experimental upstream. If Anthropic changes how Claude Code's non-interactive use
  is billed, it may cost more or stop working.
