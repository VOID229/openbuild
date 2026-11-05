# Ori Harness (OpenRouter)

[Ori Harness](https://openrouter.ai/docs/guides/ori/overview) is OpenRouter's launcher for agent
CLIs: `ori claude` and `ori codex` start the real Claude Code or Codex with OpenRouter's endpoint,
credential and model catalog injected. OpenBuild uses it as a runtime account.

## Set up

1. Install Ori on the device: `curl -fsSL https://openrouter.ai/labs/ori/install.sh | bash`
   (`ORI_BIN` points OpenBuild at another `ori`).
2. Sign in once: `ori login`. OpenBuild never reads Ori's credentials.
3. Settings → Runtimes → Add runtime → **Claude Code via Ori** or **Codex via Ori**.

The account appears in the model picker as its own provider (`claude-ori`, `codex-ori`, …) listing
the OpenRouter catalog, next to the device's native sign-in.

## How it runs

The Claude Agent SDK and Codex's app-server each take a single executable, so OpenBuild writes a
shim per harness under its data directory (`ori/claude-<hash>`):

```sh
exec ori claude -- "$@"
```

Everything after `--` reaches the harness untouched (stream-json, `app-server`, resume, …). The
account's own `CLAUDE_CONFIG_DIR` / `CODEX_HOME` keeps its history apart; Ori keeps them. A binary
path set on the account goes first on `PATH`, since Ori finds the harness there.

Ori fails before launch when no OpenRouter credential is saved. Run `ori login` on that device.
Updating Claude Code or Codex in Settings still updates the native install; `ori update` updates Ori.
