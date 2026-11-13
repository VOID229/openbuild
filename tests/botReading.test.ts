// A bot reading something, as arithmetic: which tool calls are reading (a file, a page, messages,
// memory, search results, a thread), where its mascot looks as it reads (down, slowly along a line
// from left to right, quickly back to the start of the next one a touch lower, a few lines and back
// to the top), and that every shape reads with its eyes on its body and well clear of the rim.
// tests/botLiveStatus.test.ts sends the status end to end, tests/botReadingUi.test.ts shows it in
// the app, and tests/botAvatarLife.test.ts watches a reading mascot in a real Chrome.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BotAvatar, BotHuddle, BotLineup } from "../src/components/bots/BotAvatar";
import { reads } from "../server/bots/steps";
import { reading } from "../src/lib/bots/activity";
import { SHAPES } from "../src/lib/bots/looks";
import { DRAWN, eyeLook, eyesOf, FORMS, frame, newRig, poseTarget, restOf, step } from "../src/lib/bots/rig";
import { READING, READING_STILL, readingAt } from "../src/lib/bots/routines";

test("reading a file, a page, messages, memory, search results or a thread is reading; doing things isn't", () => {
  const yes: [string, Record<string, unknown>][] = [
    ["read", { path: "notes.md" }],
    ["search", { query: "deploy", what: "messages" }],
    ["search", { query: "" }],
    ["bot_web_search", { query: "bun 1.4 release notes" }],
    ["browser", { action: "snapshot" }],
    ["openbuild", { action: "read", thread: "1a2b3c4d" }],
    ["openbuild", { action: "list" }],
    ["process", { action: "read", id: "p1" }],
    ["jobs", { action: "result", job: "2" }],
    ["apps", { action: "skill", app: "github", skill: "triage" }],
    ["bash", { command: "cat package.json" }],
    ["bash", { command: "cd ~/code/app && rg -n TODO src" }],
    ["bash", { command: "tail -n 200 server.log" }],
    ["bash", { command: "git log --oneline -20" }],
    ["use_app", { app: "github", tool: "get_file_contents" }],
    ["use_app", { app: "notion", tool: "search" }],
    ["mcp__linear__list_issues", {}],
    ["mcp__claude_ai_Gmail__read_thread", {}],
  ];
  const no: [string, Record<string, unknown>][] = [
    ["write", { path: "notes.md", content: "…" }],
    ["edit", { path: "notes.md", old: "a", new: "b" }],
    ["send_message", { text: "On it." }],
    ["memory", { action: "write", text: "Likes tea." }],
    ["browser", { action: "click", ref: "3" }],
    ["browser", { action: "open", url: "https://example.com" }],
    ["openbuild", { action: "send", thread: "1a2b3c4d", text: "Rebase it." }],
    ["openbuild", { action: "start", prompt: "Fix it." }],
    ["process", { action: "start", command: "bun dev" }],
    ["jobs", { action: "cancel", job: "all" }],
    ["apps", { action: "connect", app: "github" }],
    ["bash", { command: "bun run build" }],
    ["bash", { command: "rm -rf dist" }],
    ["use_app", { app: "github", tool: "create_issue" }],
    ["mcp__linear__create_issue", {}],
    ["html_render", { title: "Signups" }],
    ["todo", { action: "list" }],
    ["load_tools", { tools: ["browser"] }],
    ["react", { emoji: "👍" }],
    ["routine", { action: "list" }],
  ];
  for (const [tool, args] of yes) expect([tool, args, reads(tool, args)]).toEqual([tool, args, true]);
  for (const [tool, args] of no) expect([tool, args, reads(tool, args)]).toEqual([tool, args, false]);
  // Arguments still missing (or not an object) are no reason to throw.
  expect(reads("bash", undefined)).toBe(false);
  expect(reads("browser", "snapshot")).toBe(false);
  expect(reads("read", undefined)).toBe(true);
});

