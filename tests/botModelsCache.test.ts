// The bots' model listing is one for the page (src/lib/bots/models.ts), kept in this browser for the
// next load (src/lib/bots/modelsCache.ts): a picker that mounts names its model on its first render,
// never by its raw id, and the kept copy is one server's only.
import { afterEach, beforeEach, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readableModelName } from "../shared/modelName";
import { botModelsState, modelLabel, refreshBotModels, resetBotModels, useBotModels } from "../src/lib/bots/models";
import { claimBotModels, forgetBotModels, rememberedModelName, savedBotModels } from "../src/lib/bots/modelsCache";
import { botModels, type PiModels } from "../src/lib/pi";
import { spawnScriptSync } from "./spawnScript";

const KEY = "openbuild:bot-models:v1";
const KIMI = "openrouter/moonshotai/kimi-k3.1-pro";
const GLM = "opencode-go/glm-5.3-flash";
const model = (id: string, name: string) => ({ id, provider: id.split("/")[0]!, name, reasoning: { efforts: [] } });
const listing = (...models: [string, string][]): PiModels => ({ models: models.map(([id, name]) => model(id, name)) as unknown as PiModels["models"], checkedAt: 1 });

let values: Map<string, string>;
const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const original = globalThis.fetch;
let calls: string[];
let answers: { resolve: (l: PiModels) => void; reject: (e: Error) => void }[];

beforeEach(() => {
  values = new Map();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v), removeItem: (k: string) => void values.delete(k) } });
  calls = [];
  answers = [];
  globalThis.fetch = ((url: string) => {
    calls.push(String(url));
    return new Promise<Response>((resolve, reject) => answers.push({ resolve: (l) => resolve(Response.json(l)), reject }));
  }) as typeof fetch;
  claimBotModels("imac");
  resetBotModels();
});

