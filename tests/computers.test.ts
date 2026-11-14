import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { Computer, procListeners } from "../server/computers/index";
import { Browser } from "../server/computers/browser";
import { spawnScript } from "./spawnScript";

async function temporary(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-computers-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function fakeComputer(kind: "host" | "container", home: string) {
  const c = new Computer({ id: "test-computer", kind, engine: "podman", createdAt: 0 });
  Object.defineProperty(c, "hostHome", { value: home });
  c.ensure = async () => {};
  return c;
}

test("container filesystem operations never follow bind-home symlinks on the host", async () => {
  await temporary(async (dir) => {
    const home = join(dir, "home"), outside = join(dir, "outside");
    await mkdir(home);
    await mkdir(outside);
    await writeFile(join(outside, "secret"), "HOST SECRET");
    // Absolute and relative links can both escape a lexical host-home boundary.
    await symlink(outside, join(home, "absolute"));
    await symlink("../outside", join(home, "relative"));
    const c = fakeComputer("container", home);
    const calls: string[] = [];
    (c as any).capture = async (command: string) => {
      calls.push(command);
      const out = command.startsWith("stat ") ? "directory|12|123" : command.startsWith("ls ") ? "child\n" : "CONTAINER DATA";
      return { code: 0, out: Buffer.from(out), err: "" };
    };
    for (const link of ["absolute", "relative"]) {
      expect((await c.readFile(`${link}/secret`)).toString()).toBe("CONTAINER DATA");
      await c.writeFile(`${link}/secret`, "overwrite");
      await c.mkdir(`${link}/created`);
      await c.access(`${link}/secret`);
      expect(await c.stat(`${link}/secret`)).toEqual({ dir: true, size: 12, mtime: 123000 });
      expect(await c.readdir(link)).toEqual(["child"]);
    }
    expect(calls).toHaveLength(12);
    expect(calls.every((command) => command.includes("/home/bot/"))).toBe(true);
    expect(calls.some((command) => command.includes(home))).toBe(false);
    expect(await readFile(join(outside, "secret"), "utf8")).toBe("HOST SECRET");
    await expect(access(join(outside, "created"))).rejects.toThrow();
    expect(await c.list("absolute")).toEqual({ path: "/home/bot/absolute", entries: [{ name: "child", dir: true, size: 12, mtime: 123000 }] });
  });
});

test("host computers retain direct filesystem operations", async () => {
  await temporary(async (dir) => {
    const c = fakeComputer("host", dir);
    await c.writeFile("nested/file", "hello");
    expect((await c.readFile("nested/file")).toString()).toBe("hello");
    expect(await c.readdir("nested")).toEqual(["file"]);
    expect((await c.stat("nested")).dir).toBe(true);
  });
});

test("engine discovery accepts successful info for both engines without mixed templates", async () => {
  await temporary(async (dir) => {
    for (const engine of ["podman", "docker"]) {
      const file = join(dir, engine);
      await writeFile(file, '#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = info ]\n');
      await chmod(file, 0o755);
    }
    // Separate module/cache/environment: no real engine can be discovered or started.
    const { code, stderr: err } = await spawnScript(`
      const { engines } = await import('./server/computers/index.ts');
      const found = await engines();
      if (JSON.stringify(found) !== '["podman","docker"]') throw new Error(JSON.stringify(found));
    `, { PATH: dir });
    expect(err).toBe("");
    expect(code).toBe(0);
  });
});

test("exec timeout is milliseconds, with a bounded abort fallback", async () => {
  await temporary(async (dir) => {
    const c = fakeComputer("host", dir);
    const controller = new AbortController();
    const fallback = setTimeout(() => controller.abort(), 1000);
    const start = Date.now();
    try {
      await expect(c.exec("sleep 10", { timeout: 40, signal: controller.signal })).rejects.toThrow("timeout:40");
      expect(Date.now() - start).toBeLessThan(900);
    } finally { clearTimeout(fallback); }
  });
});

test("a command that leaves something running returns when its shell exits, not when that ends", async () => {
  await temporary(async (dir) => {
    const c = fakeComputer("host", dir);
    let out = "";
    const start = Date.now();
    // The sleep inherits the shell's output: waiting for that to close held the call for as long as it ran.
    const left = await c.exec("sleep 3 & echo started", { timeout: 20_000, onData: (d) => (out += d) });
    expect(Date.now() - start).toBeLessThan(2500);
    expect(left).toEqual({ exitCode: 0, background: true });
    expect(out).toBe("started\n");
    // A command that leaves nothing behind says nothing of it, and all it printed is there.
    out = "";
    expect(await c.exec("printf one; sleep 0.2; printf two; exit 3", { onData: (d) => (out += d) })).toEqual({ exitCode: 3 });
    expect(out).toBe("onetwo");
    // The timeout still stops the whole group, a child that holds the output included.
    const timed = Date.now();
    await expect(c.exec("sleep 30 & sleep 30", { timeout: 150 })).rejects.toThrow("timeout:150");
    expect(Date.now() - timed).toBeLessThan(2500);
  });
});

test("exec does not spawn when aborted before or during ensure", async () => {
  const c = fakeComputer("host", tmpdir());
  let spawned = false, ensured = false;
  (c as any).spawnShell = () => { spawned = true; throw new Error("unexpected spawn"); };
  const before = new AbortController();
  before.abort();
  c.ensure = async () => { ensured = true; };
  await expect(c.exec("unused", { signal: before.signal })).rejects.toThrow("aborted");
  expect(ensured).toBe(false);
  const during = new AbortController();
  c.ensure = async () => { during.abort(); };
  await expect(c.exec("unused", { signal: during.signal })).rejects.toThrow("aborted");
  expect(spawned).toBe(false);
});

test("capture and startProc handle missing executables without unhandled child errors", async () => {
  await temporary(async (dir) => {
    const c = fakeComputer("container", dir);
    (c.config as any).engine = join(dir, "nonexistent-engine");
    await expect(c.readFile("file")).rejects.toThrow();
    await expect(c.writeFile("file", "input")).rejects.toThrow();
    const notifications: string[] = [];
    const listener = (_id: string, _proc: unknown, tail: string) => { notifications.push(tail); };
    procListeners.add(listener);
    try {
      const proc = await c.startProc("unused", undefined, true);
      for (let n = 0; n < 100 && notifications.length === 0; n++) await Bun.sleep(5);
      const result = await c.readProc(proc.id);
      expect(result.info.state).toBe("exited");
      expect(result.info.exitCode).toBe(-1);
      expect(result.output).toMatch(/ENOENT|not found/i);
      expect(notifications).toHaveLength(1);
    } finally { procListeners.delete(listener); }
  });
});

function fakeBrowser() {
  return new Browser(() => { throw new Error("must not start a browser"); }, "/profile", "/downloads");
}

test("DOM snapshots redact password values but retain normal text fields", async () => {
  const browser = fakeBrowser();
  const element = (type: string, value: string) => ({
    nodeType: 1, tagName: "INPUT", type, value, name: type, labels: [],
    getAttribute: () => null, hasAttribute: () => false, setAttribute() {},
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
  });
  (browser as any).evaluate = async (expression: string) => runInNewContext(expression, {
    window: {}, document: { title: "Test", body: { childNodes: [element("password", "SECRET-PASSWORD"), element("text", "visible value")] }, documentElement: { scrollHeight: 900 } },
    location: { href: "https://example.test" }, scrollY: 0, innerHeight: 900,
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  });
  const snapshot = await browser.snapshot();
  expect(snapshot.text).not.toContain("SECRET-PASSWORD");
  expect(snapshot.text).toContain("[redacted]");
  expect(snapshot.text).toContain('value="visible value"');
});

test("closeTab is idempotent against targetDestroyed before the response", async () => {
  for (const eventFirst of [true, false]) {
    const browser = fakeBrowser();
    const b = browser as any;
    b.tabs = [{ targetId: "a" }, { targetId: "b" }, { targetId: "c" }];
    b.active = 2;
    b.connection = async () => ({ send: async () => { if (eventFirst) b.removeTab("b"); } });
    await browser.closeTab(1);
    if (!eventFirst) b.removeTab("b");
    expect(b.tabs.map((t: { targetId: string }) => t.targetId)).toEqual(["a", "c"]);
    expect(b.active).toBe(1);
    browser.close();
  }
});
