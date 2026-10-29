import { expect, test } from "bun:test";
import { elicit, elicitationMethods } from "../server/fx/questions";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn, answer, hasAsk, release } from "../server/fx/sessions";

test("fx exposes native form elicitation and resumes only after an app answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fx-questions-"));
  const bin = join(dir, "fx");
  const previous = process.env.FX_BIN;
  const threadId = crypto.randomUUID();
  writeFileSync(bin, `#!${process.execPath}\n` + String.raw`
const out = m => process.stdout.write(JSON.stringify(m)+'\n');
if (process.argv.includes('status')) { out({permission_mode:'auto'}); process.exit(0); }
let prompt;
for await (const line of console) {
 const m = JSON.parse(line), reply = result => out({jsonrpc:'2.0',id:m.id,result});
 if(m.method==='initialize') {
   if(!m.params.clientCapabilities.elicitation?.form) process.exit(4);
   reply({protocolVersion:1});
 } else if(m.method==='session/new') reply({sessionId:'native-fx'});
 else if(m.method==='session/prompt') {
   prompt=m.id;
   if(!m.params.prompt.some(p=>p.text?.includes('request_user_input'))) process.exit(5);
   out({jsonrpc:'2.0',id:'form-1',method:'elicitation/create',params:{sessionId:'native-fx',mode:'form',message:'Choose database',requestedSchema:{type:'object',properties:{database:{type:'string',enum:['SQLite','Postgres']}}}}});
 } else if(m.id==='form-1') {
   out({jsonrpc:'2.0',method:'session/update',params:{sessionId:'native-fx',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(m.result)}}}});
   out({jsonrpc:'2.0',id:prompt,result:{stopReason:'end_turn'}});
 } else if(m.id!==undefined) reply({});
}
`);
  chmodSync(bin, 0o700); process.env.FX_BIN = bin;
  try {
    const events: any[] = [];
    for await (const chunk of runTurn({ threadId, cwd: dir, model: "fx/fake", effort: "off", prior: 0, message: "Ask me" }, new AbortController().signal)) {
      for (const line of new TextDecoder().decode(chunk).trim().split("\n").filter(Boolean)) {
        const event = JSON.parse(line); events.push(event);
        if (event.t === "ask") {
          expect(hasAsk(threadId, event.id)).toBe(true);
          expect(event.options).toEqual(["SQLite", "Postgres"]);
          expect(answer(threadId, event.id, { value: "Postgres" })).toBe(true);
          expect(hasAsk(threadId, event.id)).toBe(false);
        }
      }
    }
    expect(events.some(e => e.t === "ask")).toBe(true);
    expect(events.find(e => e.t === "text")?.v).toBe(JSON.stringify({ action: "accept", content: { database: "Postgres" } }));
    expect(events.some(e => e.t === "asked" && e.answer === "Postgres")).toBe(true);
  } finally { release(threadId); process.env.FX_BIN = previous; rmSync(dir, {recursive:true,force:true}); }
}, 10000);

test("fx supports the three ACP elicitation method names", () => {
  expect([...elicitationMethods]).toEqual(["elicitation/create", "session/elicitation", "_session/elicitation"]);
});
test("fx form questions return typed answers keyed by the native field ID", async () => {
  const cards: any[] = [];
  const answers = ["SQLite", "false", "42", "my answer"];
  const response = await elicit({ mode: "form", message: "Configure project", requestedSchema: { type: "object", properties: {
    database: { type: "string", title: "Database", enum: ["Postgres", "SQLite"] },
    publish: { type: "boolean" }, port: { type: "integer", minimum: 1, maximum: 100 }, name: { type: "string" },
  } } }, async card => { cards.push(card); return { value: answers.shift() }; });
  expect(response).toEqual({ action: "accept", content: { database: "SQLite", publish: false, port: 42, name: "my answer" } });
  expect(cards[0]).toMatchObject({ method: "select", options: ["Postgres", "SQLite"] });
  expect(cards[3]).toMatchObject({ method: "input", other: true });
});
test("fx declines URL and unsupported forms without asking", async () => {
  for (const form of [{ mode: "url", url: "https://example.com" }, { mode: "form", requestedSchema: { type: "object", properties: { secret: { type: "string", format: "password" } } } }]) {
    expect(await elicit(form, async () => { throw Error("must not ask"); })).toEqual({ action: "decline" });
  }
});
test("fx dismissal cancels the native request and skips remaining fields", async () => {
  let count = 0;
  expect(await elicit({ mode: "form", requestedSchema: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } } } }, async () => { count++; return { cancelled: true }; })).toEqual({ action: "cancel" });
  expect(count).toBe(1);
});
test("fx never accepts invalid typed answers or values outside an enum", async () => {
  for (const [field, value] of [[{ type: "integer" }, "NaN"], [{ type: "integer" }, "1.5"], [{ type: "number", minimum: 5 }, "3"], [{ type: "string", enum: ["A"] }, "B"]] as const) {
    expect(await elicit({ mode: "form", requestedSchema: { type: "object", properties: { answer: field } } }, async () => ({ value }))).toEqual({ action: "decline" });
  }
});
