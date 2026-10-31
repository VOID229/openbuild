// Offline protocol fixture based on installed Cursor 2026.10.22 headless.ts and
// generated protobuf JSON. Never invokes a real model or uses Cursor credentials.
export const FAKE_CURSOR = String.raw`
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2026.10.22-fake'); process.exit(0); }
if (args[0] === 'status') { console.log(JSON.stringify({isAuthenticated:true})); process.exit(0); }
if (args[0] === '--help') { console.log('Usage: agent [options]\n\nOptions:\n  -p, --print                  Print\n  --mode <mode>                Start in mode. plan: read-only. (choices: "plan")\n  -f, --force                  Force allow commands unless explicitly denied\n  -h, --help                   Help\n\nCommands:\n  login  Log in'); process.exit(0); }
if (args[0] === 'models') { console.log('Available models\n\nauto - Auto (default)\nfake-high - Fake High\nfake-low - Fake Low\nfake-high-fast - Fake High Fast\n\nTip: --model <id>'); process.exit(0); }
if (!args.includes('--print') || args.includes('--yolo') || args.includes('--stream-partial-output')) throw new Error('Unexpected flags');
const arg = flag => args[args.indexOf(flag)+1];
const rawPrompt = args.at(-1);
const prefixEnd = rawPrompt.indexOf('The user message follows after this paragraph.]\n\n');
const received = prefixEnd < 0 ? rawPrompt : rawPrompt.slice(prefixEnd + 'The user message follows after this paragraph.]\n\n'.length);
// Act on the user's words; the effects log keeps exactly what Cursor received.
const prompt = received.replace(/^\[OpenBuild display instructions:[\s\S]*?\]\n\n/, '').replace(/^\[OpenBuild plugin instructions:[\s\S]*?\]\n\n/, '');
const id = arg('--resume'), cwd = arg('--workspace');
const pluginDir = args.includes('--plugin-dir') ? arg('--plugin-dir') : undefined;
if (args.includes('--approve-mcps')) throw new Error('Broad MCP approval forbidden');
const db = join(process.env.CURSOR_CONFIG_DIR,'chats',createHash('md5').update(cwd).digest('hex'),id,'store.db');
mkdirSync(dirname(db),{recursive:true});
const previous = existsSync(db) ? readFileSync(db,'utf8') : '';
appendFileSync(process.env.FAKE_PROTOCOL,JSON.stringify({id,cwd,prompt,rawPrompt,pluginDir,model:arg('--model'),previous,force:args.includes('--force'),mode:args.includes('--mode')?arg('--mode'):undefined})+'\n');
appendFileSync(process.env.FAKE_EFFECTS,received+'\n');
const out = event => console.log(JSON.stringify({...event,session_id:id}));
out({type:'system',subtype:'init',cwd,model:'Fake'});
if (prompt === 'ask bridge') {
 const config = JSON.parse(readFileSync(join(pluginDir,'.mcp.json'),'utf8'));
 const url = config.mcpServers['openbuild-questions'].url;
 const response = await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'question_ask',arguments:{question:'Which approach?',options:['A','B']}}})});
 const reply = await response.json();
 out({type:'assistant',message:{content:[{type:'text',text:reply.result.content[0].text}]}});
}
process.on('SIGINT',()=>{ writeFileSync(db,previous+'aborted\n'); process.exit(130); });
if (prompt === 'bad stream') { console.log('not json'); setInterval(()=>{},1000); }
else {
 out({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'Started-'}]}});
 if (prompt === 'work once' || prompt === 'steering work') while (!existsSync(process.env.FAKE_RELEASE)) await Bun.sleep(25);
 if (prompt === 'wait') while (true) await Bun.sleep(25);
 const command = "printf 'once\\n' >> \\\"$FAKE_TOOL_EFFECTS\\\"";
 const tool = {shellToolCall:{args:{command:'printf hi',workingDirectory:cwd},result:{success:{stdout:'hi\n',stderr:'',exitCode:0}}}};
 out({type:'tool_call',subtype:'started',call_id:'tool-1',tool_call:{shellToolCall:{args:tool.shellToolCall.args}}});
 const executed = Bun.spawnSync(['sh','-c', 'printf "once\\n" >> "$FAKE_TOOL_EFFECTS"']);
 if (executed.exitCode !== 0) throw new Error('Fixture shell failed');
 out({type:'tool_call',subtype:'completed',call_id:'tool-1',tool_call:tool});
 if (prompt === 'steering work') {
   const hooks = JSON.parse(readFileSync(join(pluginDir,'hooks','hooks.json'),'utf8'));
   const hook = Bun.spawn(['sh','-c',hooks.hooks.postToolUse[0].command],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});
   hook.stdin.write(JSON.stringify({tool_name:'Shell',tool_output:'ok'})); hook.stdin.end();
   const injected = await new Response(hook.stdout).text();
   if (await hook.exited !== 0) throw new Error('Steering hook failed: ' + await new Response(hook.stderr).text());
   appendFileSync(db, injected);
   out({type:'assistant',message:{role:'assistant',content:[{type:'text',text:injected}]}});
 }
 out({type:'assistant',message:{role:'assistant',content:[{type:'text',text:previous ? 'resumed saved thread' : 'finished offline'}]}});
 writeFileSync(db,previous+prompt+'\n');
 out({type:'result',subtype:'success',is_error:false,result:'Started-'+(previous ? 'resumed saved thread':'finished offline'),usage:{inputTokens:3,outputTokens:4,cacheReadTokens:2,cacheWriteTokens:1}});
}
`;
