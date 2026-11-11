import { expect, test } from "bun:test";
import { spawnScriptSync } from "./spawnScript";

// Isolate UI mocks from the other suites.
test("bot model menu uses Pi's current scope despite Show all and a stale selection", () => {
  const script = `
    import { mock } from "bun:test";
    import { resolve } from "node:path";
    import assert from "node:assert/strict";
    import React from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    const model = (id, provider, name) => ({ id, provider, name });
    mock.module(resolve("src/lib/store.ts"), () => ({
      useStore: (select) => select({}),
      planDetection: () => ({ models: [model("cursor/auto", "cursor", "Cursor Auto")] }),
    }));
    mock.module(resolve("src/lib/plugins.ts"), () => ({ usePlugins: () => 0 }));
    mock.module(resolve("src/lib/models.ts"), () => ({
      providerOf: (m) => m.provider, providerName: (p) => p,
      CUSTOM_PROVIDER: "custom", findModel: () => undefined,
    }));
    mock.module(resolve("src/lib/ui.ts"), () => ({
      useDevicePref: () => [true, () => {}], useFocusOnShow() {}, arrowNav() {}, cx() {},
    }));
    mock.module(resolve("src/components/primitives.tsx"), () => ({ BrandIcon: () => null, Popover: () => null }));
    const { ModelMenu } = await import(resolve("src/components/ModelSelect.tsx"));
    const detection = {
      plan: "pi", status: "valid",
      models: [model("openai/gpt", "openai", "GPT connected"), model("google/gemini", "google", "Gemini connected"), model("opencode-go/other", "opencode-go", "Out of scope")],
      scope: { models: [{ provider: "openai", id: "gpt" }, { provider: "google", id: "gemini" }] },
    };
    const html = renderToStaticMarkup(React.createElement(ModelMenu, {
      selected: { plan: "pi", id: "opencode-go/other" }, piDetection: detection, scopedOnly: true, onPick() {},
    }));
    assert.ok(html.includes("GPT connected"));
    assert.ok(html.includes("Gemini connected"));
    assert.ok(html.includes('role="group" aria-label="openai"'));
    assert.ok(html.includes('role="group" aria-label="google"'));
    assert.ok(!html.includes("Out of scope"));
    assert.ok(!html.includes("Cursor Auto"));
    assert.ok(!html.includes("Show all"));
  `;
  const result = spawnScriptSync(script);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
});
