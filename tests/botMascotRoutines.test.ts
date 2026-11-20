// What a bot does of its own accord, sampled many times: at work, the reference recording's clips
// (each the same every time it plays, never the same one twice running), always in place, going right
// round now and then; idle, mostly resting. And every avatar of a bot at the same thing shares one
// timeline, so they all move as one. tests/botAvatarLife.test.ts watches the same in a real Chrome.
import { expect, test } from "bun:test";
import { joinLife, Life } from "../src/lib/bots/life";
import { AFTER_DOTS, beats, CLIPS, nextBeat, nextBlink, nextClip, nextIdle, type Clip, type Step } from "../src/lib/bots/routines";

const RUNS = 5000;
const sample = (fn: () => Step[]) => Array.from({ length: RUNS }, fn);
const poseOf = (what: Step[0]) => (what !== null && typeof what === "object" && "x" in what ? what : what !== null && typeof what === "object" && "sweep" in what ? what.sweep : undefined);
/** The moves in some routines: everything named that isn't a blink. */
const moves = (routines: Step[][]) => new Set(routines.flatMap((r) => r.map(([what]) => what)).filter((w): w is Extract<Step[0], string> => typeof w === "string" && !w.startsWith("blink")));
const faces = (routines: Step[][]) => routines.flatMap((r) => r.map(([what]) => what)).filter((w) => w !== null && typeof w === "object" && "flash" in w);
const poses = (routines: Step[][]) => routines.flatMap((r) => r.map(([what]) => poseOf(what)).filter((p) => !!p));
const clips = Object.keys(CLIPS) as Clip[];

test("at work, it plays the reference's clips: each the same every time, and never the same one twice running", () => {
  for (const c of clips) expect(CLIPS[c]()).toEqual(CLIPS[c]());
  for (const c of clips) for (let i = 0; i < 200; i++) expect(nextClip(c)).not.toBe(c);
  // In the long run each comes up, the look round most.
  const counts = Object.fromEntries(clips.map((c) => [c, 0])) as Record<Clip, number>;
  let last: Clip | undefined;
  for (let i = 0; i < RUNS; i++) counts[(last = nextClip(last))]++;
  for (const c of clips) expect(counts[c]).toBeGreaterThan(RUNS * 0.05);
  expect(Math.max(...Object.values(counts))).toBe(counts.lookRound);
  // One after another, as a busy bot plays them.
  const next = beats();
  let prev = "";
  for (let i = 0; i < 200; i++) {
    const r = JSON.stringify(next());
    expect(r).not.toBe(prev);
    prev = r;
  }
});

test("at work, a bot never hops: it moves in place, and now and then spins right round, but never flips of its own accord", () => {
  const all = sample(nextBeat);
  // A flip is for a message going out (BotAvatar's pulse), so seeing one means something was sent.
  expect([...moves(all)].sort()).toEqual(["spin"]);
  for (const r of [...all, AFTER_DOTS, ...sample(() => nextIdle(true)), ...sample(nextBlink)]) expect(r.some(([w]) => w === "flip")).toBe(false);
  // Once in a good while: the curious spell's spin, not every few seconds.
  const ms = all.reduce((n, r) => n + r.reduce((m, [, t]) => m + t, 0), 0);
  const turns = all.reduce((n, r) => n + r.filter(([w]) => w === "spin").length, 0);
  expect(ms / turns).toBeGreaterThan(20000);
  expect(ms / turns).toBeLessThan(90000);
  // Facing straight out when it goes round, so the face goes off the top or the side and comes back.
  for (const c of clips) {
    const r = CLIPS[c]();
    r.forEach(([what], i) => {
      if (what === "flip" || what === "spin") expect(typeof poseOf(r[i - 1]![0])?.x).toBe("number");
    });
  }
});

test("at work, every look is held long enough to read, and a clip is over in a few seconds", () => {
  for (const c of clips) {
    const r = CLIPS[c]();
    for (const [what, ms] of r) {
      // (A step of 0 ms goes with the next one: a blink as it moves, or a look straight out as it flips.)
      if (ms === 0) continue;
      expect(ms).toBeGreaterThanOrEqual(poseOf(what) ? 250 : 400);
    }
    const total = r.reduce((n, [, ms]) => n + ms, 0);
    expect(total).toBeGreaterThan(2500);
    expect(total).toBeLessThan(9000);
  }
});

test("at work, the whole body is in it: it looks every way, rolls right over both ways, leans right back, and its eyes change", () => {
  const all = poses(clips.map((c) => CLIPS[c]()));
  expect(Math.max(...all.map((p) => p.x))).toBeGreaterThan(0.4);
  expect(Math.min(...all.map((p) => p.x))).toBeLessThan(-0.7);
  expect(Math.max(...all.map((p) => p.y))).toBeGreaterThan(0.8);
  expect(Math.min(...all.map((p) => p.y))).toBeLessThan(-0.9);
  expect(Math.max(...all.map((p) => p.roll ?? 0))).toBeGreaterThan(25);
  expect(Math.min(...all.map((p) => p.roll ?? 0))).toBeLessThan(-25);
  expect(Math.min(...all.map((p) => p.zoom ?? 0))).toBeLessThan(-0.2);
  // Big eyes most of the time (no form said), round dots when curious (quizzical, one eye bigger), small ones now and then.
  const forms = all.map((p) => p.eyes ?? "big");
  expect(forms.filter((f) => f === "big").length / forms.length).toBeGreaterThan(0.5);
  expect(forms).toContain("dot");
  expect(forms).toContain("open");
  for (const p of all.filter((p) => p.eyes === "dot" && p.x !== 0)) expect(p.near).toBeGreaterThan(0.1);
  // Every clip ends straight ahead, big-eyed.
  for (const c of clips) {
    const last = CLIPS[c]().map(([what]) => poseOf(what)).filter((p) => !!p).at(-1);
    expect(last).toEqual({ x: 0, y: 0 });
  }
});

