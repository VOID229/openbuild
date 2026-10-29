// Runs under Node with the *installed* Pi's SDK (its path is the first argument), for what Pi's RPC
// mode doesn't offer: listing providers and their sign-in state, signing in (OAuth or API key) and
// signing out, and resolving Pi's model scope. Credentials land in Pi's own auth.json, exactly as
// `/login` in Pi would store them.
//
//   node helper.mjs <pi package dir> providers
//   node helper.mjs <pi package dir> login <provider> <api_key|oauth>
//   node helper.mjs <pi package dir> logout <provider>
//   node helper.mjs <pi package dir> builtins
//   node helper.mjs <pi package dir> prices
//   node helper.mjs <pi package dir> scope [agent dir]
//   node helper.mjs <pi package dir> speeds
//
// Output is JSONL. During a login, prompts go out as {type:"prompt", id, prompt} and answers come
// back on stdin as {id, value} or {id, cancel:true}; {type:"event"} records are for display.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const [root, command, ...args] = process.argv.slice(2);
const out = (record) => process.stdout.write(JSON.stringify(record) + "\n");

let sdk;
try {
  sdk = await import(pathToFileURL(join(root, "dist", "index.js")).href);
} catch (err) {
  out({ type: "error", message: `Couldn't load Pi's SDK from ${root}: ${err.message}` });
  process.exit(1);
}
const { ModelRuntime } = sdk;
const runtime = await ModelRuntime.create();

try {
  if (command === "providers") {
    const credentials = await runtime.listCredentials();
    const providers = runtime.getProviders().map((p) => ({
      id: p.id,
      name: p.name,
      apiKey: p.auth.apiKey ? { name: p.auth.apiKey.name, canLogin: !!p.auth.apiKey.login } : undefined,
      oauth: p.auth.oauth ? { name: p.auth.oauth.name, label: p.auth.oauth.loginLabel, subscription: !!p.auth.oauth.isSubscription } : undefined,
      status: runtime.getProviderAuthStatus(p.id),
      stored: credentials.find((c) => c.providerId === p.id)?.type,
      models: runtime.getModels(p.id).length,
    }));
    out({ type: "providers", providers });
  } else if (command === "prices") {
    // Every model Pi knows a price for, signed in or not (reference prices for estimates), and how
    // each provider is signed in to (a subscription's OAuth is a plan, not per-token billing).
    const credentials = await runtime.listCredentials();
    const models = runtime.getProviders().flatMap((p) => runtime.getModels(p.id))
      .filter((m) => m.cost && (m.cost.input > 0 || m.cost.output > 0))
      .map((m) => ({ provider: m.provider, id: m.id, context: m.contextWindow, cost: { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cacheRead || 0, cacheWrite: m.cost.cacheWrite || 0 } }));
    const providers = runtime.getProviders().map((p) => ({
      id: p.id,
      subscription: !!p.auth.oauth?.isSubscription && credentials.find((c) => c.providerId === p.id)?.type === "oauth",
    }));
    out({ type: "prices", models, providers });
  } else if (command === "scope") {
    // Pi's `enabledModels` (Settings → Models, `pi --models`), resolved with Pi's own resolver so
    // OpenBuild and a terminal agree. Only the global settings file counts: OpenBuild lists models
    // for a device, not for one folder's project settings.
    const { SettingsManager, resolveModelScopeWithDiagnostics } = sdk;
    const agent = args[0] || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
    const patterns = (SettingsManager.create(homedir(), agent).getGlobalSettings()?.enabledModels ?? []).filter((p) => typeof p === "string" && p.trim());
    const { scopedModels, diagnostics } = patterns.length ? await resolveModelScopeWithDiagnostics(patterns, runtime) : { scopedModels: [], diagnostics: [] };
    out({
      type: "scope",
      patterns,
      models: scopedModels.map((s) => ({ provider: s.model.provider, id: s.model.id })),
      diagnostics: diagnostics.map((d) => ({ code: d.code, pattern: d.pattern, message: d.message })),
    });
  } else if (command === "speeds") {
    out({ type: "speeds", speeds: await speeds() });
  } else if (command === "builtins") {
    // The providers Pi ships with, as opposed to ones from models.json or extensions. pi-ai doesn't
    // export this to the coding agent's dependents, so find it the way Node would from Pi's package.
    let dir = root;
    while (!existsSync(join(dir, "node_modules", "@earendil-works", "pi-ai", "package.json")) && dirname(dir) !== dir) dir = dirname(dir);
    const catalog = await import(pathToFileURL(join(dir, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "all.js")).href);
    out({ type: "builtins", ids: catalog.builtinProviders().map((p) => p.id) });
  } else if (command === "logout") {
    await runtime.logout(args[0]);
    out({ type: "done" });
  } else if (command === "login") {
    const [providerId, type] = args;
    const waiting = new Map();
    // stdin closing (the browser went away) cancels whatever is still being asked.
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const w = waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      if (msg.cancel) w.reject(new Error("Cancelled"));
      else w.resolve(String(msg.value ?? ""));
    });
    const ctrl = new AbortController();
    rl.on("close", () => {
      ctrl.abort();
      for (const w of waiting.values()) w.reject(new Error("Cancelled"));
    });
    let n = 0;
    const interaction = {
      signal: ctrl.signal,
      prompt(prompt) {
        const id = String(++n);
        const { signal, ...rest } = prompt;
        out({ type: "prompt", id, prompt: rest });
        return new Promise((resolve, reject) => {
          waiting.set(id, { resolve, reject });
          // The flow can settle a prompt itself (an OAuth callback beat a pasted code).
          signal?.addEventListener("abort", () => {
            if (waiting.delete(id)) {
              out({ type: "prompt_closed", id });
              reject(new Error("Superseded"));
            }
          });
        });
      },
      notify(event) {
        out({ type: "event", event });
      },
    };
    await runtime.login(providerId, type, interaction, { agentName: "OpenBuild", getDeviceId: () => process.env.OPENBUILD_DEVICE_ID || "openbuild" });
    out({ type: "done" });
    rl.close();
  } else {
    out({ type: "error", message: `Unknown command ${command}` });
  }
} catch (err) {
  out({ type: "error", message: err?.message ?? String(err) });
  process.exitCode = 1;
}
/**
 * Faster service tiers per Pi model ("<provider>/<model id>" → [{id, name, description}]), as the
 * providers themselves list them: the Codex models endpoint (per signed-in ChatGPT account) and
 * Claude's model catalog (fast mode). Models neither lists get none, so the app shows no picker.
 */
