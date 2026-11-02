export const FAKE_HERMES = String.raw`
import { existsSync, appendFileSync, writeFileSync } from 'node:fs';
let buf='', pending;
const send = v => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\n');
const update = u => send({method:'session/update',params:{sessionId:'sid',update:u}});
process.stdin.on('data', b => { buf+=b; let n; while((n=buf.indexOf('\n'))>=0) {const m=JSON.parse(buf.slice(0,n));buf=buf.slice(n+1);const result=r=>send({id:m.id,result:r});
if(m.method==='initialize') result({agentCapabilities:{loadSession:true}});
else if(m.method==='session/new') result({sessionId:'sid',models:{currentModelId:'p/m',availableModels:[{modelId:'p/m',name:'Model'}]}});
else if(m.method==='session/load') {update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OLD HISTORY'}});result({});}
else if(m.method==='session/set_model') result({});
else if(m.method==='session/cancel') {send({id:pending,result:{stopReason:'cancelled'}});pending=null;}
else if(m.method==='session/prompt') {
const text=m.params.prompt.at(-1).text;
if(text.endsWith('work once released')) {
appendFileSync(process.env.FAKE_EFFECTS,text+'\n');
update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Started-'}});
const timer=setInterval(()=>{if(!existsSync(process.env.FAKE_RELEASE))return;clearInterval(timer);update({sessionUpdate:'tool_call',toolCallId:'x',kind:'execute',title:'terminal',rawInput:{command:'echo hi'}});update({sessionUpdate:'tool_call_update',toolCallId:'x',status:'completed',content:[{type:'content',content:{type:'text',text:'hi'}}]});update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'finished offline'}});writeFileSync(process.env.FAKE_EFFECTS+'.finished','yes');result({stopReason:'end_turn'});},25); continue; }
if(text==='hold') { pending=m.id;update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'working'}}); }
else if(text==='correct') {result({stopReason:'end_turn'});setTimeout(()=>{update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'corrected'}});send({id:pending,result:{stopReason:'end_turn'}})},20);}
else { update({sessionUpdate:'tool_call',toolCallId:'t',title:'Shell',kind:'execute',rawInput:{command:'pwd'}});update({sessionUpdate:'tool_call_update',toolCallId:'t',status:'completed',content:[{type:'content',content:{type:'text',text:'ok'}}]});result({stopReason:'end_turn'});}
}
}});
`;
