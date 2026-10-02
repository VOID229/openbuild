# OpenChat

Chat with the Opencode models available to your own Opencode API keys.

```sh
bun install
bun run dev        # http://localhost:3000 (next free port if taken), with HMR
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
- Keys and chats stay in your browser (localStorage / IndexedDB). The server never stores them.
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
