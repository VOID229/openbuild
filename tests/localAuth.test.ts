import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalAuth } from "../server/localAuth";

const PASSWORD = "correct horse battery staple";
const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "openbuild-auth-"));
  directories.push(directory);
  let time = 1_000_000;
  const auth = createLocalAuth({ directory, now: () => time });
  return { auth, directory, advance: (ms: number) => { time += ms; } };
}
function request(cookie?: string, url = "http://localhost/api") {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}
function loginRequest(password = PASSWORD, url = "http://localhost/login", headers: HeadersInit = {}) {
  return new Request(url, { method: "POST", headers, body: JSON.stringify({ password }) });
}
function session(response: Response): string {
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie");
  expect(cookie).not.toBeNull();
  return cookie!.split(";")[0]!;
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("local password authentication", () => {
  test("fails closed before configuration and reports only public status", async () => {
    const { auth } = fixture();
    expect(auth.configured()).toBe(false);
    expect(auth.authorize(request())?.status).toBe(401);
    expect(await auth.authorize(request())!.json()).toEqual({ error: "Unauthorized" });
    expect(await auth.status(request()).json()).toEqual({ configured: false, authenticated: false });
    expect((await auth.login(loginRequest())).status).toBe(503);
    expect(auth.logout(request()).status).toBe(200);
  });

  test("validates password bounds and atomically stores only a private Argon2id hash", async () => {
    const { auth, directory } = fixture();
    for (const password of ["", "a".repeat(11), "a".repeat(1025)]) {
      await expect(auth.setPassword(password)).rejects.toThrow();
    }
    expect(readdirSync(directory)).toEqual([]);
    await auth.setPassword("a".repeat(12));
    await auth.setPassword("b".repeat(1024));
    const file = join(directory, "access.json");
    const stored = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(stored)).toEqual(["hash"]);
    expect(stored.hash.startsWith("$argon2id$")).toBe(true);
    expect(await Bun.password.verify("b".repeat(1024), stored.hash)).toBe(true);
    expect(readFileSync(file, "utf8")).not.toContain("b".repeat(1024));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory)).toEqual(["access.json"]);
    expect(auth.configured()).toBe(true);
  });

  test("creates the data directory and respects OPENCHAT_DATA_DIR by default", async () => {
    const { directory } = fixture();
    const previous = process.env.OPENCHAT_DATA_DIR;
    process.env.OPENCHAT_DATA_DIR = join(directory, "nested");
    try {
      const auth = createLocalAuth();
      await auth.setPassword(PASSWORD);
      expect(statSync(join(directory, "nested", "access.json")).mode & 0o777).toBe(0o600);
    } finally {
      if (previous === undefined) delete process.env.OPENCHAT_DATA_DIR;
      else process.env.OPENCHAT_DATA_DIR = previous;
    }
  });

  test("authenticates using opaque cookies, not passwords or invented tokens", async () => {
    const { auth } = fixture();
    await auth.setPassword(PASSWORD);
    expect((await auth.login(loginRequest("incorrect password"))).status).toBe(401);
    const response = await auth.login(loginRequest());
    const cookie = session(response);
    expect(cookie).toMatch(/^openbuild_session=[a-f0-9]{64}$/);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000");
    expect(response.headers.get("set-cookie")).not.toContain("Secure");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(auth.authorize(request(cookie))).toBeUndefined();
    expect(await auth.status(request(cookie)).json()).toEqual({ configured: true, authenticated: true });
    expect(await auth.status(request()).json()).toEqual({ configured: true, authenticated: false });
    for (const invalid of ["openbuild_session=" + "0".repeat(64), "openbuild_session=" + PASSWORD, cookie + "; " + cookie]) {
      expect(auth.authorize(request(invalid))?.status).toBe(401);
    }
    const another = session(await auth.login(loginRequest()));
    expect(another).not.toBe(cookie);
  });

  test("sets Secure only from the request URL, including logout", async () => {
    const { auth } = fixture();
    await auth.setPassword(PASSWORD);
    const insecure = await auth.login(loginRequest(PASSWORD, "http://localhost/login", { "x-forwarded-proto": "https" }));
    expect(insecure.headers.get("set-cookie")).not.toContain("Secure");
    const secure = await auth.login(loginRequest(PASSWORD, "https://localhost/login", { "x-forwarded-proto": "http" }));
    expect(secure.headers.get("set-cookie")).toContain("; Secure");
    expect(auth.logout(request(session(secure), "https://localhost/logout")).headers.get("set-cookie")).toContain("Max-Age=0; Secure");
  });

  test("logout revokes only that session and clears the cookie", async () => {
    const { auth } = fixture();
    await auth.setPassword(PASSWORD);
    const first = session(await auth.login(loginRequest()));
    const second = session(await auth.login(loginRequest()));
    const response = auth.logout(request(first));
    expect(response.headers.get("set-cookie")).toBe("openbuild_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    expect(auth.authorize(request(first))?.status).toBe(401);
    expect(auth.authorize(request(second))).toBeUndefined();
  });

  test("expires sessions after exactly thirty idle days", async () => {
    const { auth, advance } = fixture();
    await auth.setPassword(PASSWORD);
    const cookie = session(await auth.login(loginRequest()));
    advance(2592000_000);
    expect(auth.authorize(request(cookie))?.status).toBe(401);
    expect(auth.status(request(cookie)).headers.get("set-cookie")).toBeNull();
  });

  test("activity renews disk expiry and browser cookie, including status checks", async () => {
    const { auth, advance, directory } = fixture();
    await auth.setPassword(PASSWORD);
    const cookie = session(await auth.login(loginRequest(PASSWORD, "https://localhost/login")));
    advance(2592000_000 - 1);
    const response = await auth.protect(request(cookie, "https://localhost/api/config"),
      () => Response.json({ ok: true }));
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("set-cookie")).toContain(`${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000; Secure`);
    advance(1);
    const status = auth.status(request(cookie));
    expect(await status.json()).toEqual({ configured: true, authenticated: true });
    expect(status.headers.get("set-cookie")).toContain("Max-Age=2592000");
    const expires = JSON.parse(readFileSync(join(directory, "access.json"), "utf8")).sessions[0][1];
    expect(expires).toBe(1_000_000 + 2 * 2592000_000);
    const restarted = createLocalAuth({ directory, now: () => expires });
    let called = false;
    const denied = await restarted.protect(request(cookie), () => { called = true; return new Response(); });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("set-cookie")).toBeNull();
    expect(called).toBe(false);
  });

  test("password reset revokes sessions, including a reset to the same password", async () => {
    const { auth } = fixture();
    await auth.setPassword(PASSWORD);
    const cookie = session(await auth.login(loginRequest()));
    await auth.setPassword(PASSWORD);
    expect(auth.authorize(request(cookie))?.status).toBe(401);
    const next = session(await auth.login(loginRequest()));
    await auth.setPassword("a different password");
    expect(auth.authorize(request(next))?.status).toBe(401);
    expect((await auth.login(loginRequest())).status).toBe(401);
    expect((await auth.login(loginRequest("a different password"))).status).toBe(200);
  });

  test("observes external process changes and never restores revoked sessions", async () => {
    const { auth, directory } = fixture();
    await auth.setPassword(PASSWORD);
    const original = readFileSync(join(directory, "access.json"), "utf8");
    const cookie = session(await auth.login(loginRequest()));
    const external = createLocalAuth({ directory });
    await external.setPassword("external password change");
    expect(await auth.status(request(cookie)).json()).toEqual({ configured: true, authenticated: false });
    writeFileSync(join(directory, "access.json"), original);
    expect(auth.authorize(request(cookie))?.status).toBe(401);
    const fresh = session(await auth.login(loginRequest()));
    unlinkSync(join(directory, "access.json"));
    expect(auth.authorize(request(fresh))?.status).toBe(401);
    expect(auth.configured()).toBe(false);
    writeFileSync(join(directory, "access.json"), original);
    expect(auth.authorize(request(fresh))?.status).toBe(401);
    writeFileSync(join(directory, "access.json"), "not json");
    expect(auth.configured()).toBe(false);
    writeFileSync(join(directory, "access.json"), JSON.stringify({ hash: PASSWORD }));
    expect((await auth.login(loginRequest())).status).toBe(503);
  });

  test("does not issue sessions for credentials changed during a pending login", async () => {
    const { auth, directory } = fixture();
    await auth.setPassword(PASSWORD);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const pending = auth.login(new Request("http://localhost/login", { method: "POST", body }));
    await createLocalAuth({ directory }).setPassword("replacement password");
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ password: PASSWORD })));
    controller.close();
    const response = await pending;
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    const cookie = session(await auth.login(loginRequest("replacement password")));
    const restarted = createLocalAuth({ directory, now: () => 1_000_000 });
    expect(restarted.configured()).toBe(true);
    expect(restarted.authorize(request(cookie))).toBeUndefined();
  });

  test("persists only token hashes and preserves logout across restarts", async () => {
    const { auth, directory } = fixture();
    await auth.setPassword(PASSWORD);
    const cookie = session(await auth.login(loginRequest(PASSWORD, "https://localhost/login")));
    const stored = readFileSync(join(directory, "access.json"), "utf8");
    expect(stored).not.toContain(cookie.split("=")[1]!);
    expect(stored).not.toContain(PASSWORD);
    expect(JSON.parse(stored).sessions).toHaveLength(1);
    expect(statSync(join(directory, "access.json")).mode & 0o777).toBe(0o600);
    const restarted = createLocalAuth({ directory, now: () => 1_000_000 });
    expect(restarted.authorize(request(cookie))).toBeUndefined();
    restarted.logout(request(cookie));
    expect(auth.authorize(request(cookie))?.status).toBe(401);
    expect(createLocalAuth({ directory, now: () => 1_000_000 }).authorize(request(cookie))?.status).toBe(401);
  });

  test("rejects corrupt persisted sessions without trusting their contents", async () => {
    const { auth, directory } = fixture();
    await auth.setPassword(PASSWORD);
    const cookie = session(await auth.login(loginRequest()));
    const file = join(directory, "access.json");
    const stored = JSON.parse(readFileSync(file, "utf8"));
    stored.sessions = [[cookie.split("=")[1], "never"]];
    writeFileSync(file, JSON.stringify(stored));
    expect(auth.authorize(request(cookie))?.status).toBe(401);
    expect(createLocalAuth({ directory }).authorize(request(cookie))?.status).toBe(401);
  });

  test("limits all attempts globally, ignoring spoofed IP headers, and recovers", async () => {
    const { auth, advance } = fixture();
    await auth.setPassword(PASSWORD);
    for (let i = 0; i < 10; i++) {
      const response = await auth.login(new Request("http://localhost/login", {
        method: "POST", body: "{", headers: { "x-forwarded-for": `192.0.2.${i}` },
      }));
      expect(response.status).toBe(400);
    }
    const limited = await auth.login(loginRequest());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    advance(60_000);
    expect((await auth.login(loginRequest())).status).toBe(200);
  });

  test("rejects malformed, missing and oversized password bodies", async () => {
    const { auth } = fixture();
    await auth.setPassword(PASSWORD);
    for (const body of ["", "{", "null", "[]", '{}', '{"password":42}', JSON.stringify({ password: "x".repeat(1025) }), " ".repeat(4097)]) {
      expect((await auth.login(new Request("http://localhost/login", { method: "POST", body }))).status).toBe(400);
    }
    expect((await auth.login(new Request("http://localhost/login", { method: "POST", body: "{}", headers: { "content-length": "4097" } }))).status).toBe(400);
  });

  test("enforces the streaming byte limit without trusting content-length", async () => {
    const { auth } = fixture();
    await auth.setPassword(PASSWORD);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2048).fill(32));
        controller.enqueue(new Uint8Array(2048).fill(32));
        controller.enqueue(new Uint8Array(1).fill(32));
      },
      cancel() { cancelled = true; },
    });
    expect((await auth.login(new Request("http://localhost/login", { method: "POST", body, headers: { "content-length": "1" } }))).status).toBe(400);
    expect(cancelled).toBe(true);
    // Exactly 4096 bytes is accepted; multi-byte UTF-8 is counted as bytes.
    const payload = JSON.stringify({ password: PASSWORD });
    expect((await auth.login(new Request("http://localhost/login", { method: "POST", body: payload.padEnd(4096) }))).status).toBe(200);
    expect((await auth.login(new Request("http://localhost/login", { method: "POST", body: JSON.stringify({ password: PASSWORD, padding: "é".repeat(2100) }) }))).status).toBe(400);
  });

  test("bounds simultaneous Argon2 verification and fails closed when busy", async () => {
    const { auth } = fixture();
    await auth.setPassword(PASSWORD);
    const responses = await Promise.all(Array.from({ length: 3 }, () => auth.login(loginRequest())));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 429]);
    expect(responses.find((response) => response.status === 429)!.headers.get("retry-after")).toBe("1");
  });
});
