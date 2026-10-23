import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateManifest, type PluginManifest } from "../shared/plugins";
import { createLocalAuth } from "../server/localAuth";

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

    const list = await (await authed("/api/plugins")).json();
    expect(list.plugins).toHaveLength(1);
    expect(list.plugins[0]).toMatchObject({ id: "example", client: true, server: true, styles: true, serverLoaded: true });

    const client = await (await authed("/api/plugins/example/client.js")).text();
    expect(client).toContain("globalThis.__OPENBUILD__.JSXRuntime");
    expect(client.length).toBeLessThan(20_000);
    expect(await (await authed("/api/plugins/example/styles.css")).text()).toContain(".example");

    // Routes a plugin contributes go through the same host/Origin/password checks as the app.
    expect((await call("/api/plugins/example/hello")).status).toBe(401);
    const hello = await authed("/api/plugins/example/hello");
    expect(hello.status).toBe(200);
    expect(await hello.json()).toEqual({ hello: "plugin" });

    // Disabling takes the client and styles away, and remembers the choice.
    expect((await authed("/api/plugins/example", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) })).status).toBe(200);
    expect((await authed("/api/plugins")).json()).resolves.toMatchObject({ disabled: ["example"] });
    expect((await authed("/api/plugins/example/client.js")).status).toBe(404);
  } finally {
    clearTimeout(timeout);
    child.kill();
    await child.exited;
    rmSync(directory, { recursive: true, force: true });
  }
}, 25_000);
