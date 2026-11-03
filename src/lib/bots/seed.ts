// Sample bots and chats, kept so the shapes the UI renders can be built in one place. The app no
// longer loads them: the server creates the primary bot the first time OpenBots starts.
import { uid } from "../id";
import type { Bot, BotMessage, Conversation, Reaction } from "./types";

const MIN = 60_000;

/** A time `daysAgo` days back at hh:mm, or (for today) never later than a few minutes ago. */
function at(daysAgo: number, hh: number, mm: number): number {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
}

function bot(name: string, shape: string, color: string, instructions: string, extra: Partial<Bot> = {}): Bot {
  return { id: uid(), name, look: { shape, color }, instructions, memory: [], routines: [], createdAt: Date.now() - 3 * 24 * 60 * MIN, ...extra };
}

type Line = Omit<BotMessage, "id"> & { key?: string; replyKey?: string };

/** Messages from short lines; `key`/`replyKey` link a reply to what it answers. */
function thread(lines: Line[]): BotMessage[] {
  const ids = new Map<string, string>();
  return lines.map(({ key, replyKey, ...m }) => {
    const id = uid();
    if (key) ids.set(key, id);
    return { ...m, id, replyTo: replyKey ? ids.get(replyKey) : undefined };
  });
}

const react = (emoji: string, by: string, when: number): Reaction => ({ emoji, by, at: when });

