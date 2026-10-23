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

Set a local access password with `bun bin/openbuild.ts password`, then open http://localhost:3100. The entire app stays behind a non-dismissible password dialog until unlocked. This is a local server password, not a cloud account.

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

OpenBuild is a front end for building software with [Pi](https://pi.dev), the coding agent installed on this computer. It doesn't bundle Pi or reimplement it: every thread runs on the `pi` you have installed, with its models, credentials, extensions, skills and prompt templates.

1. **Pi.** Settings → Pi shows whether it's installed, its version, and whether there's an update; it installs or updates Pi for you (Pi's own installer, `curl -fsSL https://pi.dev/install.sh | sh`), and lists problems Pi reported (warnings, extension errors).
2. **Providers.** Settings → Providers signs in to model providers through Pi (OAuth or API key, via Pi's own login flows), so credentials land in `~/.pi/agent/auth.json` exactly as `/login` in Pi would put them. The model picker lists the models Pi can use, grouped by provider; Pi's default model is picked first.
3. **Projects.** Settings → Projects adds folders (usually git repositories). It suggests repositories it finds in your usual code folders, or browse to one.
4. **Start a thread.** Under the composer, pick the project, then **Local** (work in the project's own checkout, optionally switching branch when nothing is uncommitted) or **Worktree** (a new git worktree on its own `openbuild/<name>` branch, started from the branch you pick). "No project" gives the thread an empty scratch folder.

The sidebar automatically discovers saved Pi sessions from before OpenBuild was installed, as well as sessions started in a terminal or another Pi client. It refreshes every five seconds while the app is visible. Opening and continuing one uses its original session file and working directory; discovery itself never modifies Pi's files. Removing a thread hides it from OpenBuild without deleting its Pi transcript. Sessions saved with `--no-session` can't be discovered; custom archives configured through `PI_CODING_AGENT_SESSION_DIR` or Pi's global `sessionDir` setting are included.

URLs use `/new` for a new thread, `/thread-<id>` for an existing thread, and `/settings/<section>` for settings (for example, `/settings/appearance`). Direct links, reloads, and browser Back/Forward work; old `#/c/<id>` bookmarks are converted automatically. Unknown or deleted threads return to `/new`.

In a thread you see what Pi does as it does it: files it read, commands it ran (with output), and edits as diffs. When an extension asks something (a confirmation, a choice), it shows up as a card to answer. Type `/` for Pi's commands (extension commands, prompt templates, `/skill:…`), plus `/compact` and `/new` from OpenBuild. Under each reply, the context fill shows how close the thread is to compaction.

Settings → Pi also manages **extensions, skills and prompt templates** (`~/.pi/agent/…` and `~/.agents/skills`): turn them off and on (Pi's exact `-path` exclusion in `settings.json`), edit their files in place, create new ones from a template, or remove them (moved to `~/.pi/agent/.openbuild-trash`, never deleted). Pi packages (npm/git) can be installed and removed there too.

### Local Whisper dictation

Settings → General → **Local dictation** replaces browser speech recognition with your private whisper.cpp server. Tap the mic to record, then again to transcribe (up to two minutes). The transcript is appended to the draft. Audio is sent through the authenticated OpenBuild backend, not to a public transcription service, and OpenBuild doesn't save recordings. With the toggle off, browser dictation works as before.

Set `OPENBUILD_WHISPER_LAN_URL` and/or `OPENBUILD_WHISPER_TAILSCALE_URL` in `.env.local` to your whisper.cpp server's base URL, then restart OpenBuild. The LAN/Tailscale setting chooses the **backend-to-Whisper** connection; your browser can open OpenBuild over Tailscale while its backend reaches Whisper over LAN. **Test connection** checks the selected endpoint. Whisper must support `/health` and `/inference`. No ffmpeg installation is needed by OpenBuild: the browser converts recordings to 16 kHz mono WAV.

Use HTTPS (or localhost) to open OpenBuild: browsers block microphone access on ordinary LAN HTTP pages. For a private remote endpoint, use Tailscale Serve, never Funnel. A TCP forward over a Tailscale IP is encrypted by Tailscale even when the endpoint URL uses HTTP. Only devices permitted by your tailnet policy should reach Whisper; whisper.cpp itself has no access gate added here. If your Tailscale daemon uses a custom socket, set `OPENBUILD_TAILSCALE_SOCKET` so the CLI can set up HTTPS.

### The `openbuild` command

`bun run cli:install` links `openbuild` into `~/.local/bin`. It runs the server in the background:

```sh
openbuild password          # set/change the local password (hidden terminal prompt)
openbuild start             # this computer only: http://localhost:3100
openbuild start lan         # also devices on your network (plain HTTP, this computer's LAN addresses)
openbuild start tailscale   # your tailnet over HTTPS: https://<this-mac>.<tailnet>.ts.net
openbuild stop              # also restart, status, logs, open
```

`start tailscale` keeps the server on `127.0.0.1` and puts `tailscale serve` (HTTPS, tailnet only) in front of it; `stop` turns that off again. If your tailnet has no HTTPS certificates, it listens on the Tailscale address over plain HTTP instead. HTTPS matters on the iPhone: dictation and the clipboard only work on secure pages, and Share → Add to Home Screen gives it a full-screen icon. The pid, mode and address are in `server.json` in the data folder, the output in `server.log`.

Every device/browser must unlock the server with its local password before accessing threads, settings, credentials, or Pi. There is no close button, Escape dismissal, or usable app behind the lock dialog; the server also rejects unauthenticated API requests. LAN/Tailscale startup requires a password to be configured. Set/change it on the host with `openbuild password` (or `bun bin/openbuild.ts password`); only an Argon2id password hash and hashed session tokens are saved in the private `access.json` file in the data directory—never the password or raw login tokens. Changing the password revokes all browser sessions. Browser logins survive server restarts and expire only after 30 days of inactivity. Each authenticated API request (including an unlock-status check) resets the server expiry and browser cookie to another 30 days; background requests while the app is open also count as activity. Logging out revokes that browser's session immediately. Remembered logins use ordinary first-party HttpOnly, SameSite=Strict cookies (also Secure over HTTPS), without requiring a Lockdown Mode exemption. Clearing website data or using a new/private browser requires signing in again. If you forget the password, run that command again on the host—no cloud recovery needed.

An unlocked browser can make Pi run commands as you. Never expose this directly to the internet. **Plain LAN HTTP does not encrypt passwords or session cookies**; use Tailscale HTTPS or a trusted HTTPS reverse proxy when possible. The password is an access gate, not a sandbox for Pi.

Signing in to a provider from the phone: OAuth flows that redirect to `localhost` can't complete on another device, so pick the "headless" / copy-code method when Pi offers one, or paste the address the sign-in page ends on into the box OpenBuild shows.

## How it works

- `server/pi/`: Pi integration. Each thread gets a `pi --mode rpc` process running in the thread's folder (`rpc.ts`, `sessions.ts`), started on demand and closed after 20 idle minutes. Its session is a normal Pi session under `~/.pi/agent/sessions`, so `pi -r` in a terminal can open the same thread. Pi owns the conversation: a turn sends just the new message plus how many user messages come before it, and when the thread was edited or retried, Pi's history is forked back to that point first. Pi's events are turned into the app's reply stream (text, thinking, tool calls, questions) and run apart from the request (`runs.ts`), so a reload or a dropped connection doesn't stop Pi.
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
- Threads are named automatically after the first reply (Settings → General → Thread naming), with a quick no-tools Pi call.
