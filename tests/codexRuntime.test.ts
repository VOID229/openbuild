import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PiChatRequest } from "../shared/types";
import { CodexProcess } from "../server/codex/rpc";
import { answer, hasAsk, release, runTurn, steer } from "../server/codex/sessions";
import { forgetModels, listModels, listPermissions } from "../server/codex/install";

const directory = mkdtempSync(join(tmpdir(), "ob-codex-unit-"));
const fake = join(directory, "codex");
const log = join(directory, "log");
writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
const out = m => process.stdout.write(JSON.stringify(m)+'\n');
let thread, turn, waiting;
for await (const line of console) {
 const m=JSON.parse(line); appendFileSync(process.env.CODEX_TEST_LOG,JSON.stringify(m)+'\n');
 const reply=result=>out({id:m.id,result});
 const ev=(method,params={})=>out({method,params:{threadId:thread,turnId:turn,...params}});
 if (m.method==='initialize') reply({});
 else if(m.method==='thread/start') { thread='native-'+crypto.randomUUID(); writeFileSync(process.env.CODEX_TEST_DIR+'/'+thread,'0'); reply({thread:{id:thread,turns:[]}}); }
 else if(m.method==='thread/resume') {thread=m.params.threadId;const n=Number(readFileSync(process.env.CODEX_TEST_DIR+'/'+thread,'utf8'));reply({thread:{id:thread,turns:Array.from({length:n},(_,i)=>({id:'old-'+i,status:'completed'}))}});}
 else if(m.method==='permissionProfile/list') reply({data:[{id:':read-only',description:null,allowed:true},{id:':workspace',description:null,allowed:true},{id:'team',description:'Team profile',allowed:false}],nextCursor:null});
 else if(m.method==='config/read') reply({config:{default_permissions:':workspace'},origins:{}});
 else if(m.method==='experimentalFeature/list') reply({data:[{name:'guardian_approval',enabled:process.env.CODEX_TEST_NO_REVIEW!=='1'}],nextCursor:null});
 else if(m.method==='configRequirements/read') reply({requirements:process.env.CODEX_TEST_REVIEWERS?{allowedApprovalsReviewers:process.env.CODEX_TEST_REVIEWERS.split(',')}:null});
 else if(m.method==='model/list') reply({data:[{id:'catalog-id',model:'native-model',displayName:'Native model',inputModalities:['text','image'],supportedReasoningEfforts:[{reasoningEffort:'high'}],serviceTiers:[{id:'priority',name:'Fast',description:'extra usage'}],isDefault:true}],nextCursor:null});
 else if(m.method==='hang') {}
 else if(m.method==='crash') process.exit(17);
 else if(m.method==='turn/start') {
  if(m.params.input[0].text==='reject'){out({id:m.id,error:{code:-32602,message:'unsupported effort'}});continue;}
  turn=crypto.randomUUID(); const n=Number(readFileSync(process.env.CODEX_TEST_DIR+'/'+thread,'utf8'))+1;writeFileSync(process.env.CODEX_TEST_DIR+'/'+thread,String(n));
  reply({turn:{id:turn,status:'inProgress'}});
  ev('turn/started',{turn:{id:turn,status:'inProgress'}});
  const text=m.params.input[0].text;
  if(text==='crash') { process.exit(17); }
  if(text==='abort'||text==='steer') continue;
  if(text==='secret') {out({id:'input-1',method:'item/tool/requestUserInput',params:{threadId:thread,turnId:turn,itemId:'input',questions:[{id:'password',header:'Password',question:'Enter secret',isSecret:true,isOther:true,options:null}]}});continue;}
  if(text==='children') {
   ev('item/started',{item:{id:'spawn',type:'collabAgentToolCall',tool:'spawnAgent',receiverThreadIds:['child-thread'],status:'inProgress'}});
   out({method:'item/started',params:{threadId:'child-thread',turnId:'child-turn',item:{id:'child-cmd',type:'commandExecution',command:'child read',commandActions:[{type:'read',path:'child-file'}],status:'inProgress'}}});
   out({method:'item/commandExecution/outputDelta',params:{threadId:'child-thread',turnId:'child-turn',itemId:'child-cmd',delta:'child output'}});
   out({method:'item/completed',params:{threadId:'child-thread',turnId:'child-turn',item:{id:'child-cmd',type:'commandExecution',command:'child read',commandActions:[{type:'read',path:'child-file'}],status:'completed',aggregatedOutput:'child output'}}});
   out({method:'turn/completed',params:{threadId:'child-thread',turn:{id:'child-turn',status:'completed'}}});
  }
  if(text==='ask') { waiting=true;out({id:'permission-1',method:'item/commandExecution/requestApproval',params:{threadId:thread,turnId:turn,itemId:'cmd',command:'echo permission',cwd:process.cwd()}});continue; }
  ev('item/agentMessage/delta',{itemId:'a',delta:'hello'});
  ev('item/started',{item:{id:'cmd',type:'commandExecution',command:'cat file',cwd:process.cwd(),commandActions:[{type:'read',path:'file'}],status:'inProgress'}});
  ev('item/commandExecution/outputDelta',{itemId:'cmd',delta:'full output\n'});
  ev('item/completed',{item:{id:'cmd',type:'commandExecution',command:'cat file',commandActions:[{type:'read',path:'file'}],status:'completed',aggregatedOutput:'full output\n',exitCode:0,durationMs:7}});
  ev('thread/tokenUsage/updated',{tokenUsage:{total:{inputTokens:n*20,cachedInputTokens:n*5,cacheWriteInputTokens:0,outputTokens:n*3,totalTokens:n*23},last:{totalTokens:23},modelContextWindow:100000}});
  ev('turn/completed',{turn:{id:turn,status:'completed'}});
 } else if(m.method==='turn/steer') {
  if(m.params.expectedTurnId!==turn){out({id:m.id,error:{code:-32600,message:'no active turn'}});continue;}
  reply({turnId:turn});
  ev('item/started',{item:{id:'u2',type:'userMessage',clientId:m.params.clientUserMessageId,content:m.params.input}});
  ev('item/agentMessage/delta',{itemId:'b',delta:'steered'});
  ev('turn/completed',{turn:{id:turn,status:'completed'}});
 } else if(m.method==='turn/interrupt') {reply({});ev('turn/completed',{turn:{id:turn,status:'interrupted'}});}
 else if(m.id==='input-1') {ev('turn/completed',{turn:{id:turn,status:'completed'}});}
 else if(m.id==='permission-1') { waiting=false;ev('turn/completed',{turn:{id:turn,status:'completed'}}); }
 else if(m.id!==undefined) reply({});
}
`);
chmodSync(fake, 0o700);
const original = { bin: process.env.CODEX_BIN, log: process.env.CODEX_TEST_LOG, dir: process.env.CODEX_TEST_DIR };
process.env.CODEX_BIN = fake; process.env.CODEX_TEST_LOG = log; process.env.CODEX_TEST_DIR = directory;
const active = new Set<string>();
afterAll(() => { for (const id of active) release(id); forgetModels(); process.env.CODEX_BIN = original.bin; process.env.CODEX_TEST_LOG = original.log; process.env.CODEX_TEST_DIR = original.dir; rmSync(directory, { recursive: true, force: true }); });
const request = (message: string, prior = 0, threadId = crypto.randomUUID()) => { active.add(threadId); return { threadId, cwd: directory, model: "codex/native-model", effort: "high" as const, message, prior }; };
async function collect(req: PiChatRequest, signal = new AbortController().signal) { return (await new Response(runTurn(req, signal)).text()).trim().split("\n").map((s) => JSON.parse(s)); }
const messages = () => readFileSync(log, "utf8").trim().split("\n").map((s) => JSON.parse(s));

test("Codex starts, persists/resumes, sends only new input, preserves configured policies and per-turn usage", async () => {
 const req=request("first");
 const one=await collect(req); expect(one.at(-1).t).toBe("end"); expect(one.find(e=>e.t==='text').v).toBe('hello');
 expect(one.find(e=>e.t==='usage').usage).toMatchObject({input:15,cacheRead:5,output:3,contextTokens:23,contextWindow:100000});
 expect(one.filter(e=>e.t==='tool').every(e=>e.name==='read')).toBe(true);
 expect(one.find(e=>e.t==='tool'&&e.status==='done')).toMatchObject({output:'full output\n',ms:7,args:{codex:{exitCode:0}}});
 release(req.threadId);
 const two=await collect({...req,message:'second',prior:1});
 expect(two.find(e=>e.t==='usage').usage).toMatchObject({input:15,cacheRead:5,output:3});
 const all=messages(); expect(all.some(m=>m.method==='thread/resume')).toBe(true);
 const turns=all.filter(m=>m.method==='turn/start');
 expect(turns.at(-1).params.input).toEqual([{type:'text',text:'second',text_elements:[]}]);
 expect(turns.at(-1).params.serviceTier).toBeNull();
 for(const m of all.filter(m=>['thread/start','thread/resume','turn/start'].includes(m.method))) {expect(m.params.approvalPolicy).toBeUndefined();expect(m.params.sandbox).toBeUndefined();expect(m.params.sandboxPolicy).toBeUndefined();}
 const rejected=await collect({...req,prior:0});expect(rejected.find(e=>e.t==='error').message).toContain('history mismatch');
 const fork=await collect({...request('fork'),forkFrom:req.threadId});expect(fork.find(e=>e.t==='error').message).toContain('fork');
});

test("Codex steers a message into the running turn and counts it as a user message", async () => {
 const req=request('steer');
 await expect(steer(req.threadId,'early','too soon')).rejects.toThrow();
 const result=collect(req);
 for(let i=0;i<200&&!messages().some(m=>m.method==='turn/start'&&m.params.input[0].text==='steer');i++)await Bun.sleep(10);
 await Bun.sleep(20);
 expect(await steer(req.threadId,'steer-1','also this')).toEqual({handled:false});
 const events=await result;
 expect(events.find(e=>e.t==='steer')).toEqual({t:'steer',id:'steer-1',text:'also this'});
 expect(events.find(e=>e.t==='done').finish).toBe('stop');
 const sent=messages().find(m=>m.method==='turn/steer');
 expect(sent.params).toMatchObject({clientUserMessageId:'steer-1',input:[{type:'text',text:'also this',text_elements:[]}]});
 await expect(steer(req.threadId,'late','after')).rejects.toThrow("isn't working");
 // The steered message is a user message in the thread's history; the native turn count is unchanged.
 expect((await collect({...req,message:'next',prior:2})).find(e=>e.t==='done').finish).toBe('stop');
});

test("Codex permission request reaches ask UI and only explicit reply grants once", async () => {
 const req=request('ask'); const reader=runTurn(req,new AbortController().signal).getReader(); const decoder=new TextDecoder();let ask:any;
 while(!ask){const r=await reader.read();if(r.done)throw new Error('no ask');for(const line of decoder.decode(r.value).trim().split('\n')){const e=JSON.parse(line);if(e.t==='ask')ask=e;}}
 expect(hasAsk(req.threadId,ask.id)).toBe(true); expect(answer(req.threadId,ask.id,{value:'Allow once'})).toBe(true);expect(hasAsk(req.threadId,ask.id)).toBe(false);
 while(!(await reader.read()).done) {}
 expect(messages().find(m=>m.id==='permission-1'&&!m.method)?.result).toEqual({decision:'accept'});
});

test("Codex secret asks redact journal answers and child tools remain visible without completing parent", async () => {
 const req=request('secret');const reader=runTurn(req,new AbortController().signal).getReader();let ask:any;let events:any[]=[];
 while(!ask){const r=await reader.read();if(r.done)throw new Error('no secret ask');for(const line of new TextDecoder().decode(r.value).trim().split('\n')){const e=JSON.parse(line);events.push(e);if(e.t==='ask')ask=e;}}
 expect(ask.secret).toBe(true);answer(req.threadId,ask.id,{value:'test-password-not-journaled'});
 while(true){const r=await reader.read();if(r.done)break;events.push(...new TextDecoder().decode(r.value).trim().split('\n').map(s=>JSON.parse(s)));}
 expect(events.find(e=>e.t==='asked').answer).toBe('[redacted]');expect(JSON.stringify(events)).not.toContain('test-password-not-journaled');
 const children=await collect(request('children'));expect(children.find(e=>e.id==='child-thread:child-cmd'&&e.status==='done')).toMatchObject({name:'read',output:'child output',args:{agentThreadId:'child-thread'}});
 expect(children.find(e=>e.t==='text').v).toBe('hello');expect(children.filter(e=>e.t==='done')).toHaveLength(1);
});

test("Codex interrupts active turns; process failures end stream and reject rewind", async () => {
 const req=request('abort');const abort=new AbortController();const result=collect(req,abort.signal);
 for(let i=0;i<100&&!messages().some(m=>m.method==='turn/start'&&m.params.input[0].text==='abort');i++)await Bun.sleep(10);
 abort.abort();expect((await result).find(e=>e.t==='done').finish).toBe('aborted');expect(messages().some(m=>m.method==='turn/interrupt')).toBe(true);
 const crash=request('crash');const events=await collect(crash);expect(events.find(e=>e.t==='error').message).toContain('exited');expect(events.at(-1).t).toBe('end');
 expect((await collect(crash)).find(e=>e.t==='error').message).toContain('history mismatch');
});

test("Codex authoritative turn rejection permits a new message without replaying the rejected input", async () => {
 const req=request('reject');expect((await collect(req)).find(e=>e.t==='error').message).toBe('unsupported effort');
 expect((await collect({...req,message:'valid next message',prior:1})).find(e=>e.t==='done').finish).toBe('stop');
});

test("Codex model discovery uses app-server model/list and real model IDs", async () => {
 const result=await listModels(true);expect(result.defaultModel).toBe('codex/native-model');expect(result.models[0]).toMatchObject({id:'codex/native-model',reasoning:{efforts:['high']},speeds:[{id:'priority',name:'Fast'}]});
});

test("Codex RPC timeouts kill hung processes and reject pending requests", async () => {
 const proc=new CodexProcess(directory); await proc.initialize();
 await expect(proc.request('hang',{},30)).rejects.toThrow('timed out');expect(proc.exited).toBe(true);proc.close();
});

test("Codex lists its own permission profiles and sends a picked one until reset to default", async () => {
 const listed=await listPermissions(directory,true);
 expect(listed.defaultMode).toBe(':workspace');
 expect(listed.modes.map(m=>m.id)).toEqual([':read-only',':workspace','auto-review','team']);
 expect(listed.modes.find(m=>m.id==='auto-review')!.allowed).toBe(true);
 process.env.CODEX_TEST_REVIEWERS='user';
 expect((await listPermissions(directory,true)).modes.find(m=>m.id==='auto-review')!.allowed).toBe(false);
 delete process.env.CODEX_TEST_REVIEWERS; process.env.CODEX_TEST_NO_REVIEW='1';
 expect((await listPermissions(directory,true)).modes.some(m=>m.id==='auto-review')).toBe(false);
 delete process.env.CODEX_TEST_NO_REVIEW;
 expect(listed.modes.find(m=>m.id==='team')).toMatchObject({name:'team',description:'Team profile',allowed:false});
 expect(messages().find(m=>m.method==='permissionProfile/list').params.cwd).toBe(directory);
 const req=request('perm default');
 await collect(req);
 await collect({...req,prior:1,message:'perm picked',permission:':read-only'});
 const resumes=()=>messages().filter(m=>m.method==='thread/resume'&&m.params.threadId===messages().filter(x=>x.method==='turn/start'&&x.params.input[0].text==='perm default')[0]?.params.threadId).length;
 const before=resumes();
 await collect({...req,prior:2,message:'perm reset'});
 const turn=(t:string)=>messages().find(m=>m.method==='turn/start'&&m.params.input[0].text===t).params;
 expect(turn('perm default').permissions).toBeUndefined();
 expect(turn('perm picked').permissions).toBe(':read-only');
 expect(turn('perm reset').permissions).toBeUndefined();
 // Going back to the default restarts the native process, which resumes with only the user's config.
 expect(resumes()).toBe(before+1);
});

test("Codex auto-review sends the workspace profile with the auto reviewer, and leaving it restarts cleanly", async () => {
 const req=request('review on',0);
 await collect({...req,permission:'auto-review'});
 const tid=messages().find(m=>m.method==='turn/start'&&m.params.input[0].text==='review on').params.threadId;
 const resumes=()=>messages().filter(m=>m.method==='thread/resume'&&m.params.threadId===tid).length;
 await collect({...req,prior:1,message:'review plain',permission:':workspace'});
 const turn=(t:string)=>messages().find(m=>m.method==='turn/start'&&m.params.input[0].text===t).params;
 expect(turn('review on')).toMatchObject({permissions:':workspace',approvalsReviewer:'auto_review'});
 expect(turn('review plain').permissions).toBe(':workspace');
 expect(turn('review plain').approvalsReviewer).toBeUndefined();
 expect(resumes()).toBe(1);
});
