# pi-claude-code, vendored for bots

The Pi provider that routes Claude model requests through the installed Claude Code CLI, so bots
can run on a Claude Pro or Max subscription. OpenBuild loads it into bots' Pi itself
(`server/bots/claude.ts`), so the user doesn't have to install or enable a Pi package.

- Upstream: https://github.com/earendil-works/pi-claude-code
- Revision: `d5b5e04c314d3452d357174d16d10dda34daa2d2` (main, 2026-11-05), `src/` only
- License: MIT, Copyright (c) 2026 Armin Ronacher. See [LICENSE](LICENSE), which must stay with
  these files.

Upstream's own test suite (`tests/`, not copied here) passes against this copy, with OpenBuild's
changes, on the pi-ai version OpenBuild depends on: 42 passed, 6 Windows-only skipped. OpenBuild's
tests are in `tests/botClaude.test.ts`.

## OpenBuild changes

Each change is marked `OpenBuild:` in the source.

- `provider.ts`: `createClaudeCodeProvider(profile)` takes an id, name, config directory and
  executable, so every Claude Code login is its own provider (`claude-code`, `claude-code-2`, …)
  with its own auth and discovery state. A profile pins `CLAUDE_CONFIG_DIR` and the executable for
  status checks, discovery and requests, and never reads `process.env` for them or shares state
  with another profile. Without a profile it behaves as upstream.
- `index.ts`: takes the profiles OpenBuild passes (from a generated wrapper), registers each
  provider once, and checks each login in `/claude-code-status`. It types the small part of Pi's
  extension API it uses, since `@earendil-works/pi-coding-agent` isn't an OpenBuild dependency.
- `claude-cli.ts`:
  - `budgetCacheMarkers`: the Messages API allows four `cache_control` blocks. Claude Code's own
    tool and system markers plus the replay's could reach five ("A maximum of 4 blocks with
    cache_control may be provided. Found 5."), and the bot's turn failed over to another model.
    The latest four are kept, in prefix order (tools, system, messages, including blocks inside a
    tool result). Tool schemas, tool inputs and other data are never touched. Based on
    earendil-works/pi-claude-code#37.
  - Captured native system messages are restored only when Claude Code sent native system
    messages in this request too (Haiku 4.5 refuses the `system` role), and
    `alignSystemOutputConfig` gives them this request's `output_config`, or none. Before, a turn
    after the model behind a Pi model id changed failed with HTTP 400.
  - Process output is read until `close`, not `exit`, and `claude auth status` is asked again when
    it prints nothing, so a login doesn't flicker to signed out and hide its models.
  - Unused imports removed for OpenBuild's stricter compiler settings.
- `transcript.ts`: foreign tool ids rewritten for Anthropic get a hash of the original, so
  distinct ids can't collapse into one.
- `model-catalog.ts`, `turn-relay.ts`: unused names removed for the compiler.

Upstream's README, ARCHITECTURE and package files aren't copied. Its behaviour notes still apply:
requests count against the Claude plan's limits, Claude Code never runs tools (Pi does), and an
inherited API key, proxy, Bedrock, Vertex or Foundry setting is ignored rather than used.
