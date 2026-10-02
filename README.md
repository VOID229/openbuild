# OpenChat

Chat with the Opencode models available to your own Opencode API keys.

```sh
bun install
bun run dev        # http://localhost:3000 (PORT=... to change), with HMR
bun run start      # production mode
bun run typecheck
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
- Chats are named automatically after the first reply (Settings → General → Chat naming), using an ordered list of models with fallbacks.

## Web search

Open **Settings → Web Search** and add a key for any of Exa, Brave, Kagi, Firecrawl, Tavily or X (the app Bearer token from the X developer portal; your X API plan must include post search), or the address of a SearXNG instance you already run (LAN, Tailscale, anywhere reachable from the OpenChat server; its `search.formats` must include `json`). Like plan keys, each provider can have several keys (or instances) that are tried in order.

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