test("back from three dots, it's round-eyed, leans right back for a look, and then gets on big-eyed", () => {
  const [first, back, ...rest] = AFTER_DOTS.map(([what]) => poseOf(what));
  expect(first).toMatchObject({ x: 0, y: 0, eyes: "dot" });
  expect(back!.zoom).toBeLessThan(-0.2);
  expect(back!.eyes).toBe("dot");
  expect(rest.at(-1)).toEqual({ x: 0, y: 0 });
});

test("idle, a bot mostly rests: a good while at rest, then a blink or a calm look about with its small eyes", () => {
  let looks = 0;
  let blinks = 0;
  for (const r of sample(() => nextIdle(false))) {
    // Resting first, for seconds.
    expect(r[0]![0]).toBeNull();
    expect(r[0]![1]).toBeGreaterThanOrEqual(2400);
    const held = r.map(([what]) => poseOf(what)).filter((p) => !!p);
    for (const p of held) expect(p.eyes).toBe("open");
    if (held.length) {
      looks++;
      // And back to rest after.
      expect(r.at(-1)![0]).toBeNull();
    } else if (r.some(([what]) => what === "blink" || what === "blink2")) blinks++;
  }
  expect(blinks / RUNS).toBeGreaterThan(0.3);
  expect(looks / RUNS).toBeGreaterThan(0.3);
  expect(looks + blinks).toBe(RUNS);
});

test("idle, it never moves of its own accord, and only a lively bot pulls a face", () => {
  const quiet = sample(() => nextIdle(false));
  expect(moves(quiet).size).toBe(0);
  expect(faces(quiet).length).toBe(0);
  const lively = sample(() => nextIdle(true));
  expect(moves(lively).size).toBe(0);
  expect(faces(lively).length).toBeGreaterThan(0);
});

test("idle and following the pointer, a bot never takes its eyes off it", () => {
  for (const r of sample(() => nextIdle(true, true))) for (const [what] of r) expect(poseOf(what)).toBeUndefined();
});

test("plain, a bot only blinks: its eyes held open a natural while between, and no look, move or face", () => {
  const plain = sample(nextBlink);
  expect(moves(plain).size).toBe(0);
  expect(faces(plain).length).toBe(0);
  expect(poses(plain).length).toBe(0);
  for (const r of plain) {
    expect(r.map(([what]) => what)).toEqual([null, expect.stringMatching(/^blink2?$/)]);
    expect(r[0]![1]).toBeGreaterThanOrEqual(2000);
    expect(r[0]![1]).toBeLessThanOrEqual(5000);
  }
});

test("every avatar of a bot at the same thing shares one timeline: a late one picks up where it has got to", () => {
  let made = 0;
  const routine = (): Step[] => [[{ x: made++, y: 0 }, 400], ["blink", 100]];
  const a = joinLife("bot:blue busy", routine, 1000);
  const b = joinLife("bot:blue busy", routine, 1700);
  expect(b.life).toBe(a.life);
  expect(a.life.start).toBe(1000);
  // Both see the same steps at the same moments.
  const seenA = a.life.due(-1, 1050);
  expect(seenA.steps.map((s) => s.what)).toEqual([{ x: 0, y: 0 }]);
  expect(seenA.next).toBe(1400);
  // The late one, come in at 1700, has everything up to then: the pose it's to take up is the last of them.
  const seenB = b.life.due(-1, 1700);
  expect(seenB.steps.map((s) => [s.what, s.at])).toEqual([[{ x: 0, y: 0 }, 1000], ["blink", 1400], [{ x: 1, y: 0 }, 1500]]);
  expect(a.life.due(seenA.steps.at(-1)!.index, 1700).steps).toEqual(seenB.steps.slice(1));
  // Another bot, or the same at something else, has its own.
  expect(joinLife("bot:blue read", routine, 1700).life).not.toBe(a.life);
  expect(joinLife("bot:green busy", routine, 1700).life).not.toBe(a.life);
  // Once every avatar has let go, the next starts afresh.
  a.leave();
  expect(joinLife("bot:blue busy", routine, 2000).life).toBe(b.life);
  b.leave();
  b.leave();
});

test("back from three dots, a bot's timeline starts over once, however many of its avatars ask", () => {
  const life = new Life(0, (): Step[] => [[{ x: 0.5, y: 0 }, 1000]]);
  life.due(-1, 2500);
  life.restart(2600, AFTER_DOTS);
  // A second avatar asking at the same moment changes nothing.
  life.restart(2620, AFTER_DOTS);
  const { steps } = life.due(-1, 2650);
  const after = steps.filter((s) => s.at >= 2600);
  expect(after.map((s) => s.what)).toEqual([AFTER_DOTS[0]![0]]);
  expect(after[0]!.at).toBe(2600);
  // And then on as before, once it's through.
  const end = 2600 + AFTER_DOTS.reduce((n, [, ms]) => n + ms, 0);
  expect(life.due(-1, end + 10).steps.at(-1)!.what).toEqual({ x: 0.5, y: 0 });
});
