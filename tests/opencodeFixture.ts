// Offline OpenCode 2 HTTP/SSE fixture. Native sessions survive fixture process starts.
export const FAKE_OPENCODE = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
if (process.argv[2] === '--version') { console.log('2.0.32'); process.exit(0); }
if (process.argv[2] !== 'serve' || !process.argv.includes('--hostname=127.0.0.1') || !process.argv.includes('--port=0')) throw new Error('Expected ephemeral serve');
const model = {id:'fake-1',providerID:'test',name:'Fake',enabled:true,capabilities:{input:['text'],tools:true},variants:[],limit:{context:10000,output:1000}};
const sessionID = 'ses_fixture';
const load = () => existsSync(process.env.FAKE_HISTORY) ? JSON.parse(readFileSync(process.env.FAKE_HISTORY,'utf8')) : {session:null,messages:[]};
const save = value => writeFileSync(process.env.FAKE_HISTORY,JSON.stringify(value));
const clients = new Set();
let pendingPermission;
const emit = (type,data) => { for (const c of clients) { try { c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type,data})+'\n\n')); } catch { clients.delete(c); } } };
const json = value => Response.json(value);
const server = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req) {
  const url = new URL(req.url), path = url.pathname;
  if (path === '/api/info') return json({data:{version:'2.0.32'}});
  if (path === '/api/model') return json({data:[model]});
  if (path === '/api/model/default') return json({data:model});
  if (path === '/api/event') return new Response(new ReadableStream({start(c) { clients.add(c); c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:'server.connected',data:{}})+'\n\n')); },cancel(c) { clients.delete(c); }}),{headers:{'Content-Type':'text/event-stream'}});
  if (path === '/api/session/active') return json({data:{}});
  if (path === '/api/session' && req.method === 'POST') {
    const body = await req.json(); const state = load();
    if (state.session) throw new Error('Must reuse saved native session, not create another');
    state.session = {id:sessionID,location:{directory:body.location?.directory || url.searchParams.get('location[directory]') || process.cwd()},title:'Restart fixture',time:{created:1,updated:1,idle:2}};
    save(state); appendFileSync(process.env.FAKE_PROTOCOL,'session/create\n');
    return json({data:state.session});
  }
  if (path === '/api/session/'+sessionID && req.method === 'GET') { appendFileSync(process.env.FAKE_PROTOCOL,'session/get\n'); return json({data:load().session}); }
  if (path === '/api/session/'+sessionID+'/message') return json({data:load().messages,cursor:{}});
  if (path === '/api/session/'+sessionID+'/model') return json({data:model});
  if (path === '/api/session/'+sessionID+'/permission/perm_fixture/reply' && req.method === 'POST') {
    const body = await req.json();
    if (body.decision !== 'once' || !pendingPermission) throw new Error('Expected a single Allow once permission answer');
    appendFileSync(process.env.FAKE_PROTOCOL,'permission/once\n');
    const finish = pendingPermission; pendingPermission = undefined;
    setTimeout(finish,25);
    return json({data:{}});
  }
  if (path === '/api/session/'+sessionID+'/prompt' && req.method === 'POST') {
    const body = await req.json(); const text = body.text;
    if (typeof text !== 'string') throw new Error('Expected prompt {text}');
    // Effects track user submissions, while native history below retains the full prompt.
    const userText = text.startsWith('<openbuild-question-instructions>\n') ? text.split('</openbuild-question-instructions>\n\n').slice(1).join('</openbuild-question-instructions>\n\n') : text;
    appendFileSync(process.env.FAKE_EFFECTS,userText+'\n');
    const state = load(), n = state.messages.length+1, assistantMessageID = 'assistant_'+n;
    state.messages.push({id:'msg_'+n,sessionID,type:'user',role:'user',text,parts:[{type:'text',text}]}); save(state);
    const common = {sessionID,assistantMessageID};
    setTimeout(() => {
      if (n > 1) {
        pendingPermission = () => {
          const command = "printf 'approved\\n' >> \"$FAKE_TOOL_EFFECTS\"; printf 'approved\\n'";
          const tool = {...common,id:'tool-approved',name:'shell'};
          emit('session.tool.input.started',tool);
          emit('session.tool.called',{...tool,input:{command}});
          const result = Bun.spawnSync(['sh','-c',command]);
          emit('session.tool.success',{...tool,content:[{type:'text',text:result.stdout.toString()}]});
          emit('session.text.delta',{...common,ordinal:0,delta:'resumed saved session'});
          emit('session.text.ended',{...common,ordinal:0,text:'resumed saved session'});
          emit('session.execution.succeeded',common);
        };
        emit('permission.asked',{sessionID,id:'perm_fixture',action:'shell',resources:['approved fixture command']});
        return;
      }
      emit('session.text.delta',{...common,ordinal:0,delta:'Started-'});
      const timer = setInterval(() => {
        if (!existsSync(process.env.FAKE_RELEASE)) return;
        clearInterval(timer);
        const command = "printf 'once\\n' >> \"$FAKE_TOOL_EFFECTS\"; printf 'hi\\n'";
        const tool = {...common,id:'tool-1',name:'shell',ordinal:1};
        emit('session.tool.input.started',tool);
        emit('session.tool.called',{...tool,input:{command}});
        const executed = Bun.spawnSync(['sh','-c',command]);
        emit('session.tool.success',{...tool,content:[{type:'text',text:executed.stdout.toString()}]});
        emit('session.text.ended',{...common,ordinal:0,text:'Started-'});
        emit('session.text.delta',{...common,ordinal:2,delta:'finished offline'});
        emit('session.text.ended',{...common,ordinal:2,text:'finished offline'});
        emit('session.execution.succeeded',common);
        writeFileSync(process.env.FAKE_EFFECTS+'.finished','done');
      },25);
    },25);
    return json({data:{id:'msg_'+n}});
  }
  appendFileSync(process.env.FAKE_PROTOCOL,'unexpected '+req.method+' '+path+'\n');
  return json({error:'Unexpected fixture request: '+req.method+' '+path});
}});
console.log('opencode server listening on http://127.0.0.1:'+server.port);
`;