async function speeds() {
  const result = {};
  const models = runtime.getProviders().flatMap((p) => runtime.getModels(p.id));
  const get = async (url, headers) => {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${url} ${res.status}`);
    return res.json();
  };

  // Codex (ChatGPT sign-in): `service_tiers` per model slug, for this account.
  const codex = [...new Set(models.filter((m) => m.api === "openai-codex-responses").map((m) => m.provider))];
  await Promise.all(
    codex.map(async (provider) => {
      try {
        const auth = (await runtime.getAuth(provider))?.auth;
        const token = auth?.apiKey;
        if (!token) return;
        const accountId = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())?.["https://api.openai.com/auth"]?.chatgpt_account_id;
        const base = (models.find((m) => m.provider === provider)?.baseUrl || "https://chatgpt.com/backend-api").replace(/\/+$/, "").replace(/\/codex(\/responses)?$/, "");
        // The endpoint hides models newer than the client asking; a high version lists them all.
        const body = await get(`${base}/codex/models?client_version=99.0.0`, { authorization: `Bearer ${token}`, ...(accountId ? { "chatgpt-account-id": accountId } : {}), ...auth.headers });
        for (const m of body?.models ?? []) {
          const tiers = (m.service_tiers ?? []).filter((t) => typeof t?.id === "string").map((t) => ({ id: t.id, name: t.name || t.id, description: t.description || undefined }));
          if (tiers.length) result[`${provider}/${m.slug}`] = tiers;
        }
      } catch (err) {
        process.stderr.write(`[speeds] ${provider}: ${err.message}\n`);
      }
    }),
  );

  // Claude on Anthropic's own API: the catalog's `fast_mode` options (Anthropic's `speed`).
  const claude = models.filter((m) => m.api === "anthropic-messages" && /(^|\.)anthropic\.com$/.test(safeHost(m.baseUrl)));
  if (claude.length) {
    try {
      const catalog = await get("https://downloads.claude.ai/model-catalog/v1/catalog.json", {});
      const fast = new Map();
      const visit = (v) => {
        if (Array.isArray(v)) return v.forEach(visit);
        if (!v || typeof v !== "object") return;
        if (typeof v.id === "string" && v.fast_mode?.options) {
          const tiers = v.fast_mode.options.filter((o) => typeof o?.id === "string" && o.id !== "off").map((o) => ({ id: o.id, name: o.selector_label || o.name || o.id }));
          if (tiers.length && !fast.has(v.id)) fast.set(v.id, tiers);
        }
        Object.values(v).forEach(visit);
      };
      visit(catalog?.surfaces?.cc ?? catalog);
      for (const m of claude) if (fast.has(m.id)) result[`${m.provider}/${m.id}`] = fast.get(m.id);
    } catch (err) {
      process.stderr.write(`[speeds] claude: ${err.message}\n`);
    }
  }
  return result;
}

function safeHost(url) {
  try {
    return new URL(url || "https://api.anthropic.com").hostname;
  } catch {
    return "";
  }
}

// Once stdout is flushed: exiting right away cuts a large answer short when it's a pipe.
process.stdout.write("", () => process.exit());
