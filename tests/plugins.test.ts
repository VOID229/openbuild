import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateManifest, type PluginManifest } from "../shared/plugins";
import { createLocalAuth } from "../server/localAuth";
import type { ModelInfo } from "../shared/types";
import openrouterDeepseek from "../plugins/openrouter-deepseek/client";
import piClaude from "../plugins/pi-claude/client";
import codexMulti from "../plugins/codex-multi/client";
import { providerOf, providerName, providerSvg } from "../src/lib/models";
import { providerGroups } from "../src/lib/modelSearch";
import { clearProviderOverrides, setProviderOverrides } from "../src/lib/pluginOverrides";

const manifest = (patch: Partial<PluginManifest> = {}) => ({
  id: "example",
  name: "Example",
  version: "1.0.0",
  apiVersion: 1,
  ...patch,
});

test("plugin manifests are validated, including paths and api version", () => {
  expect(validateManifest(manifest()).manifest?.id).toBe("example");
  expect(validateManifest(manifest({ id: "Bad ID" })).error).toContain("id");
  expect(validateManifest(manifest({ apiVersion: 2 })).error).toContain("apiVersion");
  expect(validateManifest(manifest({ client: "../outside.tsx" })).error).toContain("relative");
  expect(validateManifest(manifest({ client: "/etc/passwd" })).error).toContain("relative");
  expect(validateManifest(manifest({ tokens: { color: "red" } })).error).toContain("--");
  expect(validateManifest(manifest({ hide: [""] })).error).toContain("hide");
});

test("the OpenRouter plugin overrides the DeepSeek provider and brand marks", () => {
  const icons = openrouterDeepseek.icons;
  expect(icons.providers.deepseek).toContain("<svg");
  expect(icons.providers.deepseek).toContain("M18.654");
  expect(icons.providers.deepseek).toContain("color:var(--text)");
  expect(icons.brands.deepseek).toBe(icons.providers.deepseek);
});

test("provider overrides move pi-claude out of Custom and into Claude", () => {
  try {
    setProviderOverrides(piClaude.providers);
    const model = { id: "pi-claude/claude-opus-5-5", provider: "pi-claude", custom: true } as const;
    expect(providerOf(model)).toBe("claude");
    expect(providerName("claude")).toBe("Claude");
    const other = { id: "someone/other-model", provider: "someone", custom: true } as const;
    expect(providerOf(other)).toBe("custom");
  } finally {
    clearProviderOverrides();
  }
});

test("Claude Code accounts have separate Claude groups and a badged second icon", () => {
  try {
    setProviderOverrides(piClaude.providers);
    const first: ModelInfo = { id: "claude-code/claude-opus-5-5", provider: "claude-code", custom: true, name: "Claude Opus 5.5", protocol: "chat", reasoning: { efforts: [], mode: "effort", toggle: false }, input: ["text", "image"] };
    const second: ModelInfo = { ...first, id: "claude-code-2/claude-opus-5-5", provider: "claude-code-2" };
    expect(providerOf(first)).toBe("claude");
    expect(providerName(providerOf(first))).toBe("Claude");
    expect(providerSvg(providerOf(first))).toContain("<svg");
    expect(providerOf(second)).toBe("claude-code-2");
    expect(providerName(providerOf(second))).toBe("Claude (2)");
    const groups = providerGroups([first, second]);
    expect(groups.map((g) => g.provider)).toEqual(["claude", "claude-code-2"]);
    expect(groups[0]!.models).toEqual([first]);
    expect(groups[1]!.models).toEqual([second]);

    const icon = piClaude.icons.providers["claude-code-2"];
    expect(icon).toContain("<svg");
    expect(icon).toContain('fill="currentColor"');
    expect(icon).toContain('fill="#D97757"');
    expect(icon).toContain("claude2-two-_R_0_");
    expect(icon).toContain("claude2-cut-_R_0_");
    expect(icon).not.toContain("<title>");
  } finally {
    clearProviderOverrides();
  }
});

