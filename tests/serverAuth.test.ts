import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalAuth } from "../server/localAuth";

test("server gates every device API and only unlocks with a local session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openbuild-access-"));
  const auth = createLocalAuth({ directory });
  await auth.setPassword("test-only-password-123");
  const child = Bun.spawn([process.execPath, "server/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: "0", OPENCHAT_DATA_DIR: directory, OPENCHAT_ALLOWED_HOSTS: "localhost" },
    stdout: "pipe", stderr: "pipe",
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
    expect(await (await call("/api/auth/status")).json()).toEqual({ configured: true, authenticated: false });
    for (const [path, method] of [
      ["/api/config", "GET"], ["/api/chats", "GET"], ["/api/state", "PUT"],
      ["/api/keys/secrets", "GET"], ["/api/pi/chat", "POST"], ["/api/pi/providers", "GET"],
      ["/api/unknown", "GET"], ["/api/dictation/check", "GET"], ["/api/dictation/transcribe", "POST"],
    ]) expect((await call(path!, { method })).status).toBe(401);
    const login = await call("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test-only-password-123" }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect((await call("/api/config", { headers: { cookie } })).status).toBe(200);
    // Another allowed host is still a foreign origin, not a CSRF bypass.
    expect((await call("/api/chats", { headers: { cookie, origin: "http://localhost:9999" } })).status).toBe(403);
    expect((await call("/api/auth/logout", { method: "POST", headers: { cookie } })).status).toBe(200);
    expect((await call("/api/chats", { headers: { cookie } })).status).toBe(401);
    const again = await call("/api/auth/login", { method: "POST", body: JSON.stringify({ password: "test-only-password-123" }) });
    const oldCookie = again.headers.get("set-cookie")!.split(";")[0]!;
    await auth.setPassword("replacement-password-123");
    expect((await call("/api/config", { headers: { cookie: oldCookie } })).status).toBe(401);
    // Bundling and serving the locked UI remains public, but none of its data does.
    const page = await call("/");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<html");
  } finally {
    clearTimeout(timeout);
    child.kill();
    await child.exited;
    rmSync(directory, { recursive: true, force: true });
  }
}, 25_000);
