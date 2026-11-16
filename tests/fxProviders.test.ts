// fx's custom providers (OpenCode Go, OpenRouter… set up in ~/.fx/settings.json): the picker lists
// every provider's models, a turn runs on the picked one, and the keys people export from their shell
// profile reach fx even though OpenBuild's server never ran that profile.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { customProviders, forgetModels, listModels, providerId, splitModel } from "../server/fx/install";
import { release, runTurn } from "../server/fx/sessions";
import { fxArgs } from "../server/textGeneration";
import { threadBrands } from "../src/lib/bots/activity";
import { providerName } from "../src/lib/models";

// A fake fx with Gal's setup: opencode-go (key and a session header from the environment) is the
// configured provider, Codex is signed in, the gateway and Grok aren't, and "local-llm"'s key is
// set nowhere. It logs what each run was given.
const fx = String.raw`
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2), env = process.env;
const provider = env.FX_PROVIDER || "opencode-go";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
appendFileSync(env.FX_TEST_LOG, JSON.stringify({ args, provider: env.FX_PROVIDER ?? null, key: env.OCG_KEY ?? null, session: env.OCG_SESSION ?? null }) + "\n");
const signedIn = (p) => p === "codex" || ((p === "gateway" || p === "grok") && !!env.FX_TEST_GATEWAY) || (p === "opencode-go" && !!env.OCG_KEY && !!env.OCG_SESSION) || (p === "local-llm" && !!env.LOCAL_KEY);
const SOURCE = { gateway: undefined, codex: "Codex subscription", grok: "Grok subscription", "opencode-go": "opencode-go", "local-llm": "local-llm" };
const MODELS = {
  gateway: [{ id: "openai/gpt-5" }, { id: "xai/grok-5" }],
  codex: [{ id: "gpt-6", source: "Codex subscription" }],
  grok: [{ id: "grok-4.7", source: "Grok subscription" }],
  "opencode-go": [{ id: "glm-5.3-flash", source: "opencode-go" }, { id: "kimi-k3.1-pro", source: "opencode-go" }],
  "local-llm": [{ id: "qwen-local", source: "local-llm" }],
};
if (args[0] === "config") {
  out({ kind: "config", entries: [
    { key: "provider", value: "opencode-go" },
    { key: "providers.opencode-go.protocol", value: "openai-chat-completions" },
    { key: "providers.opencode-go.auth.type", value: "bearer" },
    { key: "providers.opencode-go.auth.env", value: "OCG_KEY" },
    { key: "providers.opencode-go.headers.x-opencode-session.env", value: "OCG_SESSION" },
    { key: "providers.local-llm.base_url", value: "http://127.0.0.1:1" },
    { key: "providers.local-llm.auth.env", value: "LOCAL_KEY" },
  ] });
  process.exit(0);
}
if (args[0] === "status") {
  out({ kind: "status", model: { "opencode-go": "kimi-k3.1-pro", codex: "gpt-6" }[provider] ?? "x", model_source: SOURCE[provider], effort: "auto", auth: signedIn(provider) ? "configured" : "missing", permission_mode: "auto" });
  process.exit(0);
}
if (args[0] === "models") {
  // Without its key and header fx lists only the models its settings describe, from the current provider.
  out({ kind: "models", models: signedIn(provider) ? MODELS[provider] : MODELS[provider].slice(0, 1) });
  process.exit(0);
}
// fx acp: like fx, it can't start on a provider it has no credentials for and falls back to the gateway.
let current = provider, model = { "opencode-go": "glm-5.3-flash", codex: "gpt-6" }[provider];
const options = () => [
  { id: "provider", category: "model", currentValue: current, options: Object.keys(MODELS).map((value) => ({ value })) },
  { id: "model", category: "model", currentValue: model, options: MODELS[current].map((m) => ({ value: m.id })) },
];
for await (const line of console) {
  const m = JSON.parse(line), reply = (result) => out({ jsonrpc: "2.0", id: m.id, result });
  appendFileSync(env.FX_TEST_LOG, JSON.stringify({ rpc: m.method, params: m.method === "session/set_config_option" ? m.params : undefined }) + "\n");
  if (m.method === "initialize") {
    if (!signedIn(provider)) out({ jsonrpc: "2.0", id: m.id, error: { code: -32600, message: "fx needs access to Vercel AI Gateway. Run fx login to sign in." } });
    else reply({ protocolVersion: 1, agentCapabilities: {} });
  } else if (m.method === "session/new") reply({ sessionId: "s1", configOptions: options() });
  else if (m.method === "session/set_config_option") {
    if (m.params.configId === "provider") { current = m.params.value; model = MODELS[current][0].id; }
    if (m.params.configId === "model") model = m.params.value;
    reply({ configOptions: options() });
  } else if (m.method === "session/prompt") {
    out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: current + "/" + model } } } });
    reply({ stopReason: "end_turn" });
  } else if (m.id !== undefined) reply({});
}
`;

