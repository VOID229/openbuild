import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLocalAuth } from "../server/localAuth";
import { FAKE_CURSOR } from "./cursorFixture";
import { HTML_DELIVERY_NOTE } from "../server/htmlDelivery";
/** Each native turn receives the display note once, ahead of the user's prompt. */
const prompts = (...messages: string[]) => messages.map(m => HTML_DELIVERY_NOTE + m + "\n").join("");
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(25); }
  throw new Error(`Timed out: ${label}`);
}
// Same real HTTP shutdown/reconnect path as codexServerRestart.test.ts. The fake
// CLI gates a real shell effect until the HTTP server is gone. All dirs and pids
// are fixture-owned; this never calls or stops a developer's Cursor/OB process.
test("Cursor survives HTTP shutdown, replays once and resumes saved native history after worker replacement", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ob-cursor-http-"));
  const data = join(directory, "data"), fake = join(directory, "cursor");
  const effects = join(directory, "effects"), toolEffects = join(directory, "tool-effects"), release = join(directory, "release"), protocol = join(directory, "protocol");
  mkdirSync(data); writeFileSync(fake, `#!${process.execPath}\n` + FAKE_CURSOR); chmodSync(fake, 0o700);
  await createLocalAuth({ directory: data }).setPassword("cursor fixture password");
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!; probe.stop(true);
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, NODE_ENV: "production", PORT: String(port), HOST: "127.0.0.1", OPENCHAT_DATA_DIR: data, PI_CODING_AGENT_DIR: join(directory, "pi"), CURSOR_BIN: fake, CURSOR_CONFIG_DIR: join(directory, "cursor-config"), FAKE_RELEASE: release, FAKE_EFFECTS: effects, FAKE_TOOL_EFFECTS: toolEffects, FAKE_PROTOCOL: protocol };
  const servers: ReturnType<typeof Bun.spawn>[] = [], logs: Promise<string>[] = [];
  const workers: { pid: number; socket: string }[] = [];
  let cookie = "";
  const request = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => fetch(base + path, { method, headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  const json = async (path: string, body?: unknown, method?: string) => {
    const res = await request(path, body, method), text = await res.text();
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${text}`);
    return JSON.parse(text);
  };
  const launch = async () => {
    const child = Bun.spawn([process.execPath, resolve("server/index.ts")], { env, stdout: "pipe", stderr: "pipe" });
    servers.push(child); logs.push(new Response(child.stdout).text(), new Response(child.stderr).text());
    await until(async () => { if (child.exitCode !== null) throw new Error(`Server exited: ${(await Promise.all(logs)).join("\n")}`); try { return (await request("/api/auth/status")).ok; } catch { return false; } }, "HTTP server startup");
    return child;
  };
  const workerMetadata = () => { const worker = JSON.parse(readFileSync(join(data, "pi-worker", "worker.json"), "utf8")); workers.push(worker); return worker; };
  const killWorker = (worker: { pid: number; socket: string }) => {
    const group = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(worker.pid)]);
    try { process.kill(Number(group.stdout.toString().trim()) === worker.pid ? -worker.pid : worker.pid, "SIGKILL"); } catch {}
    rmSync(worker.socket, { force: true });
  };
  try {
    let server = await launch();
    const login = await request("/api/auth/login", { password: "cursor fixture password" });
    expect(login.status).toBe(200); cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const models = await json("/api/cursor/models");
    expect(models.models.find((m: any) => m.id === "cursor/fake").reasoning.efforts).toEqual(["low", "high"]);
    const { workspace } = await json("/api/workspaces", { mode: "scratch" });
    const { serverId } = await json("/api/config");
    const runId = "reply-cursor-restart-0123456789abcdef";
    const chat = { id: "thread-cursor-restart", title: "Cursor restart fixture", runtime: "cursor", createdAt: Date.now(), updatedAt: Date.now(), workspace, messages: [
      { id: "user-original", role: "user", content: "work once", createdAt: Date.now() },
      { id: "assistant-original", role: "assistant", content: "", createdAt: Date.now(), startedAt: Date.now(), status: "streaming", model: { plan: "cursor", id: "cursor/fake" }, stream: { id: runId, via: serverId } },
    ] };
    const saved = await json(`/api/chats/${chat.id}`, chat, "PUT");
    const turn = { threadId: chat.id, runtime: "cursor", cwd: workspace.cwd, model: "cursor/fake", effort: "high", prior: 0, message: "work once", stream: { id: runId } };
    const pending = await request("/api/pi/chat", turn);
    expect(pending.status).toBe(200); expect(pending.headers.get("x-openchat-run")).toBe("1");
    const reader = pending.body!.getReader(); let received = "";
    while (!received.includes("Started-")) { const chunk = await reader.read(); if (chunk.done) throw new Error(`Early end: ${received}`); received += new TextDecoder().decode(chunk.value); }
    expect(existsSync(toolEffects)).toBe(false);
    const worker = workerMetadata();
    server.kill("SIGTERM"); await server.exited; void reader.cancel().catch(() => {});
    process.kill(worker.pid, 0);
    writeFileSync(release, "finish offline");
    await until(async () => { const response = await fetch("http://pi/runs?id=" + runId, { unix: worker.socket } as RequestInit); return response.ok && (await response.json() as any).status !== "pending"; }, "offline worker completion");
    expect(readFileSync(toolEffects, "utf8")).toBe("once\n");
    server = await launch();
    const index = await json("/api/chats?index");
    expect(index.index.find((e: any) => e.id === chat.id).v).not.toBe(saved.v);
    const completed = (await json("/api/chats/fetch", { ids: [chat.id] })).chats[0].chat;
    expect(completed.messages).toHaveLength(2);
    const reply = completed.messages[1];
    expect(reply.content).toBe("Started-\n\nfinished offline"); expect(reply.status).toBe("done");
    expect(reply.parts.find((part: any) => part.type === "tool")).toMatchObject({ id: "tool-1", name: "bash", status: "done", output: "hi\n" });
    const replay = await request(`/api/chat/runs/${runId}`);
    const events = (await replay.text()).trim().split("\n").map(s => JSON.parse(s));
    expect(events.at(-1).t).toBe("end");
    expect(events.filter(e => e.t === "text").map(e => e.v).join("")).toBe(reply.content);
    expect(events.filter(e => e.t === "tool" && e.status === "done")).toHaveLength(1);
    const protectedWrite = await json(`/api/chats/${chat.id}`, chat, "PUT");
    expect(protectedWrite.chat.messages[1].content).toBe(reply.content);
    expect(await (await request("/api/pi/chat", turn)).text()).toContain("finished offline");
    expect(readFileSync(effects, "utf8")).toBe(prompts("work once"));
    expect(readFileSync(toolEffects, "utf8")).toBe("once\n");
    expect((await request("/api/pi/chat", { ...turn, runtime: "pi", model: "test/x", prior: 1, stream: { id: "reply-cursor-switch-0123456789abcdef" } })).status).toBe(400);
    // Completed run replay survives loss of the detached worker too; a fresh
    // worker must load the persistent mapping rather than starting another chat.
    server.kill("SIGTERM"); await server.exited; killWorker(worker);
    server = await launch();
    const followup = await request("/api/pi/chat", { ...turn, prior: 1, message: "follow up", stream: { id: "reply-cursor-followup-0123456789abcdef" } });
    expect(followup.status).toBe(200); expect(await followup.text()).toContain("resumed saved thread");
    workerMetadata();
    const calls = readFileSync(protocol, "utf8").trim().split("\n").map(s => JSON.parse(s));
    expect(calls).toHaveLength(2); expect(calls[0].id).toBe(calls[1].id); expect(calls[1].previous).toBe("work once\n");
    expect(readFileSync(effects, "utf8")).toBe(prompts("work once", "follow up"));
    expect(readFileSync(toolEffects, "utf8")).toBe("once\nonce\n");
  } finally {
    for (const child of servers) { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
    for (const kind of ["pi-worker", "durable"]) try { const worker = JSON.parse(readFileSync(join(data, kind, "worker.json"), "utf8")); if (Number.isSafeInteger(worker.pid) && worker.pid > 1 && worker.pid !== process.pid) killWorker(worker); } catch {}
    await Promise.all(logs); rmSync(directory, { recursive: true, force: true });
  }
}, 60000);
