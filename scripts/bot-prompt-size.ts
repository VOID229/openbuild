// How big a bot's always-on prompt text is: the system prompt OpenBots gives Pi plus the context
// sections (contextFor) and the apps note, for a representative primary bot. Tool JSON schemas,
// the machines note and the web search note aren't counted: this measures the text only.
//
// Runs on sample data in a throwaway data directory of its own, never the live one:
//   bun scripts/bot-prompt-size.ts           prints before/after as JSON
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
  for (const text of ["Likes tea", "Works Tuesday to Saturday", "Prefers short answers"]) svc.addMemory(boss.bot.id, text);

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

const tokens = (chars: number) => Math.round(chars / BYTES_PER_TOKEN);
const sum = (m: { systemPrompt: number; context: number; apps: number }) => m.systemPrompt + m.context + m.apps;

if (import.meta.main) {
  const dir = mkdtempSync(join(tmpdir(), "openbots-prompt-size-"));
  Object.assign(process.env, { OPENCHAT_DATA_DIR: dir, PI_BIN: join(dir, "no-pi"), PI_CODING_AGENT_DIR: join(dir, "pi"), OPENCHAT_SECRETS: "file", OPENCHAT_SECRETS_FILE: join(dir, "secrets.json") });
  try {
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