test("the codex-multi plugin gives the second Codex login its own Codex group", () => {
  try {
    setProviderOverrides(codexMulti.providers);
    const second = { id: "openai-codex-2/gpt-5.6-luna", provider: "openai-codex-2", custom: true } as const;
    expect(providerOf(second)).toBe("openai-codex-2");
    expect(providerName("openai-codex-2")).toBe("Codex (2)");
    const first = { id: "openai-codex/gpt-5.6-luna", provider: "openai-codex", custom: false } as const;
    expect(providerOf(first)).toBe("openai-codex");
    expect(providerName("openai-codex")).toBe("Codex");

    const icon = codexMulti.icons.providers["openai-codex-2"];
    expect(icon).toContain("<svg");
    expect(icon).toContain('fill="currentColor"');
    // The "2" badge is cut out with two masks whose ids the host makes unique per instance.
    expect(icon).toContain("codex2-two-_R_0_");
    expect(icon).toContain("codex2-cut-_R_0_");
  } finally {
    clearProviderOverrides();
  }
});

test("Claude model icons include provider-scoped default aliases without rebranding other providers", async () => {
  const script = `
    import { expect } from "bun:test";
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    globalThis.window = globalThis;
    globalThis.document = { addEventListener() {}, documentElement: { style: {
      getPropertyValue: () => "", setProperty() {}, removeProperty() {},
    } } };
    globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
    globalThis.fetch = async () => Response.json({ enabled: true, safe: false, disabled: [], plugins: [{
      id: "pi-claude", name: "Claude", version: "0.2.0", apiVersion: 1, client: true,
      clientUrl: ${JSON.stringify(new URL("../plugins/pi-claude/client.tsx", import.meta.url).href)},
    }] });
    const { usePlugins, pluginBrandSvg } = await import("./src/lib/plugins.tsx");
    const { BrandIcon } = await import("./src/components/primitives.tsx");
    await usePlugins.getState().refresh();
    expect(usePlugins.getState().errors).toEqual({});
    for (const id of ["claude-code/default", "claude-code/claude-opus-5-5"]) {
      expect(pluginBrandSvg(id)).toContain('fill="#D97757"');
      expect(renderToStaticMarkup(createElement(BrandIcon, { id }))).not.toContain("claude2-two-");
    }
    for (const id of ["claude-code-2/default", "claude-code-2/claude-opus-5-5", "CLAUDE-CODE-2/DEFAULT"]) {
      const html = renderToStaticMarkup(createElement(BrandIcon, { id }));
      expect(html).toContain("claude2-two-");
    }
    const pair = renderToStaticMarkup(createElement("div", null,
      createElement(BrandIcon, { id: "claude-code-2/default" }),
      createElement(BrandIcon, { id: "claude-code-2/default" }),
    ));
    const masks = [...pair.matchAll(/<mask id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(masks).size).toBe(4);
    for (const id of masks) expect(pair).toContain("url(#" + id + ")");
    expect(pluginBrandSvg("other/default")).toBeUndefined();
    expect(pluginBrandSvg("other/claude-opus-5-5")).toBeUndefined();
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${out}\n${err}`);
  expect(code).toBe(0);
});

