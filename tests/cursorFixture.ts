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
const id = arg('--resume'), cwd = arg('--workspace'), prompt = args.at(-1);
const db = join(process.env.CURSOR_CONFIG_DIR,'chats',createHash('md5').update(cwd).digest('hex'),id,'store.db');
mkdirSync(dirname(db),{recursive:true});
const previous = existsSync(db) ? readFileSync(db,'utf8') : '';
appendFileSync(process.env.FAKE_PROTOCOL,JSON.stringify({id,cwd,prompt,model:arg('--model'),previous,force:args.includes('--force'),mode:args.includes('--mode')?arg('--mode'):undefined})+'\n');
appendFileSync(process.env.FAKE_EFFECTS,prompt+'\n');
const out = event => console.log(JSON.stringify({...event,session_id:id}));
out({type:'system',subtype:'init',cwd,model:'Fake'});
process.on('SIGINT',()=>{ writeFileSync(db,previous+'aborted\n'); process.exit(130); });
if (prompt === 'bad stream') { console.log('not json'); setInterval(()=>{},1000); }
else {
 out({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'Started-'}]}});
 if (prompt === 'work once') while (!existsSync(process.env.FAKE_RELEASE)) await Bun.sleep(25);
 if (prompt === 'wait') while (true) await Bun.sleep(25);
 const command = "printf 'once\\n' >> \\\"$FAKE_TOOL_EFFECTS\\\"";
 const tool = {shellToolCall:{args:{command:'printf hi',workingDirectory:cwd},result:{success:{stdout:'hi\n',stderr:'',exitCode:0}}}};
 out({type:'tool_call',subtype:'started',call_id:'tool-1',tool_call:{shellToolCall:{args:tool.shellToolCall.args}}});
 const executed = Bun.spawnSync(['sh','-c', 'printf "once\\n" >> "$FAKE_TOOL_EFFECTS"']);
 if (executed.exitCode !== 0) throw new Error('Fixture shell failed');
 out({type:'tool_call',subtype:'completed',call_id:'tool-1',tool_call:tool});
 out({type:'assistant',message:{role:'assistant',content:[{type:'text',text:previous ? 'resumed saved thread' : 'finished offline'}]}});
 writeFileSync(db,previous+prompt+'\n');
 out({type:'result',subtype:'success',is_error:false,result:'Started-'+(previous ? 'resumed saved thread':'finished offline'),usage:{inputTokens:3,outputTokens:4,cacheReadTokens:2,cacheWriteTokens:1}});
}
`;
