import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PiClient } from "../server/pi/remote";
import { workerSocket } from "../server/pi/worker";
import type { PiChatRequest } from "../shared/types";

const workers: ReturnType<typeof Bun.spawn>[] = [];
const clients: PiClient[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const child of workers.splice(0)) { child.kill("SIGKILL"); await child.exited; }
  for (const dir of dirs.splice(0)) { rmSync(workerSocket(dir), { force: true }); rmSync(dir, { force: true, recursive: true }); }
});
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await check()) return; await Bun.sleep(25); }
  throw new Error("Timed out");
}
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "ob-pi-worker-")); dirs.push(directory);
  const fake = join(directory, "fake-pi");
  writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import { appendFileSync } from 'node:fs';
const out = (x) => process.stdout.write(JSON.stringify(x)+'\n');
let timer;
let busy = process.argv.includes("thread_orphan");
const settled = () => { busy = false; out({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'finished'}}); out({type:'agent_settled'}); };
for await (const line of console) {
 const r=JSON.parse(line);
 const reply=(data={})=>out({type:'response',id:r.id,success:true,data});
 if(r.type==='get_state') reply({isStreaming:busy,sessionFile:process.env.FAKE_SESSION,model:{provider:'test',id:'fake'}});
 else if(r.type==='get_fork_messages') reply({messages:[]});
 else if(r.type==='get_available_thinking_levels') reply({levels:['off']});
 else if(r.type==='get_session_stats') reply({});
 else if(r.type==='prompt') {
   busy = true;
   appendFileSync(process.env.FAKE_EFFECTS, r.message+'\n');
   reply(); out({type:'agent_start'}); out({type:'message_start',message:{role:'user'}});
   out({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'started-'}});
   if(r.message==='continue') timer=setTimeout(() => {
     out({type:'agent_settled'});
     out({type:'agent_start'});
     out({type:'extension_ui_request',method:'input',id:'continued-question',title:'Continue?'});
   }, 50);
   else if(r.message==='ask') out({type:'extension_ui_request',method:'input',id:'question',title:'Question'});
   else if(r.message!=='hang') timer=setTimeout(settled,700);
   else { appendFileSync(process.env.FAKE_EFFECTS+'.pids',String(process.pid)+'\n'); timer=setInterval(()=>{},1000); }
 } else if(r.type==='bash') {
   out({type:'bash_execution_update',id:r.id,delta:'shell-output'});
   setTimeout(()=>reply({output:'shell-output',exitCode:0,cancelled:false,truncated:false}),200);
 } else if(r.type==='extension_ui_response') { settled(); }
 else if(r.type==='abort') { appendFileSync(process.env.FAKE_EFFECTS+'.aborts','abort\n'); busy = false; clearTimeout(timer); reply(); out({type:'agent_settled'}); }
 else reply();
}
`);
  chmodSync(fake, 0o700);
  const socket = workerSocket(directory);
  const env = { ...process.env, PI_BIN: fake, OPENCHAT_DATA_DIR: join(directory, "data"), OPENBUILD_PI_WORKER_DIR: directory, OPENBUILD_PI_WORKER_SOCKET: socket, FAKE_SESSION: join(directory, "session.jsonl"), FAKE_EFFECTS: join(directory, "effects") };
  writeFileSync(env.FAKE_SESSION, "");
  const launch = async () => {
    const child = Bun.spawn([process.execPath, resolve("server/pi/worker.ts")], { env, detached: true, stdout: "pipe", stderr: "pipe" }); workers.push(child);
    await until(async () => { try { return (await fetch("http://pi/health", { unix: socket } as RequestInit)).ok; } catch { return false; } });
    return child;
  };
  const client = () => { const c = new PiClient(directory, socket); clients.push(c); return c; };
  const req = (id: string, message = "normal"): PiChatRequest => ({ threadId: `thread_${id}`, cwd: directory, model: "test/fake", effort: "off", prior: 0, message, stream: { id } });
  return { directory, socket, env, launch, client, req };
}

test("real RPC subprocess keeps running after client process death, replays finished output after worker restart", async () => {
  const f = setup();
  let worker = await f.launch();
  expect(statSync(f.socket).mode & 0o777).toBe(0o600);
  expect(statSync(f.directory).mode & 0o777).toBe(0o700);
  const script = join(f.directory, "client.ts");
  writeFileSync(script, `import {PiClient} from ${JSON.stringify(resolve("server/pi/remote.ts"))};
