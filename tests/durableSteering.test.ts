import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DurableRuntime } from "../server/durable/runtime";
import { fakeModels } from "./durable-fake";
const req = (model: string) => ({threadId:"steering-thread",cwd:tmpdir(),model,effort:"off" as const,message:"initial",prior:0,stream:{id:"steering-run"}});
async function until(fn: () => boolean) { for(let i=0;i<1500;i++) {if(fn()) return; await Bun.sleep(10);} throw Error("timed out"); }
test("Durable places multiple steers once, includes images, waits for answers and resumes", async () => {
 const directory=mkdtempSync(join(tmpdir(),"durable-steer-"));
 const fake=fakeModels({delayMs:80}); let runtime=new DurableRuntime(directory,fake.models);
 const request=req(fake.model);
 try {
  const run=await runtime.startRun(request);
  const images=[{data:"aGk=",mimeType:"image/png"}];
  await runtime.steer(request.threadId,"s1","new direction",images);
  await runtime.steer(request.threadId,"s2","also this");
  await runtime.steer(request.threadId,"s1","new direction",images);
  await expect(runtime.steer(request.threadId,"s1","changed")).rejects.toThrow("different input");
  await until(()=>run.ended);
  expect(run.events.filter(e=>e.t==="steer")).toEqual([{t:"steer",id:"s1",text:"new direction"},{t:"steer",id:"s2",text:"also this"}]);
  const input=JSON.stringify(fake.inputs().at(-1));
  expect(input).toContain("new direction"); expect(input).toContain("aGk="); expect(input).toContain("also this");
  await expect(runtime.steer(request.threadId,"late","late")).rejects.toThrow("isn't working");
  await runtime.close(); runtime=new DurableRuntime(directory,fake.models);
  const replay=await runtime.findRun(run.id); expect(replay?.events).toEqual(run.events);
  await expect(runtime.startRun({...request,prior:1,stream:{id:"rewind"}})).rejects.toThrow("rewinds");
  const next=await runtime.startRun({...request,prior:3,message:"follow up",stream:{id:"next"}});
  await until(()=>next.ended); expect(next.events.some(e=>e.t==="error")).toBe(false);
 } finally {await runtime.close();rmSync(directory,{recursive:true,force:true});}
});
test("Durable recovers steer intent from either side of upstream submit without duplicates",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"durable-steer-recover-"));
 const held=fakeModels({hold:true}); const request=req(held.model);
 let runtime=new DurableRuntime(directory,held.models);
 try {
  await runtime.startRun(request);
  await runtime.steer(request.threadId,"committed","already submitted");
  await runtime.close();
  const path=join(directory,"runs",createHash("sha256").update(request.stream.id).digest("hex")+".json");
  const manifest=JSON.parse(readFileSync(path,"utf8"));
  manifest.steers.push({id:"intent",text:"not submitted yet"}); writeFileSync(path,JSON.stringify(manifest));
  const recovered=fakeModels(); runtime=new DurableRuntime(directory,recovered.models);
  await runtime.recover(); const run=(await runtime.findRun(request.stream.id))!;
  await until(()=>run.ended);
  expect(run.events.filter(e=>e.t==="steer")).toEqual([{t:"steer",id:"committed",text:"already submitted"},{t:"steer",id:"intent",text:"not submitted yet"}]);
  const messages=recovered.inputs().at(-1) as any[];
  expect(messages.filter(m=>m.role==="user"&&m.content==="already submitted")).toHaveLength(1);
  expect(messages.filter(m=>m.role==="user"&&m.content==="not submitted yet")).toHaveLength(1);
 }finally{await runtime.close();rmSync(directory,{recursive:true,force:true});}
});
test("Durable Stop withdraws unread steers and recovery never submits them again",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"durable-steer-stop-"));
 const held=fakeModels({hold:true}); let runtime=new DurableRuntime(directory,held.models);
 const request=req(held.model);
 try{
  const run=await runtime.startRun(request); await until(()=>held.calls()>0);
  await runtime.steer(request.threadId,"unread","never deliver");
  await runtime.stopRun(run.id); await until(()=>run.ended);
  expect(run.events.filter(e=>e.t==="steer")).toEqual([]);
  expect(run.events.find(e=>e.t==="done")).toMatchObject({finish:"aborted"});
  await runtime.close();const recovered=fakeModels();runtime=new DurableRuntime(directory,recovered.models);
  await runtime.recover(); expect(recovered.calls()).toBe(0);
  const next=await runtime.startRun({...request,prior:1,stream:{id:"after-stop"}});
  await runtime.steer(request.threadId,"unread","never deliver");
  await runtime.steer(request.threadId,"unread","never deliver");
  await until(()=>next.ended);
  expect(next.events.filter(e=>e.t==="steer")).toEqual([{t:"steer",id:"unread",text:"never deliver"}]);
  await runtime.stopThread(request.threadId);
  await expect(runtime.steer(request.threadId,"deleted","no")).rejects.toThrow("deleted");
 }finally{await runtime.close();rmSync(directory,{recursive:true,force:true});}
});

test("Durable delivers at the tool boundary without interrupting or repeating a running tool",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"durable-steer-tool-"));
 const marker=join(directory,"started"),release=join(directory,"release"),effects=join(directory,"effects");
 const fake=fakeModels({tool:true,command:`printf once >> '${effects}'; touch '${marker}'; while [ ! -f '${release}' ]; do sleep 0.02; done; printf finished`});
 const runtime=new DurableRuntime(directory,fake.models),request=req(fake.model);
 try{
  const run=await runtime.startRun(request);await until(()=>{try{return readFileSync(marker).length===0;}catch{return false;}});
  await runtime.steer(request.threadId,"tool-steer","use the tool output");
  expect(run.events.some(e=>e.t==="steer")).toBe(false);
  writeFileSync(release,"go");await until(()=>run.ended);
  expect(readFileSync(effects,"utf8")).toBe("once");
  const tool=run.events.findIndex(e=>e.t==="tool"&&e.status==="done");
  const steer=run.events.findIndex(e=>e.t==="steer");expect(steer).toBeGreaterThan(tool);
  expect(JSON.stringify(fake.inputs().at(-1))).toContain("use the tool output");
 }finally{writeFileSync(release,"go");await runtime.close();rmSync(directory,{recursive:true,force:true});}
});
