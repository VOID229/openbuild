import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { animates, colorDepth, wordmarkFits } from "../bin/motion";

const terminal = { isTTY: true, columns: 100, rows: 40 };
const env = { LANG: "en_US.UTF-8", COLORTERM: "truecolor", TERM: "xterm-256color" };

test("anything that can move a cursor animates", () => {
  expect(animates(env, terminal, 2)).toBe(true);
  expect(animates({ TERM: "xterm" }, terminal, 2)).toBe(true);
  expect(animates({ ...env, LANG: "C" }, terminal, 2)).toBe(true);
  expect(animates({ ...env, NO_COLOR: "1" }, terminal, 2)).toBe(true);
  expect(animates(env, { ...terminal, columns: 40 }, 2)).toBe(true);
  expect(animates(env, { ...terminal, rows: 8 }, 2)).toBe(true);
});

test("logs, pipes, dumb terminals and the opt-out stay plain", () => {
  expect(animates({ ...env, CI: "1" }, terminal, 2)).toBe(false);
  expect(animates({ ...env, OPENBUILD_NO_MOTION: "1" }, terminal, 2)).toBe(false);
  expect(animates({ ...env, TERM: "dumb" }, terminal, 2)).toBe(false);
  expect(animates({ LANG: "C" }, terminal, 2)).toBe(false);
  expect(animates(env, { ...terminal, isTTY: false }, 2)).toBe(false);
  expect(animates(env, { ...terminal, columns: 20 }, 2)).toBe(false);
});

test("colour falls back by what the terminal says it has", () => {
  expect(colorDepth(env)).toBe("truecolor");
  expect(colorDepth({ TERM: "xterm-256color" })).toBe("256");
  expect(colorDepth({ TERM: "xterm-kitty" })).toBe("256");
  expect(colorDepth({ TERM: "screen" })).toBe("basic");
  expect(colorDepth({ ...env, NO_COLOR: "1" })).toBe("none");
});

test("the wordmark shrinks to the window", () => {
  expect(wordmarkFits(69, 7, 5, 73, 14)).toBe(true);
  expect(wordmarkFits(69, 7, 5, 72, 14)).toBe(false);
  expect(wordmarkFits(69, 7, 5, 73, 13)).toBe(false);
});

test("piped output never starts the animation", () => {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "bin", "motion.ts"), "track"], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).not.toContain("\x1b");
});

test.skipIf(process.platform !== "linux" || !Bun.which("script"))("an action that finishes instantly still plays its transitions", () => {
  const motion = join(import.meta.dir, "..", "bin", "motion.ts");
  const program = `import { stage } from ${JSON.stringify(motion)}; stage.open({ scene: "lifecycle", steps: ["One", "Two"] }); stage.update({ power: 0 }); stage.update({ power: 1 }); stage.step("Two"); stage.end();`;
  const temp = mkdtempSync(join(tmpdir(), "ob-motion-"));
  try {
    const file = join(temp, "run.ts"), capture = join(temp, "capture");
    writeFileSync(file, program);
    const result = Bun.spawnSync(["script", "-qfc", `stty cols 100 rows 30; ${process.execPath} ${file}`, capture], { env: { ...process.env, ...env, CI: "" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    const frames = readFileSync(capture, "latin1").split("\x1b[?2026h").slice(1);
    expect(new Set(frames).size).toBeGreaterThan(60);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
