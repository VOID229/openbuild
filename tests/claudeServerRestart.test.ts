import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLocalAuth } from "../server/localAuth";
import { FAKE_CLAUDE } from "./claudeFixture";
import { HTML_DELIVERY_NOTE } from "../server/htmlDelivery";
/** Each native turn receives the display note once, ahead of the user's prompt. */
const prompts = (...messages: string[]) => messages.map(m => HTML_DELIVERY_NOTE + m + "\n").join("");

async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out: ${label}`);
}

test("Claude Code turn survives HTTP SIGTERM, replays once, and resumes its saved session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ob-claude-http-"));
  const data = join(directory, "data");
  const fake = join(directory, "fake-claude");
  const release = join(directory, "release");
  const effects = join(directory, "effects");
  const toolEffects = join(directory, "tool-effects");
  const protocol = join(directory, "protocol");
  mkdirSync(data);
  writeFileSync(fake, `#!${process.execPath}\n` + FAKE_CLAUDE);
  chmodSync(fake, 0o700);
  await createLocalAuth({ directory: data }).setPassword("claude restart fixture password");
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, NODE_ENV: "production", PORT: String(port), HOST: "127.0.0.1",
    OPENCHAT_DATA_DIR: data, PI_CODING_AGENT_DIR: join(directory, "agent"), CLAUDE_BIN: fake, CLAUDE_CONFIG_DIR: join(directory, "claude-config"),
    FAKE_RELEASE: release, FAKE_EFFECTS: effects, FAKE_TOOL_EFFECTS: toolEffects,
    FAKE_PROTOCOL: protocol,
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
    const login = await request("/api/auth/login", { password: "claude restart fixture password" });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const models = await json("/api/claude/models");
    expect(models.models.map((m: { id: string }) => m.id)).toEqual(["claude/default", "claude/opus", "claude/haiku"]);
    expect((await json("/api/claude/permissions")).modes.length).toBe(6);
    const { workspace } = await json("/api/workspaces", { mode: "scratch" });
    const { serverId } = await json("/api/config");
    const runId = "reply-claude-restart-0123456789abcdef";
    const chat = {
      id: "thread-claude-restart", title: "Claude restart fixture", runtime: "claude", createdAt: Date.now(), updatedAt: Date.now(), workspace,
      messages: [
        { id: "user-original", role: "user", content: "slow work once", createdAt: Date.now() },
        { id: "assistant-original", role: "assistant", content: "", createdAt: Date.now(), startedAt: Date.now(), status: "streaming", model: { plan: "claude", id: "claude/opus" }, stream: { id: runId, via: serverId } },
      ],
    };
    const saved = await json(`/api/chats/${chat.id}`, chat, "PUT");
    const turnRequest = { threadId: chat.id, runtime: "claude", cwd: workspace.cwd, model: "claude/opus", effort: "high", prior: 0, message: "slow work once", stream: { id: runId } };
    const pending = await request("/api/pi/chat", turnRequest);
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
    // A stale client cannot roll the projected completion back.
    const protectedWrite = await json(`/api/chats/${chat.id}`, chat, "PUT");
    expect(protectedWrite.chat.messages[1].content).toBe(reply.content);
    expect(protectedWrite.chat.messages[1].status).toBe("done");
    // Duplicate admission is replay, not another Claude prompt or shell execution.
    const duplicate = await request("/api/pi/chat", turnRequest);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.text()).toContain("finished offline");
    expect(readFileSync(effects, "utf8")).toBe(prompts("slow work once"));
    expect(readFileSync(toolEffects, "utf8")).toBe("once\n");
    const switched = await request("/api/pi/chat", { ...turnRequest, runtime: "pi", model: "test/x", prior: 1, message: "again", stream: { id: "reply-claude-switch-0123456789abcdef" } });
    expect(switched.status).toBe(400);

    // Restart the agent worker's Claude process (as after an idle reap): the next turn resumes from disk.
    await fetch("http://pi/release", { method: "POST", unix: worker.socket, body: JSON.stringify({ threadId: chat.id }) } as RequestInit);
    const followup = await request("/api/pi/chat", { ...turnRequest, prior: 1, message: "follow up", stream: { id: "reply-claude-followup-0123456789abcdef" } });
    expect(followup.status).toBe(200);
    expect(await followup.text()).toContain("reply 2 to follow up");
    // Control-only probes (model listing, status) start processes too, but never send a turn.
    const turns = readFileSync(protocol, "utf8").split("\n").filter((l) => l.startsWith("start ") || l.startsWith("turn "));
    expect(turns.flatMap((l, i) => l.startsWith("turn ") ? [turns[i - 1]!.split(" ")[1]] : [])).toEqual(["new", "resume"]);
    expect(readFileSync(effects, "utf8")).toBe(prompts("slow work once", "follow up"));
    expect(readFileSync(toolEffects, "utf8")).toBe("once\n");
  } finally {
    for (const child of servers) {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
    // Only fixture-owned detached processes; never pkill a developer's Claude/worker.
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
}, 60_000);
