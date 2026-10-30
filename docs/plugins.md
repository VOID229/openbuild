# Plugins

OpenBuild can be extended without editing its source. A plugin is a folder with a `plugin.json` manifest and optional `client.tsx`, `server.ts` and `styles.css`:

```
plugins/my-plugin/
  plugin.json     manifest (required)
  client.tsx      UI: slots, settings page, custom tool rows
  server.ts       authenticated routes and chat hooks (loaded when active)
  styles.css      CSS for both
```

User plugins live in the data folder's `plugins/`, outside the application checkout. On the first start with this layout, OpenBuild copies the checkout's existing plugin folders there once, including custom plugins and changes to the examples. Existing user folders are never overwritten. Later app updates neither replace these copies nor restore deleted plugins. Plugin enable/disable choices and settings remain in the data directory.

`pluginsDir` in `openbuild.config.ts` still overrides this location. Keep explicit paths outside the application checkout for independent updates. The default data folder is `~/.local/share/openbuild` on Linux and `~/Library/Application Support/OpenBuild` on macOS (or `OPENCHAT_DATA_DIR`). Settings → Plugins shows the active folder.

If an older installation has edits inside the checkout's `plugins/`, start OpenBuild once to copy them before updating. Verify the copies in the active folder, then commit or stash the old checkout changes so `ob update` can proceed. The updater refuses source changes rather than discarding them.

The plugin API remains version 1. This storage change does not change manifests, SDK imports, hooks, or plugin settings.

The whole plugin system is **off by default**. `Settings → Plugins` has the master switch: until it's on, nothing from the folder runs — no UI slots, styles, server routes or hooks. With it on, the same page lists everything found (including broken plugins) and turns each one on or off without deleting it.

The folder ships six examples: `daily-note` (a composer button + server route + settings page), `openrouter-deepseek` (icon overrides), `pi-claude` and `codex-multi` (provider grouping and a badged provider icon), `bare-model-names` (rewrites Pi's OpenRouter model names through the SDK's `subscribe`/`useStore`) and `quiet-ui` (manifest-only tokens and CSS, off by default).

## Manifest

```json
{
  "id": "daily-note",
  "name": "Daily note",
  "version": "0.1.0",
  "apiVersion": 1,
  "description": "What it does, shown in Settings.",
  "client": "client.tsx",
  "server": "server.ts",
  "styles": "styles.css",
  "slots": ["composer:toolbar"],
  "tokens": { "--content-w": "820px" },
  "hide": [".sidebar-divider"],
  "defaultEnabled": true
}
```

- `id`: lowercase letters, numbers, dots, dashes or underscores. Also the URL segment under `/api/plugins/<id>/`.
- `apiVersion`: currently `1`.
- File paths are relative to the plugin folder and may not escape it.
- `tokens` are CSS custom properties applied while the plugin is enabled; `hide` selectors are `display: none !important`.
- `defaultEnabled: false` ships a plugin turned off until enabled in Settings.
- A manifest-only plugin (no `client.tsx`/`server.ts`) can restyle the app or set tokens.

## Client modules

`client.tsx` is a normal ES module. `react` and `openbuild` are resolved to the host's instances, so no dependencies or build step are needed, and hooks/context work across the app and plugins.

```tsx
import { useState } from "react";
import { insertComposerText } from "openbuild";

function NoteButton() {
  return <button onClick={() => insertComposerText("Hello from a plugin")}>Note</button>;
}

export default {
  slots: { "composer:toolbar": NoteButton },
  settings: { label: "My plugin", component: SettingsPage },
  toolRenderers: { bash: BashRow },
  icons: {
    providers: { deepseek: "<svg …>…</svg>" }, // provider id → SVG markup
    brands: { deepseek: "<svg …>…</svg>" },    // model id prefix → SVG markup
  },
  providers: {
    "pi-claude": { group: "claude", name: "Claude" }, // move a provider out of Custom
  },
  providerOrder: ["openai-codex", "claude", "opencode"], // provider rail, top to bottom
  tokens: { "--content-w": "900px" },
  hide: [".sidebar-divider"],
  dispose() {},
};
```

`plugin` in the SDK is `{ id, name }` for the module being evaluated.

### Slots

Components receive the slot's context as props.

| Slot | Rendered | Context |
|---|---|---|
| `app:before` | before the app shell | — |
| `app:overlay` | above the app, below tooltips | — |
| `home:above-composer` / `home:below-composer` | new-thread screen | — |
| `sidebar:header` / `sidebar:footer` | sidebar | — |
| `chat:header` | above the messages | `{ chat }` |
| `chat:before-messages` | first item in the message list | `{ chat }` |
| `composer:above` / `composer:below` | around the composer | `{ variant, chatId }` |
| `composer:toolbar` | controls row in the composer | `{ variant, chatId }` |
| `message:actions` | assistant reply actions | `{ message, chatId }` |
| `message:user-actions` | user message actions | `{ message, chatId }` |
| `settings:appearance:after` | Appearance settings page | — |

`toolRenderers` is keyed by Pi tool name (`bash`, `edit`, …). A registered renderer replaces the built-in tool row and receives `{ part, cwd }`.