test("icon first paint waits for plugins, with cached, missing, corrupt or blocked storage", async () => {
  // Each process gets a genuinely fresh module registry and synchronous cache hydration. Browser
  // shims must not leak into the server/plugin tests (or other frontend tests) in this process.
  const directory = mkdtempSync(join(tmpdir(), "openbuild-icon-paint-"));
  const client = join(directory, "client.mjs");
  writeFileSync(client, `export default async () => {
    globalThis.__iconEntered = (globalThis.__iconEntered ?? 0) + 1;
    await globalThis.__iconGate;
    return { icons: ${JSON.stringify(openrouterDeepseek.icons)} };
  };`);
  try {
    for (const scenario of ["missing", "blocked", "corrupt", "malformed", "empty", "partial", "cached", "cold-failure", "cached-failure"]) {
      const script = `
        import { expect } from "bun:test";
        import { createElement } from "react";
        import { renderToStaticMarkup } from "react-dom/server";
        const scenario = ${JSON.stringify(scenario)};
        const icons = ${JSON.stringify(openrouterDeepseek.icons)};
        const cache = scenario === "corrupt" ? "{" : scenario === "malformed" ? "null" :
          scenario.startsWith("cached") ? JSON.stringify(icons) : scenario === "partial" ?
          JSON.stringify({ providers: {}, brands: { unrelated: "<svg/>" } }) :
          scenario === "empty" ? JSON.stringify({ providers: {}, brands: {} }) : null;
        globalThis.window = globalThis;
        globalThis.document = { addEventListener() {}, documentElement: { style: {
          getPropertyValue: () => "", setProperty() {}, removeProperty() {},
        } } };
        globalThis.localStorage = {
          getItem(key) {
            if (scenario === "blocked") throw new Error("Storage blocked");
            return key === "openbuild:plugin-icons" ? cache : null;
          },
          setItem() { if (scenario === "blocked") throw new Error("Storage blocked"); },
          removeItem() {},
        };
        const { BrandIcon, ProviderIcon } = await import("./src/components/primitives.tsx");
        const { usePlugins, pluginIconsReady, pluginProviderSvg } = await import("./src/lib/plugins.tsx");
        const paint = () => [
          renderToStaticMarkup(createElement(BrandIcon, { id: "deepseek/deepseek-v3" })),
          renderToStaticMarkup(createElement(ProviderIcon, { provider: "deepseek" })),
        ];
        const assertOverride = () => { for (const html of paint()) expect(html).toContain("M18.654"); };
        expect(pluginIconsReady()).toBe(false);
        if (scenario.startsWith("cached")) assertOverride();
        else for (const html of paint()) expect(html).not.toContain("<svg");

        if (scenario.endsWith("-failure")) {
          // A failed API request releases built-ins instead of leaving the UI blank forever,
          // but never throws away an available cached override.
          globalThis.fetch = async () => { throw new Error("Offline"); };
          const version = usePlugins.getState().version;
          await usePlugins.getState().refresh();
          expect(usePlugins.getState().error).toBe("Offline");
          expect(usePlugins.getState().version).toBeGreaterThan(version);
          expect(pluginIconsReady()).toBe(true);
          if (scenario === "cached-failure") assertOverride();
          else for (const html of paint()) {
            expect(html).toContain("<svg");
            expect(html).not.toContain("M18.654");
          }
          process.exit(0);
        }

        let release;
        globalThis.__iconGate = new Promise(resolve => { release = resolve; });
        let info = { enabled: true, safe: false, disabled: [], customCss: false, plugins: [{
          id: "icons", name: "Icons", version: "1.0.0", apiVersion: 1,
          client: true, clientUrl: ${JSON.stringify(`file://${client}`)},
        }] };
        globalThis.fetch = async () => Response.json(info);
        const waitForEntry = async (count) => {
          const deadline = Date.now() + 2000;
          while ((globalThis.__iconEntered ?? 0) < count) {
            if (Date.now() > deadline) throw new Error("Plugin factory did not start");
            await new Promise(resolve => setTimeout(resolve, 5));
          }
        };
        const loading = usePlugins.getState().refresh();
        await waitForEntry(1);
        expect(pluginIconsReady()).toBe(false);
        if (scenario === "cached") assertOverride();
        else for (const html of paint()) expect(html).not.toContain("<svg");
        release();
        await loading;
        expect(usePlugins.getState().errors).toEqual({});
        expect(pluginIconsReady()).toBe(true);
        assertOverride();

        // Hot reload keeps committed icons until replacement is ready, never flashing built-ins.
        globalThis.__iconGate = new Promise(resolve => { release = resolve; });
        const reload = usePlugins.getState().refresh();
        await waitForEntry(2);
        assertOverride();
        release();
        await reload;
        assertOverride();

        // A superseded async factory must not repopulate the newly disabled registry.
        const enabledInfo = info;
        globalThis.__iconGate = new Promise(resolve => { release = resolve; });
        const superseded = usePlugins.getState().refresh();
        await waitForEntry(3);
        info = { ...enabledInfo, enabled: false };
        await usePlugins.getState().refresh(true);
        release();
        await superseded;
        expect(pluginProviderSvg("deepseek")).toBeUndefined();

        // Disabled/safe mode commits an empty set and restores the built-in fallback.
        for (const patch of [{ disabled: ["icons"] }, { enabled: false }, { safe: true }]) {
          info = { ...enabledInfo, ...patch };
          await usePlugins.getState().refresh();
          expect(pluginIconsReady()).toBe(true);
          expect(pluginProviderSvg("deepseek")).toBeUndefined();
          for (const html of paint()) {
            expect(html).toContain("<svg");
            expect(html).not.toContain("M18.654");
          }
        }
      `;
      const child = Bun.spawn([process.execPath, "-e", script], {
        cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
      });
      const timer = setTimeout(() => child.kill(), 8_000);
      try {
        const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        if (code !== 0) throw new Error(`${scenario}: ${out}\n${err}`);
        expect(code).toBe(0);
      } finally {
        clearTimeout(timer);
        child.kill();
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 65_000);

test("plugins are served, built against the host React, and can be disabled", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openbuild-plugins-"));
  const pluginsDir = join(directory, "plugins");
  const pluginDir = join(pluginsDir, "example");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(directory, "openbuild.config.ts"),
    `export default { pluginsDir: ${JSON.stringify(pluginsDir)} };`,
  );
  writeFileSync(
    join(pluginDir, "plugin.json"),
    JSON.stringify({ id: "example", name: "Example plugin", version: "1.0.0", apiVersion: 1, description: "test", client: "client.tsx", server: "server.ts", styles: "styles.css", slots: ["composer:toolbar"] }),
  );
  writeFileSync(join(pluginDir, "client.tsx"), `import { useState } from "react";\nexport default { slots: { "composer:toolbar": () => <b>hi</b> } };\n`);
  writeFileSync(
    join(pluginDir, "server.ts"),
    `export default { routes: (api: any) => ({ "/api/plugins/example/hello": { GET: api(() => Response.json({ hello: "plugin" })) } }) };`,
  );
  writeFileSync(join(pluginDir, "styles.css"), `.example { color: red; }\n`);

  const auth = createLocalAuth({ directory });
  await auth.setPassword("test-only-password-123");
  const child = Bun.spawn([process.execPath, "server/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "0",
      OPENCHAT_DATA_DIR: directory,
      OPENBUILD_CONFIG: join(directory, "openbuild.config.ts"),
      OPENCHAT_ALLOWED_HOSTS: "localhost",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 20_000);
  try {
    const reader = child.stdout.getReader();
    let output = "";
    let url: string | undefined;
    while (!url) {
      const next = await reader.read();
      if (next.done) throw new Error(`Server exited: ${output}\n${await new Response(child.stderr).text()}`);
      output += new TextDecoder().decode(next.value);
      url = output.match(/OpenBuild running at (http:\/\/[^\s]+)/)?.[1];
    }
    reader.releaseLock();
    const call = (path: string, init?: RequestInit) => fetch(new URL(path, url), init);
    const login = await call("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test-only-password-123" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const authed = (path: string, init: RequestInit = {}) => call(path, { ...init, headers: { ...init.headers, cookie } });

    // The whole plugin system is off on first run: manifests are listed, nothing runs.
    const off = await (await authed("/api/plugins")).json();
    expect(off).toMatchObject({ enabled: false, safe: false });
    expect(off.plugins).toHaveLength(1);
    expect(off.plugins[0]).toMatchObject({ id: "example", client: true, server: true, styles: true, serverLoaded: false });
    expect((await authed("/api/plugins/example/client.js")).status).toBe(404);
    expect((await authed("/api/plugins/example/hello")).status).toBe(404);

    // Turning it on starts the server module immediately (no restart) and opens the client routes.
    const on = await authed("/api/plugins/system", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ ok: true, enabled: true });
    const list = await (await authed("/api/plugins")).json();
    expect(list).toMatchObject({ enabled: true });
    expect(list.plugins[0]).toMatchObject({ id: "example", serverLoaded: true });

    const client = await (await authed("/api/plugins/example/client.js")).text();
    expect(client).toContain("globalThis.__OPENBUILD__.JSXRuntime");
    expect(client.length).toBeLessThan(20_000);
    expect(await (await authed("/api/plugins/example/styles.css")).text()).toContain(".example");

    // Routes a plugin contributes go through the same host/Origin/password checks as the app.
    expect((await call("/api/plugins/example/hello")).status).toBe(401);
    const hello = await authed("/api/plugins/example/hello");
    expect(hello.status).toBe(200);
    expect(await hello.json()).toEqual({ hello: "plugin" });

    // Disabling one plugin takes its client and server route away, and remembers the choice.
    expect((await authed("/api/plugins/example", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) })).status).toBe(200);
    expect((await authed("/api/plugins")).json()).resolves.toMatchObject({ enabled: true, disabled: ["example"] });
    expect((await authed("/api/plugins/example/client.js")).status).toBe(404);
    expect((await authed("/api/plugins/example/hello")).status).toBe(404);

    // Deleting removes the folder even while the plugin is off, and forgets the disabled choice.
    expect((await authed("/api/plugins/example", { method: "DELETE" })).status).toBe(200);
    expect(existsSync(pluginDir)).toBe(false);
    expect((await authed("/api/plugins")).json()).resolves.toMatchObject({ enabled: true, disabled: [], plugins: [] });
    expect((await authed("/api/plugins/example", { method: "DELETE" })).status).toBe(404);

    // The master switch turns everything off again, and the choice survives a reload of the state.
    expect((await authed("/api/plugins/system", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) })).status).toBe(200);
    expect((await authed("/api/plugins")).json()).resolves.toMatchObject({ enabled: false });
    expect((await authed("/api/plugins/example/client.js")).status).toBe(404);
  } finally {
    clearTimeout(timeout);
    child.kill();
    await child.exited;
    rmSync(directory, { recursive: true, force: true });
  }
}, 25_000);

test("plugin hot reload updates server modules and discovers new folders without a restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openbuild-hot-"));
  const pluginsDir = join(directory, "plugins");
  const hotDir = join(pluginsDir, "hot");
  const log = join(directory, "lifecycle.log");
  mkdirSync(hotDir, { recursive: true });
  writeFileSync(join(directory, "openbuild.config.ts"), `export default { pluginsDir: ${JSON.stringify(pluginsDir)} };`);
  writeFileSync(join(hotDir, "plugin.json"), JSON.stringify({ id: "hot", name: "Hot", version: "1.0.0", apiVersion: 1, server: "server.ts" }));
  const server = (v: number) => `import { appendFileSync } from "node:fs";
export default {
  onStart() { appendFileSync(${JSON.stringify(log)}, "start\\n"); },
  onStop() { appendFileSync(${JSON.stringify(log)}, "stop\\n"); },
  routes: (api: any) => ({ "/api/plugins/hot/value": { GET: api(() => Response.json({ v: ${v} })) } }),
};
`;
  writeFileSync(join(hotDir, "server.ts"), server(1));

  const auth = createLocalAuth({ directory });
  await auth.setPassword("test-only-password-123");
  const child = Bun.spawn([process.execPath, "server/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "0",
      OPENCHAT_DATA_DIR: directory,
      OPENBUILD_CONFIG: join(directory, "openbuild.config.ts"),
      OPENCHAT_ALLOWED_HOSTS: "localhost",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 30_000);
  try {
    const reader = child.stdout.getReader();
    let output = "";
    let url: string | undefined;
    while (!url) {
      const next = await reader.read();
      if (next.done) throw new Error(`Server exited: ${output}\n${await new Response(child.stderr).text()}`);
      output += new TextDecoder().decode(next.value);
      url = output.match(/OpenBuild running at (http:\/\/[^\s]+)/)?.[1];
    }
    reader.releaseLock();
    const call = (path: string, init?: RequestInit) => fetch(new URL(path, url), init);
    const login = await call("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test-only-password-123" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const authed = (path: string, init: RequestInit = {}) => call(path, { ...init, headers: { ...init.headers, cookie } });
    await authed("/api/plugins/system", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });

    const waitFor = async (check: () => Promise<boolean>, timeoutMs = 12_000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error("Timed out waiting for a plugin change");
    };
    const value = async () => (await authed("/api/plugins/hot/value")).json();

    expect(await value()).toEqual({ v: 1 });
    writeFileSync(join(hotDir, "server.ts"), server(2));
    await waitFor(async () => (await value()).v === 2);
    expect(await value()).toEqual({ v: 2 });
    // The old module stopped and the new one started.
    expect((await Bun.file(log).text()).trim().split("\n")).toEqual(["start", "stop", "start"]);

    // A brand-new folder is picked up by the same watcher, and a removed one disappears.
    const lateDir = join(pluginsDir, "late");
    mkdirSync(lateDir, { recursive: true });
    writeFileSync(join(lateDir, "plugin.json"), JSON.stringify({ id: "late", name: "Late", version: "1.0.0", apiVersion: 1, server: "server.ts" }));
    writeFileSync(join(lateDir, "server.ts"), `export default { routes: (api: any) => ({ "/api/plugins/late/hello": { GET: api(() => Response.json({ late: true })) } }) };`);
    await waitFor(async () => ((await (await authed("/api/plugins")).json()).plugins as { id: string }[]).some((p) => p.id === "late"));
    expect(await (await authed("/api/plugins/late/hello")).json()).toEqual({ late: true });
    rmSync(lateDir, { recursive: true, force: true });
    await waitFor(async () => !((await (await authed("/api/plugins")).json()).plugins as { id: string }[]).some((p) => p.id === "late"));
    expect((await authed("/api/plugins/late/hello")).status).toBe(404);
  } finally {
    clearTimeout(timeout);
    child.kill();
    await child.exited;
    rmSync(directory, { recursive: true, force: true });
  }
}, 35_000);