afterEach(() => {
  globalThis.fetch = original;
  if (storage) Object.defineProperty(globalThis, "localStorage", storage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

const settle = () => new Promise((r) => setTimeout(r, 0));

function Probe() {
  const { listing, confirmed } = useBotModels();
  return React.createElement("i", null, `${confirmed ? "confirmed" : "kept"}:${listing?.models.map((m) => m.name).join(",") ?? "none"}`);
}

test("pickers mounting together share one request, and a later mount has the listing on its first render", async () => {
  expect(renderToStaticMarkup(React.createElement(Probe))).toBe("<i>kept:none</i>");
  const first = refreshBotModels();
  expect(refreshBotModels()).toBe(first);
  expect(calls).toEqual(["/api/bots/models"]);
  answers[0]!.resolve(listing([KIMI, "Kimi K3.1 Pro"]));
  await first;
  // renderToStaticMarkup runs no effects: what it draws is a new picker's first frame.
  expect(renderToStaticMarkup(React.createElement(Probe))).toBe("<i>confirmed:Kimi K3.1 Pro</i>");
  // Answered a moment ago: a picker mounting now doesn't ask again.
  expect(refreshBotModels()).toBeUndefined();
  expect(calls).toHaveLength(1);
});

test("a reload starts from the kept copy, and the server's answer replaces it", async () => {
  values.set(KEY, JSON.stringify({ owner: "imac", listing: listing([KIMI, "Kimi K3.1 Pro"], ["openrouter/old", "Old model"]) }));
  resetBotModels();
  expect(botModelsState()).toMatchObject({ confirmed: false, failed: false });
  expect(renderToStaticMarkup(React.createElement(Probe))).toBe("<i>kept:Kimi K3.1 Pro,Old model</i>");
  const asked = refreshBotModels()!;
  answers[0]!.resolve(listing([KIMI, "Kimi K3.1 Pro (new)"]));
  await asked;
  expect(renderToStaticMarkup(React.createElement(Probe))).toBe("<i>confirmed:Kimi K3.1 Pro (new)</i>");
  expect(JSON.parse(values.get(KEY)!)).toMatchObject({ owner: "imac", listing: { models: [{ name: "Kimi K3.1 Pro (new)" }] } });
});

test("a fresh listing (the extensions changed) replaces the shared one, and an older answer still on its way loses", async () => {
  const older = refreshBotModels()!;
  const fresh = botModels(true);
  expect(calls).toEqual(["/api/bots/models", "/api/bots/models?fresh=1"]);
  answers[1]!.resolve(listing([KIMI, "Kimi from the new extension"]));
  await fresh;
  await settle();
  answers[0]!.resolve(listing(["openrouter/stale", "Stale"]));
  await older;
  await settle();
  expect(botModelsState().listing?.models.map((m) => m.name)).toEqual(["Kimi from the new extension"]);
});

test("Pi failing leaves nothing to pick from, as before, but the names it knew stay", async () => {
  const ok = refreshBotModels()!;
  answers[0]!.resolve(listing([KIMI, "Kimi K3.1 Pro"]));
  await ok;
  const broken = botModels(true);
  answers[1]!.reject(new Error("Pi can't start"));
  await broken.catch(() => {});
  await settle();
  expect(botModelsState().listing).toBeUndefined();
  expect(botModelsState()).toMatchObject({ failed: true, known: { models: [{ name: "Kimi K3.1 Pro" }] } });
});

test("forgetting drops the kept listing, in memory too", async () => {
  const asked = refreshBotModels()!;
  answers[0]!.resolve(listing([KIMI, "Kimi K3.1 Pro"]));
  await asked;
  expect(values.has(KEY)).toBe(true);
  forgetBotModels();
  expect(values.has(KEY)).toBe(false);
  expect(botModelsState()).toEqual({ failed: false, confirmed: false });
  expect(renderToStaticMarkup(React.createElement(Probe))).toBe("<i>kept:none</i>");
  // The next mount asks again rather than trusting an answer another server gave.
  refreshBotModels();
  expect(calls).toHaveLength(2);
});

test("another server at this address drops the listing kept from the last one; one kept before the server was known becomes its own", () => {
  values.set(KEY, JSON.stringify({ owner: "imac", listing: listing([KIMI, "The iMac's model"]) }));
  claimBotModels("macbook");
  expect(values.has(KEY)).toBe(false);
  expect(savedBotModels()).toBeUndefined();

  values.set(KEY, JSON.stringify({ listing: listing([KIMI, "Kept"]) }));
  claimBotModels("macbook");
  expect(JSON.parse(values.get(KEY)!).owner).toBe("macbook");
  expect(savedBotModels()?.models[0]?.name).toBe("Kept");
});

test("a kept copy that can't be read is as if none was kept", () => {
  values.set(KEY, "{broken");
  expect(savedBotModels()).toBeUndefined();
  values.set(KEY, JSON.stringify({ owner: "imac", listing: { models: [{ id: 3 }] } }));
  expect(savedBotModels()).toBeUndefined();
});

test("a model no listing names reads by a name made from its id, never the raw id", () => {
  expect(readableModelName(GLM)).toBe("GLM 5.3 Flash");
  expect(readableModelName("vercel-ai-gateway/zai/glm-5.3-flash")).toBe("GLM 5.3 Flash");
  expect(readableModelName(KIMI)).toBe("Kimi K3.1 Pro");
  expect(readableModelName("openrouter/anthropic/claude-sonnet-5-5")).toBe("Claude Sonnet 5.5");
  expect(readableModelName("openai-codex-2/gpt-6.1-sol")).toBe("GPT 6.1 Sol");
  expect(readableModelName("openrouter/deepseek/deepseek-r1:free")).toBe("Deepseek R1 (free)");
  // A date stays a number of its own, not a version.
  expect(readableModelName("anthropic/claude-sonnet-4-20250514")).toBe("Claude Sonnet 4 20250514");
  expect(readableModelName("plain")).toBe("Plain");
});

test("a model's name outlives the listing that had it: a later one without it, a reload, but not another server", async () => {
  let asked = refreshBotModels()!;
  answers[0]!.resolve(listing([GLM, "GLM-5.3 Flash"], [KIMI, "Kimi K3.1 Pro"]));
  await asked;
  // The next listing (an extension switched off, Pi's list not settled) lacks it: it's gone, by its name.
  const fresh = botModels(true);
  answers[1]!.resolve(listing([KIMI, "Kimi K3.1 Pro"]));
  await fresh;
  await settle();
  expect(botModelsState().known?.models.map((m) => m.id)).toEqual([KIMI]);
  expect(modelLabel(GLM, botModelsState())).toBe("GLM-5.3 Flash");
  // A reload, before the server has answered: the name it had, not a placeholder or the id.
  resetBotModels();
  expect(botModelsState().confirmed).toBe(false);
  expect(modelLabel(GLM, botModelsState())).toBe("GLM-5.3 Flash");
  expect(JSON.parse(values.get(KEY)!).names).toEqual({ [GLM]: "GLM-5.3 Flash" });
  // Listed again: the listing names it, and it isn't kept twice.
  asked = refreshBotModels()!;
  answers[2]!.resolve(listing([GLM, "GLM 5.3 Flash"], [KIMI, "Kimi K3.1 Pro"]));
  await asked;
  expect(modelLabel(GLM, botModelsState())).toBe("GLM 5.3 Flash");
  expect(JSON.parse(values.get(KEY)!).names).toEqual({});
  // Another server's now: the names go with the listing.
  forgetBotModels();
  expect(rememberedModelName(GLM)).toBeUndefined();
  expect(modelLabel(GLM, botModelsState())).toBeUndefined();
});

test("an answer without models (some servers answer {}) names nothing and breaks nothing", async () => {
  const asked = refreshBotModels()!;
  answers[0]!.resolve({} as PiModels);
  await asked;
  expect(botModelsState().confirmed).toBe(true);
  expect(modelLabel(GLM, botModelsState())).toBe("GLM 5.3 Flash");
});

test("names kept from another server aren't read for this one", () => {
  values.set(KEY, JSON.stringify({ owner: "macbook", listing: listing([KIMI, "The MacBook's Kimi"]), names: { [GLM]: "The MacBook's GLM" } }));
  resetBotModels();
  expect(rememberedModelName(GLM)).toBeUndefined();
  expect(rememberedModelName(KIMI)).toBeUndefined();
  // Names that can't be read are dropped; the listing kept with them still stands.
  values.set(KEY, JSON.stringify({ owner: "imac", listing: listing([KIMI, "Kimi K3.1 Pro"]), names: { [GLM]: 7, other: "Other" } }));
  resetBotModels();
  expect(rememberedModelName(GLM)).toBeUndefined();
  expect(rememberedModelName("other")).toBe("Other");
  expect(savedBotModels()?.models[0]?.name).toBe("Kimi K3.1 Pro");
});

test("before the server answers, a model this browser never saw holds its place; after, it reads by its id's name", async () => {
  expect(modelLabel(GLM, botModelsState())).toBeUndefined();
  const asked = refreshBotModels()!;
  answers[0]!.reject(new Error("Pi couldn't start"));
  await asked.catch(() => {});
  await settle();
  expect(botModelsState().failed).toBe(true);
  expect(modelLabel(GLM, botModelsState())).toBe("GLM 5.3 Flash");
});

// The picker itself, as it draws its first frame: in a child of its own, so its imports stay out of the other suites.
test("the model picker never draws a model's raw id, and names the provider from the first frame", () => {
  const script = `
    import { resolve } from "node:path";
    import assert from "node:assert/strict";
    const values = new Map();
    globalThis.localStorage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => void values.set(k, v), removeItem: (k) => void values.delete(k) };
    const React = (await import("react")).default;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { BotModelSelect } = await import(resolve("src/components/bots/BotAdvanced.tsx"));
    const { resetBotModels, refreshBotModels } = await import(resolve("src/lib/bots/models.ts"));
    const KIMI = ${JSON.stringify(KIMI)};
    const GLM = ${JSON.stringify(GLM)};
    const listing = { models: [{ id: KIMI, provider: "openrouter", name: "Kimi K3.1 Pro", reasoning: { efforts: [] } }, { id: "anthropic/claude-sonnet-5-5", provider: "anthropic", name: "Claude Sonnet 5.5", reasoning: { efforts: [] } }], defaultModel: "anthropic/claude-sonnet-5-5", checkedAt: 1 };
    const draw = (props) => renderToStaticMarkup(React.createElement(BotModelSelect, { label: "Model", unset: "Default", onChange() {}, ...props }));

    // Never seen a listing: a quiet placeholder and the provider's line from the id, no raw id.
    let html = draw({ value: KIMI });
    assert.ok(!html.includes(KIMI), html);
    assert.ok(html.includes("model-name-pending"), html);
    assert.ok(html.includes("OpenRouter"), html);
    html = draw({ value: KIMI, compact: true });
    assert.ok(!html.includes(KIMI) && html.includes("model-name-pending"), html);
    // Unset, Pi's default not known yet: it waits, rather than read "Default" and then change.
    html = draw({ compact: true });
    assert.ok(html.includes("model-name-pending"), html);

    // Kept from the last visit: the name and its provider, at once.
    values.set("openbuild:bot-models:v1", JSON.stringify({ listing }));
    resetBotModels();
    html = draw({ value: KIMI });
    assert.ok(html.includes("Kimi K3.1 Pro") && html.includes("OpenRouter"), html);
    assert.ok(!html.includes(KIMI), html);
    assert.ok(draw({ compact: true }).includes("Claude Sonnet 5.5"));
    // A model the kept copy doesn't have isn't called gone until the server says so.
    html = draw({ value: "openrouter/gone/model", compact: true });
    assert.ok(!html.includes("unavailable") && !html.includes("openrouter/gone/model"), html);

    // The server answered without it: now it's gone, by the name it had, never its raw id.
    globalThis.fetch = async () => Response.json({ ...listing, models: listing.models.slice(1) });
    await refreshBotModels();
    html = draw({ value: KIMI, compact: true });
    assert.ok(html.includes("Kimi K3.1 Pro (unavailable)") && !html.includes(KIMI), html);
    html = draw({ value: KIMI });
    assert.ok(html.includes("Kimi K3.1 Pro (unavailable)") && !html.includes(KIMI), html);
    // One this browser never saw named: a name read from its id.
    html = draw({ value: GLM, compact: true });
    assert.ok(html.includes("GLM 5.3 Flash (unavailable)") && !html.includes(GLM), html);
    // Following a default the listing lacks: its name, not its id.
    html = draw({ inherited: GLM, compact: true });
    assert.ok(html.includes("GLM 5.3 Flash") && !html.includes(GLM), html);

    // A first load where Pi fails: nothing is known, and still no raw id, in either picker.
    values.clear();
    resetBotModels();
    globalThis.fetch = async () => Response.json({ error: "Pi couldn't start" }, { status: 502 });
    await refreshBotModels().catch(() => {});
    for (const compact of [true, false]) {
      html = draw({ value: KIMI, compact });
      assert.ok(html.includes("Kimi K3.1 Pro") && !html.includes(KIMI) && !html.includes("unavailable") && !html.includes("model-name-pending"), html);
    }
  `;
  const result = spawnScriptSync(script);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
});
