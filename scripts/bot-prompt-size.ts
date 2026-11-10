// How big a bot's always-on prompt text is: the system prompt OpenBots gives Pi plus the context
// sections (contextFor) and the apps note, for a representative primary bot. Tool JSON schemas,
// the machines note and the web search note aren't counted: this measures the text only.
//
// Runs on sample data in a throwaway data directory of its own, never the live one:
//   bun scripts/bot-prompt-size.ts           prints before/after as JSON
//   bun scripts/bot-prompt-size.ts --memory  the per-turn memory context of a bot with many memories
//   bun scripts/bot-prompt-size.ts --tools   the tool declarations every request carries
//
// "before" is the same sample measured at origin/main 19cc40b, where Pi's default coding-assistant
// prompt (preamble, tools, rules and docs sections, as Pi 1.5.1 builds them for a bot's tool list)
// was sent ahead of OpenBots' own text.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The repo's estimate: see scripts/bot-context-audit.ts. */
export const BYTES_PER_TOKEN = 4.28;

/** Measured at origin/main 19cc40b with this script's sample, in characters. */
export const BEFORE = {
  /** Pi 1.5.1's default prompt for a bot's tool list (preamble + tools + rules + docs; docs paths from ~/.pi/agent/install), with --system-prompt "". */
  systemPrompt: 1660,
  /** contextFor() of the sample primary bot. */
  context: 12067,
  /** apps.contextNote() of the sample apps. */
  apps: 4907,
};

const LONG = (role: string) =>
  `${role} ` +
  "You keep the user's week on track. Check their calendar every morning, flag clashes early, and suggest what to move. Keep a running list of open loops and bring them up when they're relevant, not all at once. Prefer short updates over long reports; ask before you book or cancel anything. When something's unclear, ask one question rather than guessing, and remember the answer for next time. ".repeat(3);

export async function measure(): Promise<{ systemPrompt: number; context: number; apps: number; text: string }> {
  const svc = await import("../server/bots/service.ts");
  const db = await import("../server/bots/db.ts");
  const agent = await import("../server/bots/agent.ts");
  const apps = await import("../server/bots/apps.ts");
  const { BOT_SYSTEM_PROMPT } = (await import("../server/bots/extensions.ts")) as { BOT_SYSTEM_PROMPT?: string };
  svc.setHooks({ wake() {}, stop() {} });
  svc.updateSettings({ onboarding: "done", user: { name: "Gal", context: "Runs a small design studio; codes on weekends." } });

  const boss = svc.createBot({ name: "Boss", instructions: LONG("You are the user's main assistant and coordinate the other bots.") });
  const planner = svc.createBot({ name: "Planner", instructions: LONG("You plan the user's days and weeks.") });
  const scout = svc.createBot({ name: "Scout", instructions: LONG("You research products, places and prices before the user buys anything.") });
  svc.updateBot(boss.bot.id, { threads: { enabled: true, scope: "all", projects: [] } });
  const all = [boss.bot.id, planner.bot.id, scout.bot.id];
  svc.createConversation({ kind: "group", name: "Weekend trip", botIds: all });
  svc.createConversation({ kind: "group", name: "Studio admin", botIds: all });
  svc.createConversation({ kind: "group", name: "House move", botIds: [boss.bot.id, planner.bot.id] });
  for (const text of ["Likes tea", "Works Tuesday to Saturday", "Prefers short answers"]) svc.addMemory(boss.bot.id, text, { kind: "profile" });

  const tool = (app: string, i: number) => ({ name: `${app}_${["list", "get", "create", "update", "delete", "search"][i % 6]}_${["issues", "pull_requests", "files", "comments", "branches", "pages", "databases"][i % 7]}_${i}`, description: "Does one thing in the service." });
  db.setValue("apps", {
    github: { status: "connected", connectedAt: 1, fields: { access: "read" }, tools: Array.from({ length: 45 }, (_, i) => tool("gh", i)), toolsAt: Date.now() },
    notion: {
      status: "connected",
      connectedAt: 1,
      tools: Array.from({ length: 25 }, (_, i) => tool("notion", i)),
      toolsAt: Date.now(),
      skills: Array.from({ length: 6 }, (_, i) => ({ name: `notion-skill-${i}`, description: "How to do a common Notion task well, from the publisher: which tools to call, in what order, and what to check before writing anything to the user's workspace.", files: [] })),
    },
    linear: { status: "needs-auth", tools: [] },
  });

  const context = agent.contextFor(boss.bot.id);
  const note = apps.contextNote();
  const system = BOT_SYSTEM_PROMPT ?? "";
  return { systemPrompt: system.length, context: context.length, apps: note.length, text: [system, context, note].filter(Boolean).join("\n\n") };
}

