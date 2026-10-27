import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("worker replay repairs offline output, completion and stale saves without resurrecting retries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ob-pi-projection-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { strict as a } from 'node:assert';
      import { projectReply, projectChat, projectStoredChats } from './server/pi/projection';
      import * as storage from './server/storage';
      const stream = { id: 'reply-0123456789abcdef', via: 'server-test' };
      const message = { id:'assistant-original',role:'assistant',content:'partial',status:'streaming',stream,createdAt:10,startedAt:10,model:{plan:'pi',id:'test/model',name:'Test'} };
      const chat = { id:'thread-0123456789',title:'Keep my title',titleSource:'user',createdAt:1,updatedAt:10,pinned:true,messages:[{id:'user-original',role:'user',content:'hello',createdAt:9},message] };
      const snapshot = {id:stream.id,threadId:chat.id,kind:'run',status:'pending',startedAt:10,events:[
        {t:'reasoning',v:'plan'}, {t:'text',v:'Hello '},
        {t:'tool',id:'tool-1',name:'bash',status:'running',args:{command:'pwd'}},
        {t:'tool',id:'tool-1',name:'bash',status:'done',output:'/work',ms:15},
        {t:'ask',id:'ask-1',method:'select',title:'Continue?',options:['Yes']},
      ]};
      const pending = projectReply(message,snapshot);
      a.equal(pending.status,'streaming'); a.equal(pending.parts.at(-1).answer,undefined);
      a.equal(pending.parts[2].output,'/work'); a.equal(pending.parts[2].args.command,'pwd');
      snapshot.events.push({t:'asked',id:'ask-1',answer:'Yes'},{t:'text',v:'world'}, {t:'usage',usage:{input:20,output:4}}, {t:'done',finish:'stop'});
      snapshot.status='finished'; snapshot.endedAt=200;
      storage.putChat(chat);
      projectStoredChats([snapshot]);
      const stored=storage.getChat(chat.id);
      a.equal(stored.messages[1].id,message.id); a.deepEqual(stored.messages[1].stream,stream);
      a.equal(stored.messages[1].content,'Hello world'); a.equal(stored.messages[1].status,'done');
      a.equal(stored.messages[1].usage.input,20); a.equal(stored.messages[1].parts[3].answer,'Yes');
      a.equal(stored.updatedAt,200); a.equal(stored.unread,true); a.equal(stored.pinned,true); a.equal(stored.title,chat.title);
      // Once read, subsequent polls must not re-light the sidebar indicator.
      storage.putChat({...stored,unread:false});
      projectStoredChats([snapshot]);
      a.equal(storage.getChat(chat.id).unread,false);
      // A stale browser cannot replace completed output, but its read acknowledgment is retained.
      const stale=projectChat({...chat,unread:false},[snapshot],storage.getChat(chat.id));
      a.equal(stale.messages[1].status,'done'); a.equal(stale.messages[1].content,'Hello world'); a.equal(stale.unread,false);
      // Retries replace the stream id; historical logs must not revive deleted/edited messages.
      const retry={...chat,messages:[chat.messages[0],{...message,stream:{...stream,id:'new-reply-0123456789'}}]};
      a.equal(projectChat(retry,[snapshot]).messages[1].content,'partial');
      a.equal(projectChat({...chat,runtime:'durable'},[snapshot]).messages[1].content,'partial');
      const interrupted={...snapshot,status:'interrupted',events:[...snapshot.events.slice(0,-1),{t:'error',message:'Worker interrupted'}]};
      a.equal(projectReply(message,interrupted).status,'error');
      a.equal(projectReply(message,{...snapshot,status:'aborted',events:[]}).status,'stopped');
      const shell={...message,role:'shell',shell:{command:'pwd',status:'running',output:'',stream}};
      const shellSnap={...snapshot,kind:'shell',events:[{t:'snap',output:'abc',status:'running'},{t:'out',v:'def'},{t:'exit',status:'done',exitCode:0,ms:20}]};
      const projectedShell=projectChat({...chat,messages:[shell]},[shellSnap]).messages[0].shell;
      a.equal(projectedShell.output,'abcdef');a.equal(projectedShell.status,'done');a.equal(projectedShell.exitCode,0);
      // A bounded shell tail stays one event long while its journal advances.
      storage.putChat({...chat,messages:[shell]});
      const tail={...snapshot,kind:'shell',status:'pending',endedAt:undefined,eventCount:1,events:[{t:'snap',output:'first',status:'running'}]};
      projectStoredChats([tail]); a.equal(storage.getChat(chat.id).messages[0].shell.output,'first');
      projectStoredChats([{...tail,eventCount:2,events:[{t:'snap',output:'second',status:'running'}]}]);
      a.equal(storage.getChat(chat.id).messages[0].shell.output,'second');
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENCHAT_DATA_DIR: dir }, stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
