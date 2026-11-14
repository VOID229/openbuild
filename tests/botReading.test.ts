// A bot reading something, as arithmetic: which tool calls are reading (a file, a page, messages,
// memory, search results, a thread), where its mascot looks as it reads (as the reference recording
// does: its eyes wide ovals, darting down, up and across the top, then slowly along a line and quickly
// back to its start), and that every shape reads with its eyes on its body and well clear of the rim.
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
import { DRAWN, EYE_H, EYE_W, eyeLook, eyesOf, FORMS, frame, newRig, poseTarget, restOf, sizeOf, spreadOf, step } from "../src/lib/bots/rig";
import { READING_MS, READING_PAGE, READING_STILL, readingAt } from "../src/lib/bots/routines";

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
const frames = (pages = 2) => Array.from({ length: Math.round((READING_MS * pages) / (1000 / 60)) }, (_, i) => ({ ms: (i * 1000) / 60, ...readingAt((i * 1000) / 60) }));

test("reading, its eyes dart about the page as the reference's do: down, up and across the top, then back to a line's start and slowly along it", () => {
  const all = frames();
  for (const p of all) expect(p.eyes).toBe("read");
  // Every look is somewhere on the page: from well left to well right, and from the top to the bottom.
  expect(Math.min(...all.map((p) => p.x))).toBeLessThan(-0.75);
  expect(Math.max(...all.map((p) => p.x))).toBeGreaterThan(0.6);
  expect(Math.min(...all.map((p) => p.y))).toBeLessThan(-0.8);
  expect(Math.max(...all.map((p) => p.y))).toBeGreaterThan(0.8);
  // Held at each look until the next, but along the line it reads: steadily rightward, taking a good
  // second about it, from the line's start at the left.
  const sweep = READING_PAGE.find((l) => l.sweep)!;
  const along = all.filter((p) => p.ms % READING_MS > sweep.at - sweep.sweep! && p.ms % READING_MS < sweep.at);
  expect(sweep.sweep!).toBeGreaterThanOrEqual(1000);
  for (let i = 1; i < along.length; i++) if (along[i]!.ms - along[i - 1]!.ms < 20) expect(along[i]!.x).toBeGreaterThan(along[i - 1]!.x);
  expect(along[0]!.x).toBeLessThan(-0.75);
  expect(along.at(-1)!.x).toBeGreaterThan(0.6);
  // Then quickly back to the left, on the same line, and round to the top of the page again.
  const back = READING_PAGE.at(-1)!;
  expect(readingAt(back.at + 1).x).toBeLessThan(-0.6);
  expect(Math.abs(readingAt(back.at + 1).y - sweep.pose.y)).toBeLessThan(0.1);
  expect(readingAt(READING_MS + 1)).toEqual(readingAt(1));
  // Hardly rolled: it reads with its eyes.
  expect(Math.max(...all.map((p) => Math.abs(p.roll ?? 0)))).toBeLessThan(10);
  // With motion reduced, it's simply on the line, its eyes on the page.
  expect(READING_STILL).toMatchObject({ x: 0, eyes: "read" });
});

test("its eyes, reading, are wide ovals all but touching, and bots.css draws them so", () => {
  const [w, h] = FORMS.read;
  // Wider than tall, bigger than an open eye, and short of a working one.
  expect(w * EYE_W).toBeGreaterThan(h * EYE_H);
  expect(w * h).toBeGreaterThan(1.5);
  expect(w * h).toBeLessThan(FORMS.big[0] * FORMS.big[1]);
  expect(DRAWN.read).toEqual({ w, h });
  // The same numbers in the sheet, round all the way (an ellipse, not a pill).
  const css = readFileSync(`${import.meta.dir}/../src/bots.css`, "utf8");
  const rule = /\.bot\[data-eyes="read"\] \.bot-eye-fill \{([^}]*)\}/.exec(css)?.[1] ?? "";
  const value = (name: string) => Number(new RegExp(`${name}:\\s*(-?[\\d.]+)`).exec(rule)?.[1]);
  expect([value("--fw"), value("--fh")]).toEqual([w, h]);
  expect(rule).toContain("border-radius: 50%");
  // A pleased or sleepy face wins over it, as later in the sheet; reading wins over the big eyes of work.
  expect(eyeLook("idle", "read")).toBe("read");
  expect(eyeLook("happy", "read")).toBe("happy");
  expect(eyeLook("sleepy", "read")).toBe("sleepy");
  expect(css.indexOf('[data-eyes="read"]')).toBeGreaterThan(css.indexOf('[data-eyes="big"]'));
  expect(css.indexOf('[data-eyes="read"]')).toBeLessThan(css.indexOf('[data-mood="sleepy"] .bot-eye-fill'));
});

test("every shape's eyes visibly sweep along the line it reads, and dart up and down the page (tests/botMascotRig.test.ts keeps them off the rim)", () => {
  const short: string[] = [];
  const parse = (t: string) => (t === "none" ? [1, 0, 0, 1, 0, 0] : t.slice(7, -1).split(", ").map(Number));
  const sweep = READING_PAGE.find((l) => l.sweep)!;
  for (const shape of SHAPES) {
    // From where a working bot was, through a whole page frame by frame, as it's drawn.
    const rig = newRig(restOf(shape));
    const slid: number[] = [];
    const ys: number[] = [];
    for (const p of frames(1)) {
      step(rig, { ...poseTarget(shape, p, true), spread: spreadOf("read"), size: sizeOf(shape, "read") }, 1000 / 60, "pose");
      const f = frame(rig, shape, 100, "read");
      const [l, r] = [parse(f.left), parse(f.right)];
      ys.push((l[5]! + r[5]!) / 2);
      if (p.ms > sweep.at - sweep.sweep! + 150 && p.ms <= sweep.at + 150) slid.push((l[4]! + r[4]!) / 2);
    }
    // Along the line the eyes go a good way over: a reader, not a stare; and up and down the page too.
    const span = Math.max(...slid) - Math.min(...slid);
    if (span < eyesOf(shape).w * 0.6) short.push(`${shape.id} along ${span.toFixed(1)}`);
    if (Math.max(...ys) - Math.min(...ys) < eyesOf(shape).h * 0.4) short.push(`${shape.id} up and down ${(Math.max(...ys) - Math.min(...ys)).toFixed(1)}`);
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
