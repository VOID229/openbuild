import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn, steer, canSteer, release } from "../server/fx/sessions";
import { getValue } from "../server/storage";
import { PiWorkerRuntime } from "../server/pi/workerRuntime";
import { withProfileContext } from "../src/lib/profile";
const fixture = String.raw`
const out=m=>process.stdout.write(JSON.stringify(m)+'\n');
if(process.argv.includes('status')){out({permission_mode:'auto'});process.exit(0);}
const update=u=>out({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fx-native',update:u}});
let active,steers=[],timer;
for await(const line of console){
 const m=JSON.parse(line),reply=result=>out({jsonrpc:'2.0',id:m.id,result});
 if(m.method==='initialize')reply({protocolVersion:1,agentCapabilities:{_meta:{fx:{steering:process.env.FX_TEST_CAPABILITY!=='no'}}}});
 else if(m.method==='session/new')reply({sessionId:'fx-native'});
 else if(m.method==='session/resume'||m.method==='session/load')reply({});
 else if(m.method==='session/prompt'&&m.params._meta?.fx?.steer){
  if(!active)throw Error('Steer without prompt');
  if(m.params.prompt.length!==1||m.params.prompt[0].type!=='text')throw Error('Steering is text only');
  steers.push(m);
 }else if(m.method==='session/prompt'){
  active=m;
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'started'}});
  if(m.params.prompt.at(-1).text==='hold')continue;
  timer=setTimeout(()=>{
   for(const s of steers){
    const u={sessionUpdate:'user_message_chunk',content:{type:'text',text:s.params.prompt[0].text},_meta:{fx:{steering:{requestId:s.id}}}};
    // A different session and a duplicate replay must not count the input twice.
    out({jsonrpc:'2.0',method:'session/update',params:{sessionId:'child',update:u}});
    update(u);update(u);
   }
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'finished'}});
   out({jsonrpc:'2.0',id:active.id,result:{stopReason:'end_turn'}});
   // Native fx responds to steers after the original prompt response.
   for(const s of steers)out({jsonrpc:'2.0',id:s.id,result:{stopReason:'end_turn',_meta:{fx:{steering:'absorbed'}}}});
   active=undefined;steers=[];
  },100);
 }else if(m.method==='session/cancel'){
  clearTimeout(timer);
  out({jsonrpc:'2.0',id:active.id,result:{stopReason:'cancelled'}});
  for(const s of steers)out({jsonrpc:'2.0',id:s.id,result:{stopReason:'cancelled',_meta:{fx:{steering:'dropped'}}}});
  active=undefined;steers=[];
 }else if(m.id!==undefined)reply({});
}
`;
async function wait(fn:()=>boolean){for(let i=0;i<300&&!fn();i++)await Bun.sleep(5);expect(fn()).toBe(true);}
test("fx uses advertised ACP steering, correlates native delivery, and rejects unsupported input",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"fx-steer-")),bin=join(dir,"fx");
 writeFileSync(bin,`#!${process.execPath}\n`+fixture);chmodSync(bin,0o700);
 const original={bin:process.env.FX_BIN,cap:process.env.FX_TEST_CAPABILITY};process.env.FX_BIN=bin;
 const threads:string[]=[];
 const request=(message="work")=>{const threadId=crypto.randomUUID();threads.push(threadId);return {threadId,cwd:dir,model:"fx/fake",effort:"off" as const,prior:0,message};};
 const collect=async(req:any,signal=new AbortController().signal)=>(await new Response(runTurn(req,signal)).text()).trim().split("\n").filter(Boolean).map(s=>JSON.parse(s));
 try{
  const req=request(),running=collect(req);await wait(()=>canSteer(req.threadId));
  await expect(steer(req.threadId,"image","image",[{data:"aA==",mimeType:"image/png"}])).rejects.toThrow("text only");
  await expect(steer(req.threadId,"empty"," ")).rejects.toThrow("nonempty");
  await expect(steer(req.threadId,"long","é".repeat(33000))).rejects.toThrow("64 KiB");
  await steer(req.threadId,"s1","same text");await steer(req.threadId,"s2","same text");await steer(req.threadId,"s1","same text");
  await expect(steer(req.threadId,"s1","different")).rejects.toThrow("different input");
  const events=await running;
  expect(events.filter(e=>e.t==="steer")).toEqual([{t:"steer",id:"s1",text:"same text"},{t:"steer",id:"s2",text:"same text"}]);
  expect(JSON.parse(getValue(`fx-session:${req.threadId}`)! ).turns).toBe(3);
  expect(events.find(e=>e.t==="done")).toMatchObject({t:"done",finish:"stop"});
  await expect(steer(req.threadId,"late","late")).rejects.toThrow("isn't working");
  const next=await collect({...req,prior:3,message:"follow up"});expect(next.some(e=>e.t==="error")).toBe(false);
  const held=request("hold"),abort=new AbortController(),stopped=collect(held,abort.signal);
  await wait(()=>canSteer(held.threadId));await steer(held.threadId,"unread","never deliver");abort.abort();
  const stoppedEvents=await stopped;expect(stoppedEvents.filter(e=>e.t==="steer")).toEqual([]);
  expect(stoppedEvents.find(e=>e.t==="done")).toMatchObject({finish:"aborted"});
  expect(JSON.parse(getValue(`fx-session:${held.threadId}`)!).turns).toBe(1);
  process.env.FX_TEST_CAPABILITY="no";
  const legacy=request(),legacyRun=collect(legacy);await wait(()=>canSteer(legacy.threadId));
  await expect(steer(legacy.threadId,"unsupported","no")).rejects.toThrow("does not advertise");await legacyRun;
 }finally{for(const id of threads)release(id);if(original.bin===undefined)delete process.env.FX_BIN;else process.env.FX_BIN=original.bin;if(original.cap===undefined)delete process.env.FX_TEST_CAPABILITY;else process.env.FX_TEST_CAPABILITY=original.cap;rmSync(dir,{recursive:true,force:true});}
});

test("the worker logs what the user wrote for a steer, never the prompt the model reads",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"fx-steer-display-")),bin=join(dir,"fx");
 writeFileSync(bin,`#!${process.execPath}\n`+fixture);chmodSync(bin,0o700);
 const original=process.env.FX_BIN;process.env.FX_BIN=bin;
 const runtime=new PiWorkerRuntime(join(dir,"worker")),threadId=crypto.randomUUID();
 const profile={name:"gal",bio:"private preferences",location:"",language:""};
 const prompt=(text:string)=>withProfileContext(text,profile);
 try{
  const run=runtime.startRun({threadId,runtime:"fx",cwd:dir,model:"fx/fake",effort:"off",prior:0,message:"work",stream:{id:"display-run"}} as any);
  await wait(()=>canSteer(threadId));
  await runtime.steer(threadId,"plain",prompt("look at this"),undefined,"look at this");
  await runtime.steer(threadId,"file",prompt('<file name="a.txt">file body</file>\n\nand this'),undefined,"and this");
  await runtime.steer(threadId,"older-client",prompt("from an older client"));
  await wait(()=>run.record.status!=="pending");
  expect(run.events.filter(e=>e.t==="steer")).toEqual([{t:"steer",id:"plain",text:"look at this"},{t:"steer",id:"file",text:"and this"},{t:"steer",id:"older-client",text:"from an older client"}]);
  expect(JSON.stringify(run.events)).not.toContain("private preferences");
 }finally{release(threadId);if(original===undefined)delete process.env.FX_BIN;else process.env.FX_BIN=original;rmSync(dir,{recursive:true,force:true});}
});
