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