const dir = mkdtempSync(join(tmpdir(), "fx-providers-"));
const log = join(dir, "log.jsonl");
const bin = join(dir, "fx");
writeFileSync(bin, `#!${process.execPath}\n${fx}`);
chmodSync(bin, 0o700);
// The user's shell: its profile prints a banner and exports the OpenCode Go key, like ~/.bashrc
// sourcing ~/.fx/opencode-go.env. The session header is only ever set by a wrapper function.
const shell = (exports: string) => {
  const path = join(dir, `shell-${crypto.randomUUID()}`);
  writeFileSync(path, `#!/bin/sh\necho "Welcome back"\n${exports}\nexec /bin/sh "$@"\n`);
  chmodSync(path, 0o700);
  return path;
};
const saved = { FX_BIN: process.env.FX_BIN, SHELL: process.env.SHELL, FX_TEST_LOG: process.env.FX_TEST_LOG };
process.env.FX_BIN = bin;
process.env.FX_TEST_LOG = log;
for (const name of ["OCG_KEY", "OCG_SESSION", "LOCAL_KEY", "FX_PROVIDER"]) delete process.env[name];
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  writeFileSync(log, "");
  forgetModels();
});
const logged = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const turn = async (model: string) => {
  const threadId = crypto.randomUUID();
  try {
    const text = await new Response(runTurn({ threadId, cwd: dir, model, effort: "medium", prior: 0, message: "test" } as any, new AbortController().signal)).text();
    return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } finally {
    release(threadId);
  }
};

