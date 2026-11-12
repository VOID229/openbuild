// How a bot's body moves, as arithmetic: it rests turned away and rolled over; it turns straight
// toward the pointer, the eyes darting ahead, the head after them and the body last, each on a spring
// that eases in and settles; it rolls and leans but never lifts; and however far a shape turns, its
// eyes stay on its body.
// tests/botsSidebarMascots.test.ts and tests/botAvatarLife.test.ts watch the same in a real Chrome.
import { expect, test } from "bun:test";
import { SHAPES } from "../src/lib/bots/looks";
import { AHEAD, aimTarget, BODY_TURN, covers, EYE_H, EYE_W, eyesFor, eyesOf, FAR, FORMS, frame, inside, newRig, nod, outline, PITCH, poseTarget, project, restFrame, RESTING, restOf, roomOf, snap, step, turnTo, warm, YAW, type Mode, type Rig, type Target } from "../src/lib/bots/rig";

const orb = SHAPES.find((s) => s.id === "blob")!;
const to = (yaw: number, pitch = 0, roll = 0, zoom = 0): Target => ({ yaw, pitch, roll, zoom });
/** Runs a rig at 60fps toward a target until it settles: a reading of it each frame. */
function run<T>(rig: Rig, target: Target, mode: Mode, read: (rig: Rig) => T): T[] {
  const out: T[] = [];
  for (let i = 0; i < 600; i++) {
    const done = step(rig, target, 1000 / 60, mode);
    out.push(read(rig));
    if (done) return out;
  }
  throw new Error("never settled");
}

test("following the pointer, a bot turns straight toward it: all the way by its edge, and by less close in", () => {
  for (const angle of [0, 0.6, 2, -1.2, Math.PI]) {
    const t = aimTarget(orb, Math.cos(angle) * 40, Math.sin(angle) * 40, 28);
    expect(Math.atan2(t.pitch / PITCH, t.yaw / YAW)).toBeCloseTo(angle, 5);
    expect(Math.hypot(t.yaw / YAW, t.pitch / PITCH)).toBeGreaterThan(0.99);
  }
  expect(aimTarget(orb, 0, 0, 28)).toEqual(AHEAD);
  // A third of the avatar away, most of the way over already; nearer in, by less; never past a full turn.
  expect(aimTarget(orb, 28 / 3, 0, 28).yaw).toBeGreaterThan(YAW * 0.7);
  expect(aimTarget(orb, 3, 0, 28).yaw).toBeLessThan(aimTarget(orb, 9, 0, 28).yaw);
  for (let d = 0; d < 400; d += 7) expect(aimTarget(orb, d, d, 28).yaw).toBeLessThanOrEqual(YAW);
});

test("it leans into the turn: rolling toward the pointer, and the other way on the other side", () => {
  expect(aimTarget(orb, 60, 0, 28).roll).toBeGreaterThan(8);
  expect(aimTarget(orb, -60, 0, 28).roll).toBeLessThan(-8);
  expect(aimTarget(orb, 0, -60, 28).roll).toBeCloseTo(0, 5);
  // A pose leans the same way unless it says how its head is cocked.
  expect(poseTarget(orb, { x: 1, y: 0 }).roll).toBeGreaterThan(4);
  expect(poseTarget(orb, { x: 1, y: 0, roll: -12 }).roll).toBe(-12);
});

test("the head locks on quickly, easing in from rest, with only a hint of overshoot", () => {
  const yaws = run(newRig(), to(YAW), "track", (r) => r.yaw.x);
  // Eased in: the first frame moves less than the next.
  expect(yaws[0]!).toBeLessThan(yaws[1]! - yaws[0]!);
  // Most of the way there within ~150ms.
  expect(yaws[8]!).toBeGreaterThan(YAW * 0.8);
  const peak = Math.max(...yaws);
  expect(peak).toBeGreaterThan(YAW);
  expect(peak).toBeLessThan(YAW * 1.08);
  expect(yaws.at(-1)).toBe(YAW);
});

test("the eyes dart ahead of the head, and are back on it by the time it arrives", () => {
  const rig = newRig();
  const frames = run(rig, to(YAW, -PITCH / 2), "pose", (r) => ({ lead: r.leadX.x, up: r.leadY.x, yaw: r.yaw.x }));
  // Out in front within a few frames, the way it's turning, while the head has barely started.
  const first = frames.findIndex((f) => f.lead > 2);
  expect(first).toBeGreaterThanOrEqual(0);
  expect(first).toBeLessThan(6);
  expect(frames[first]!.yaw).toBeLessThan(YAW * 0.6);
  expect(Math.min(...frames.map((f) => f.up))).toBeLessThan(-1);
  // Never far: a few units of the 100-unit box. And home again at the end.
  expect(Math.max(...frames.map((f) => Math.abs(f.lead)))).toBeLessThan(5);
  expect(frames.at(-1)!.lead).toBe(0);
  expect(rig.leadY.x).toBe(0);
});

