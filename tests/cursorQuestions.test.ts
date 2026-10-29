import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StreamEvent } from "../shared/types";
import { createQuestions } from "../server/cursor/questions";

function transport(events: StreamEvent[]) {
  const q = createQuestions(e => events.push(e));
  const config = JSON.parse(readFileSync(join(q.pluginDir, ".mcp.json"), "utf8"));
  const url: string = config.mcpServers["openbuild-questions"].url;
  const post = (method: string, params?: object, id: number | string = crypto.randomUUID()) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  return { q, url, post };
}
async function waitForAsk(events: StreamEvent[], count = 1) {
  for (let i = 0; i < 200; i++) { if (events.filter(e => e.t === "ask").length >= count) return events.filter(e => e.t === "ask")[count - 1]!; await Bun.sleep(5); }
  throw new Error("Question not emitted");
}
test("Cursor MCP real HTTP initialization, capability isolation and free-text round trip", async () => {
  const events: StreamEvent[] = [], { q, url, post } = transport(events);
  try {
    expect(JSON.parse(readFileSync(join(q.pluginDir, ".cursor-plugin/plugin.json"), "utf8"))).toEqual({ name: "openbuild-questions" });
    expect(url).toStartWith("http://127.0.0.1:");
    expect((await (await post("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } })).json()).result).toMatchObject({ capabilities: { tools: {} }, serverInfo: { name: "openbuild-questions" } });
    const tools = (await (await post("tools/list")).json()).result.tools;
    expect(tools.map((t: any) => t.name)).toEqual(["question_ask"]);
    const response = post("tools/call", { name: "question_ask", arguments: { question: "Pick one?", options: ["A", "B"] } });
    const ask = await waitForAsk(events);
    expect(ask).toMatchObject({ method: "select", options: ["A", "B"], other: true });
    expect(q.hasAsk(ask.id)).toBe(true);
    expect(q.answer(ask.id, { value: "my custom answer" })).toBe(true);
    expect(q.answer(ask.id, { value: "duplicate" })).toBe(false);
    expect(q.hasAsk(ask.id)).toBe(false);
    expect(JSON.parse((await (await response).json()).result.content[0].text)).toEqual({ answer: "my custom answer" });
    expect(events.at(-1)).toEqual({ t: "asked", id: ask.id, answer: "my custom answer" });
    expect((await fetch(url.replace(/\/mcp\/.*/, "/mcp/wrong"), { method: "POST" })).status).toBe(404);
    expect((await fetch(url, { method: "POST", headers: { Origin: "https://evil.example" } })).status).toBe(404);
    expect((await fetch(url)).status).toBe(405);
    expect((await (await post("tools/call", { name: "shell", arguments: {} })).json()).error.code).toBe(-32602);
    expect((await (await post("tools/call", { name: "question_ask", arguments: { question: "bad", options: [null] } })).json()).error.code).toBe(-32602);
    expect((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(65537) })).status).toBe(413);
  } finally { q.close(); }
  expect(existsSync(q.pluginDir)).toBe(false);
  await expect(fetch(url)).rejects.toThrow();
});
test("Cursor question options match Pi normalization and can be omitted", async () => {
  const events: StreamEvent[] = [], { q, post } = transport(events);
  try {
    const selected = post("tools/call", { name: "question_ask", arguments: { question: "Pick", options: [" A ", "A", "", "Other", "Something else", "B"] } });
    const choice = await waitForAsk(events);
    expect(choice.options).toEqual(["A", "B"]);
    q.answer(choice.id, { value: "A" }); await selected;
    const open = post("tools/call", { name: "question_ask", arguments: { question: "Your words?" } });
    const free = await waitForAsk(events, 2);
    expect(free).toMatchObject({ method: "input", options: [], other: true });
    q.answer(free.id, { value: "Custom" });
    expect(JSON.parse((await (await open).json()).result.content[0].text)).toEqual({ answer: "Custom" });
  } finally { q.close(); }
});

test("Cursor questions support dismissal, independent turns and cleanup", async () => {
  const events: StreamEvent[] = [], one = transport(events), two = transport([]);
  try {
    const response = one.post("tools/call", { name: "question_ask", arguments: { question: "What now?", options: [] } });
    const ask = await waitForAsk(events);
    expect(two.q.answer(ask.id, { value: "wrong thread" })).toBe(false);
    expect(one.q.answer(ask.id, { cancelled: true })).toBe(true);
    expect(JSON.parse((await (await response).json()).result.content[0].text)).toEqual({ cancelled: true });
    const interrupted = one.post("tools/call", { name: "question_ask", arguments: { question: "Will abort", options: ["A"] } }).catch(() => undefined);
    const next = await waitForAsk(events, 2);
    one.q.close(); one.q.close();
    expect(one.q.hasAsk(next.id)).toBe(false);
    expect(events.at(-1)).toEqual({ t: "asked", id: next.id });
    expect(existsSync(one.q.pluginDir)).toBe(false);
    await interrupted;
  } finally { one.q.close(); two.q.close(); }
});