`icons.providers` keys are provider ids (exact, case-insensitive). `icons.brands` keys are model id prefixes (case-insensitive, longest match wins): a provider-scoped prefix such as `claude-code-2/` takes precedence over a bare prefix such as `claude`. Bare prefixes still match the model id without its provider, so `deepseek` matches `deepseek/deepseek-v4.1-flash`. The values are SVG markup, inlined into the existing icon slot; use `currentColor` to follow the theme. `plugins/openrouter-deepseek` is a working example.

`providers` maps a raw Pi provider id to a group and/or display name. Setting `group` moves its models out of the catch-all Custom group and into that provider's group, so its icon and name come from the group. `plugins/pi-claude` and `plugins/codex-multi` are working examples.

`providerOrder` lists provider groups for the model picker's rail, top to bottom. Names are matched case-insensitively against the group ids that `providers` and `providerOf` produce (`openai-codex`, `claude`, `claude-code-2`, …). Groups it doesn't name follow in Pi's own order, and Custom stays last. Lists from several plugins merge in load order, first mention winning. `plugins/provider-order` is a working example.

### SDK

```ts
import {
  React,              // the host's React
  useStore,           // OpenBuild's zustand store
  getState,           // useStore.getState()
  subscribe,          // useStore.subscribe
  insertComposerText, // append text to the composer
  openSettings,       // openSettings("plugins")
  fetch,              // same-origin authenticated fetch
  plugin,             // { id, name } of the current module
} from "openbuild";
```

## Server modules

`server.ts` runs in the OpenBuild process with the same permissions. It is loaded when the plugin becomes active: after the master switch is on and the plugin is enabled. Toggling either one starts or stops it immediately, without restarting OpenBuild.

```ts
export default {
  onStart({ id, dir, dataDir, log }) {
    log("started in", dir);
  },

  // Every path must start with /api/plugins/<id>/. `api` marks a handler for the
  // host/Origin/password checks (OpenBuild also wraps them, so this can't be bypassed).
  routes: (api) => ({
    "/api/plugins/my-plugin/echo": {
      POST: api(async (req) => Response.json(await req.json())),
    },
  }),

  // Adjust a Pi turn before it starts. Return the request (it is re-validated), or nothing to leave it alone.
  beforeChat(req) {
    return { ...req, message: `[plugin] ${req.message}` };
  },
};
```

Server modules can import Node/Bun APIs and OpenBuild files relative to the plugin folder. `onStart` runs when a plugin becomes active and again after a hot reload; `onStop` runs when it is disabled, the master switch goes off, or its source is replaced. Editing any TypeScript/JavaScript/JSON file in the plugin folder re-imports `server.ts` (except the file named by `client`, plus `plugin.json`) and rebuilds its routes, so `server.ts` changes do not need a server restart.

## Config

Copy `openbuild.config.example.ts` to `openbuild.config.ts` (repo root or data folder) to change the plugin folder or global CSS:

```ts
export default {
  pluginsDir: "plugins",
  customCss: "custom.css", // applied after the app's styles
  safeMode: false,         // or OPENBUILD_SAFE=1
  disabledPlugins: [],
};
```

`customCss` defaults to `<data dir>/custom.css` when that file exists. `?safe` disables plugins for one browser session.

## How loading works

- The server always discovers and validates manifests. Only when the master switch is on does it import enabled `server.ts` modules, call `onStart`, and add their routes and `beforeChat` hook. Server routes are dispatched from a table rebuilt on every toggle or reload, so no restart is needed.
- The browser loads `/api/plugins` after unlock, then imports each enabled `client.js`. The server builds it with Bun, marking `react`, `react/jsx-runtime`, `react-dom` and `openbuild` as host modules. There is exactly one React instance.
- A plugin's client module is wrapped in an error boundary. A crash is shown in `Settings → Plugins`; it doesn't take the app down.
- A file watcher polls the plugin folder (and `custom.css`). Every change re-scans the folders, reloads any `server.ts` whose source changed, and broadcasts over SSE; every open browser unloads and re-imports enabled plugins without a page reload. New and removed plugin folders work live, and so do `server.ts` edits (the module is re-imported with `onStop`/`onStart`). Only changes to OpenBuild's own app code need a restart.
- The master switch and per-plugin state are stored in OpenBuild's database, not the browser, so every device sees them. On first run the whole system is off.
- Each plugin has a delete button next to its toggle, with a confirmation step. Deleting removes the plugin folder from disk; "Don't ask again" is remembered per browser.

## Security

Plugins are trusted code, in the same trust boundary as Pi and OpenBuild itself: a server plugin can run anything the server can, and a client plugin runs in the page with access to the app's data. Only install plugins you write or have reviewed. They are behind the same local password and same-origin checks as the rest of the app, but the password is an access gate, not a sandbox.

The safe escape hatch is `OPENBUILD_SAFE=1` (or `?safe`): the app starts with no plugins. For a plugin that breaks the shell, that is also available if you get locked out.

## Limits (prototype)

- No plugin dependency installation; import from Bun's available packages (they get bundled into the client module) or keep to `react`/`openbuild`.
- No versioned API beyond `apiVersion: 1`.
- No remote install or registry; plugins are folders on disk.
- Only the built-in slots above; new ones are added in the components that render `<PluginSlot>`.
- Plugin sections stay selected after a plugin is disabled; pick another section.
- `plugins/` example files are not typechecked by `bun run typecheck`.