describe("reading fx's providers", () => {
  test("custom providers come from fx's settings, with the variables for their keys and headers", () => {
    expect(customProviders([
      { key: "provider", value: "opencode-go" },
      { key: "providers.opencode-go.base_url", value: "https://opencode.ai/inference/go/openai/v1" },
      { key: "providers.opencode-go.auth.env", value: "OPENCODE_GO_API_KEY" },
      { key: "providers.opencode-go.headers.x-opencode-session.env", value: "OPENCODE_GO_SESSION_ID" },
      { key: "providers.openrouter.protocol", value: "openai-chat-completions" },
      { key: "providers.openrouter.auth.env", value: "OPENROUTER_API_KEY" },
      { key: "providers.codex.base_url", value: "ignored: fx's own" },
    ])).toEqual([
      { name: "opencode-go", keyEnv: "OPENCODE_GO_API_KEY", headerEnv: [{ header: "x-opencode-session", env: "OPENCODE_GO_SESSION_ID" }] },
      { name: "openrouter", keyEnv: "OPENROUTER_API_KEY", headerEnv: [] },
    ]);
    expect(customProviders(undefined)).toEqual([]);
  });

  test("fx's names for its providers, and picker ids split into provider and model", () => {
    expect(providerId("Vercel AI Gateway")).toBe("gateway");
    expect(providerId("Codex subscription")).toBe("codex");
    expect(providerId("Grok subscription")).toBe("grok");
    expect(providerId("opencode-go")).toBe("opencode-go");
    expect(providerId(undefined)).toBeUndefined();
    const known = ["gateway", "codex", "grok", "opencode-go", "openrouter"];
    expect(splitModel("fx/opencode-go/kimi-k3.1-pro", known)).toEqual({ provider: "opencode-go", model: "kimi-k3.1-pro" });
    expect(splitModel("fx/openrouter/deepseek/deepseek-v4", known)).toEqual({ provider: "openrouter", model: "deepseek/deepseek-v4" });
    expect(splitModel("fx/gateway/openai/gpt-5", known)).toEqual({ provider: "gateway", model: "openai/gpt-5" });
    // Ids saved before fx had several providers run on fx's default one.
    expect(splitModel("fx/openai/gpt-5", known)).toEqual({ model: "openai/gpt-5" });
    expect(splitModel("fx/glm-5.3-flash", known)).toEqual({ model: "glm-5.3-flash" });
  });

  test("one-off text generation asks fx for the picked provider", () => {
    const request = { runtime: "fx", system: "be brief", prompt: "name it" } as any;
    const args = fxArgs({ ...request, model: "fx/opencode-go/kimi-k3.1-pro" }, [], ["gateway", "codex", "grok", "opencode-go"]);
    expect(args.slice(args.indexOf("--provider"), args.indexOf("--provider") + 4)).toEqual(["--provider", "opencode-go", "--model", "kimi-k3.1-pro"]);
    const legacy = fxArgs({ ...request, model: "fx/openai/gpt-5" }, [], ["gateway", "codex", "grok"]);
    expect(legacy).not.toContain("--provider");
    expect(legacy[legacy.indexOf("--model") + 1]).toBe("openai/gpt-5");
  });

  test("a thread on a fx provider names that provider", () => {
    const answered = (id: string) => ({ role: "assistant", text: "", model: { plan: "fx", id } }) as any;
    expect(threadBrands({ runtime: "fx", messages: [answered("fx/opencode-go/kimi-k3.1-pro")] }).provider).toEqual({ id: "opencode-go", name: "OpenCode Go" });
    expect(threadBrands({ runtime: "fx", messages: [answered("fx/gateway/openai/gpt-5")] }).provider).toEqual({ id: "vercel", name: "Vercel AI Gateway" });
    expect(providerName("vercel")).toBe("Vercel AI Gateway");
  });
});

describe("the picker's fx models", () => {
  test("every provider fx can use, the custom ones with the keys the user's shell exports", async () => {
    process.env.SHELL = shell("export OCG_KEY=sk-from-profile");
    const { models, defaultModel } = await listModels(true);
    const byProvider = (p: string) => models.filter((m) => m.provider === p).map((m) => m.id);
    // All of OpenCode Go's models, not just the one its settings describe.
    expect(byProvider("opencode-go")).toEqual(["fx/opencode-go/glm-5.3-flash", "fx/opencode-go/kimi-k3.1-pro"]);
    expect(byProvider("codex")).toEqual(["fx/codex/gpt-6"]);
    // Not signed in: the gateway, Grok, and a provider whose key nothing sets.
    expect(models.map((m) => m.id).filter((id) => /gateway|grok|local-llm/.test(id))).toEqual([]);
    expect(defaultModel).toBe("fx/opencode-go/kimi-k3.1-pro");
    expect(models.find((m) => m.id === "fx/opencode-go/kimi-k3.1-pro")).toMatchObject({ name: "kimi-k3.1-pro", billing: "api" });
    expect(models.find((m) => m.id === "fx/codex/gpt-6")).toMatchObject({ name: "gpt-6", billing: "plan" });

    const runs = logged().filter((l) => l.args?.[0] === "models" && l.provider === "opencode-go");
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) {
      expect(r.key).toBe("sk-from-profile");
      // The header a wrapper would set: a fresh id for each fx run.
      expect(r.session).toMatch(/^[0-9a-f-]{36}$/);
    }
    const sessions = logged().filter((l) => l.session).map((l) => l.session);
    expect(new Set(sessions).size).toBe(sessions.length);
  });

  test("an empty variable in the server's environment counts as unset: the shell's value is the one fx gets", async () => {
    process.env.SHELL = shell("export OCG_KEY=sk-from-profile");
    process.env.OCG_KEY = "";
    try {
      const { models } = await listModels(true);
      expect(models.filter((m) => m.provider === "opencode-go").map((m) => m.id)).toEqual(["fx/opencode-go/glm-5.3-flash", "fx/opencode-go/kimi-k3.1-pro"]);
      const runs = logged().filter((l) => l.args?.[0] === "models" && l.provider === "opencode-go");
      expect(runs.length).toBeGreaterThan(0);
      for (const r of runs) expect(r.key).toBe("sk-from-profile");
      writeFileSync(log, "");
      const events = await turn("fx/opencode-go/kimi-k3.1-pro");
      expect(events.filter((e) => e.t === "error")).toEqual([]);
      expect(logged().find((l) => l.args?.[0] === "acp")).toMatchObject({ provider: "opencode-go", key: "sk-from-profile" });
    } finally {
      delete process.env.OCG_KEY;
    }
  });

  test("each provider is a group of its own: the gateway's xai models aren't the Grok sign-in's", async () => {
    process.env.SHELL = shell("export OCG_KEY=sk-from-profile; export LOCAL_KEY=local");
    process.env.FX_TEST_GATEWAY = "1";
    try {
      const { models } = await listModels(true);
      const groups = Object.groupBy(models, (m) => m.provider!);
      // fx's own provider (OpenCode Go) first: the picker opens on the first.
      expect([...new Set(models.map((m) => m.provider))]).toEqual(["opencode-go", "vercel", "codex", "grok", "local-llm"]);
      expect(Object.fromEntries(Object.entries(groups).map(([p, ms]) => [p, ms!.map((m) => m.id)]))).toEqual({
        vercel: ["fx/gateway/openai/gpt-5", "fx/gateway/xai/grok-5"],
        codex: ["fx/codex/gpt-6"],
        grok: ["fx/grok/grok-4.7"],
        "opencode-go": ["fx/opencode-go/glm-5.3-flash", "fx/opencode-go/kimi-k3.1-pro"],
        "local-llm": ["fx/local-llm/qwen-local"],
      });
    } finally {
      delete process.env.FX_TEST_GATEWAY;
    }
  });
});

