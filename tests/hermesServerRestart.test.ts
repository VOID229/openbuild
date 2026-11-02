import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLocalAuth } from "../server/localAuth";
import { HTML_DELIVERY_NOTE } from "../server/htmlDelivery";
import { PLUGIN_GUIDANCE_NOTE } from "../server/pluginGuidance";
import { FAKE_HERMES } from "./hermesFixture";
/** Each native turn receives the display note once, ahead of the user's prompt. */
const prompts = (...messages: string[]) => messages.map(m => HTML_DELIVERY_NOTE + PLUGIN_GUIDANCE_NOTE + m + "\n").join("");

async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out: ${label}`);
}

test("Hermes thread keeps running while OB is down and the restarted server reattaches", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ob-hermes-http-"));
  const data = join(directory, "data");
  const fake = join(directory, "fake-hermes");
  const release = join(directory, "release");
  const effects = join(directory, "effects");
  mkdirSync(data);
  writeFileSync(fake, `#!${process.execPath}\n` + FAKE_HERMES);
  chmodSync(fake, 0o700);
  await createLocalAuth({ directory: data }).setPassword("hermes restart fixture password");
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, NODE_ENV: "production", PORT: String(port), HOST: "127.0.0.1",
    OPENCHAT_DATA_DIR: data, PI_CODING_AGENT_DIR: join(directory, "agent"), HERMES_BIN: fake,
    FAKE_RELEASE: release, FAKE_EFFECTS: effects,
  };
  const servers: ReturnType<typeof Bun.spawn>[] = [];
  const logs: Promise<string>[] = [];
  let cookie = "";
  const request = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => fetch(base + path, {
    method, headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
  });
  const launch = async () => {
    const child = Bun.spawn([process.execPath, resolve("server/index.ts")], { env, stdout: "pipe", stderr: "pipe" });
    servers.push(child);
    logs.push(new Response(child.stdout).text(), new Response(child.stderr).text());
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`Server exited: ${(await Promise.all(logs)).join("\n")}`);
      try { return (await request("/api/auth/status")).ok; } catch { return false; }
    }, "HTTP server startup");
    return child;
  };
  const json = async (path: string, body?: unknown, method?: string) => {
    const res = await request(path, body, method);
    const text = await res.text();
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${text}`);
    return JSON.parse(text);
  };
  try {
    let server = await launch();
    const login = await request("/api/auth/login", { password: "hermes restart fixture password" });
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const models = await json("/api/hermes/models");
    expect(models.models.map((m: { id: string }) => m.id)).toEqual(["hermes/p/m"]);
    const { workspace } = await json("/api/workspaces", { mode: "scratch" });
    const { serverId } = await json("/api/config");
    const runId = "reply-hermes-restart-0123456789abcdef";
    const chat = {
      id: "thread-hermes-restart", title: "hermes restart fixture", runtime: "hermes", createdAt: Date.now(), updatedAt: Date.now(), workspace,
      messages: [
        { id: "user-original", role: "user", content: "work once released", createdAt: Date.now() },
        { id: "assistant-original", role: "assistant", content: "", createdAt: Date.now(), startedAt: Date.now(), status: "streaming", model: { plan: "hermes", id: "hermes/p/m" }, stream: { id: runId, via: serverId } },
      ],
    };
    const saved = await json(`/api/chats/${chat.id}`, chat, "PUT");
    const pending = await request("/api/pi/chat", { threadId: chat.id, runtime: "hermes", cwd: workspace.cwd, model: "hermes/p/m", effort: "high", prior: 0, message: "work once released", stream: { id: runId } });
    expect(pending.status).toBe(200);
    const reader = pending.body!.getReader();
    let received = "";
    while (!received.includes("Started-")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Run ended before the first event: ${received}`);
      received += new TextDecoder().decode(chunk.value);
    }
    const worker = JSON.parse(readFileSync(join(data, "pi-worker", "worker.json"), "utf8"));
    server.kill("SIGTERM"); await server.exited;
    void reader.cancel().catch(() => {});
    process.kill(worker.pid, 0);
    writeFileSync(release, "finish while OB is down");
    await until(async () => {
      const response = await fetch("http://pi/runs?id=" + runId, { unix: worker.socket } as RequestInit);
      return response.ok && (await response.json() as { status: string }).status !== "pending";
    }, "detached worker offline completion");
    expect(existsSync(effects + ".finished")).toBe(true);

    server = await launch();
    const index = await json("/api/chats?index");
    expect(index.index.find((entry: { id: string }) => entry.id === chat.id).v).not.toBe(saved.v);
    const completed = (await json("/api/chats/fetch", { ids: [chat.id] })).chats[0].chat;
    const reply = completed.messages.find((message: { id: string }) => message.id === "assistant-original");
    expect(reply.content).toBe("Started-finished offline");
    expect(reply.status).toBe("done");
    const tool = reply.parts.find((part: { type: string }) => part.type === "tool");
    expect(tool).toMatchObject({ name: "bash", status: "done", output: "hi", args: { command: "echo hi" } });
    const replay = await request(`/api/chat/runs/${runId}`);
    const events = (await replay.text()).trim().split("\n").map(line => JSON.parse(line));
    expect(events.at(-1).t).toBe("end");
    // Re-posting after the restart reattaches instead of prompting Hermes a second time.
    const duplicate = await request("/api/pi/chat", { threadId: chat.id, runtime: "hermes", cwd: workspace.cwd, model: "hermes/p/m", effort: "high", prior: 0, message: "work once released", stream: { id: runId } });
    expect(await duplicate.text()).toContain("finished offline");
    expect(readFileSync(effects, "utf8")).toBe(prompts("work once released"));
    // A thread's runtime is fixed.
    const switched = await request("/api/pi/chat", { threadId: chat.id, runtime: "pi", cwd: workspace.cwd, model: "test/x", effort: "off", prior: 1, message: "again", stream: { id: "reply-hermes-switch-0123456789abcdef" } });
    expect(switched.status).toBe(400);
  } finally {
    for (const child of servers) {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
    for (const kind of ["pi-worker", "durable"]) {
      try {
        const metadata = JSON.parse(readFileSync(join(data, kind, "worker.json"), "utf8"));
        if (Number.isSafeInteger(metadata.pid) && metadata.pid > 1 && metadata.pid !== process.pid) {
          const group = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(metadata.pid)]);
          const leader = Number(group.stdout.toString().trim()) === metadata.pid;
          try { process.kill(leader ? -metadata.pid : metadata.pid, "SIGKILL"); } catch {}
        }
        if (typeof metadata.socket === "string") rmSync(metadata.socket, { force: true });
      } catch {}
    }
    await Promise.all(logs);
    rmSync(directory, { recursive: true, force: true });
  }
}, 45_000);
