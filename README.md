# OpenChat

Chat with the Opencode models available to your own Opencode API keys.

```sh
bun install
bun run dev        # http://localhost:3000 (PORT=... to change), with HMR
bun run start      # production mode
bun run typecheck
bun run test
```

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
- API keys are stored by the local OpenChat server in your **OS keychain** (macOS Keychain, Windows Credential Manager, or libsecret on Linux) and are never sent back to the browser: it only holds opaque key ids. If no keychain is available (headless Linux, containers), they fall back to a private file, `~/.config/openchat/secrets.json` (mode 0600), and Settings says so. Keys saved in the browser by earlier versions are moved into the keychain automatically on first load.
- Chats and settings are saved by the local server in a SQLite database on your disk, not in the browser, so every port, browser and tab sees the same data and clearing site data loses nothing:
  - macOS: `~/Library/Application Support/OpenChat/openchat.db`
  - Linux: `~/.local/share/openchat/openchat.db` (or `$XDG_DATA_HOME/openchat`)
  - Windows: `%APPDATA%\OpenChat\openchat.db`
  - or anywhere you like with `OPENCHAT_DATA_DIR`.

  Writes are synced to disk before they're acknowledged (SQLite WAL, `synchronous=FULL`). If the server is unreachable (restarting, stopped), changes wait in a queue in the browser and are sent as soon as it's back. A snapshot is copied to `backups/` next to the database at startup and every 6 hours (the newest 20 are kept); to restore one, stop OpenChat and copy it over `openchat.db`. Deleting a chat removes its content but keeps a marker, so a stale tab can't bring it back. Older versions kept chats in browser storage per port: open the app once at each address you used before (e.g. `PORT=3001 bun run dev`) and those chats are imported automatically.
- The port never changes on its own: if it's taken (usually by an OpenChat that's still running), `bun run dev` stops with an error instead of moving to another port.
- The server listens on `127.0.0.1` only and rejects API requests with a foreign `Host` or `Origin`, so other devices and websites can't spend your keys. To open OpenChat from another device, set `HOST=0.0.0.0` and `OPENCHAT_ALLOWED_HOSTS=<the name you'll browse to>`; the connection is plain HTTP, so only do this on a network you trust.
- Each plan can have several keys, tried in order: if a key is rejected, out of credit, or rate limited, the next one is used.
- **Replies keep going without you.** A reply runs on the server apart from the browser's request. Closing the tab, reloading, or a network blip (Wi-Fi switching, Tailscale restarting) only drops the connection that's watching it. The model keeps thinking, searching and writing, and the app picks the reply back up when it reconnects or reopens, replaying it from the start. Stop really stops it on the server. The local server keeps replies in memory, so restarting it loses any that are still running. The website's relay writes each reply as it streams to the sync service (`convex/streams.ts`), encrypted with a random key the browser made for that reply (`shared/replies.ts`). The key is kept on the message, which syncs end-to-end encrypted, so your other devices can follow the reply too. On the website a reply can run for up to 5 minutes, the hosting plan's function limit.
- Chats are named automatically after the first reply (Settings → General → Chat naming), using an ordered list of models with fallbacks.

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

**Setup** (once, by whoever hosts the sync service; users never do this):

```sh
bun run setup:cloud   # log in to Convex (free), deploy convex/, create the sign-in keys
```

It writes the deployment's address to `shared/cloud.ts`. Commit that, and every copy of OpenChat built from the repo shows sign-up and sign-in under Settings → Account, with nothing else to configure. Run it again after changing anything in `convex/` to deploy the change (existing sign-in keys are kept). To point one server at a different deployment (say, a dev one from `bunx convex dev`), set `OPENCHAT_CLOUD_URL`.

Invites are managed from the repo (see `convex/invites.ts`):

```sh
bunx convex run --prod invites:createCode '{"maxUses": 50, "note": "forum post"}'   # a code to hand out (default: 1 use)
bunx convex run --prod invites:revokeCode '{"code": "ABCD-EFGH-JKMN"}'             # kill switch for a leaked code
bunx convex run --prod invites:waitlistSize
bunx convex run --prod invites:inviteWaitlist '{"count": 10}'                      # invite the next 10 on the waitlist
```

`inviteWaitlist` emails the codes through [Resend](https://resend.com) when `RESEND_API_KEY` and `INVITE_EMAIL_FROM` (e.g. `OpenChat <invites@your-domain>`, on a domain verified in Resend) are set on the deployment with `bunx convex env set --prod`. Without them, it prints the codes for you to send.

To have bounced invites cleaned up, add a webhook in Resend (Webhooks → Add endpoint) pointing at `https://<deployment>.convex.site/resend-webhook` with the `email.bounced` and `email.complained` events, then set its signing secret with `bunx convex env set --prod RESEND_WEBHOOK_SECRET whsec_...`. A bounced invite's code is revoked, and the address can't rejoin.