test("the body turns after the head: behind it, swaying a little past, and settled within a second", () => {
  const frames = run(newRig(), to(YAW, 0, 10), "track", (r) => ({ head: r.yaw.x, body: r.bodyYaw.x, roll: r.roll.x }));
  for (let i = 1; i < 8; i++) expect(frames[i]!.body).toBeLessThan(frames[i]!.head);
  const peak = Math.max(...frames.map((f) => f.body));
  expect(peak).toBeGreaterThan(YAW * 1.03);
  expect(peak).toBeLessThan(YAW * 1.18);
  expect(Math.max(...frames.map((f) => f.roll))).toBeGreaterThan(10.2);
  expect(frames.length).toBeLessThan(70);
});

test("let go, it eases back to rest, slower and without swinging past", () => {
  const rest = restOf(orb);
  const rig = newRig(to(-YAW, PITCH / 2, 12));
  const frames = run(rig, rest, "rest", (r) => ({ head: r.yaw.x, body: r.bodyYaw.x, roll: r.roll.x }));
  // Eased out of where it was held, and never past where it rests.
  expect(frames[0]!.head + YAW).toBeLessThan(frames[1]!.head - frames[0]!.head);
  for (const f of frames) {
    expect(f.head).toBeLessThanOrEqual(rest.yaw);
    expect(f.body).toBeLessThanOrEqual(rest.yaw + 0.3);
    expect(f.roll).toBeGreaterThanOrEqual(rest.roll - 0.3);
  }
  expect(frames.length).toBeGreaterThan(run(newRig(), to(YAW), "track", (r) => r.yaw.x).length * 0.8);
  expect(frames.length).toBeLessThan(100);
  expect(frame(rig, orb, 96)).toEqual(restFrame(orb, 96));
});

test("a change of mind mid-turn carries on from where it is, without a jump", () => {
  const rig = newRig();
  const steps: number[] = [];
  const go = (yaw: number) => {
    const from = rig.yaw.x;
    step(rig, to(yaw), 1000 / 60, "pose");
    steps.push(Math.abs(rig.yaw.x - from));
  };
  for (let i = 0; i < 6; i++) go(YAW);
  const speed = rig.yaw.v;
  expect(speed).toBeGreaterThan(0);
  // Told to look the other way: it brakes and comes round over several frames. Straight there would
  // be twice a full turn in one.
  for (let i = 0; i < 6; i++) go(-YAW);
  expect(rig.yaw.v).toBeLessThan(speed);
  expect(Math.max(...steps)).toBeLessThan((YAW * 2) / 4);
  run(rig, to(-YAW), "pose", (r) => r.yaw.x);
  expect(rig.yaw.x).toBe(-YAW);
});

test("a long frame doesn't throw it off", () => {
  const rig = newRig();
  step(rig, to(YAW), 2000, "track");
  expect(rig.yaw.x).toBeGreaterThan(0);
  expect(rig.yaw.x).toBeLessThan(YAW * 1.1);
});

