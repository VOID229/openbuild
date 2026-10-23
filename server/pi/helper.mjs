// Runs under Node with the *installed* Pi's SDK (its path is the first argument), for what Pi's RPC
// mode doesn't offer: listing providers and their sign-in state, signing in (OAuth or API key) and
// signing out. Credentials land in Pi's own auth.json, exactly as `/login` in Pi would store them.
//
//   node helper.mjs <pi package dir> providers
//   node helper.mjs <pi package dir> login <provider> <api_key|oauth>
//   node helper.mjs <pi package dir> logout <provider>
//   node helper.mjs <pi package dir> builtins
//
// Output is JSONL. During a login, prompts go out as {type:"prompt", id, prompt} and answers come
// back on stdin as {id, value} or {id, cancel:true}; {type:"event"} records are for display.
import { existsSync } from "node:fs";
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
process.exit();