// ------------------------------------------------------------------ memory context
//
// What a bot with a lot of memory pays for it on every turn. "before" is origin/main 5356490, where
// the memory section was every memory, newest first, up to 40 of them and 6000 bytes, as
// "- [id8] text" lines under "Things you remember:". "after" is the profile and the latest journal
// entries (memorySection). Both are measured on the same sample, written in the same order.

const PROFILE_FACTS = [
  "Gal runs a small design studio with four people and codes on weekends.",
  "Prefers short answers; no bullet lists unless asked.",
  "Works Tuesday to Saturday; Monday is off, so nothing is scheduled then.",
  "Is vegetarian, and allergic to hazelnuts.",
  "Lives in Lisbon; home time zone is Europe/Lisbon.",
  "Ask before booking or cancelling anything that costs money.",
  "Invoices go out on the 1st through the accounting app, never by email.",
  "The studio's main client is Northwind; Carla is the contact there.",
  "Wants a one-line summary first, details only when asked.",
  "Flies from LIS and prefers a morning aisle seat.",
  "Partner is Noa; their anniversary is on 14 June.",
  "Uses the calendar called Studio for work and Home for everything else.",
];
const JOURNAL_SUBJECTS = ["the Northwind rebrand", "the studio's lease renewal", "the Porto offsite", "Q3 invoices", "the new portfolio site", "hiring a junior designer", "the accountant's questions", "the weekend trip to Sintra", "the type licence audit"];
const JOURNAL_EVENTS = [
  "Gal approved the second round of concepts and asked for a darker palette before Friday.",
  "sent the draft to Carla; she'll answer after her board meets on Thursday.",
  "moved the review to next Wednesday at 10:00 because two people were out sick.",
  "found the quote was 12% over budget, and Gal chose the cheaper of the two options.",
  "booked nothing yet: waiting on Noa's dates before picking the hotel.",
  "the first candidate declined; two more interviews are set for the week after.",
  "closed out the open questions and filed the notes in Notes/Studio.md.",
];
/** The many-memory sample, oldest first: the lasting facts a bot learns early, then months of notes. */
export function manyMemories(): { kind: "profile" | "journal"; text: string }[] {
  const journal = Array.from({ length: 108 }, (_, i) => ({ kind: "journal" as const, text: `Day ${i + 1}, on ${JOURNAL_SUBJECTS[i % JOURNAL_SUBJECTS.length]}: ${JOURNAL_EVENTS[i % JOURNAL_EVENTS.length]}` }));
  return [...PROFILE_FACTS.map((text) => ({ kind: "profile" as const, text })), ...journal];
}

/** The memory section as origin/main 5356490 built it (sessionPolicy.memoryContext under agent.contextSections), from memories newest first. */
export function memorySectionBefore(items: { id: string; text: string }[]): string {
  let budget = 6000;
  const lines: string[] = [];
  for (const item of items.slice(0, 40)) {
    const line = `- [${item.id.slice(0, 8)}] ${item.text}`;
    const bytes = Buffer.byteLength(line + "\n");
    if (bytes > budget) continue;
    lines.push(line);
    budget -= bytes;
  }
  return items.length ? `Things you remember:\n${lines.join("\n")}` : "You haven't written any memories yet.";
}

export async function measureMemory(): Promise<{ memories: number; profile: number; journal: number; before: string; after: string }> {
  const svc = await import("../server/bots/service.ts");
  const db = await import("../server/bots/db.ts");
  const agent = await import("../server/bots/agent.ts");
  svc.setHooks({ wake() {}, stop() {} });
  svc.updateSettings({ onboarding: "done", user: { name: "Gal" } });
  const bot = svc.createBot({ name: "Boss", instructions: "You are the user's main assistant." }).bot;
  const sample = manyMemories();
  for (const m of sample) svc.addMemory(bot.id, m.text, { kind: m.kind, by: bot.id });
  const stored = db.memories(bot.id);
  if (stored.length !== sample.length) throw new Error(`The sample has ${sample.length} memories and ${stored.length} were stored.`);
  return { memories: stored.length, profile: stored.filter((m) => m.kind === "profile").length, journal: stored.filter((m) => m.kind === "journal").length, before: memorySectionBefore(stored), after: agent.contextSections(bot.id).openbots_memory ?? "" };
}

