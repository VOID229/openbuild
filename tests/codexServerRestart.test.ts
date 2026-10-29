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

// Codex CLI 0.164.0 app-server v2 JSON-RPC shapes (generate-ts / generate-json-schema).
// No model/network/login dependency: the fixture gates a real shell side effect until the
// HTTP server is gone, and persists thread history across separate app-server processes.
const FAKE_CODEX = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const out = value => process.stdout.write(JSON.stringify(value)+'\n');
if (process.argv[2] === '--version') { console.log('codex-cli 0.164.0-fake'); process.exit(0); }
if (process.argv[2] !== 'app-server') throw new Error('Expected app-server');
const notify = (method, params) => out({jsonrpc:'2.0',method,params});
const threadId = '01900000-0000-7000-8000-000000000001';
const turn = (id, status, items=[]) => ({id,rootTurnId:null,items,itemsView:'full',status,error:null,startedAt:1,completedAt:status==='completed'?2:null,durationMs:status==='completed'?5:null});
const agent = (id,text) => ({type:'agentMessage',id,text,phase:null,memoryCitation:null,delivery:null,questions:null});
const load = () => existsSync(process.env.FAKE_HISTORY) ? JSON.parse(readFileSync(process.env.FAKE_HISTORY,'utf8')) : [];
const thread = cwd => ({id:threadId,sessionId:threadId,forkedFromId:null,parentThreadId:null,preview:'work once',ephemeral:false,section:null,sectionEnteredAt:null,projectId:null,historyMode:'legacy',modelProvider:'openai',model:'fake-1',reasoningEffort:'high',createdAt:1,updatedAt:2,recencyAt:null,status:{type:'idle'},path:process.env.FAKE_HISTORY,cwd,cliVersion:'0.164.0',originator:null,source:{custom:'app-server'},threadSource:null,agentNickname:null,agentRole:null,gitInfo:null,name:null,turns:load()});
for await (const line of console) {
  const m = JSON.parse(line);
  if (m.id === undefined) continue;
  const reply = result => out({jsonrpc:'2.0',id:m.id,result});
  if (m.method === 'initialize') reply({userAgent:'fake-codex',platformFamily:'unix',platformOs:'linux'});
  else if (m.method === 'model/list') reply({data:[{id:'fake-1',model:'fake-1',upgrade:null,upgradeInfo:null,availabilityNux:null,displayName:'Fake Codex',description:'Offline restart fixture',modelSpecialty:null,hidden:false,supportedReasoningEfforts:[{reasoningEffort:'high',description:'High'}],defaultReasoningEffort:'high',inputModalities:['text'],supportsPersonality:false,multiAgentVersion:null,additionalSpeedTiers:[],serviceTiers:[],defaultServiceTier:null,availableAccessPrograms:null,isDefault:true}],nextCursor:null});
  else if (m.method === 'thread/start' || m.method === 'thread/resume') {
    if (m.method === 'thread/resume' && m.params.threadId !== threadId) throw new Error('Wrong resumed thread');
    appendFileSync(process.env.FAKE_PROTOCOL,m.method+'\n');
    reply({thread:thread(m.params.cwd),model:'fake-1',modelProvider:'openai',serviceTier:null,disabledPluginIds:[],cwd:m.params.cwd,instructionSources:[],approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'dangerFullAccess'},reasoningEffort:'high'});
  } else if (m.method === 'turn/start') {
    if (m.params.threadId !== threadId) throw new Error('Wrong turn thread');
    const text = m.params.input.filter(x=>x.type==='text').map(x=>x.text).join('');
    appendFileSync(process.env.FAKE_EFFECTS,text+'\n');
    const history = load();
    const tid = 'turn-'+(history.length+1);
    const user = {type:'userMessage',id:'user-'+tid,clientId:null,content:m.params.input};
    reply({turn:turn(tid,'inProgress')});
    notify('turn/started',{threadId,turn:turn(tid,'inProgress')});
    const delta = (id,delta) => notify('item/agentMessage/delta',{threadId,turnId:tid,itemId:id,delta});
    if (history.length) {
      const message = agent('followup','resumed saved thread');
      delta(message.id,message.text);
      notify('item/completed',{threadId,turnId:tid,item:message});
      const done = turn(tid,'completed',[user,message]);
      writeFileSync(process.env.FAKE_HISTORY,JSON.stringify([...history,done]));
      notify('turn/completed',{threadId,turn:done});
      continue;
    }
    delta('a','Started-');
    const timer = setInterval(() => {
      if (!existsSync(process.env.FAKE_RELEASE)) return;
      clearInterval(timer);
      const command = "printf 'once\\n' >> \"$FAKE_TOOL_EFFECTS\"; printf 'hi\\n'";
      const tool = {type:'commandExecution',id:'tool-1',pluginId:null,scriptPath:null,command,cwd:process.cwd(),processId:null,source:'agent',status:'inProgress',commandActions:[],aggregatedOutput:null,exitCode:null,durationMs:null};
      notify('item/started',{threadId,turnId:tid,item:tool});
      const executed = Bun.spawnSync(['sh','-c',command]);
      const output = executed.stdout.toString();
      notify('item/commandExecution/outputDelta',{threadId,turnId:tid,itemId:tool.id,delta:output});
      Object.assign(tool,{status:'completed',aggregatedOutput:output,exitCode:executed.exitCode,durationMs:5});
      notify('item/completed',{threadId,turnId:tid,item:tool});
      delta('b','finished offline');
      const first = agent('a','Started-'), last = agent('b','finished offline');
      notify('item/completed',{threadId,turnId:tid,item:last});
      const done = turn(tid,'completed',[user,first,tool,last]);
      writeFileSync(process.env.FAKE_HISTORY,JSON.stringify([done]));
      notify('turn/completed',{threadId,turn:done});
      writeFileSync(process.env.FAKE_EFFECTS+'.finished','done');
      // End only the completed app-server, not the detached worker: the next turn must resume.
      setTimeout(() => { writeFileSync(process.env.FAKE_EFFECTS+'.exited','done'); process.exit(0); },50);
    },25);
  } else if (m.method === 'turn/interrupt') reply({});
  else out({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unexpected fixture method: '+m.method}});
}
`;

test("Codex turn survives HTTP SIGTERM, replays once, and resumes its saved thread", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ob-codex-http-"));
  const data = join(directory, "data");
  const fake = join(directory, "fake-codex");
  const release = join(directory, "release");
  const effects = join(directory, "effects");
  const toolEffects = join(directory, "tool-effects");
  const protocol = join(directory, "protocol");
  mkdirSync(data);
  writeFileSync(fake, `#!${process.execPath}\n` + FAKE_CODEX);
  chmodSync(fake, 0o700);
  await createLocalAuth({ directory: data }).setPassword("codex restart fixture password");
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, NODE_ENV: "production", PORT: String(port), HOST: "127.0.0.1",
    OPENCHAT_DATA_DIR: data, PI_CODING_AGENT_DIR: join(directory, "agent"), CODEX_BIN: fake,
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
    const login = await request("/api/auth/login", { password: "codex restart fixture password" });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const models = await json("/api/codex/models");
    expect(models.models.map((m: { id: string }) => m.id)).toEqual(["codex/fake-1"]);
    const { workspace } = await json("/api/workspaces", { mode: "scratch" });
    const { serverId } = await json("/api/config");
    const runId = "reply-codex-restart-0123456789abcdef";
    const chat = {
      id: "thread-codex-restart", title: "Codex restart fixture", runtime: "codex", createdAt: Date.now(), updatedAt: Date.now(), workspace,
      messages: [
        { id: "user-original", role: "user", content: "work once", createdAt: Date.now() },
        { id: "assistant-original", role: "assistant", content: "", createdAt: Date.now(), startedAt: Date.now(), status: "streaming", model: { plan: "codex", id: "codex/fake-1" }, stream: { id: runId, via: serverId } },
      ],
    };
    const saved = await json(`/api/chats/${chat.id}`, chat, "PUT");
    const turnRequest = { threadId: chat.id, runtime: "codex", cwd: workspace.cwd, model: "codex/fake-1", effort: "high", prior: 0, message: "work once", stream: { id: runId } };
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
    // Duplicate admission is replay, not another Codex prompt or shell execution.
    const duplicate = await request("/api/pi/chat", turnRequest);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.text()).toContain("finished offline");
    expect(readFileSync(effects, "utf8")).toBe("work once\n");
    expect(readFileSync(toolEffects, "utf8")).toBe("once\n");
    const switched = await request("/api/pi/chat", { ...turnRequest, runtime: "pi", model: "test/x", prior: 1, message: "again", stream: { id: "reply-codex-switch-0123456789abcdef" } });
    expect(switched.status).toBe(400);

    await until(() => existsSync(effects + ".exited"), "completed app-server exit before resume");
    const followup = await request("/api/pi/chat", { ...turnRequest, prior: 1, message: "follow up", stream: { id: "reply-codex-followup-0123456789abcdef" } });
    expect(followup.status).toBe(200);
    expect(await followup.text()).toContain("resumed saved thread");
    expect(readFileSync(protocol, "utf8")).toBe("thread/start\nthread/resume\n");
    expect(readFileSync(effects, "utf8")).toBe("work once\nfollow up\n");
    expect(readFileSync(toolEffects, "utf8")).toBe("once\n");
  } finally {
    for (const child of servers) {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
    // Only fixture-owned detached processes; never pkill a developer's Codex/worker.
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