const c=new PiClient(${JSON.stringify(f.directory)},${JSON.stringify(f.socket)});
const r=await c.startRun(${JSON.stringify(f.req("survives"))});
while (!r.events.length) await Bun.sleep(10);
console.log('ready'); await Bun.sleep(60000);`);
  const first = Bun.spawn([process.execPath, script], { env: f.env, stdout: "pipe", stderr: "pipe" });
  const reader = first.stdout.getReader();
  await reader.read(); first.kill("SIGKILL"); await first.exited;
  await Bun.sleep(1000);
  const c = f.client();
  const replay = await c.findRun("survives");
  await until(() => !!replay?.ended);
  expect(replay!.events.filter((e) => e.t === "text").map((e) => e.v).join("")).toBe("started-finished");
  worker.kill("SIGKILL"); await worker.exited;
  worker = await f.launch();
  const second = await f.client().findRun("survives");
  await until(() => !!second?.ended);
  expect(second!.events).toEqual(replay!.events);
  expect(readFileSync(f.env.FAKE_EFFECTS, "utf8").trim()).toBe("normal");
  const health = await fetch("http://pi/health", { unix: f.socket } as RequestInit).then((r) => r.json()) as { pid: number };
  const rivals = [1,2,3].map(() => Bun.spawn([process.execPath, resolve("server/pi/worker.ts")], { env: f.env, stdout: "ignore", stderr: "ignore" }));
  for (const rival of rivals) expect(await rival.exited).not.toBe(0);
  expect((await fetch("http://pi/health", { unix: f.socket } as RequestInit).then((r) => r.json()) as {pid:number}).pid).toBe(health.pid);
}, 20000);

test("crash records are interrupted and never automatically rerun; asks and explicit cancellation survive reconnect", async () => {
  const f = setup(); let worker = await f.launch();
  const c = f.client();
  const pending = await c.startRun(f.req("crashed", "hang"));
  await expect(c.startRun({ ...f.req("busy", "hang"), threadId: "thread_crashed" })).rejects.toMatchObject({ status: 409, code: "busy" });
  await until(() => pending.events.length > 0);
  await c.close(); worker.kill("SIGKILL"); await worker.exited;
  worker = await f.launch();
  const orphan = Number(readFileSync(f.env.FAKE_EFFECTS + ".pids", "utf8").trim().split("\n")[0]);
  await until(() => { try { process.kill(orphan, 0); return process.platform === "linux" && /State:\s+Z/.test(readFileSync(`/proc/${orphan}/status`, "utf8")); } catch { return true; } });
  const next = f.client(); const crashed = await next.findRun("crashed");
  await until(() => !!crashed?.ended);
  expect(crashed!.events.some((e) => e.t === "error" && e.message.includes("not rerun"))).toBe(true);
  expect((await next.listRuns()).find((r) => r.id === "crashed")?.status).toBe("interrupted");
  const again = await next.startRun(f.req("crashed", "hang")); expect(again).toBe(crashed!);
  expect(readFileSync(f.env.FAKE_EFFECTS, "utf8").trim()).toBe("hang");
  const ask = await next.startRun(f.req("question", "ask"));
  await until(() => ask.events.some((e) => e.t === "ask"));
  await next.close();
  const third = f.client(); const question = await third.findRun("question");
  await until(() => !!question?.events.some((e) => e.t === "ask"));
  expect(await third.answer("thread_question", "question", { value: "yes" })).toBe(true);
  await until(() => !!question?.ended);
  expect(question!.events.some((e) => e.t === "asked" && e.answer === "yes")).toBe(true);
  const stopped = await third.startRun(f.req("stopped", "hang"));
  await until(() => stopped.events.length > 0);
  await third.stopRun("stopped"); await until(() => stopped.ended);
  expect(stopped.events.some((e) => e.t === "done" && e.finish === "aborted")).toBe(true);
  await third.recover(); expect(third.ownsSession("thread_crashed")).toBe(true);
  const cancelledAsk = await third.startRun(f.req("cancelask", "ask"));
  await until(() => cancelledAsk.events.some((e) => e.t === "ask"));
  await third.stopRun("cancelask"); await until(() => cancelledAsk.ended);
  const afterAsk = await third.startRun({ ...f.req("afterask"), threadId: "thread_cancelask" });
  await until(() => afterAsk.ended);
  expect(afterAsk.events.some((e) => e.t === "ask")).toBe(false);
  const shell = await third.startShell({ id: "shell", threadId: "thread_shell", cwd: f.directory, command: "echo hello", hidden: false });
  await until(() => shell.ended);
  const snapshots = await third.snapshots();
  expect(snapshots.find((s) => s.id === "shell")?.kind).toBe("shell");
  expect(snapshots.find((s) => s.id === "shell")?.events.some((e) => e.t === "exit")).toBe(true);
  expect("request" in snapshots[0]!).toBe(false);
  expect(await third.snapshots()).toEqual(snapshots);
  const shellReplay = await f.client().findShell("shell");
  await until(() => !!shellReplay?.ended);
  expect(shellReplay!.events).toEqual(shell.events);
  await third.deleteThread("thread_deleted");
  await expect(third.startRun({ ...f.req("deleted"), threadId: "thread_deleted" })).rejects.toMatchObject({ status: 410 });
}, 20000);


test("extension continuation after agent_settled keeps the reply and question attached", async () => {
  const f = setup();
  await f.launch();
  const c = f.client();
  const run = await c.startRun(f.req("continuation", "continue"));
  await until(() => run.events.some((e) => e.t === "ask"));
  await Bun.sleep(100);
  expect(run.ended).toBe(false);
  expect(await c.answer("thread_continuation", "continued-question", { value: "yes" })).toBe(true);
  await until(() => run.ended);
  expect(run.events.some((e) => e.t === "text" && e.v === "finished")).toBe(true);
  expect(run.events.some((e) => e.t === "error")).toBe(false);
  const next = await c.startRun({ ...f.req("after-continuation"), threadId: "thread_continuation" });
  await until(() => next.ended);
  expect(next.events.some((e) => e.t === "error")).toBe(false);
});


test("a new message stops an unowned busy Pi run before submitting its prompt", async () => {
  const f = setup();
  await f.launch();
  const run = await f.client().startRun(f.req("orphan"));
  await until(() => run.ended);
  expect(readFileSync(f.env.FAKE_EFFECTS + ".aborts", "utf8")).toBe("abort\n");
  expect(readFileSync(f.env.FAKE_EFFECTS, "utf8")).toBe("normal\n");
  expect(run.events.some((e) => e.t === "done")).toBe(true);
  expect(run.events.some((e) => e.t === "error")).toBe(false);
});