export function seedBots(): { bots: Bot[]; conversations: Conversation[] } {
  const now = Date.now();
  // Today's messages run up to a few minutes ago, whatever the time is now.
  const today = (minutesAgo: number) => now - minutesAgo * MIN;

  const pip = bot("Pip", "puff", "white", "You're the user's general helper. Keep answers short and friendly, and hand work to the other bots when it's theirs.", {
    primary: true,
    memory: [{ id: uid(), text: "Prefers short answers, no bullet lists unless asked", at: now - 2 * 24 * 60 * MIN }],
  });
  const juniper = bot("Juniper · notes", "tile", "blue", "Look after the user's notes: reading list, reminders, the odd to-do. Write things down before saying they're done.", {
    memory: [
      { id: uid(), text: "Reading list lives in Notes/Reading.md", at: at(1, 18, 5) },
      { id: uid(), text: "Waters the plants every other evening", at: today(30) },
    ],
    routines: [
      { id: uid(), title: "Water the plants", schedule: "Every other day at 20:00", enabled: true },
      { id: uid(), title: "Tidy up the week's notes", schedule: "Sundays at 10:00", enabled: false },
    ],
  });
  const scout = bot("Scout · research", "spark", "teal", "Find things out: prices, options, sources. Say where each number came from.");
  const tally = bot("Tally", "bean", "green", "Keep track of money: budgets, subscriptions, splitting costs. Round to whole euros.", {
    routines: [{ id: uid(), title: "Subscriptions check", schedule: "1st of each month at 09:00", enabled: true }],
  });
  const quill = bot("Quill", "flower", "pink", "Help with writing: tighten drafts, suggest titles, keep the user's voice.");
  const ember = bot("Ember", "orb", "orange", "A running coach. Plan easy weeks after hard ones and check in after each run.", {
    routines: [{ id: uid(), title: "Morning run check-in", schedule: "Weekdays at 07:30", enabled: true }],
  });
  const rook = bot("Rook", "gem", "purple", "Review code changes the user shares. Point out real bugs first, style last.");

  const conversations: Conversation[] = [];
  const add = (c: Omit<Conversation, "id" | "createdAt" | "updatedAt">) => {
    const updatedAt = c.messages.at(-1)?.at ?? now;
    conversations.push({ ...c, id: uid(), createdAt: c.messages[0]?.at ?? now, updatedAt });
  };

  add({
    kind: "direct",
    botIds: [pip.id],
    pinnedAt: 1,
    messages: thread([
      { author: pip.id, at: at(2, 9, 12), text: "Hi! I'm Pip, your first bot. Ask me anything, or make more bots for the things you do often." },
      { author: pip.id, at: at(2, 9, 12), text: "Bots keep their own memory and instructions. Put a few in a group and they'll split up the work." },
      { author: "me", at: at(2, 9, 20), text: "hey pip 👋", reactions: [react("👋", pip.id, at(2, 9, 20))] },
      { author: pip.id, at: at(2, 9, 20), text: "Hey! Try pinning the bots you talk to most. They show up big at the top." },
    ]),
  });

  add({
    kind: "direct",
    botIds: [juniper.id],
    pinnedAt: 2,
    messages: thread([
      { author: "me", at: at(1, 18, 2), text: "Can you keep a running list of the books I want to read?" },
      { author: juniper.id, at: at(1, 18, 2), text: "Sure. I started a Reading list note." },
      { author: juniper.id, at: at(1, 18, 3), text: "Anything on it yet, or should I start it empty?" },
      { author: "me", at: at(1, 18, 4), text: "Piranesi and The Dispossessed", reactions: [react("👍", juniper.id, at(1, 18, 4))] },
      { author: juniper.id, at: at(1, 18, 5), text: "Added both. When you finish one I'll tell you what's next.", reactions: [react("❤️", "me", at(1, 18, 6))] },
      { author: juniper.id, at: at(1, 18, 5), text: "", event: { kind: "memory", text: "Remembered", detail: "Reading list lives in Notes/Reading.md" } },
      { author: "me", at: today(32), text: "remind me to water the plants tonight" },
      { author: juniper.id, at: today(32), text: "On it." },
      { author: juniper.id, at: today(31), text: "", event: { kind: "routine", text: "Created routine", detail: "Water the plants · 20:00" } },
      { key: "ask", author: juniper.id, at: today(31), text: "I'll ping you here at 8 pm. Just tonight, or every evening?" },
      { author: "me", at: today(30), replyKey: "ask", text: "every other day is enough", seenBy: [juniper.id] },
      { author: juniper.id, at: today(30), text: "Done: **every other day at 8 pm**, starting tonight.", reactions: [react("🙏", "me", today(29))] },
    ]),
  });

  const lisbon = thread([
    { author: "me", at: today(26), text: "", event: { kind: "created", text: "Created the group", detail: "Lisbon weekend" } },
    { author: "me", at: today(26), text: "Let's plan a weekend in Lisbon, mid December. Around €600 all in.", reactions: [react("🔥", scout.id, today(25)), react("👍", tally.id, today(25))] },
    { author: pip.id, at: today(25), text: "Love it. I'll split this up so everyone has a piece:" },
    {
      author: pip.id,
      at: today(25),
      text: "",
      plan: {
        title: "Lisbon weekend",
        steps: [
          { text: "Find flights and two places to stay", bot: scout.id, status: "done" },
          { text: "Keep the total under €600", bot: tally.id, status: "doing" },
          { text: "Packing list and a loose itinerary", bot: juniper.id, status: "todo" },
        ],
      },
    },
    { key: "flights", author: scout.id, at: today(21), text: "Return flights for Fri 11 – Sun 13 Dec: **€189** on the early Friday one, **€232** leaving Friday evening." },
    { author: scout.id, at: today(21), text: "Both direct. The early one lands at 10:40, so you get the whole first day." },
    { author: tally.id, at: today(19), replyKey: "flights", text: "The early one leaves €411 for the rest. Two nights in Alfama run €140–€210, so there's room for food and a day trip to Sintra." },
    {
      author: pip.id,
      at: today(18),
      text: "One thing I need from you:",
    },
    {
      author: pip.id,
      at: today(18),
      text: "",
      question: {
        title: "Which flight should Scout hold?",
        hint: "Scout and Tally both lean toward the early one.",
        options: [
          { key: "A", label: "Early Friday (€189)" },
          { key: "B", label: "Friday evening (€232)" },
          { key: "C", label: "Look at Saturday too" },
        ],
      },
    },
    { author: juniper.id, at: today(17), text: "Whichever it is, I'll start the itinerary note once it's booked." },
  ]);
  add({ kind: "group", name: "Lisbon weekend", botIds: [pip.id, scout.id, tally.id, juniper.id], pinnedAt: 3, instructions: "Plan a three-day trip to Lisbon in mid December for under €600, flights included.", messages: lisbon });

  add({
    kind: "side",
    botIds: [scout.id, tally.id],
    messages: thread([
      { author: scout.id, at: today(24), text: "Tally, is the €600 the total or per night?" },
      { author: tally.id, at: today(24), text: "Total, flights included." },
      { author: scout.id, at: today(23), text: "Got it. I'll drop anything over €110 a night.", reactions: [react("👍", tally.id, today(23))] },
      { author: tally.id, at: today(22), text: "I'll keep a running total in the group so nobody has to ask." },
    ]),
  });

  add({
    kind: "direct",
    botIds: [ember.id],
    unread: true,
    messages: thread([
      { author: ember.id, at: at(1, 7, 30), text: "Morning! Easy 5 km today, keep it conversational." },
      { author: "me", at: at(1, 8, 40), text: "done, felt good", reactions: [react("🎉", ember.id, at(1, 8, 41))] },
      { author: ember.id, at: today(12), text: "Rest day today. Tomorrow: 6 km with four short pickups in the middle." },
    ]),
  });

  add({
    kind: "direct",
    botIds: [tally.id],
    messages: thread([
      { author: tally.id, at: at(3, 9, 0), text: "", event: { kind: "routine", text: "Ran routine", detail: "Subscriptions check" } },
      { author: tally.id, at: at(3, 9, 0), text: "Three subscriptions renew this month: music (€11), cloud storage (€3), and the news app (€8) you haven't opened since August." },
      { author: "me", at: at(3, 9, 15), text: "cancel the news one" },
      { author: tally.id, at: at(3, 9, 15), text: "Noted. I can't cancel it myself, but here's the page: Settings → Subscriptions in the app." },
    ]),
  });

  add({
    kind: "direct",
    botIds: [scout.id],
    messages: thread([
      { author: "me", at: at(2, 21, 5), text: "what's a good beginner film camera?" },
      { author: scout.id, at: at(2, 21, 6), text: "A used Olympus OM-10 or Pentax K1000: both cheap, sturdy, and lenses are easy to find." },
    ]),
  });

  add({
    kind: "direct",
    botIds: [quill.id],
    messages: thread([{ author: quill.id, at: at(4, 16, 20), text: "Send me a draft whenever you like. I'll keep your voice and cut the rest." }]),
  });

  add({
    kind: "direct",
    botIds: [rook.id],
    hidden: true,
    messages: thread([{ author: rook.id, at: at(6, 11, 0), text: "Paste a diff and I'll look for bugs first." }]),
  });

  return { bots: [pip, juniper, scout, tally, quill, ember, rook], conversations: conversations.sort((a, b) => b.updatedAt - a.updatedAt) };
}
