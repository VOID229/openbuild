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

Then open http://localhost:3100.

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

Chat with the Opencode models available to your own Opencode API keys.

Open **Settings → API Keys** and paste a key for your plan. OpenChat checks the key and lists the models it can use.

| Plan        | Base URL                        | Provider/model prefix |
|-------------|---------------------------------|-----------------------|
| Zen         | https://opencode.ai/zen/v1      | opencode/...          |
| Go $10      | https://opencode.ai/zen/go/v1   | opencode-go/...       |
| Go Plus $40 | https://opencode.ai/zen/go/v1   | opencode-go/...       |
| Black       | https://opencode.ai/zen/v1      | opencode/...          |

## How it works

- `server/` is a Bun server. It serves the React app and proxies chat requests to Opencode. Each request uses the endpoint that model needs (`/chat/completions`, `/responses`, `/messages` or Gemini `:streamGenerateContent`). Every stream is converted into one NDJSON event format.
- Model detection: `GET {baseURL}/models` with your key returns the models that key can use. A zero-cost malformed request validates the key (401 = invalid). Metadata from [models.dev](https://models.dev) supplies the protocol, reasoning-effort levels and input types.
- API keys are stored by the local OpenChat server in your **OS keychain** (macOS Keychain, Windows Credential Manager, or libsecret on Linux) and are never sent back to the browser: it only holds opaque key ids. If no keychain is available (headless Linux, containers), they fall back to a private file, `~/.config/openbuild/secrets.json` (mode 0600), and Settings says so. Keys saved in the browser by earlier versions are moved into the keychain automatically on first load.
- Chats and settings are saved by the local server in a SQLite database on your disk, not in the browser, so every port, browser and tab sees the same data and clearing site data loses nothing:
  - macOS: `~/Library/Application Support/OpenBuild/openchat.db`
  - Linux: `~/.local/share/openbuild/openchat.db` (or `$XDG_DATA_HOME/openbuild`)
  - Windows: `%APPDATA%\OpenBuild\openchat.db`
  - or anywhere you like with `OPENCHAT_DATA_DIR`.

  Writes are synced to disk before they're acknowledged (SQLite WAL, `synchronous=FULL`). If the server is unreachable (restarting, stopped), changes wait in a queue in the browser and are sent as soon as it's back. A snapshot is copied to `backups/` next to the database at startup and every 6 hours (the newest 20 are kept); to restore one, stop OpenChat and copy it over `openchat.db`. Deleting a chat removes its content but keeps a marker, so a stale tab can't bring it back. Older versions kept chats in browser storage per port: open the app once at each address you used before (e.g. `PORT=3001 bun run dev`) and those chats are imported automatically.
- The port never changes on its own: if it's taken (usually by an OpenChat that's still running), `bun run dev` stops with an error instead of moving to another port.
- The server listens on `127.0.0.1` only and rejects API requests with a foreign `Host` or `Origin`, so other devices and websites can't spend your keys. To open OpenChat from another device, set `HOST=0.0.0.0` and `OPENCHAT_ALLOWED_HOSTS=<the name you'll browse to>`; the connection is plain HTTP, so only do this on a network you trust.
- Each plan can have several keys, tried in order: if a key is rejected, out of credit, or rate limited, the next one is used.
- **Replies keep going without you.** A reply runs on the server apart from the browser's request. Closing the tab, reloading, or a network blip (Wi-Fi switching, Tailscale restarting) only drops the connection that's watching it. The model keeps thinking, searching and writing, and the app picks the reply back up when it reconnects or reopens, replaying it from the start. Stop really stops it on the server. The local server keeps replies in memory, so restarting it loses any that are still running.- Chats are named automatically after the first reply (Settings → General → Chat naming), using an ordered list of models with fallbacks.

## Account & sync (optional)

Sign in under **Settings → Account** to sync chats, settings and your profile (name, bio, picture, ...) live between devices. It runs on [Convex](https://convex.dev); the free plan is plenty for personal use.

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

## Web search

Open **Settings → Web Search** and add a key for any of Exa, Brave, Kagi, Firecrawl, Tavily, X (the app Bearer token from the X developer portal; your X API plan must include post search) or YouTube (a Google Cloud API key with the YouTube Data API v3 enabled; each search uses about 101 of the free 10,000 daily quota units), or the address of a SearXNG instance you already run (its `search.formats` must include `json`). With the local app, that can be any address the OpenChat server can reach, including LAN and Tailscale. Like plan keys, each provider can have several keys (or instances) that are tried in order. Each key or instance is checked with one small search when you save it, and not again after that (only if you press Retry after a failed check).

Each configured provider is exposed to the model as its own tool (`search_exa`, `search_brave`, ...). Tool descriptions and a system-prompt section tell the model what each provider is best at, so with several configured it picks per query:

| Task | Preferred order |
|------|-----------------|
| Quick, broad lookups | SearXNG → Brave → Kagi |
| Latest / up-to-date information | Exa → Brave → Tavily |
| Deep research, multi-source facts | Tavily → Exa → Firecrawl |
| Full page contents (docs, long articles) | Firecrawl → Exa → Tavily |
| Technical / quality-sensitive topics | Kagi → Exa → SearXNG |
| What people are saying on X (reactions, breaking news, posts by an account) | X → Exa → Brave |

The server runs the tool loop (`server/agent.ts`) for all four upstream protocols: it streams the model's turn, runs the searches it asked for, sends the results back, and repeats (up to 8 rounds) until the model answers. Searches show up above the reply with their result links. Models that models.dev lists as lacking tool support never get the search tools.

**Efficient web search** (Settings → Web Search, on by default): instead of handing the raw results to the chat model, each search's results first go to a separate summarizing model (`server/digest.ts`), which writes a dense digest that keeps the relevant facts, figures and source links. The chat model only sees the digest, so long chats carry far fewer tokens per search on every later turn. Pick the summarizing model and its reasoning effort in Settings; by default the fastest available model is used. Short results (under ~1,500 characters) are passed on unchanged, and if the summarizer fails, the raw results are used instead. Searches that were summarized are marked "summarized" above the reply.
