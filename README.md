# OpenBuild

## Working on the iMac server

When making changes to OpenBuild, do **not** stop or restart the OpenBuild server running on my iMac unless I explicitly ask you to. Leave the server running while you work.

## OpenBuild and openchat

OpenBuild is a fork of [openchat](https://openchat.shade-io.com), with a different purpose:

| | OpenBuild | openchat |
|---|---|---|
| Purpose | Coding with [Pi](https://pi.dev) under the hood, not a general-purpose chat app | Chatting |
| Hosting | Self-hosted on your own machine | Hosted at [openchat.shade-io.com](https://openchat.shade-io.com) |
| Access | Localhost, LAN, or Tailscale — your choice | Hosted website |
| Accounts & cloud sync | None; a local instance password protects access | Accounts and Convex cloud syncing |
| Data | Stored on your self-hosted server | Cloud syncing through Convex |

Multiple browsers and devices connect to the same OpenBuild server; they do not need cloud accounts or cloud syncing. OpenBuild does not use openchat's hosted service or Convex deployment.

OpenBuild also keeps its local storage separate from an openchat install on the same machine: its default port is `3100` (rather than `3000`), macOS data lives in `~/Library/Application Support/OpenBuild/`, the keychain service is `openbuild`, and the secrets-file fallback is `~/.config/openbuild/secrets.json`.

```sh
bun install
bun run dev          # http://localhost:3100 (PORT=... to change), with HMR
bun run start        # same, production mode
bun run typecheck
bun test
```

Set a local access password with `openbuild set pass <password>` (or `bun bin/openbuild.ts set pass <password>`), then open http://localhost:3100. The entire app stays behind a non-dismissible password dialog until unlocked. This is a local server password, not a cloud account.

### Environment variables (all optional)

The names keep upstream's `OPENCHAT_` prefix. Put them in `.env` or `.env.local` (Bun loads both; both are git-ignored); see `.env.example`.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3100` | Port to listen on |
| `HOST` | `127.0.0.1` | Bind address |
| `OPENCHAT_ALLOWED_HOSTS` | (none) | Extra host names allowed to reach the API, comma-separated |
| `OPENCHAT_DATA_DIR` | per-user data dir (`OpenBuild`) | Where chats and settings are stored |
| `OPENCHAT_SECRETS` | keychain | `file` keeps API keys in a 0600 file instead of the OS keychain |
| `OPENCHAT_SECRETS_FILE` | `~/.config/openbuild/secrets.json` | Path of that file |
| `PI_BIN` | `pi` on `PATH`, else `~/.local/bin/pi` | The Pi executable to run |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi's config folder (Pi reads this too) |

### No cloud accounts or syncing

OpenBuild is self-hosted and offers no cloud accounts or cloud syncing. Convex/account code inherited from openchat is not part of OpenBuild's supported setup. Do not configure `OPENCHAT_CLOUD_URL` or deploy to openchat's Convex project. The local instance password is an access gate for your server, not a cloud account.

## Usage

OpenBuild is a front end for building software with [Pi](https://pi.dev), the coding agent installed on this computer. Choose **Pi** or **Durable** above the composer before starting a thread. The choice is fixed for that thread. Pi threads run on the `pi` you have installed, with its models, credentials, extensions, skills and prompt templates. Durable threads use the separate, experimental [Pi Durable harness](https://github.com/earendil-works/pi/tree/main/packages/durable); see [Durable runtime](docs/durable.md).

1. **Pi.** Settings → Pi shows whether it's installed, its version, and whether there's an update; it installs or updates Pi for you (Pi's own installer, `curl -fsSL https://pi.dev/install.sh | sh`), and lists problems Pi reported (warnings, extension errors).
2. **Providers.** Settings → Providers signs in to model providers through Pi (OAuth or API key, via Pi's own login flows), so credentials land in `~/.pi/agent/auth.json` exactly as `/login` in Pi would put them. The model picker lists the models Pi can use, grouped by provider; Pi's default model is picked first.
3. **Projects.** Settings → Projects adds folders (usually git repositories). It suggests repositories it finds in your usual code folders, or browse to one.
4. **Start a thread.** Under the composer, pick the project, then **Local** (work in the project's own checkout, optionally switching branch when nothing is uncommitted) or **Worktree** (a new git worktree on its own `openbuild/<name>` branch, started from the branch you pick). "No project" gives the thread an empty scratch folder.

The sidebar automatically discovers saved Pi sessions from before OpenBuild was installed, as well as sessions started in a terminal or another Pi client. It refreshes every five seconds while the app is visible. Opening and continuing one uses its original session file and working directory; discovery itself never modifies Pi's files. Removing a thread hides it from OpenBuild without deleting its Pi transcript. Sessions saved with `--no-session` can't be discovered; custom archives configured through `PI_CODING_AGENT_SESSION_DIR` or Pi's global `sessionDir` setting are included.

URLs use `/new` for a new thread, `/thread-<id>` for an existing thread, and `/settings/<section>` for settings (for example, `/settings/appearance`). Direct links, reloads, and browser Back/Forward work; old `#/c/<id>` bookmarks are converted automatically. Unknown or deleted threads return to `/new`.

In a thread you see what Pi does as it does it: files it read, commands it ran (with output), and edits as diffs. When an extension asks something (a confirmation, a choice), it shows up as a card to answer. Type `/` for Pi's commands (extension commands, prompt templates, `/skill:…`), plus `/compact` and `/new` from OpenBuild. Under the composer, on the right, a ring shows how full the context is and next to it what the thread has cost; click it for the tokens by kind (system prompt and tools, cached, input, output) and the spend. Models Pi prices are shown as billed; subscription models (Codex, the Claude bridge, xAI OAuth, OpenCode Go, coding plans) as `(plan)` at their API value; local models and free tiers as `(free)`, estimated at what the same model costs elsewhere in Pi's catalog.

Start a message with `!` to run a shell command on the server, in the thread's folder (a scratch thread's commands run in your home folder). It runs right away, even while Pi is working: it doesn't wait for the reply, interrupt it or get steered in. Its output streams into the thread, and a Stop button ends it. Pi keeps the command in the thread's session the way `!` works in Pi's terminal, so the agent reads the command and its output with your next message. Start with `!!` instead to run a command only for yourself: the agent never sees it. Pi can only stop all of a thread's running commands at once, so stopping one stops the others. Commands go through your `user_bash` extensions, like any `!` in Pi. They aren't available in Durable threads yet.

Settings → Pi also manages **extensions, skills and prompt templates** (`~/.pi/agent/…` and `~/.agents/skills`): turn them off and on (Pi's exact `-path` exclusion in `settings.json`), edit their files in place, create new ones from a template, or remove them (moved to `~/.pi/agent/.openbuild-trash`, never deleted). Pi packages (npm/git) can be installed and removed there too.

### Plugins

OpenBuild can be extended without editing its source. Drop a folder with a `plugin.json` into `plugins/`, then open **Settings → Plugins** and turn on **Enable plugins** — the whole plugin system is off by default, so nothing in that folder loads until you do. The same page lists, enables, disables, deletes and reloads each plugin. A plugin can fill UI slots (composer, sidebar, messages, settings), add a Settings page, render custom tool rows, apply CSS tokens or a stylesheet, restyle the app, and add authenticated `/api/plugins/<id>/…` routes or a `beforeChat` hook on the server.

Client modules are ordinary TSX with no build step: `react` and `openbuild` resolve to the app's own instances, so hooks and context work. **Plugins hot-reload without restarting OpenBuild**: edits to `client.tsx`, `styles.css`, `server.ts` and `plugin.json` reload live, and new plugin folders are picked up too. Client changes reach open browsers over SSE; a changed `server.ts` is re-imported, its old `onStop` runs and its new `onStart` runs, with routes and chat hooks rebuilt. The master switch and per-plugin toggles also apply immediately. The watcher never restarts the server, so active Pi threads keep running. Only changes to OpenBuild's own code need a restart.

Five examples ship in `plugins/`: **Daily note** (a composer button, a server route and a plugin Settings page), **OpenRouter logo for DeepSeek** (icon overrides), **Claude provider for pi-claude** and **Codex (2) for codex-multi** (provider grouping, the second with a badged icon), and **Quiet UI** (manifest-only tokens/CSS, off by default). `openbuild.config.example.ts` shows how to change the plugin folder or global CSS. Full reference: [docs/plugins.md](docs/plugins.md). Plugins are trusted code — `OPENBUILD_SAFE=1` (or `?safe`) starts with none.

### Local Whisper dictation

Settings → General → **Local dictation** replaces browser speech recognition with your private whisper.cpp server. Tap the mic to record, then again to transcribe (up to two minutes). The transcript is appended to the draft. Audio is sent through the authenticated OpenBuild backend, not to a public transcription service, and OpenBuild doesn't save recordings. With the toggle off, browser dictation works as before.

Set `OPENBUILD_WHISPER_LAN_URL` and/or `OPENBUILD_WHISPER_TAILSCALE_URL` in `.env.local` to your whisper.cpp server's base URL, then restart OpenBuild. The LAN/Tailscale setting chooses the **backend-to-Whisper** connection; your browser can open OpenBuild over Tailscale while its backend reaches Whisper over LAN. **Test connection** checks the selected endpoint. Whisper must support `/health` and `/inference`. No ffmpeg installation is needed by OpenBuild: the browser converts recordings to 16 kHz mono WAV.

Use HTTPS (or localhost) to open OpenBuild: browsers block microphone access on ordinary LAN HTTP pages. For a private remote endpoint, use Tailscale Serve, never Funnel. A TCP forward over a Tailscale IP is encrypted by Tailscale even when the endpoint URL uses HTTP. Only devices permitted by your tailnet policy should reach Whisper; whisper.cpp itself has no access gate added here. If your Tailscale daemon uses a custom socket, set `OPENBUILD_TAILSCALE_SOCKET` so the CLI can set up HTTPS.

### The `openbuild` command

`bun run cli:install` links `openbuild` and its shorter alias `ob` into `~/.local/bin`. It runs the server in the background:

```sh
openbuild set pass <pw>     # set/change the local password
openbuild password          # the same, at a hidden terminal prompt
openbuild start             # this computer only: http://localhost:3100
openbuild start lan         # also devices on your network (plain HTTP, this computer's LAN addresses)
openbuild start tailscale   # your tailnet over HTTPS: https://<this-mac>.<tailnet>.ts.net
openbuild stop              # also restart, status, logs, open
openbuild restart           # asks first: a restart ends the Pi threads working in it
openbuild pair --host       # let another OpenBuild use this computer (prints a code)
openbuild pair --client     # add another computer's OpenBuild (asks for its code)
```

### Paired devices

One OpenBuild can use another computer's projects, worktrees, Pi turns and shell commands. On the computer to be used, run `openbuild pair --host`: name it, pick Tailscale or LAN, and it starts (or reuses) its headless server and prints a short code. On the computer whose UI you use, run `openbuild pair --client`, pick the same transport, and enter the code; it finds the waiting host on the tailnet or LAN. The other device's projects then appear in Settings → Projects (with a device picker for adding new ones) and in the project menu under the composer, labelled `@<device>`. Settings → Pi has the same picker: install Pi there, update it and its packages, manage its extensions, skills, prompt templates and packages, and read its problems. Settings → Providers uses it too, so a provider can be signed in to, or given an API key, on the paired device; such a sign-in often ends on a `localhost` address, which OpenBuild asks you to paste back. Threads whose project lives on a paired device run there: this server proxies their API and streams, while the UI, chats and settings stay on the server you opened. Unpair from Settings → Projects. Pairing stores a token on the client and only its hash on the host, in owner-only files next to the database.

A restart (and a stop) kills the server process. **Durable threads automatically resume unfinished work when OpenBuild starts again**, without needing a browser to reconnect. No work executes while the server is stopped. Ordinary **Pi** threads still stop mid-reply and have to be asked for again. The thread and its Pi session file stay on disk, so nothing is lost from the conversation. `openbuild restart` asks `Restarting stops ordinary Pi replies; Durable threads resume after startup. Proceed? [Y/n]` when a server it started is running; a server started some other way (systemd, `bun dev`) keeps no `server.json`, so `openbuild restart` refuses with an explanation instead of guessing — restart it where it is managed; `openbuild restart --yes` skips the question (needed when there is no terminal, e.g. from a script).

`start tailscale` keeps the server on `127.0.0.1` and puts `tailscale serve` (HTTPS, tailnet only) in front of it; `stop` turns that off again. If your tailnet has no HTTPS certificates, it listens on the Tailscale address over plain HTTP instead. HTTPS matters on the iPhone: dictation and the clipboard only work on secure pages, and Share → Add to Home Screen gives it a full-screen icon. The pid, mode and address are in `server.json` in the data folder, the output in `server.log`.

Every device/browser must unlock the server with its local password before accessing threads, settings, credentials, or Pi. There is no close button, Escape dismissal, or usable app behind the lock dialog; the server also rejects unauthenticated API requests. LAN/Tailscale startup requires a password to be configured. Set/change it on the host with `openbuild set pass <password>` (or `openbuild password` to type it at a hidden prompt), or from an unlocked browser in Settings → Security, which asks for the current password first; only an Argon2id password hash and hashed session tokens are saved in the private `access.json` file in the data directory—never the password or raw login tokens. Changing the password revokes all other browser sessions (the browser that changed it stays unlocked). Browser logins survive server restarts and expire only after 30 days of inactivity. Each authenticated API request (including an unlock-status check) resets the server expiry and browser cookie to another 30 days; background requests while the app is open also count as activity. Logging out revokes that browser's session immediately. Remembered logins use ordinary first-party HttpOnly, SameSite=Strict cookies (also Secure over HTTPS), without requiring a Lockdown Mode exemption. Clearing website data or using a new/private browser requires signing in again. If you forget the password, run that command again on the host—no cloud recovery needed.

An unlocked browser can make Pi run commands as you. Never expose this directly to the internet. **Plain LAN HTTP does not encrypt passwords or session cookies**; use Tailscale HTTPS or a trusted HTTPS reverse proxy when possible. The password is an access gate, not a sandbox for Pi.

Signing in to a provider from the phone: OAuth flows that redirect to `localhost` can't complete on another device, so pick the "headless" / copy-code method when Pi offers one, or paste the address the sign-in page ends on into the box OpenBuild shows.

## How it works

- `server/plugins.ts` and `src/lib/plugins.tsx`: the plugin system. It is off by default; the master switch is in Settings → Plugins. The server always discovers and validates manifests, imports `server.ts` only when the system and that plugin are on, re-imports it when its files change, and dispatches server routes from a table rebuilt on every reload or toggle. Client modules are built with Bun on demand (React and the `openbuild` SDK are left as references to the host). The app loads enabled plugins after unlock into named slots, with an error boundary per plugin, a Settings page, and SSE-driven hot reload. Threads and their Pi processes are untouched by plugin reloads.
- `server/pi/`: Pi integration. Each thread gets a `pi --mode rpc` process running in the thread's folder (`rpc.ts`, `sessions.ts`), started on demand and closed after 20 idle minutes. Its session is a normal Pi session under `~/.pi/agent/sessions`, so `pi -r` in a terminal can open the same thread. Pi owns the conversation: a turn sends just the new message plus how many user messages come before it, and when the thread was edited or retried, Pi's history is forked back to that point first. Every thread's Pi also loads OpenBuild's own extension, `server/pi/extensions/question-ask.ts`, which gives the model a `question_ask` tool: a question with lettered choices plus the user's own answer, shown as a card in the reply (it stands in for the terminal-only `ask` extension, which can't work over RPC). Pi's events are turned into the app's reply stream (text, thinking, tool calls, questions) and run apart from the request (`runs.ts`), so a reload or a dropped connection doesn't stop Pi.
- `server/pi/helper.mjs` runs under Node with the installed Pi's SDK, for what RPC mode doesn't cover: listing providers and signing in or out. `install.ts` finds Pi (the managed installer's `~/.local/bin/pi`, an npm global install, or `PI_BIN`) and checks npm for updates. `resources.ts` manages extensions, skills and prompts.
- `server/projects.ts`: projects, branches and worktrees. Worktrees live in OpenBuild's data folder under `worktrees/`. The thread menu in the sidebar can remove a thread's worktree (and its branch, if merged).
- The older Opencode proxy (`/api/chat`, `server/opencode.ts`, `agent.ts`, `search.ts`) is still in the server but no longer reachable from the UI.
- Threads and settings are saved by the local server in a SQLite database on your disk, not in the browser, so every port, browser and device sees the same data:
  - macOS: `~/Library/Application Support/OpenBuild/openchat.db`
  - Linux: `~/.local/share/openbuild/openchat.db` (or `$XDG_DATA_HOME/openbuild`)
  - Windows: `%APPDATA%\OpenBuild\openchat.db`
  - or anywhere you like with `OPENCHAT_DATA_DIR`.

  Writes are synced to disk before they're acknowledged (SQLite WAL, `synchronous=FULL`). If the server is unreachable (restarting, stopped), changes wait in a queue in the browser and are sent as soon as it's back. A snapshot is copied to `backups/` next to the database at startup and every 6 hours (the newest 20 are kept).
- The port never changes on its own: if it's taken, `bun run dev` stops with an error instead of moving to another port.
- The API rejects requests with a foreign `Host` or `Origin`, so other websites can't drive Pi through your browser.
- Threads are named automatically after the first prompt (Settings → General → Thread naming), using the thread's own model with thinking off unless you pick naming models.
