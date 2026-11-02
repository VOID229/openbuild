// A fake `grok`, shaped by what `grok agent stdio` 1.0.70 actually sent in recorded live sessions.
// Prompts starting with a scenario word pick what it does; FAKE_EFFECTS records each prompt.
export const FAKE_GROK = String.raw`
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const out = value => process.stdout.write(JSON.stringify(value)+'\n');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('grok 1.0.70 (fake) [stable]'); process.exit(0); }
if (args[0] === 'models') { console.log('You are logged in with grok.com.\n\nDefault model: fake-1\n\nAvailable models:\n  * fake-1 (default)\n  - fake-fast'); process.exit(0); }
if (args.join(' ') !== 'agent --no-leader stdio') { console.error('unexpected args '+args); process.exit(2); }
const SID = process.env.FAKE_SESSION ?? 'fake-session';
const tool = (name, kind) => ({ 'x.ai/tool': { version:1, name, kind, namespace:'grok_build' } });
const models = [{ modelId:'fake-1', name:'Fake One', _meta:{ totalContextTokens:500000, supportsReasoningEffort:true, reasoningEfforts:[{ value:'high' },{ value:'low' }] } },{ modelId:'fake-fast', name:'Fake Fast', _meta:{ totalContextTokens:256000 } }];
const options = [
  { id:'model', category:'model', currentValue:'fake-1', options:[{ value:'fake-1' },{ value:'fake-fast' }] },
  { id:'reasoning_effort', category:'thought_level', currentValue:'high', options:[{ value:'high' },{ value:'low' }] },
];
let id = 1000, active, gotAnswer;
const update = (u, meta) => out({ jsonrpc:'2.0', method:'session/update', params:{ sessionId:SID, update:u, ...(meta ? { _meta:meta } : {}) } });
const note = u => out({ jsonrpc:'2.0', method:'_x.ai/session_notification', params:{ sessionId:SID, update:u } });
const say = (text, promptId='p1') => update({ sessionUpdate:'agent_message_chunk', content:{ type:'text', text } }, { totalTokens:1234, promptId });
const finish = (stopReason='end_turn', extra={}) => {
  note({ sessionUpdate:'turn_completed', prompt_id:'p1', stop_reason:stopReason, usage:{ inputTokens:100, outputTokens:10, cachedReadTokens:60, cacheCreationTokens:0, costUsdTicks:10000000 } });
  out({ jsonrpc:'2.0', method:'_x.ai/session/prompt_complete', params:{ sessionId:SID, promptId:'p1', stopReason, ...extra } });
  out({ jsonrpc:'2.0', id:active.id, result:{ stopReason } });
  active = undefined;
};
const ask = (method, params) => new Promise(resolve => { const rid = ++id; gotAnswer = m => { if (m.id === rid) { gotAnswer = undefined; resolve(m); } }; out({ jsonrpc:'2.0', id:rid, method, params }); });
const scenarios = {
  async tools() {
    update({ sessionUpdate:'agent_thought_chunk', content:{ type:'text', text:'hmm' } });
    say('Starting.');
    note({ sessionUpdate:'response_completed', usage:{} });
    update({ sessionUpdate:'tool_call', toolCallId:'sh', title:'run_terminal_command', rawInput:{ command:'seq 2', description:'Count' }, _meta:tool('run_terminal_command','execute') });
    update({ sessionUpdate:'tool_call_update', toolCallId:'sh', kind:'execute', title:'Execute', content:[{ type:'content', content:{ type:'text', text:'Count' } }], rawInput:{ variant:'Bash', command:'seq 2', description:'Count' }, _meta:tool('run_terminal_command','execute') });
    update({ sessionUpdate:'tool_call_update', toolCallId:'sh', status:'in_progress', content:[{ type:'content', content:{ type:'text', text:'1\n' } }], rawOutput:{ type:'Bash', exit_code:0 } });
    update({ sessionUpdate:'tool_call_update', toolCallId:'sh', status:'completed', content:[{ type:'content', content:{ type:'text', text:'1\n2\n' } }], rawOutput:{ type:'Bash', exit_code:0 } });
    update({ sessionUpdate:'tool_call', toolCallId:'bad', title:'run_terminal_command', rawInput:{ command:'false' }, _meta:tool('run_terminal_command','execute') });
    update({ sessionUpdate:'tool_call_update', toolCallId:'bad', status:'completed', content:[{ type:'content', content:{ type:'text', text:'nope\n' } }], rawOutput:{ type:'Bash', exit_code:1 } });
    update({ sessionUpdate:'tool_call', toolCallId:'new', title:'search_replace', rawInput:{ file_path:process.cwd()+'/a.txt', old_string:'', new_string:'hi' }, _meta:tool('search_replace','edit') });
    update({ sessionUpdate:'tool_call_update', toolCallId:'new', status:'completed', content:[{ type:'diff', path:process.cwd()+'/a.txt', oldText:'', newText:'hi' }], rawOutput:{ type:'SearchReplace', EditsApplied:{ tool_output_for_prompt_concise:'The file has been created.' } } });
    update({ sessionUpdate:'tool_call', toolCallId:'ed', title:'search_replace', rawInput:{ file_path:process.cwd()+'/a.txt', old_string:'hi', new_string:'hello' }, _meta:tool('search_replace','edit') });
    update({ sessionUpdate:'tool_call_update', toolCallId:'ed', status:'completed', content:[{ type:'diff', path:process.cwd()+'/a.txt', oldText:'hi', newText:'hello' }], rawOutput:{ type:'SearchReplace', EditsApplied:{ tool_output_for_prompt_concise:'The file has been updated.' } } });
    update({ sessionUpdate:'tool_call', toolCallId:'rd', title:'read_file', rawInput:{ target_file:'a.txt' }, _meta:tool('read_file','read') });
    update({ sessionUpdate:'tool_call_update', toolCallId:'rd', status:'completed', content:[{ type:'content', content:{ type:'text', text:'1→hello' } }], rawOutput:{ type:'ReadFile', FileContent:{ raw_output:'hello' } } });
    update({ sessionUpdate:'tool_call', toolCallId:'miss', title:'read_file', rawInput:{ target_file:'gone' }, _meta:tool('read_file','read') });
    update({ sessionUpdate:'tool_call_update', toolCallId:'miss', status:'failed', content:[{ type:'content', content:{ type:'text', text:'Error: gone does not exist.' } }], rawOutput:{ type:'ReadFile', FileNotFound:'x' } });
    update({ sessionUpdate:'tool_call', toolCallId:'ls', title:'list_dir', rawInput:{ target_directory:'.' }, _meta:tool('list_dir','list') });
    update({ sessionUpdate:'tool_call_update', toolCallId:'ls', status:'completed', rawOutput:{ type:'ListDir', Content:{ content:'- ./\n  - a.txt' } } });
    update({ sessionUpdate:'tool_call', toolCallId:'gr', title:'grep', rawInput:{ pattern:'hello', path:'.' }, _meta:tool('grep','search') });
    update({ sessionUpdate:'tool_call_update', toolCallId:'gr', status:'completed', content:[{ type:'content', content:{ type:'text', text:'found 1 matches' } }], rawOutput:{ type:'GrepSearch', file_matches:[{ path:'a.txt', matches:[{ line_number:1, content:'hello' }] }] } });
    update({ sessionUpdate:'tool_call', toolCallId:'td', title:'todo_write', rawInput:{ todos:[] }, _meta:tool('todo_write','plan') });
    update({ sessionUpdate:'tool_call_update', toolCallId:'td', status:'completed', rawOutput:{ type:'Todo' } });
    update({ sessionUpdate:'plan', entries:[{ content:'First', status:'completed' },{ content:'Second', status:'pending' }] });
    say('Finished.');
    finish();
  },
  async permission() {
    const p = await ask('session/request_permission', { sessionId:SID, toolCall:{ toolCallId:'x', title:'Edit', kind:'edit', rawInput:{ variant:'SearchReplace', file_path:'a.txt', old_string:'a', new_string:'b' }, _meta:tool('search_replace','edit') }, options:[{ optionId:'allow-once', name:'Yes', kind:'allow_once' },{ optionId:'reject-once', name:'No', kind:'reject_once' }] });
    appendFileSync(process.env.FAKE_EFFECTS, 'permission='+JSON.stringify(p.result)+'\n');
    if (p.result.outcome.optionId === 'reject-once') finish('cancelled', { cancellationCategory:'PermissionRejected' });
    else { say('edited'); finish(); }
  },
  async question() {
    update({ sessionUpdate:'tool_call', toolCallId:'q', title:'ask_user_question', rawInput:{}, _meta:tool('ask_user_question','other') });
    const a = await ask('_x.ai/ask_user_question', { sessionId:SID, toolCallId:'q', mode:'default', questions:[{ question:'Which colour?', options:[{ label:'Red' },{ label:'Blue' }], multiSelect:null },{ question:'Why?', options:[] }] });
    appendFileSync(process.env.FAKE_EFFECTS, 'answers='+JSON.stringify(a.result)+'\n');
    update({ sessionUpdate:'tool_call_update', toolCallId:'q', status:'completed', content:[{ type:'content', content:{ type:'text', text:'answered' } }] });
    finish();
  },
  async unknownRequest() {
    const r = await ask('_x.ai/exit_plan_mode', { sessionId:SID });
    appendFileSync(process.env.FAKE_EFFECTS, 'refused='+JSON.stringify(r.error?.code)+'\n');
    finish();
  },
  hold() { say('Started-'); },
  released() {
    say('Started-');
    const timer = setInterval(() => {
      if (!existsSync(process.env.FAKE_RELEASE)) return;
      clearInterval(timer);
      update({ sessionUpdate:'tool_call', toolCallId:'t1', title:'run_terminal_command', rawInput:{ command:'echo hi' }, _meta:tool('run_terminal_command','execute') });
      update({ sessionUpdate:'tool_call_update', toolCallId:'t1', status:'completed', content:[{ type:'content', content:{ type:'text', text:'hi\n' } }], rawOutput:{ exit_code:0 } });
      say('finished offline');
      finish();
      writeFileSync(process.env.FAKE_EFFECTS+'.finished', 'done');
    }, 25);
  },
  // An interjection that reaches Grok as the turn ends becomes a turn of its own.
  lateSteer() { say('main'); active.late = true; },
};
let pendingLate;
for await (const line of console) {
  const m = JSON.parse(line);
  if (m.id !== undefined && !m.method) { gotAnswer?.(m); continue; }
  const reply = result => out({ jsonrpc:'2.0', id:m.id, result });
  if (m.method === 'initialize') {
    reply({ protocolVersion:1, agentCapabilities:{ loadSession:true }, _meta:{ modelState:{ currentModelId:'fake-1', availableModels:[models[1]] } } });
    out({ jsonrpc:'2.0', method:'_x.ai/models/update', params:{ currentModelId:'fake-1', availableModels:models } });
  } else if (m.method === 'session/new') {
    if (process.env.FAKE_NEW_LOG) appendFileSync(process.env.FAKE_NEW_LOG, 'new\n');
    reply({ sessionId:SID, configOptions:options, models:{ availableModels:models } });
  } else if (m.method === 'session/resume') {
    if (process.env.FAKE_NO_RESUME) out({ jsonrpc:'2.0', id:m.id, error:{ code:-32602, message:'Invalid params', data:'session not found' } });
    else reply({ configOptions:options, models:{ availableModels:models } });
  } else if (m.method === 'session/set_config_option') {
    if (typeof m.params.value !== 'string') { out({ jsonrpc:'2.0', id:m.id, error:{ code:-32602, message:'Invalid params' } }); continue; }
    const o = options.find(x => x.id === m.params.configId); if (o) o.currentValue = m.params.value;
    reply({ configOptions:options });
  } else if (m.method === 'session/prompt') {
    const text = m.params.prompt.at(-1).text;
    appendFileSync(process.env.FAKE_EFFECTS, text+'\n');
    active = m;
    const scenario = Object.keys(scenarios).find(s => text.endsWith(s));
    if (scenario) void scenarios[scenario]();
    else { say('reply to '+text.split('\n').at(-1)+' model='+options[0].currentValue+' effort='+options[1].currentValue); finish(); }
  } else if (m.method === '_x.ai/interject') {
    appendFileSync(process.env.FAKE_EFFECTS, 'interject='+JSON.stringify({ text:m.params.text, images:m.params.content?.length ?? 0 })+'\n');
    reply({ result:{ status:'queued' } });
    out({ jsonrpc:'2.0', method:'_x.ai/session/interjection', params:{ sessionId:SID, text:m.params.text, interjectionId:m.params.interjectionId } });
    if (active?.late) {
      finish();
      const fallback = 'interject-fallback-1';
      setTimeout(() => {
        out({ jsonrpc:'2.0', method:'_x.ai/queue/changed', params:{ sessionId:SID, entries:[], runningPromptId:fallback } });
        setTimeout(() => {
          say('late reply', fallback);
          note({ sessionUpdate:'turn_completed', prompt_id:fallback, stop_reason:'end_turn', usage:{ inputTokens:50, outputTokens:5 } });
        }, 300);
      }, 20);
    } else if (active) { setTimeout(() => { say('steered'); finish(); }, 100); }
  } else if (m.method === 'session/cancel') {
    if (active) finish('cancelled', { cancellationCategory:'MidTurnAbort' });
  } else if (m.id !== undefined) out({ jsonrpc:'2.0', id:m.id, error:{ code:-32601, message:'Method not found' } });
}
`;
