import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLocalAuth } from "../server/localAuth";
import { FAKE_OPENCODE } from "./opencodeFixture";

async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out: ${label}`);
}

test("OpenCode turn survives HTTP SIGTERM, replays once, and reuses its saved native session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ob-opencode-http-"));
  const data = join(directory, "data");
  const fake = join(directory, "fake-opencode");
  const release = join(directory, "release");
  const effects = join(directory, "effects");
  const toolEffects = join(directory, "tool-effects");
  const protocol = join(directory, "protocol");
  mkdirSync(data);
  writeFileSync(fake, `#!${process.execPath}\n` + FAKE_OPENCODE);
  chmodSync(fake, 0o700);
  await createLocalAuth({ directory: data }).setPassword("opencode restart fixture password");
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, NODE_ENV: "production", PORT: String(port), HOST: "127.0.0.1",
    OPENCHAT_DATA_DIR: data, PI_CODING_AGENT_DIR: join(directory, "agent"), OPENCODE_BIN: fake,
    // Explicitly ignore any developer-owned external OpenCode service.
    OPENCODE_SERVER_URL: "", OPENCODE_SERVER_PASSWORD: "",
    FAKE_RELEASE: release, FAKE_EFFECTS: effects, FAKE_TOOL_EFFECTS: toolEffects,
    FAKE_PROTOCOL: protocol, FAKE_HISTORY: join(directory, "history.json"),
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
    const childLogs = [new Response(child.stdout).text(), new Response(child.stderr).text()];
    logs.push(...childLogs);
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`Server exited: ${(await Promise.all(childLogs)).join("\n")}`);
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
    const login = await request("/api/auth/login", { password: "opencode restart fixture password" });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const models = await json("/api/opencode/models");
    expect(models.models.map((m: { id: string }) => m.id)).toEqual(["opencode/test/fake-1"]);
    const { workspace } = await json("/api/workspaces", { mode: "scratch" });
    const { serverId } = await json("/api/config");
    const runId = "reply-opencode-restart-0123456789abcdef";
    const chat = {
      id: "thread-opencode-restart", title: "OpenCode restart fixture", runtime: "opencode", createdAt: Date.now(), updatedAt: Date.now(), workspace,
      messages: [
        { id: "user-original", role: "user", content: "work once", createdAt: Date.now() },
        { id: "assistant-original", role: "assistant", content: "", createdAt: Date.now(), startedAt: Date.now(), status: "streaming", model: { plan: "opencode", id: "opencode/test/fake-1" }, stream: { id: runId, via: serverId } },
      ],
    };
    const saved = await json(`/api/chats/${chat.id}`, chat, "PUT");
    const turnRequest = { threadId: chat.id, runtime: "opencode", cwd: workspace.cwd, model: "opencode/test/fake-1", effort: "off", prior: 0, message: "work once", stream: { id: runId } };
    const pending = await request("/api/pi/chat", turnRequest);
    if (!pending.ok) throw new Error(`OpenCode admission: HTTP ${pending.status} ${await pending.text()}`);
    expect(pending.status).toBe(200);
    expect(pending.headers.get("x-openchat-run")).toBe("1");
    const reader = pending.body!.getReader();
    let received = "";
    while (!received.includes("Started-")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Run ended before the first event: ${received}`);
      received += new TextDecoder().decode(chunk.value);
    }
    expect(existsSync(toolEffects)).toBe(false);
    const worker = JSON.parse(readFileSync(join(data, "opencode-worker", "worker.json"), "utf8"));
    server.kill("SIGTERM"); await server.exited;
    void reader.cancel().catch(() => {});
    // ESRCH would prove HTTP shutdown killed the detached owner.
    process.kill(worker.pid, 0);
    writeFileSync(release, "finish while OB is down");
    await until(async () => {
      const response = await fetch("http://pi/runs?id=" + runId, { unix: worker.socket } as RequestInit);
      return response.ok && (await response.json() as { status: string }).status !== "pending";
    }, "detached worker offline completion");
    expect(existsSync(effects + ".finished")).toBe(true);
    expect(readFileSync(toolEffects, "utf8")).toBe("once\n");

    server = await launch();
    const index = await json("/api/chats?index");
    expect(index.index.find((entry: { id: string }) => entry.id === chat.id).v).not.toBe(saved.v);
    const completed = (await json("/api/chats/fetch", { ids: [chat.id] })).chats[0].chat;
    expect(completed.messages).toHaveLength(2);
    const reply = completed.messages.find((message: { id: string }) => message.id === "assistant-original");
    expect(reply.stream).toEqual(chat.messages[1]!.stream);
    expect(reply.content).toBe("Started-\n\nfinished offline");
    expect(reply.status).toBe("done");
    expect(reply.parts.find((part: { type: string }) => part.type === "tool")).toMatchObject({ id: "tool-1", name: "bash", status: "done", output: "hi\n" });
    const replay = await request(`/api/chat/runs/${runId}`);
    expect(replay.status).toBe(200);
    const events = (await replay.text()).trim().split("\n").map(line => JSON.parse(line));
    expect(events.at(-1).t).toBe("end");
    expect(events.filter(event => event.t === "text").map(event => event.v).join("")).toBe(reply.content);
    expect(events.filter(event => event.t === "tool" && event.id === "tool-1" && event.status === "done")).toHaveLength(1);
    const protectedWrite = await json(`/api/chats/${chat.id}`, chat, "PUT");
    expect(protectedWrite.chat.messages[1].content).toBe(reply.content);
    expect(protectedWrite.chat.messages[1].status).toBe("done");
    // Admission with the original id replays rather than prompting or executing again.
    const duplicate = await request("/api/pi/chat", turnRequest);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.text()).toContain("finished offline");
    expect(readFileSync(effects, "utf8")).toBe("work once\n");
    expect(readFileSync(toolEffects, "utf8")).toBe("once\n");
    const switched = await request("/api/pi/chat", { ...turnRequest, runtime: "pi", model: "test/x", prior: 1, message: "again", stream: { id: "reply-opencode-switch-0123456789abcdef" } });
    expect(switched.status).toBe(400);
    const followup = await request("/api/pi/chat", { ...turnRequest, prior: 1, message: "follow up", stream: { id: "reply-opencode-followup-0123456789abcdef" } });
    expect(followup.status).toBe(200);
    const readAsk = async (response: Response) => {
      const reader = response.body!.getReader();
      let buffer = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Run ended before permission ask: ${buffer}`);
        buffer += new TextDecoder().decode(chunk.value);
        const lines = buffer.split("\n");
        for (const line of lines.slice(0, -1)) {
          const event = JSON.parse(line);
          if (event.t === "ask") {
            void reader.cancel().catch(() => {});
            return event;
          }
        }
        buffer = lines.at(-1)!;
      }
    };
    const ask = await readAsk(followup);
    expect(ask.options).toEqual(["Allow once", "Deny"]);
    server.kill("SIGTERM"); await server.exited;
    process.kill(worker.pid, 0);
    // Permission cannot execute while disconnected, even though the worker is alive.
    expect(readFileSync(toolEffects, "utf8")).toBe("once\n");
    server = await launch();
    const askReplay = await request("/api/chat/runs/reply-opencode-followup-0123456789abcdef");
    expect(askReplay.status).toBe(200);
    expect(await readAsk(askReplay)).toEqual(ask);
    const answered = await request(`/api/pi/threads/${chat.id}/answer`, { askId: ask.id, value: "Allow once" });
    expect(answered.status).toBe(200);
    const finished = await request("/api/chat/runs/reply-opencode-followup-0123456789abcdef");
    const finishedEvents = (await finished.text()).trim().split("\n").map(line => JSON.parse(line));
    expect(finishedEvents.some(event => event.t === "asked" && event.id === ask.id)).toBe(true);
    expect(finishedEvents.filter(event => event.t === "text").map(event => event.v).join("")).toBe("resumed saved session");
    expect(finishedEvents.filter(event => event.t === "tool" && event.id === "tool-approved" && event.status === "done")).toHaveLength(1);
    expect(finishedEvents.at(-1).t).toBe("end");
    expect(readFileSync(protocol, "utf8").split("\n").filter(line => line === "session/create")).toHaveLength(1);
    expect(readFileSync(protocol, "utf8")).toContain("session/get\n");
    expect(readFileSync(effects, "utf8")).toBe("work once\nfollow up\n");
    expect(readFileSync(toolEffects, "utf8")).toBe("once\napproved\n");
    expect(readFileSync(protocol, "utf8").split("\n").filter(line => line === "permission/once")).toHaveLength(1);
  } finally {
    for (const child of servers) {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
    // Kill only fixture-owned detached process groups, never a real OpenCode session.
    for (const kind of ["pi-worker", "opencode-worker", "durable"]) {
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
}, 60_000);
