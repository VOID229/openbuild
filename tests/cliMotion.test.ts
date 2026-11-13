import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("a temp directory that can't be written drops the animation, not the command", () => {
  // A regular file where the temp directory should be: every write under it fails, as on a full disk.
  const blocked = join(mkdtempSync(join(tmpdir(), "openbuild-motion-test-")), "not-a-directory");
  writeFileSync(blocked, "");
  try {
    const script = `
      Object.defineProperty(process.stdout, "isTTY", { value: true });
      const { stage } = await import(${JSON.stringify(join(import.meta.dir, "..", "bin", "motion.ts"))});
      const opened = stage.open({ scene: "lifecycle", power: 0, steps: ["One", "Two"] });
      stage.step("One");
      stage.print("result");
      stage.end("fail");
      console.log("opened", opened);
    `;
    const { CI: _ci, OPENBUILD_NO_MOTION: _plain, ...rest } = process.env;
    const result = Bun.spawnSync([process.execPath, "-e", script], { env: { ...rest, ...env, TMPDIR: blocked }, stdout: "pipe", stderr: "pipe" });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("result\nopened false\n");
  } finally {
    rmSync(join(blocked, ".."), { recursive: true, force: true });
  }
});
