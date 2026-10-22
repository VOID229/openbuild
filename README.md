# OpenBuild

## Local only

OpenBuild is a private, local-only copy of openchat for experimenting. It is never deployed: there is no hosted site, no Vercel config, and no default sync service. It doesn't share data, keychain entries or a browser origin with an openchat install on the same machine:

| | OpenBuild | openchat |
|---|---|---|
| URL | http://localhost:3100 | http://localhost:3000 |
| Data (macOS) | `~/Library/Application Support/OpenBuild/` | `.../OpenChat/` |
| Keychain service | `openbuild` | `openchat` |
| Secrets file fallback | `~/.config/openbuild/secrets.json` | `~/.config/openchat/secrets.json` |
| Sync service | none, unless you set `OPENCHAT_CLOUD_URL` | openchat's production Convex |

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
| `OPENCHAT_CLOUD_URL` | (none: no sync) | Your own Convex deployment for accounts & sync (see below) |
| `PI_BIN` | `pi` on `PATH`, else `~/.local/bin/pi` | The Pi executable to run |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi's config folder (Pi reads this too) |

### Optional: your own Convex dev deployment for sync

The app works fully without this; Settings → Account just says accounts aren't switched on. To try sync, create a **brand-new** personal Convex project. Never select or deploy to the existing openchat project, and never use `--prod` here.

1. Run `bunx convex dev`, log in, and when asked choose **create a new project**, named e.g. `openbuild`. It pushes `convex/` to a new dev deployment and writes `CONVEX_DEPLOYMENT` to `.env.local`.
2. Set the sign-in keys Convex Auth needs on that deployment (no `--prod`, so they go to the dev deployment). Generate a key pair (prints the private key on the first line, the JWKS on the second):

   ```sh
   bun -e 'import { exportJWK, exportPKCS8, generateKeyPair } from "jose"; const k = await generateKeyPair("RS256", { extractable: true }); console.log((await exportPKCS8(k.privateKey)).trimEnd().replace(/\n/g, " ")); console.log(JSON.stringify({ keys: [{ use: "sig", ...(await exportJWK(k.publicKey)) }] }))'
   bunx convex env set JWT_PRIVATE_KEY -- '<first line>'
   bunx convex env set JWKS -- '<second line>'
   bunx convex env set SITE_URL http://localhost:3100
   ```

   `CONVEX_SITE_URL` is provided by Convex itself. Optional, for emailed waitlist invites: `RESEND_API_KEY`, `INVITE_EMAIL_FROM` and `RESEND_WEBHOOK_SECRET` (see below); without them invite codes are printed instead.
3. Add `OPENCHAT_CLOUD_URL=https://<your-dev-deployment>.convex.cloud` (the URL `convex dev` printed) to `.env.local`, restart `bun run dev`, and check that `curl http://127.0.0.1:3100/api/config` shows it as `convexUrl`.
4. Make yourself an invite code with `bunx convex run invites:createCode`, then use Settings → Account → Create an account.

## Usage