test("a bot reads, as far as anyone can see, only while it's visibly at work on it", () => {
  expect(reading({ state: "working", activity: "Reading notes.md", reading: true })).toBe(true);
  expect(reading({ state: "working", activity: "Running a command" })).toBe(false);
  // Still deciding whether a group message is its own, or not at work at all: no reading.
  expect(reading({ state: "working", reading: true, deciding: true })).toBe(false);
  expect(reading({ state: "idle", reading: true })).toBe(false);
  expect(reading(undefined)).toBe(false);
});

/** Every pose the reading takes, a frame (60 fps) at a time, over `pages` pages. */
const frames = (pages = 2) => {
  const page = (READING.settle + READING.sweep) * READING.lines;
  return Array.from({ length: Math.round((page * pages) / (1000 / 60)) }, (_, i) => ({ ms: (i * 1000) / 60, ...readingAt((i * 1000) / 60) }));
};

test("reading, it looks down, along a line slowly from left to right, and quickly back to the left and a touch lower", () => {
  const all = frames();
  // Always looking down at the page, its eyes lowered onto it, leaning in a little.
  for (const p of all) {
    expect(p.y).toBeGreaterThan(0.3);
    expect(p.eyes).toBe("read");
    expect(p.zoom).toBeGreaterThan(0);
  }
  // Along each line: steadily rightward, from well left to well right, taking a good while about it.
  const line = READING.settle + READING.sweep;
  for (let n = 0; n < READING.lines * 2; n++) {
    const on = all.filter((p) => p.ms >= n * line && p.ms < (n + 1) * line);
    for (let i = 1; i < on.length; i++) {
      expect(on[i]!.x).toBeGreaterThanOrEqual(on[i - 1]!.x);
      expect(on[i]!.y).toBe(on[0]!.y);
      // Never faster than the whole line in 1.5 s.
      expect(on[i]!.x - on[i - 1]!.x).toBeLessThan(((READING.to - READING.from) / 1500) * (1000 / 60) + 1e-9);
    }
    expect(on[0]!.x).toBeLessThan(-0.6);
    expect(on.at(-1)!.x).toBeGreaterThan(0.6);
  }
  expect(READING.sweep).toBeGreaterThanOrEqual(1500);
  // Then straight back to the left in one go, and down to the next line: a touch lower each time.
  const jumps = all.slice(1).flatMap((p, i) => (p.x < all[i]!.x ? [[all[i]!, p] as const] : []));
  expect(jumps.length).toBe(READING.lines * 2 - 1);
  for (const [from, to] of jumps) {
    expect(from.x - to.x).toBeGreaterThan(1.2);
    const down = to.y - from.y;
    // Down a little to the next line, or after the last one, back up to the top of the next page.
    if (down > 0) expect(down).toBeCloseTo(READING.drop, 6);
    else expect(to.y).toBe(READING.top);
  }
  const ys = [...new Set(all.map((p) => p.y))].sort();
  expect(ys.length).toBe(READING.lines);
  expect(ys.at(-1)! - ys[0]!).toBeLessThan(0.45);
  // It leans into the line as it goes, and only a little.
  expect(Math.max(...all.map((p) => Math.abs(p.roll ?? 0)))).toBeLessThan(6);
  expect(Math.sign(readingAt(READING.settle + READING.sweep * 0.9).roll!)).toBe(1);
  expect(Math.sign(readingAt(READING.settle + READING.sweep * 0.1).roll!)).toBe(-1);
  // With motion reduced, it's simply looking down at the page.
  expect(READING_STILL).toMatchObject({ x: 0, y: READING.top, eyes: "read" });
});