// ------------------------------------------------------------------ tool declarations
//
// What a request declares, as each provider gets it: every active tool's name, description and JSON
// schema. "before" is origin/main 6e31329, where all 24 OpenBots tools were declared on every request.
// "after" is the core set (CORE_TOOLS, load_tools' catalog included) a request carries until the bot
// loads more; each tool it loads then costs its own declaration, from the next request on.

/** All 24 tools' declarations at origin/main 6e31329, in characters, measured as declaration() does. */
export const TOOLS_BEFORE = 29660;

const declaration = (t: { name: string; description: string; parameters: unknown }) => JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters });

export async function measureTools(): Promise<{ core: Record<string, number>; catalog: number; loadable: Record<string, number> }> {
  const { default: openbots, CORE_TOOLS } = await import("../server/bots/extension.ts");
  const tools: any[] = [];
  openbots({ on() {}, registerTool(t: any) { tools.push(t); } });
  const load = tools.find((t) => t.name === "load_tools");
  const core = Object.fromEntries(tools.filter((t) => CORE_TOOLS.includes(t.name)).map((t) => [t.name, declaration(t).length]));
  const loadable = Object.fromEntries(tools.filter((t) => !CORE_TOOLS.includes(t.name)).map((t) => [t.name, declaration(t).length]).sort((a, b) => b[1] - a[1]));
  return { core, catalog: load.description.length - load.description.indexOf("\n"), loadable };
}

const tokens = (chars: number) => Math.round(chars / BYTES_PER_TOKEN);
const sum = (m: { systemPrompt: number; context: number; apps: number }) => m.systemPrompt + m.context + m.apps;

if (import.meta.main) {
  const dir = mkdtempSync(join(tmpdir(), "openbots-prompt-size-"));
  Object.assign(process.env, { OPENCHAT_DATA_DIR: dir, PI_BIN: join(dir, "no-pi"), PI_CODING_AGENT_DIR: join(dir, "pi"), OPENCHAT_SECRETS: "file", OPENCHAT_SECRETS_FILE: join(dir, "secrets.json") });
  try {
    if (process.argv.includes("--tools")) {
      const m = await measureTools();
      const after = Object.values(m.core).reduce((a, b) => a + b, 0);
      const sizes = Object.values(m.loadable).sort((a, b) => a - b);
      const size = (chars: number) => ({ chars, approxTokens: tokens(chars) });
      console.log(JSON.stringify({
        before: { tools: 24, ...size(TOOLS_BEFORE) },
        after: { tools: Object.keys(m.core), ...size(after), catalog: size(m.catalog) },
        saved: { chars: TOOLS_BEFORE - after, approxTokens: tokens(TOOLS_BEFORE) - tokens(after), percent: Math.round((1 - after / TOOLS_BEFORE) * 100) },
        loadOne: { median: size(sizes[Math.floor(sizes.length / 2)]!), smallest: size(sizes[0]!), largest: size(sizes.at(-1)!), each: Object.fromEntries(Object.entries(m.loadable).map(([k, v]) => [k, tokens(v)])) },
        estimate: `chars / ${BYTES_PER_TOKEN}`,
      }, null, 1));
      process.exit(0);
    }
    if (process.argv.includes("--memory")) {
      const m = await measureMemory();
      if (process.argv.includes("--print")) console.error(`--- before\n${m.before}\n--- after\n${m.after}`);
      const size = (text: string) => ({ chars: text.length, approxTokens: tokens(text.length), lines: text.split("\n").length });
      const [before, after] = [size(m.before), size(m.after)];
      console.log(JSON.stringify({ sample: { memories: m.memories, profile: m.profile, journal: m.journal }, before, after, saved: { chars: before.chars - after.chars, approxTokens: before.approxTokens - after.approxTokens, percent: Math.round((1 - after.chars / before.chars) * 100) }, estimate: `chars / ${BYTES_PER_TOKEN}` }, null, 1));
      process.exit(0);
    }
    const after = await measure();
    if (process.argv.includes("--print")) console.error(after.text);
    const row = (m: { systemPrompt: number; context: number; apps: number }) => ({ ...m, total: sum(m), approxTokens: tokens(sum(m)) });
    const { text: _, ...now } = after;
    console.log(JSON.stringify({ before: row(BEFORE), after: row(now), saved: { chars: sum(BEFORE) - sum(now), approxTokens: tokens(sum(BEFORE)) - tokens(sum(now)) }, estimate: `chars / ${BYTES_PER_TOKEN}` }, null, 1));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  process.exit(0);
}