describe("a turn on a fx provider", () => {
  test("runs on the picked provider and model, with the key from the user's shell", async () => {
    process.env.SHELL = shell("export OCG_KEY=sk-from-profile");
    const events = await turn("fx/opencode-go/kimi-k3.1-pro");
    expect(events.filter((e) => e.t === "error")).toEqual([]);
    expect(events.filter((e) => e.t === "text").map((e) => e.v).join("")).toContain("opencode-go/kimi-k3.1-pro");
    const acp = logged().find((l) => l.args?.[0] === "acp");
    expect(acp).toMatchObject({ provider: "opencode-go", key: "sk-from-profile" });
    expect(acp.session).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("a thread that changes provider switches its fx session's provider, then its model", async () => {
    process.env.SHELL = shell("export OCG_KEY=sk-from-profile");
    const threadId = crypto.randomUUID();
    const run = async (model: string) => (await new Response(runTurn({ threadId, cwd: dir, model, effort: "medium", prior: 0, message: "test" } as any, new AbortController().signal)).text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    try {
      expect((await run("fx/opencode-go/kimi-k3.1-pro")).filter((e) => e.t === "text").map((e) => e.v).join("")).toBe("opencode-go/kimi-k3.1-pro");
      writeFileSync(log, "");
      const events = await run("fx/codex/gpt-6");
      expect(events.filter((e) => e.t === "error")).toEqual([]);
      expect(events.filter((e) => e.t === "text").map((e) => e.v).join("")).toBe("codex/gpt-6");
      // The same fx process, told the provider first.
      expect(logged().filter((l) => l.args)).toEqual([]);
      expect(logged().filter((l) => l.rpc === "session/set_config_option").map((l) => [l.params.configId, l.params.value])[0]).toEqual(["provider", "codex"]);
    } finally {
      release(threadId);
    }
  });

  test("a provider whose key nothing sets says which variable, not that the Vercel gateway needs a sign-in", async () => {
    process.env.SHELL = shell("true");
    const events = await turn("fx/opencode-go/kimi-k3.1-pro");
    const error = events.find((e) => e.t === "error")?.message as string;
    expect(error).toContain("OCG_KEY");
    expect(error).not.toContain("Vercel");
    // A provider that needs nothing of the shell still works.
    const codex = await turn("fx/codex/gpt-6");
    expect(codex.filter((e) => e.t === "error")).toEqual([]);
  });
});
