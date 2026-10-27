import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLocalAuth } from "../server/localAuth";

async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out: ${label}`);
}

test("HTTP Pi run finishes while OB is down and projects the same reply after server restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ob-pi-http-"));
  const data = join(directory, "data");
  const fake = join(directory, "fake-pi");
  const release = join(directory, "release");
  const effects = join(directory, "effects");
  const session = join(directory, "session.jsonl");
  mkdirSync(data);
  writeFileSync(session, "");
  writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const out = value => process.stdout.write(JSON.stringify(value)+'\n');
for await (const line of console) {
  const r = JSON.parse(line);
  const reply = (data={}) => out({ type:'response', id:r.id, success:true, data });
  if (r.type === 'get_state') reply({ sessionFile:process.env.FAKE_SESSION, model:{provider:'test',id:'fake'} });
  else if (r.type === 'get_fork_messages') reply({messages:[]});
  else if (r.type === 'get_available_thinking_levels') reply({levels:['off']});
  else if (r.type === 'get_session_stats') reply({});
  else if (r.type === 'prompt') {
    appendFileSync(process.env.FAKE_EFFECTS, r.message+'\n');
    reply(); out({type:'agent_start'}); out({type:'message_start',message:{role:'user'}});
    out({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Started-'}});
    const timer = setInterval(() => {
      if (!existsSync(process.env.FAKE_RELEASE)) return;
      clearInterval(timer);
      out({type:'tool_execution_start',toolCallId:'tool-1',toolName:'read',args:{path:'fixture.txt'}});
      out({type:'tool_execution_end',toolCallId:'tool-1',toolName:'read',result:{content:[{type:'text',text:'fixture contents'}]},isError:false});
      out({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'finished offline'}});
      out({type:'agent_settled'});
      writeFileSync(process.env.FAKE_EFFECTS+'.finished', 'done');
    }, 25);
  } else reply();
}
`);
  chmodSync(fake, 0o700);
  await createLocalAuth({ directory: data }).setPassword("http restart fixture password");
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, NODE_ENV: "production", PORT: String(port), HOST: "127.0.0.1",
    OPENCHAT_DATA_DIR: data, PI_CODING_AGENT_DIR: join(directory, "agent"), PI_BIN: fake,
    FAKE_SESSION: session, FAKE_RELEASE: release, FAKE_EFFECTS: effects,
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
    const login = await request("/api/auth/login", { password: "http restart fixture password" });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const { workspace } = await json("/api/workspaces", { mode: "scratch" });
    const { serverId } = await json("/api/config");
    const runId = "reply-http-restart-0123456789abcdef";
    const chat = {
      id: "thread-http-restart", title: "HTTP restart fixture", runtime: "pi", createdAt: Date.now(), updatedAt: Date.now(), workspace,
      messages: [
        { id: "user-original", role: "user", content: "work once", createdAt: Date.now() },
        { id: "assistant-original", role: "assistant", content: "", createdAt: Date.now(), startedAt: Date.now(), status: "streaming", model: { plan: "pi", id: "test/fake" }, stream: { id: runId, via: serverId } },
      ],
    };
    const saved = await json(`/api/chats/${chat.id}`, chat, "PUT");
    expect(saved.chat.messages[1].stream.id).toBe(runId);
    const pending = await request("/api/pi/chat", { threadId: chat.id, cwd: workspace.cwd, model: "test/fake", effort: "off", prior: 0, message: "work once", stream: { id: runId } });
    expect(pending.status).toBe(200);
    expect(pending.headers.get("x-openchat-run")).toBe("1");
    const reader = pending.body!.getReader();
    let received = "";
    while (!received.includes("Started-")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Run ended before the first event");
      received += new TextDecoder().decode(chunk.value);
    }
    const piMetadata = join(data, "pi-worker", "worker.json");
    const piWorker = JSON.parse(readFileSync(piMetadata, "utf8"));
    server.kill("SIGTERM"); await server.exited;
    void reader.cancel().catch(() => {});
    // The only model fixture completion signal is deliberately sent AFTER the HTTP server dies.
    process.kill(piWorker.pid, 0);
    writeFileSync(release, "finish while OB is down");
    await until(async () => {
      const response = await fetch("http://pi/runs?id=" + runId, { unix: piWorker.socket } as RequestInit);
      return response.ok && (await response.json() as { status: string }).status !== "pending";
    }, "detached worker offline completion");
    expect(existsSync(effects + ".finished")).toBe(true);
    server = await launch();
    const index = await json("/api/chats?index");
    expect(index.index.find((entry: { id: string }) => entry.id === chat.id).v).not.toBe(saved.v);
    const fetched = await json("/api/chats/fetch", { ids: [chat.id] });
    const completed = fetched.chats[0].chat;
    const reply = completed.messages.find((message: { id: string }) => message.id === "assistant-original");
    expect(completed.messages).toHaveLength(2);
    expect(reply.stream).toEqual(chat.messages[1]!.stream);
    expect(reply.content).toBe("Started-finished offline");
    expect(reply.status).toBe("done");
    expect(reply.parts.some((part: { type: string; id: string; status: string }) => part.type === "tool" && part.id === "tool-1" && part.status === "done")).toBe(true);
    expect(completed.unread).toBe(true);
    const replay = await request(`/api/chat/runs/${runId}`);
    expect(replay.status).toBe(200);
    const events = (await replay.text()).trim().split("\n").map(line => JSON.parse(line));
    expect(events.filter(event => event.t === "text").map(event => event.v).join("")).toBe(reply.content);
    expect(events.at(-1).t).toBe("end");
    // A stale browser returning with its partial snapshot must not roll completed output back.
    const stale = { ...chat, messages: chat.messages.map(message => message.role === "assistant" ? { ...message, content: "Started-" } : message) };
    const protectedWrite = await json(`/api/chats/${chat.id}`, stale, "PUT");
    expect(protectedWrite.chat.messages[1].content).toBe(reply.content);
    expect(protectedWrite.chat.messages[1].status).toBe("done");
    expect(protectedWrite.chat.messages[1].parts).toEqual(reply.parts);
    // Duplicate admission after a server restart replays the same run rather than doing work twice.
    const duplicate = await request("/api/pi/chat", { threadId: chat.id, cwd: workspace.cwd, model: "test/fake", effort: "off", prior: 0, message: "work once", stream: { id: runId } });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.text()).toContain("finished offline");
    expect(readFileSync(effects, "utf8")).toBe("work once\n");
  } finally {
    for (const child of servers) {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
    // Both workers are detached from OB. Only signal fixture-owned metadata and a verified group
    // leader, never a generic pkill which could touch a developer's running Pi/server.
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
