import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { laneDirectory, sessionGeneration, SESSION_MAX_AGE, SESSION_MAX_BYTES, memoryContext, compactionPolicy, COMPACT_AT, deliveryIdentity, readDeliveries, saveDeliveries } from "../server/bots/sessionPolicy";
import { spawnScript } from "./spawnScript";

test("bot and conversation lanes are independent including friend conversations", () => {
  const paths = new Set([laneDirectory("/tmp", "a", "direct"), laneDirectory("/tmp", "a", "friend"), laneDirectory("/tmp", "b", "direct")]);
  expect(paths.size).toBe(3);
  expect(laneDirectory("/tmp", "a", "direct", "friend:one")).not.toBe(laneDirectory("/tmp", "a", "direct", "friend:two"));
  expect(laneDirectory("/tmp", "a", "direct", "friend:one")).not.toBe(laneDirectory("/tmp", "a", "direct"));
  expect(laneDirectory("/tmp", "a/b", "c")).not.toBe(laneDirectory("/tmp", "a", "b/c"));
});
test("size and age rotate retained generations and delivery ledgers start fresh", () => {
  const root = mkdtempSync(join(tmpdir(), "bot-policy-"));
  try {
    const first = sessionGeneration(root, 1000);
    const keys = new Set([deliveryIdentity("conversation", { id: "full-id", text: "private" })]);
    saveDeliveries(first, keys);
    expect(readDeliveries(first)).toEqual(keys);
    writeFileSync(join(first, "session.jsonl"), Buffer.alloc(SESSION_MAX_BYTES));
    expect(sessionGeneration(root, 1001)).toBe(first); // uncertain work cannot rotate
    writeFileSync(join(first, "settled"), "");
    const second = sessionGeneration(root, 1001);
    expect(second).not.toBe(first);
    expect(existsSync(join(first, "session.jsonl"))).toBe(true);
    expect(readDeliveries(second).size).toBe(0);
    expect(sessionGeneration(root, 1002)).toBe(second);
    writeFileSync(join(second, "settled"), "");
    expect(sessionGeneration(root, 1001 + SESSION_MAX_AGE)).not.toBe(second);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("memory byte budget handles unicode and oversized notes without truncating stored memory", () => {
  const items = [{ id: "long", text: "😃".repeat(100) }, { id: "short", text: "remember" }];
  const result = memoryContext(items, 50);
  expect(Buffer.byteLength(result)).toBeLessThanOrEqual(50);
  expect(result).toContain("remember");
  expect(items[0]!.text.length).toBe(200);
});
test("delivery identity uses full ids and content including edits and reactions", () => {
  const base = { id: "12345678-a", text: "hello" };
  const key = deliveryIdentity("c", base);
  expect(key).toBe(deliveryIdentity("c", { ...base, seenBy: ["bot"] }));
  expect(key).not.toBe(deliveryIdentity("c", { ...base, id: "12345678-b" }));
  expect(key).not.toBe(deliveryIdentity("c", { ...base, reactions: [{ by: "me", emoji: "❤️" }] }));
  expect(key).not.toBe(deliveryIdentity("other", base));
});

test("real Pi loads bot-only compaction settings with explicit project approval, without a model call", async () => {
  const { piBin } = await import("../server/pi/install");
  if (!piBin()) return;
  const { PiProcess } = await import("../server/pi/rpc");
  const { mkdirSync, readFileSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "bot-settings-"));
  let proc: InstanceType<typeof PiProcess> | undefined;
  try {
    mkdirSync(join(root, ".pi"));
    mkdirSync(join(root, "agent"));
    const policy = { enabled: true, reserveTokens: 65536, keepRecentTokens: 8000, modelOverrides: { "test/big": { reserveTokens: 868928, keepRecentTokens: 8000 } } };
    writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({ compaction: policy }));
    const extension = join(root, "inspect.ts");
    writeFileSync(extension, `import { writeFileSync } from 'node:fs'; export default function(pi) { pi.on('session_start', () => writeFileSync(${JSON.stringify(join(root, "effective.json"))}, JSON.stringify(pi.getSettings().compaction))); }`);
    proc = new PiProcess(["--approve", "--no-session", "--no-extensions", "--no-skills", "--no-mcp", "-e", extension], root, { PI_CODING_AGENT_DIR: join(root, "agent") });
    await proc.send({ type: "get_state" });
    expect(JSON.parse(readFileSync(join(root, "effective.json"), "utf8"))).toEqual(policy);
  } finally {
    proc?.close();
    if (proc) await proc.ended;
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("compaction starts at 3/4 of small windows and at a fixed bound on large ones", () => {
  const policy = compactionPolicy([...[32768, 65536, 200000, 1000000].map(contextWindow => ({ provider: "test", id: String(contextWindow), contextWindow })), { provider: "test", id: "unknown" }]);
  expect(policy.modelOverrides["test/32768"]).toEqual({ reserveTokens: 8192, keepRecentTokens: 2048 });
  expect(policy.modelOverrides["test/65536"]).toEqual({ reserveTokens: 16384, keepRecentTokens: 4096 });
  // Pi compacts once context exceeds window - reserve: here at COMPACT_AT, not near the window.
  expect(200000 - policy.modelOverrides["test/200000"]!.reserveTokens).toBe(COMPACT_AT);
  expect(policy.modelOverrides["test/1000000"]).toEqual({ reserveTokens: 1000000 - COMPACT_AT, keepRecentTokens: 8000 });
  expect(policy.modelOverrides["test/unknown"]).toBeUndefined();
  expect(policy).toMatchObject({ enabled: true, reserveTokens: 16384, keepRecentTokens: 8000 });
});

test("transcript suppresses committed context, retains explicit assignments and exposes reaction changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "bot-dedup-"));
  try {
    const { code, stderr } = await spawnScript(`
      import { strict as a } from 'node:assert';
      const svc = await import('./server/bots/service.ts');
      const runner = await import('./server/bots/runner.ts');
      const bot = svc.createBot({ name: 'Test' });
      const message = { id: crypto.randomUUID(), author: 'me', text: 'CONTEXT_CANARY', at: Date.now() };
      svc.postMessage(bot.conversationId, message);
      const bots = [bot.bot], delivered = new Set(), candidates = new Set();
      const first = runner.transcript(bot.conversationId, bots, 'User', bot.bot.id, undefined, delivered, candidates);
      a.match(first, /CONTEXT_CANARY/);
      const second = runner.transcript(bot.conversationId, bots, 'User', bot.bot.id, undefined, candidates);
      a.doesNotMatch(second, /CONTEXT_CANARY/);
      a.match(second, /nothing new since you last saw it/);
      const assigned = runner.transcript(bot.conversationId, bots, 'User', bot.bot.id, [message.id], candidates);
      a.match(assigned, /assigned request: answer this.*CONTEXT_CANARY/);
      svc.toggleReaction(bot.conversationId, message.id, '❤️', bot.bot.id);
      const changed = runner.transcript(bot.conversationId, bots, 'User', bot.bot.id, undefined, candidates);
      a.match(changed, /CONTEXT_CANARY/);
      a.match(changed, /❤️/);
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: root });
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
