// A stand-in for the installed `claude` CLI speaking the Agent SDK's stream-json protocol, as
// observed from Claude Code 2.1.311 (argv, control_request/control_response, stream_event,
// assistant/user/result frames). No model, network or sign-in. It persists a transcript at
// $CLAUDE_CONFIG_DIR/projects/fixture/<session>.jsonl so a fresh process can resume it.
export const FAKE_CLAUDE = String.raw`
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const out = v => process.stdout.write(JSON.stringify(v) + '\n');
const log = s => process.env.FAKE_PROTOCOL && appendFileSync(process.env.FAKE_PROTOCOL, s + '\n');
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('2.1.311-fake (Claude Code)'); process.exit(0); }
const flag = name => { const a = argv.find(x => x.startsWith('--' + name + '=')); if (a) return a.slice(name.length + 3); const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined; };
const resume = flag('resume'), fixed = flag('session-id'), fork = argv.includes('--fork-session');
let session = fork ? (fixed ?? crypto.randomUUID()) : (resume ?? fixed ?? crypto.randomUUID());
const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fixture');
mkdirSync(dir, { recursive: true });
const file = id => join(dir, id + '.jsonl');
if (resume && !existsSync(file(resume))) { process.stderr.write('No conversation found with session ID: ' + resume + '\n'); process.exit(1); }
if (fork) {
  // Like the CLI: the fork keeps the source transcript up to and including --resume-session-at.
  const at = flag('resume-session-at'), lines = readFileSync(file(resume), 'utf8').trim().split('\n');
  const end = at ? lines.findIndex(l => l.includes('"' + at + '"')) + 1 : lines.length;
  writeFileSync(file(session), lines.slice(0, end || lines.length).join('\n') + '\n');
}
log('start ' + (resume ? (fork ? 'fork' : 'resume') : 'new') + ' ' + argv.filter(a => /permission-mode|resume-session-at|model|thinking/.test(a)).join(' '));
const state = { model: 'opus', mode: flag('permission-mode') ?? 'default', fast: false, effort: null };
const models = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5', supportsEffort: true, supportedEffortLevels: ['low','medium','high','xhigh','max'], supportsAdaptiveThinking: true, supportsThinkingOff: false },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For complex work', supportsEffort: true, supportedEffortLevels: ['low','medium','high','xhigh','max'], supportsAdaptiveThinking: true, supportsFastMode: true, supportsThinkingOff: true },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5', description: 'Fastest', supportsEffort: true, supportedEffortLevels: ['low','medium','high'], supportsAdaptiveThinking: true },
];
const pending = new Map();
let n = 0;
const ask = request => new Promise(res => { const id = 'cli-' + (++n); pending.set(id, res); out({ type: 'control_request', request_id: id, request }); });
const base = { session_id: session };
const frame = (v) => out({ ...v, ...base, uuid: crypto.randomUUID() });
const assistant = (content) => { const uuid = crypto.randomUUID(); out({ type: 'assistant', message: { id: 'msg-' + uuid, role: 'assistant', content, usage: { input_tokens: 10, output_tokens: 5 } }, parent_tool_use_id: null, uuid, ...base }); appendFileSync(file(session), JSON.stringify({ type: 'assistant', uuid }) + '\n'); return uuid; };
const text = (t) => { frame({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm' + n } } }); frame({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }); frame({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } } }); const uuid = crypto.randomUUID(); out({ type: 'assistant', message: { id: 'm' + n, role: 'assistant', content: [{ type: 'text', text: t }], usage: { input_tokens: 10, output_tokens: 5 } }, parent_tool_use_id: null, uuid, ...base }); appendFileSync(file(session), JSON.stringify({ type: 'assistant', uuid }) + '\n'); };
const result = (extra = {}) => out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 5, duration_api_ms: 5, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 }, modelUsage: { 'claude-opus-5-5': { contextWindow: 200000 } }, permission_denials: [], fast_mode_state: state.fast ? 'on' : 'off', ...base, uuid: crypto.randomUUID(), ...extra });
let interrupted = false;
async function turn(prompt) {
  interrupted = false;
  const t = prompt.message.content.filter(c => c.type === 'text').map(c => c.text).join('');
  log('turn ' + t + ' model=' + state.model + ' effort=' + state.effort + ' fast=' + state.fast + ' mode=' + state.mode);
  appendFileSync(file(session), JSON.stringify({ type: 'user', text: t }) + '\n');
  if (process.env.FAKE_EFFECTS) appendFileSync(process.env.FAKE_EFFECTS, t + '\n');
  out({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: ['Bash','Edit'], mcp_servers: [], model: state.model, permissionMode: state.mode, slash_commands: [], output_style: 'default', skills: [], plugins: [], apiKeySource: 'none', claude_code_version: '2.1.311', ...base, uuid: crypto.randomUUID() });
  if (t.startsWith('question')) {
    const questions = t === 'question malformed' ? [] : [
      { question: 'Which approach?', header: 'Approach', multiSelect: false, options: [{ label: 'Small', description: 'Minimal change' }, { label: 'Full', description: 'Complete change' }] },
      { question: 'Which checks?', header: 'Checks', multiSelect: true, options: [{ label: 'Unit' }, { label: 'Integration' }] },
    ];
    const input = { questions };
    assistant([{ type: 'tool_use', id: 'tool-question', name: 'AskUserQuestion', input }]);
    // Native Claude always sends interactive AskUserQuestion to the permission host,
    // even when ordinary tools are bypassed. dontAsk deliberately denies questions.
    const r = state.mode === 'dontAsk' ? { behavior: 'deny' } : await ask({ subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input, tool_use_id: 'tool-question' });
    log('question-decision ' + JSON.stringify(r));
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-question', content: r.behavior === 'allow' ? JSON.stringify(r.updatedInput.answers) : r.message ?? 'denied', is_error: r.behavior !== 'allow' }] }, parent_tool_use_id: null, ...base, uuid: crypto.randomUUID() });
    text(r.behavior === 'allow' ? 'answered ' + JSON.stringify(r.updatedInput.answers) : 'question dismissed');
    return result();
  }
  if (t.startsWith('edit')) {
    const input = { file_path: process.cwd() + '/a.txt', old_string: 'one', new_string: 'two' };
    assistant([{ type: 'tool_use', id: 'tool-edit', name: 'Edit', input }]);
    const r = await ask({ subtype: 'can_use_tool', tool_name: 'Edit', input, tool_use_id: 'tool-edit', title: 'Claude wants to edit a.txt', permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'localSettings' }] });
    log('decision ' + r.behavior + (r.updatedPermissions ? ' ' + r.updatedPermissions.map(p => p.destination).join(',') : ''));
    const ok = r.behavior === 'allow';
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-edit', content: ok ? 'Edited' : r.message, is_error: !ok }] }, parent_tool_use_id: null, tool_use_result: ok ? { filePath: input.file_path, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-one', '+two'] }] } : undefined, ...base, uuid: crypto.randomUUID() });
    text(ok ? 'edited' : 'not edited');
    return result();
  }
  if (t.startsWith('slow')) {
    text('Started-');
    while (!interrupted && !(process.env.FAKE_RELEASE && existsSync(process.env.FAKE_RELEASE))) await Bun.sleep(25);
    if (interrupted) return result({ subtype: 'error_during_execution', is_error: true, errors: ['interrupted'] });
    const command = "printf 'once\\n' >> \"$FAKE_TOOL_EFFECTS\"; printf 'hi\\n'";
    assistant([{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command } }]);
    const ran = Bun.spawnSync(['sh', '-c', command]);
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: ran.stdout.toString() }] }, parent_tool_use_id: null, tool_use_result: { stdout: ran.stdout.toString(), stderr: '' }, ...base, uuid: crypto.randomUUID() });
    text('finished offline');
    result();
    if (process.env.FAKE_EFFECTS) writeFileSync(process.env.FAKE_EFFECTS + '.finished', 'done');
    return;
  }
  const lines = existsSync(file(session)) ? readFileSync(file(session), 'utf8').trim().split('\n').filter(l => l.includes('"user"')).length : 0;
  text('reply ' + lines + ' to ' + t);
  result();
}
let busy = Promise.resolve();
for await (const line of console) {
  if (!line.trim()) continue;
  const m = JSON.parse(line);
  if (m.type === 'control_response') { const r = pending.get(m.response.request_id); pending.delete(m.response.request_id); r?.(m.response.response ?? {}); continue; }
  if (m.type === 'user') { busy = busy.then(() => turn(m)); continue; }
  if (m.type !== 'control_request') continue;
  const r = m.request, ok = response => out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, ...(response ? { response } : {}) } });
  if (r.subtype === 'initialize' && r.appendSystemPrompt) log('question-instructions ' + r.appendSystemPrompt);
  log('control ' + r.subtype + (r.subtype === 'set_model' ? ' ' + r.model : r.subtype === 'set_permission_mode' ? ' ' + r.mode : r.subtype === 'apply_flag_settings' ? ' ' + JSON.stringify(r.settings) : ''));
  if (r.subtype === 'initialize') ok({ commands: [], agents: [], output_style: 'default', available_output_styles: ['default'], models, account: { email: 'fixture@example.com', subscriptionType: 'Claude Pro', apiProvider: 'firstParty' }, pid: process.pid, claude_code_version: '2.1.311', current_permission_mode: state.mode, fast_mode_state: 'off', fast_mode_disabled_reason: 'sdk_opt_in_required' });
  else if (r.subtype === 'set_model') { state.model = r.model; ok({ model: r.model }); }
  else if (r.subtype === 'apply_flag_settings') { if ('fastMode' in r.settings) state.fast = r.settings.fastMode === true; if ('effortLevel' in r.settings) state.effort = r.settings.effortLevel; ok(); }
  else if (r.subtype === 'set_permission_mode') { state.mode = r.mode; ok({ mode: r.mode }); }
  else if (r.subtype === 'interrupt') { interrupted = true; ok({}); }
  else out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'Unsupported fixture request ' + r.subtype } });
}
`;
