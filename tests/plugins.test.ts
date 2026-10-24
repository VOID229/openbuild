import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateManifest, type PluginManifest } from "../shared/plugins";
import { createLocalAuth } from "../server/localAuth";
import openrouterDeepseek from "../plugins/openrouter-deepseek/client";
import piClaude from "../plugins/pi-claude/client";
import codexMulti from "../plugins/codex-multi/client";
import { providerOf, providerName } from "../src/lib/models";
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
