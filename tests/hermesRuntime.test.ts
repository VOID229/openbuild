import { FAKE_HERMES } from "./hermesFixture";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "../shared/replies";
import { runTurn, steer, release } from "../server/hermes/sessions";
import { listModels } from "../server/hermes/install";
const dir = mkdtempSync(join(tmpdir(), "ob-hermes-"));
const original = process.env.HERMES_BIN;
const ids: string[] = [];
beforeAll(() => {
  const bin = join(dir, "hermes");
  writeFileSync(bin, `#!${process.execPath}\n` + FAKE_HERMES);
  chmodSync(bin, 0o700); process.env.HERMES_BIN = bin;
});
afterAll(() => { for (const id of ids) release(id); if (original === undefined) delete process.env.HERMES_BIN; else process.env.HERMES_BIN = original; rmSync(dir, { recursive:true, force:true }); });
function request(message: string, threadId = crypto.randomUUID(), prior=0) { ids.push(threadId); return { threadId, message, cwd:dir, prior, model:'hermes/p/m', effort:'off' as const }; }
async function collect(req: ReturnType<typeof request>, signal = new AbortController().signal) { const events = []; for await (const e of readEvents(runTurn(req, signal))) events.push(e); return events; }
test('discovers native models', async () => { const r = await listModels(true); expect(r.defaultModel).toBe('hermes/p/m'); expect(r.models[0]?.name).toBe('Model'); });
test('streams tools and reloads the saved session without replaying history', async () => { const req=request('tools'); const a=await collect(req); expect(a.find(e=>e.t==='tool' && e.status==='done')).toMatchObject({name:'bash',args:{command:'pwd'},output:'ok'}); release(req.threadId); const b=await collect(request('tools',req.threadId,1)); expect(b.some(e=>e.t==='text' && e.v.includes('OLD'))).toBe(false); expect(b.at(-2)).toMatchObject({t:'done',finish:'stop'}); });
test('steers a running turn and records the delivery', async () => { const req=request('hold'); const events:any[]=[]; const done=(async()=>{for await(const e of readEvents(runTurn(req,new AbortController().signal))) {events.push(e); if(e.t==='text' && e.v==='working') await steer(req.threadId,'steer1','correct');}})(); await done; expect(events).toContainEqual({t:'steer',id:'steer1',text:'correct'}); expect(events.some(e=>e.t==='text' && e.v==='corrected')).toBe(true); });
test('turns away images it can never steer, as unsupported rather than not now', async () => { const req=request('hold'); let refused: any; for await(const e of readEvents(runTurn(req,new AbortController().signal))) { if(e.t==='text' && e.v==='working' && !refused) { refused=await steer(req.threadId,'image','look',[{data:'aA==',mimeType:'image/png'}]).then(()=>undefined,(err)=>err); await steer(req.threadId,'words','correct'); } } expect(refused?.message).toContain('requires text'); expect(refused?.code).toBe('steer_unsupported'); });
test('cancels through ACP', async () => {const req=request('hold'), controller=new AbortController(); const events=[];for await(const e of readEvents(runTurn(req,controller.signal))) {events.push(e);if(e.t==='text')controller.abort();} expect(events.at(-2)).toMatchObject({t:'done',finish:'aborted'});});