test("facing straight out a bot is drawn as its shape is, and turned, the body and each eye have their own transforms", () => {
  const rig = newRig();
  // Nothing on the body or the eyes; the whole bot only leans back a hair from where it rests.
  expect(frame(rig, orb, 100)).toEqual({ whole: `translate(${((-restOf(orb).yaw / YAW) * 2.6).toFixed(2)}px, 0px) rotate(0deg) scale(1.0000)`, body: "none", left: "none", right: "none", back: false });
  snap(rig, to(30, 10, 8, 0.05));
  const f = frame(rig, orb, 100);
  // The body takes part of the head's turn, in perspective, and the whole bot rolls and swells.
  expect(f.body).toBe(`perspective(260.0px) rotateX(${(-10 * BODY_TURN).toFixed(2)}deg) rotateY(${(30 * BODY_TURN).toFixed(2)}deg)`);
  expect(f.whole).toMatch(/rotate\(8\.00deg\) scale\(1\.0500\)$/);
  // Each eye is put where the whole of the turn takes it: slid right and down across the body,
  // narrower than it is tall by more than before, and still upright.
  const eye = (t: string) => t.slice(7, -1).split(", ").map(Number) as [number, number, number, number, number, number];
  for (const t of [f.left, f.right]) {
    expect(t).toMatch(/^matrix\(/);
    const [a, b, c, d, x, y] = eye(t);
    expect(x).toBeGreaterThan(8);
    expect(x).toBeLessThan(22);
    expect(y).toBeGreaterThan(2);
    expect(Math.hypot(a, b)).toBeLessThan(Math.hypot(c, d) * 0.97);
    expect(Math.abs(b)).toBeLessThan(0.1);
  }
  // Turned right, the left eye is the nearer one: a little bigger, and it has slid further.
  expect(Math.hypot(...(eye(f.left).slice(2, 4) as [number, number]))).toBeGreaterThan(Math.hypot(...(eye(f.right).slice(2, 4) as [number, number])));
  expect(eye(f.left)[4]).toBeGreaterThan(eye(f.right)[4]);
});

test("at rest a bot is turned up and away and rolled over, the same for every shape that has the room", () => {
  for (const shape of SHAPES) {
    const rest = restOf(shape);
    // Up and to our right, as far as RESTING asks or the shape allows, and rolled the other way.
    expect(rest.yaw).toBeGreaterThan(8);
    expect(rest.yaw).toBeLessThanOrEqual(RESTING.x * YAW + 1e-9);
    expect(rest.pitch).toBeLessThan(-3);
    expect(rest.roll).toBe(RESTING.roll);
    expect(rest.roll).toBeLessThan(-15);
    expect(rest.zoom).toBe(0);
    // Drawn that way with nothing run: the whole bot rolled about its middle (and not moved off it),
    // the body turned a little, each eye slid up and across.
    const f = restFrame(shape, 100);
    expect(f.whole).toBe(`rotate(${rest.roll.toFixed(2)}deg) scale(1.0000)`);
    expect(f.body).toMatch(/^perspective\(260\.0px\) rotateX\(\d/);
    for (const t of [f.left, f.right]) {
      const [, , , , x, y] = t.slice(7, -1).split(", ").map(Number);
      expect(x!).toBeGreaterThan(3);
      expect(y!).toBeLessThan(-1);
    }
    expect(restFrame(shape, 100)).toBe(f);
  }
  // Most of them have all the room it asks for.
  expect(SHAPES.filter((s) => Math.abs(restOf(s).yaw - RESTING.x * YAW) < 1e-9).length).toBeGreaterThanOrEqual(9);
});

test("an eye is drawn where the turn puts it on the body: the same place `project` says", () => {
  for (const shape of SHAPES.slice(0, 6)) {
    const rig = newRig();
    snap(rig, to(-25, -18));
    const f = frame(rig, shape, 100);
    const { gap } = eyesOf(shape);
    for (const [side, t] of [[-1, f.left], [1, f.right]] as const) {
      const [, , , , x, y] = t.slice(7, -1).split(", ").map(Number);
      const [px, py] = project(shape.face.x + (side * gap) / 2, shape.face.y, -25, -18);
      expect(shape.face.x + (side * gap) / 2 + x!).toBeCloseTo(px, 1);
      expect(shape.face.y + y!).toBeCloseTo(py, 1);
    }
  }
});

test("whatever it does, the body never lifts: it leans sideways and settles down, never up", () => {
  for (const [yaw, pitch] of [[YAW, -PITCH], [-YAW, -PITCH], [0, -PITCH], [YAW, PITCH], [0, PITCH]] as const) {
    const rig = newRig();
    let lowest = 0;
    for (let i = 0; i < 200; i++) {
      step(rig, to(yaw, pitch, 12, -0.1), 1000 / 60, "pose");
      const y = Number(/translate\([^,]+, (-?[\d.]+)px\)/.exec(frame(rig, orb, 100).whole)?.[1] ?? 0);
      lowest = Math.min(lowest, y);
    }
    expect(lowest).toBe(0);
  }
});

test("a nod dips the head and the body after it, and brings them back: down, never up", () => {
  const rig = newRig();
  nod(rig);
  const frames = run(rig, AHEAD, "rest", (r) => ({ head: r.pitch.x, body: r.bodyPitch.x, y: Number(/translate\([^,]+, (-?[\d.]+)px\)/.exec(frame(r, orb, 100).whole)?.[1] ?? 0) }));
  // A real dip of the head, the body going less far; over within a second.
  const deepest = Math.max(...frames.map((f) => f.head));
  expect(deepest).toBeGreaterThan(14);
  expect(deepest).toBeLessThan(30);
  expect(Math.max(...frames.map((f) => f.body))).toBeLessThan(deepest);
  expect(frames.length).toBeLessThan(70);
  for (const f of frames) {
    expect(f.head).toBeGreaterThanOrEqual(0);
    expect(f.y).toBeGreaterThanOrEqual(0);
  }
  expect(frame(rig, orb, 100)).toEqual(frame(newRig(), orb, 100));
});

test("turned right round, the body shows its back and the face is out of sight", () => {
  const rig = newRig();
  for (const [spin, back] of [[0, false], [60, false], [120, true], [180, true], [250, true], [300, false]] as const) {
    rig.spin = spin;
    expect(frame(rig, orb, 96).back).toBe(back);
  }
  rig.spin = 180;
  expect(frame(rig, orb, 96).body).toContain("rotateY(180.00deg)");
});

test("an outline follows its shape's path: closed parts, inside where the body is", () => {
  for (const shape of SHAPES) {
    const parts = outline(shape.path);
    expect(parts.length).toBe(shape.path.split("M").length - 1);
    for (const part of parts) expect(part.length).toBeGreaterThan(10);
    // Between the eyes is on the body; the box's corners never are.
    expect(inside(parts, shape.face.x, shape.face.y)).toBe(true);
    for (const [x, y] of [[1, 1], [99, 1], [1, 99], [99, 99]] as const) expect(inside(parts, x, y)).toBe(false);
  }
});

test("the filled-in body agrees with its outline, to within a cell at the edge", () => {
  for (const shape of SHAPES) {
    const parts = outline(shape.path);
    let wrong = 0;
    for (let x = 0.3; x < 100; x += 1.7)
      for (let y = 0.3; y < 100; y += 1.7) {
        if (covers(shape, x, y) === inside(parts, x, y)) continue;
        wrong++;
        // Where they differ, the edge is right there.
        expect([[-0.6, 0], [0.6, 0], [0, -0.6], [0, 0.6]].some(([dx, dy]) => inside(parts, x + dx!, y + dy!) !== inside(parts, x, y))).toBe(true);
      }
    // (A long, wavy outline has more edge to be near: a few dozen of the 3,500 points at most.)
    expect(wrong).toBeLessThan(90);
  }
  expect(covers(SHAPES[0]!, -5, 50)).toBe(false);
  expect(covers(SHAPES[0]!, 50, 140)).toBe(false);
});

test("however far over it looks, every shape keeps its eyes on its body", () => {
  const misses: string[] = [];
  for (const shape of SHAPES) {
    const body = outline(shape.path);
    const { w, h, gap } = eyesOf(shape);
    for (const form of ["open", "wide", "round", "squint", "big"] as const) {
      const [fw, fh] = FORMS[form];
      for (let a = 0; a < 32; a++) {
        // As far as it'll go that way: a full turn, held to the room the shape has.
        const [yaw, pitch] = turnTo(shape, Math.cos((a / 16) * Math.PI) * 3, Math.sin((a / 16) * Math.PI) * 3, form);
        for (const side of [-1, 1]) {
          // Each eye's middle, and well toward each end of it: only its ends may slip under the edge.
          for (const [dx, dy] of [[0, 0], [0, -h * fh * 0.28], [0, h * fh * 0.28], [-w * fw * 0.28, 0], [w * fw * 0.28, 0]] as const) {
            const [x, y] = [shape.face.x + (side * gap) / 2 + dx, shape.face.y + dy];
            if (!inside(body, ...project(x, y, yaw, pitch))) misses.push(`${shape.id} ${form} ${a}`);
          }
        }
      }
    }
  }
  expect([...new Set(misses)]).toEqual([]);
});

test("every shape can look around: a fair turn each way, and all the way where it has the room", () => {
  for (const shape of SHAPES) {
    const room = roomOf(shape);
    expect(room.length).toBe(36);
    // Some way every way (a triangle or a star has little room toward a point), half a turn on the
    // whole, and all but the whole of it one way at least.
    for (const r of room) {
      expect(r).toBeGreaterThan(0.15);
      expect(r).toBeLessThanOrEqual(1);
    }
    expect(room.reduce((a, b) => a + b, 0) / room.length).toBeGreaterThan(0.5);
    expect(Math.max(...room)).toBeGreaterThan(0.75);
  }
  // A turn never asks for more than the shape has, and a small one is left alone.
  expect(turnTo(orb, 0.3, 0)).toEqual([0.3 * YAW, 0]);
  expect(turnTo(orb, 0, 0)).toEqual([0, 0]);
});

test("a shape's turn limits are worked out ahead of its first look, a form at a time as there's a moment", () => {
  // A shape nothing has looked at yet.
  const shape = { ...SHAPES.find((s) => s.id === "star")!, id: "star-not-seen-yet" };
  const waiting: (() => void)[] = [];
  warm(shape, (step) => waiting.push(step));
  // Nothing is worked out until there's a moment, and then one form of eye a turn.
  let turns = 0;
  for (; waiting.length; turns++) {
    expect(waiting.length).toBe(1);
    waiting.shift()!();
  }
  expect(turns).toBe(Object.keys(FORMS).length);
  // All there now, the same as worked out on the spot for the shape it's a copy of.
  for (const form of Object.keys(FORMS) as (keyof typeof FORMS)[]) expect(roomOf(shape, form)).toEqual(roomOf(SHAPES.find((s) => s.id === "star")!, form));
  // And nothing left to do for it.
  warm(shape, (step) => waiting.push(step));
  expect(waiting.length).toBe(0);
});

test("the eyes are tall pills, and at work they're big: a quarter of the face between them", () => {
  expect(EYE_H / EYE_W).toBeGreaterThan(2.1);
  // An open eye stands about a quarter of the body's height (the disc is 72 across).
  for (const shape of SHAPES) expect(eyesOf(shape).h).toBeGreaterThan(17);
  // At work both are much bigger, and a squint is a slit: well under half an open eye.
  expect(FORMS.big[0] * FORMS.big[1]).toBeGreaterThan(2.2);
  expect(FORMS.squint[1]).toBeLessThan(0.3);
  // A bot at work has them big whenever a pose would leave them open or staring, and only then.
  expect(eyesFor(undefined, true)).toBe("big");
  expect(eyesFor({ x: 0, y: 0 }, true)).toBe("big");
  expect(eyesFor({ x: 0, y: 0, eyes: "wide" }, true)).toBe("big");
  expect(eyesFor({ x: 0, y: 0, eyes: "squint" }, true)).toBe("squint");
  expect(eyesFor({ x: 0, y: 0, eyes: "wide" }, false)).toBe("wide");
  expect(eyesFor(undefined, false)).toBeUndefined();
  // Big eyes need the room: a turn at work is held to what they have.
  const wedge = SHAPES.find((s) => s.id === "wedge")!;
  expect(Math.abs(poseTarget(wedge, { x: 1, y: 0 }, true).yaw)).toBeLessThanOrEqual(Math.abs(poseTarget(wedge, { x: 1, y: 0 }).yaw));
});

test("turned away, the eyes are a little smaller all round, and keep most of their width", () => {
  const size = (yaw: number, pitch: number) => {
    const rig = newRig();
    snap(rig, to(yaw, pitch));
    const [a, b, c, d] = frame(rig, orb, 100).left.slice(7, -1).split(", ").map(Number) as [number, number, number, number];
    return [Math.hypot(a, b), Math.hypot(c, d)] as const;
  };
  const [w, h] = size(YAW, 0);
  // A full turn to the side: shorter by FAR, and narrower still, but by far less than a true turn would.
  expect(h).toBeGreaterThan(0.85);
  expect(h).toBeLessThan(0.92);
  expect(w).toBeLessThan(h);
  expect(w).toBeGreaterThan(0.75);
  expect(w).toBeGreaterThan(Math.cos((YAW * Math.PI) / 180) * (1 - FAR));
  // Part of the way, it's in between; and looking down does the same to its height.
  expect(size(YAW / 2, 0)[1]).toBeGreaterThan(h);
  expect(size(YAW / 2, 0)[1]).toBeLessThan(1);
  expect(size(0, PITCH)[1]).toBeLessThan(size(0, PITCH)[0]);
});

test("a full turn takes the eyes well over, but keeps them off the body's edge", () => {
  const rig = newRig();
  for (const side of [1, -1]) {
    snap(rig, to(side * YAW));
    const f = frame(rig, orb, 100);
    const { w, gap } = eyesOf(orb);
    // The eye on the side it's turned to: slid a good way, and still more than its own width inside the rim.
    const far = side === 1 ? f.right : f.left;
    const slid = Number(far.slice(7, -1).split(", ")[4]);
    expect(Math.abs(slid)).toBeGreaterThan(8);
    expect(Math.sign(slid)).toBe(side);
    const rim = 35.8 - Math.abs(orb.face.x + (side * gap) / 2 + slid - 50);
    expect(rim).toBeGreaterThan(w);
  }
});