## Hosted website

OpenChat also runs as a website at **https://openchat.shade-io.com** (deployed on Vercel from `main`). It's the same app, minus the local server's storage:

- **Chats, settings and API keys stay in your browser** (IndexedDB/localStorage, marked persistent). Sign in to sync and back them up, end-to-end encrypted, like the local app. API keys sync too if you turn on Sync API keys.
- **The relay keeps no keys or chats.** `/api/chat` is a Node.js function and `/api/models` and `/api/verify-search` are Edge Functions (`server/vercel/`). The browser sends the keys a request needs along with it; the relay forwards the request to Opencode (and the search providers) and logs nothing. The one thing it keeps is a reply while it's coming in, so the reply survives a reload, a closed tab or a network blip (see below). It's encrypted with a key that only your browser has, and deleted an hour after the reply ends.
- **Locked down.** The relay answers only pages from its own site. A SearXNG instance must be a public `https` address (the relay runs on Vercel, so it can't reach LAN or Tailscale addresses). A strict Content Security Policy lets the page talk only to the site itself and the sync service, so there are no third-party scripts, fonts or images.

**iPhone / iPad with Lockdown Mode.** The site works, but it's a bit iffy: Lockdown Mode turns off IndexedDB, the browser storage the site normally uses. You have two options:

- **Easiest: turn Lockdown Mode off for this site only.** In Safari, tap the page menu in the address bar → Website Settings → turn off Lockdown Mode. The rest of your phone stays in Lockdown Mode, and the site then works like it does anywhere else.
- **Keep Lockdown Mode on.** Chats, settings and API keys are then kept in localStorage instead (about 5 MB, so a very long chat history may not fit). Sync still works, but the browser has nowhere safe to keep the sync key, so sync locks again every time you reload the page. To avoid typing your password each time, open Settings → Account and set up **Unlock with Face ID** (needs iOS 18 or later). It creates a passkey whose secret, released only by Face ID, encrypts the sync key on your phone. After each reload, a fullscreen lock screen asks you to **Unlock with Face ID to resync**. The app stays covered until sync is unlocked (or you sign out), so nothing gets changed on the phone while it isn't syncing. Your password always works too.

`bun run build` produces the site in Vercel's Build Output format (`.vercel/output`): the static app, the relay functions, and the routes and headers. `vercel.json` tells Vercel to install with Bun and run that build.

**Domain setup** (once): in Vercel, add `openchat.shade-io.com` under the project's Settings → Domains. Then in GoDaddy's DNS for `shade-io.com`, add the `CNAME` record Vercel shows (name `openchat`, value like `cname.vercel-dns.com`). The rest of `shade-io.com` is unaffected.

## Web search

Open **Settings → Web Search** and add a key for any of Exa, Brave, Kagi, Firecrawl, Tavily, X (the app Bearer token from the X developer portal; your X API plan must include post search) or YouTube (a Google Cloud API key with the YouTube Data API v3 enabled; each search uses about 101 of the free 10,000 daily quota units), or the address of a SearXNG instance you already run (its `search.formats` must include `json`). With the local app, that can be any address the OpenChat server can reach, including LAN and Tailscale. On the website, searches run from the cloud relay, so the instance must be a public `https://` address; run OpenChat locally to use a LAN or Tailscale instance. Like plan keys, each provider can have several keys (or instances) that are tried in order. Each key or instance is checked with one small search when you save it, and not again after that (only if you press Retry after a failed check).

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