test("its eyes, lowered to read, are the big eyes of work with the lids come down, mostly from the top, and bots.css draws them so", () => {
  const [w, h] = FORMS.read;
  // Still big and deep: fatter and as tall as an open eye, and well short of a working one.
  expect(w).toBeGreaterThan(1.3);
  expect(h).toBeGreaterThanOrEqual(1);
  expect(h).toBeLessThan(FORMS.big[1] * 0.75);
  // Coming from a working eye, its top comes down a good deal further than its foot comes up.
  const top = FORMS.big[1] / 2 - h / 2 + DRAWN.read.drop;
  const foot = FORMS.big[1] / 2 - h / 2 - DRAWN.read.drop;
  expect(top).toBeGreaterThan(foot * 2.5);
  expect(foot).toBeGreaterThanOrEqual(0);
  // The same numbers in the sheet (--lift is the other way up from drop).
  const css = readFileSync(`${import.meta.dir}/../src/bots.css`, "utf8");
  const rule = /\.bot\[data-eyes="read"\] \.bot-eye-fill \{([^}]*)\}/.exec(css)?.[1] ?? "";
  const value = (name: string) => Number(new RegExp(`${name}:\\s*(-?[\\d.]+)`).exec(rule)?.[1]);
  expect([value("--fw"), value("--fh"), value("--lift")]).toEqual([w, h, -Number(DRAWN.read.drop.toFixed(2))]);
  // A pleased or sleepy face wins over it, as later in the sheet; reading wins over the big eyes of work.
  expect(eyeLook("idle", "read")).toBe("read");
  expect(eyeLook("happy", "read")).toBe("happy");
  expect(eyeLook("sleepy", "read")).toBe("sleepy");
  expect(css.indexOf('[data-eyes="read"]')).toBeGreaterThan(css.indexOf('[data-eyes="big"]'));
  expect(css.indexOf('[data-eyes="read"]')).toBeLessThan(css.indexOf('[data-mood="sleepy"] .bot-eye-fill'));
});

test("every shape's eyes visibly sweep each line, lower on the face than straight ahead (tests/botMascotRig.test.ts keeps them off the rim)", () => {
  const short: string[] = [];
  const parse = (t: string) => (t === "none" ? [1, 0, 0, 1, 0, 0] : t.slice(7, -1).split(", ").map(Number));
  for (const shape of SHAPES) {
    // From where a working bot was, through a whole page frame by frame, as it's drawn.
    const rig = newRig(restOf(shape));
    const slid: number[] = [];
    for (const p of frames(1)) {
      step(rig, poseTarget(shape, p, true), 1000 / 60, "pose");
      if (p.ms < 800) continue;
      const [l, r] = [parse(frame(rig, shape, 100, "read").left), parse(frame(rig, shape, 100, "read").right)];
      slid.push((l[4]! + r[4]!) / 2);
      // Looking down: the eyes are lower on the face than they'd be straight ahead.
      expect((l[5]! + r[5]!) / 2).toBeGreaterThan(0.5);
    }
    // Along each line the eyes go a good way over: a reader, not a stare.
    const span = Math.max(...slid) - Math.min(...slid);
    if (span < eyesOf(shape).w * 0.6) short.push(`${shape.id} ${span.toFixed(1)}`);
  }
  expect(short).toEqual([]);
}, 60_000);

test("only a busy bot reads: in a group's huddle or lineup just the member at work reading, and never one thinking what to type", () => {
  const looks = [{ shape: "blob", color: "green" }, { shape: "star", color: "blue" }];
  const count = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el).match(/data-reading=""/g)?.length ?? 0;
  for (const group of [BotHuddle, BotLineup]) {
    expect(count(createElement(group, { looks, size: 64, active: [true, true], reading: [false, true] }))).toBe(1);
    // A dozing member isn't at work, whatever it's said to be doing.
    expect(count(createElement(group, { looks, size: 64, active: [false, true], reading: [true, false] }))).toBe(0);
  }
  expect(count(createElement(BotAvatar, { look: looks[0]!, size: 64, busy: true, reading: true }))).toBe(1);
  expect(renderToStaticMarkup(createElement(BotAvatar, { look: looks[0]!, size: 64, busy: true, reading: true }))).toContain('data-eyes="read"');
  expect(count(createElement(BotAvatar, { look: looks[0]!, size: 64, reading: true }))).toBe(0);
  expect(count(createElement(BotAvatar, { look: looks[0]!, size: 64, busy: true, reading: true, mood: "thinking" }))).toBe(0);
  expect(count(createElement(BotAvatar, { look: looks[0]!, size: 64, busy: true, reading: true, dots: true }))).toBe(0);
});
