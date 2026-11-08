// Fills a disposable data folder with threads and OpenBots chats shaped like a long-used install:
// hundreds of threads, most small, a few tens of MB with pasted screenshots and image-reading tool
// calls, and one busy group chat. Deterministic, so runs before and after a change are comparable.
//
//   OPENCHAT_DATA_DIR=/tmp/ob-bench/data bun scripts/bench/seed.ts [--threads 740] [--scale 1]
//
// Refuses to write anywhere but an explicitly given OPENCHAT_DATA_DIR that holds no database yet.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const dir = process.env.OPENCHAT_DATA_DIR;
if (!dir || !process.env.HOME?.startsWith(dir.replace(/\/data\/?$/, ""))) throw new Error("Set OPENCHAT_DATA_DIR to a disposable folder, with HOME beside it (see run.ts)");
if (existsSync(join(dir, "openchat.db"))) throw new Error(`${dir} already has a database; seed an empty folder`);

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const THREADS = arg("threads", 740);
const SCALE = arg("scale", 1);

const storage = await import("../../server/storage");
const bots = await import("../../server/bots/db");

// mulberry32: the same data every run.
let state = 0x9e3779b9;
const rnd = () => {
  state |= 0; state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
const id = () => crypto.randomUUID();

/** A PNG of noise: incompressible, so its size is what a screenshot of that size costs. */
function png(width: number, height: number): string {
  const row = width * 4 + 1;
  const raw = Buffer.alloc(row * height);
  for (let i = 0; i < raw.length; i++) raw[i] = i % row === 0 ? 0 : (rnd() * 256) | 0;
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(Bun.hash.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const file = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${file.toString("base64")}`;
}
// A few sizes, reused: small crops (~70 KB), medium (~250 KB) and full screenshots (~900 KB).
const images = [png(130, 130), png(250, 250), png(470, 470)].map((dataUrl) => ({ dataUrl, size: Math.round(dataUrl.length * 0.75) }));

const WORDS = "the a thread worker render state server client reply stream cache index route sidebar composer draft model token session runtime branch commit review test build bundle layout scroll focus caret".split(" ");
const sentence = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(" ");
const paragraph = () => `${sentence(int(12, 30))}. ${sentence(int(8, 24))}.`;
const code = () => `\`\`\`ts\n${Array.from({ length: int(4, 24) }, (_, i) => `const v${i} = ${pick(["await load", "render", "useStore", "fetch"])}(${JSON.stringify(sentence(2))});`).join("\n")}\n\`\`\``;
const markdown = () => Array.from({ length: int(2, 6) }, () => (rnd() < 0.3 ? code() : rnd() < 0.2 ? `- ${sentence(6)}\n- ${sentence(7)}\n- \`${pick(WORDS)}\` ${sentence(5)}` : paragraph())).join("\n\n");
const output = (lines: number) => Array.from({ length: lines }, (_, i) => `${String(i + 1).padStart(4)}  ${sentence(int(3, 12))}`).join("\n");

function toolPart(): Record<string, unknown> {
  const kind = rnd();
  if (kind < 0.012 * SCALE) {
    // Reading a screenshot: the runtime keeps the image it was shown in the call's args.
    const image = pick(images);
    return { type: "tool", id: id(), name: "read", status: "done", ms: int(5, 80), args: { path: "/tmp/shot.png", claude: { type: "image", source: { type: "base64", media_type: "image/png", data: image.dataUrl.slice(22) } } }, output: "Read image" };
  }
  if (kind < 0.45) return { type: "tool", id: id(), name: "bash", status: rnd() < 0.05 ? "error" : "done", ms: int(20, 9000), args: { command: `bun run test ${pick(WORDS)}` }, output: output(int(5, 120)) };
  if (kind < 0.75) return { type: "tool", id: id(), name: "read", status: "done", ms: int(2, 40), args: { path: `src/lib/${pick(WORDS)}.ts` }, output: output(int(20, 200)) };
  const patch = Array.from({ length: int(3, 40) }, () => `${pick(["+", "-", " "])} ${sentence(int(3, 10))}`).join("\n");
  return { type: "tool", id: id(), name: "edit", status: "done", ms: int(2, 40), args: { path: `src/components/${pick(WORDS)}.tsx`, oldText: sentence(8), newText: sentence(9) }, patch: `@@ -1,3 +1,4 @@\n${patch}` };
}

function assistant(at: number) {
  const parts: Record<string, unknown>[] = [];
  const n = int(4, 60);
  for (let i = 0; i < n; i++) {
    const r = rnd();
    parts.push(r < 0.25 ? { type: "thought", text: paragraph(), ms: int(200, 9000) } : r < 0.4 ? { type: "text", text: markdown() } : toolPart());
  }
  const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n\n") || markdown();
  if (!parts.some((p) => p.type === "text")) parts.push({ type: "text", text });
  return {
    id: id(), role: "assistant", content: text, createdAt: at, startedAt: at, status: "done", workedMs: int(4_000, 900_000),
    model: { plan: "pi", id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5" }, parts,
    usage: { input: int(1000, 90000), output: int(100, 9000), cacheRead: int(0, 400000), cost: rnd() * 2 },
  };
}

function user(at: number) {
  const shots = rnd() < 0.02 * SCALE ? int(1, 9) : 0;
  return {
    id: id(), role: "user", content: paragraph(), createdAt: at,
    attachments: shots ? Array.from({ length: shots }, () => ({ id: id(), name: "image.png", mime: "image/png", ...pick(images) })) : undefined,
  };
}

const now = Date.now();
// Real folders under the disposable HOME, registered the way Settings → Projects stores them.
const home = process.env.HOME!;
const projects = ["openbuild", "openchat", "site", "notes"].map((name, i) => ({ id: `proj${i}`, name, path: join(home, name) }));
for (const p of projects) mkdirSync(p.path, { recursive: true });
storage.setValue("projects", JSON.stringify(projects));
let bytes = 0;
storage.transaction(() => {
  for (let t = 0; t < THREADS; t++) {
    // Most threads are one exchange; a long tail runs for dozens.
    const exchanges = rnd() < 0.7 ? int(1, 3) : rnd() < 0.85 ? int(4, 12) : int(13, 40);
    const updatedAt = now - t * int(60_000, 3_600_000);
    const messages: Record<string, unknown>[] = [];
    let at = updatedAt - exchanges * 600_000;
    for (let e = 0; e < exchanges; e++) {
      messages.push(user(at));
      messages.push(assistant(at + 1000));
      at += 600_000;
    }
    const project = pick(projects);
    const chat = {
      id: `bench-${t.toString().padStart(4, "0")}`,
      title: `${sentence(int(2, 6))} ${t}`.replace(/^./, (c) => c.toUpperCase()),
      titleSource: "auto" as const,
      createdAt: updatedAt - exchanges * 600_000, updatedAt, runtime: "pi" as const,
      messages,
      workspace: { projectId: project.id, projectName: project.name, cwd: project.path },
      ...(t % 37 === 3 ? { pinned: true } : {}),
      // The latest ones finished and wait under "Done"; the rest are closed, by hand or by age.
      ...(t < 60 ? { done: true } : rnd() < 0.5 ? { archived: true } : {}),
      ...(t < 30 && rnd() < 0.2 ? { unread: true } : {}),
    };
    bytes += JSON.stringify(chat).length;
    storage.putChat(chat);
  }
});

// OpenBots: a primary bot, a team, their direct chats and one busy group.
const team = [
  { name: "Pip", look: { shape: "puff", color: "white" }, primary: true },
  { name: "Manager", look: { shape: "tile", color: "blue" } },
  { name: "Tracer", look: { shape: "spark", color: "teal" } },
  { name: "Researcher", look: { shape: "bean", color: "green" } },
  { name: "Quill", look: { shape: "flower", color: "pink" } },
].map((b, i) => ({ id: `bot-${i}`, ...b, instructions: paragraph(), createdAt: now - 30 * 86_400_000, proactivity: "normal" as const, by: "me" }));
for (const b of team) bots.putBot(b as Parameters<typeof bots.putBot>[0]);
const conversations = [
  ...team.map((b, i) => ({ id: `conv-direct-${i}`, kind: "direct" as const, botIds: [b.id], size: [400, 120, 90, 70, 60][i]! })),
  { id: "conv-group", kind: "group" as const, name: "Team", botIds: team.map((b) => b.id), size: 1700 },
  ...[0, 1, 2, 3, 4].map((i) => ({ id: `conv-side-${i}`, kind: "side" as const, botIds: [team[1]!.id, team[2 + (i % 3)]!.id], size: 20 + i * 8 })),
];
let botBytes = 0;
bots.db.transaction(() => {
  for (const [ci, c] of conversations.entries()) {
    const updatedAt = now - ci * 3_600_000;
    bots.putConversation({ id: c.id, kind: c.kind, botIds: c.botIds, name: (c as { name?: string }).name, createdAt: updatedAt - c.size * 60_000, updatedAt });
    for (let m = 0; m < c.size; m++) {
      const author = rnd() < 0.4 ? "me" : pick(c.botIds);
      const message = {
        id: `${c.id}-m${m}`, author, at: updatedAt - (c.size - m) * 60_000, text: rnd() < 0.3 ? markdown() : paragraph(),
        ...(author === "me" && rnd() < 0.004 * SCALE ? { images: Array.from({ length: int(1, 4) }, () => pick(images).dataUrl) } : {}),
      };
      botBytes += JSON.stringify(message).length;
      const seq = bots.addMessage(c.id, message);
      // Read up to here, so the bots don't set about answering a history.
      if (m === c.size - 1) for (const b of c.botIds) bots.setCursor(b, c.id, seq);
    }
  }
})();

console.log(`Seeded ${THREADS} threads (${(bytes / 1e6).toFixed(0)} MB) and ${conversations.length} OpenBots chats (${(botBytes / 1e6).toFixed(1)} MB) in ${dir}`);