OpenBuild is a front end for building software with [Pi](https://pi.dev), the coding agent installed on this computer. It doesn't bundle Pi or reimplement it: every thread runs on the `pi` you have installed, with its models, credentials, extensions, skills and prompt templates.

1. **Pi.** Settings → Pi shows whether it's installed, its version, and whether there's an update; it installs or updates Pi for you (Pi's own installer, `curl -fsSL https://pi.dev/install.sh | sh`), and lists problems Pi reported (warnings, extension errors).
2. **Providers.** Settings → Providers signs in to model providers through Pi (OAuth or API key, via Pi's own login flows), so credentials land in `~/.pi/agent/auth.json` exactly as `/login` in Pi would put them. The model picker lists the models Pi can use, grouped by provider; Pi's default model is picked first.
3. **Projects.** Settings → Projects adds folders (usually git repositories). It suggests repositories it finds in your usual code folders, or browse to one.
4. **Start a thread.** Under the composer, pick the project, then **Local** (work in the project's own checkout, optionally switching branch when nothing is uncommitted) or **Worktree** (a new git worktree on its own `openbuild/<name>` branch, started from the branch you pick). "No project" gives the thread an empty scratch folder.

The sidebar automatically discovers saved Pi sessions from before OpenBuild was installed, as well as sessions started in a terminal or another Pi client. It refreshes every five seconds while the app is visible. Opening and continuing one uses its original session file and working directory; discovery itself never modifies Pi's files. Removing a thread hides it from OpenBuild without deleting its Pi transcript. Sessions saved with `--no-session` can't be discovered; custom archives configured through `PI_CODING_AGENT_SESSION_DIR` or Pi's global `sessionDir` setting are included.

In a thread you see what Pi does as it does it: files it read, commands it ran (with output), and edits as diffs. When an extension asks something (a confirmation, a choice), it shows up as a card to answer. Type `/` for Pi's commands (extension commands, prompt templates, `/skill:…`), plus `/compact` and `/new` from OpenBuild. Under each reply, the context fill shows how close the thread is to compaction.

Settings → Pi also manages **extensions, skills and prompt templates** (`~/.pi/agent/…` and `~/.agents/skills`): turn them off and on (Pi's exact `-path` exclusion in `settings.json`), edit their files in place, create new ones from a template, or remove them (moved to `~/.pi/agent/.openbuild-trash`, never deleted). Pi packages (npm/git) can be installed and removed there too.

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

Every device/browser must unlock the server with its local password before accessing threads, settings, credentials, or Pi. There is no close button, Escape dismissal, or usable app behind the lock dialog; the server also rejects unauthenticated API requests. LAN/Tailscale startup requires a password to be configured. Set/change it on the host with `openbuild password` (or `bun bin/openbuild.ts password`); only an Argon2id hash is saved in `access.json` in the data directory. Changing it revokes all browser sessions. Sessions expire after seven days and are also cleared on server restart. If you forget the password, run that command again on the host—no cloud recovery needed.

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

## Account & sync (optional)

Sign in under **Settings → Account** to sync threads, settings and your profile (name, bio, picture, ...) live between devices. It runs on [Convex](https://convex.dev); the free plan is plenty for personal use.

**Privacy.** Everything is end-to-end encrypted in the browser before it's uploaded, so the Convex deployment holds only ciphertext:

- Your password is stretched on your device (PBKDF2-SHA256, 600k rounds, salted with your username) and split into two keys. One is the sign-in secret the server sees. The other unlocks a random data key that encrypts every synced item with AES-256-GCM. The server can't get from the first to the second, so it can't decrypt anything.
- There's no email, phone or name: an account is just a username and password. The flip side is that **a forgotten password can't be reset**. The synced copy is then unreadable, but what's on your devices is untouched.
- No analytics or telemetry, and prompts are never logged: not by the OpenChat server, and not by the sync functions (`convex/sync.ts`), which only store what they're given.
- **API keys sync only if you turn it on** (Settings → Account → Sync API keys). Then they're encrypted on the device like everything else, so you enter a key once and every device has it. Off (the default), they stay on each device: in the OS keychain for the local app, in the browser on the website. Turning it off removes them from the account; devices keep their copies. Turning it on merges every device's keys, so none are lost; after that, adding or removing a key on one device does the same everywhere.
- **Delete account** removes the account and everything synced to it from the deployment.

**Invites and limits.** The sync service runs on Convex's free plan, so new accounts need an invite code. No code yet? Join the waitlist under Settings → Account with an email address, and a one-time code is emailed to you when there's room. The address is used only for that: it isn't linked to your account, and it's deleted once the code is used. Addresses are checked without emailing them: throwaway inboxes and domains that can't receive mail are turned away, and Gmail dots and `+tags` count as the same inbox. An account can be signed in on up to 3 devices at once. **Settings → Account → Devices** lists them; sign one out there to make room (or from the sign-in form on the new device, after entering your password). You can sign out up to 3 devices and add about 3 new ones a week, and devices that go unused for a month are signed out on their own. Sign-ups, sign-ins and waitlist joins are rate limited to keep bots from using up the free plan.

**Speed.** Each device holds a live subscription to "what changed since I last looked", so changes made elsewhere show up within moments, and only changed items travel (gzipped, then encrypted). Local changes go out about 150 ms after you make them. Your local copy stays the primary one: offline edits are queued and sent when you reconnect. If two devices edit the same chat at once, both sets of messages are kept.

**Setup**: there is no default sync service; see "Optional: your own Convex dev deployment for sync" at the top.

Invites are managed from the repo, against your own dev deployment (see `convex/invites.ts`):

```sh
bunx convex run invites:createCode '{"maxUses": 50, "note": "forum post"}'   # a code to hand out (default: 1 use)
bunx convex run invites:revokeCode '{"code": "ABCD-EFGH-JKMN"}'             # kill switch for a leaked code
bunx convex run invites:waitlistSize
bunx convex run invites:inviteWaitlist '{"count": 10}'                      # invite the next 10 on the waitlist
```

`inviteWaitlist` emails the codes through [Resend](https://resend.com) when `RESEND_API_KEY` and `INVITE_EMAIL_FROM` (e.g. `OpenChat <invites@your-domain>`, on a domain verified in Resend) are set on the deployment with `bunx convex env set`. Without them, it prints the codes for you to send.

To have bounced invites cleaned up, add a webhook in Resend (Webhooks → Add endpoint) pointing at `https://<deployment>.convex.site/resend-webhook` with the `email.bounced` and `email.complained` events, then set its signing secret with `bunx convex env set RESEND_WEBHOOK_SECRET whsec_...`. A bounced invite's code is revoked, and the address can't rejoin.
