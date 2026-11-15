// The words an update is told in: the lines `ob update` prints for its steps and the app reads back
// as progress, a changelog's lines from commit subjects, and what the app says when the update fails.
import { expect, test } from "bun:test";
import { changeText, tagLabel, tagVersion, UPDATE_STEPS, updateStepLine, updateStepOf } from "../shared/releaseUpdate";
import { updateError, updateView } from "../src/lib/releaseUpdate";

test("each step of `ob update` is a line the app reads back as that step", () => {
  expect(updateStepLine("check")).toBe("Checking for a new release…");
  expect(updateStepLine("download", "0.3.53-nightly")).toBe("Downloading 0.3.53-nightly…");
  expect(updateStepLine("install")).toBe("Installing dependencies…");
  for (const step of UPDATE_STEPS) {
    expect(updateStepOf(updateStepLine(step))).toBe(step);
    expect(updateStepOf(`  ${updateStepLine(step, "0.3.53")}  `)).toBe(step);
  }
  // Anything else `ob update` or the package manager prints is output, not a step.
  for (const line of ["", "Updated to OpenBuild 0.3.53-nightly (nightly).", "Downloadingly", "bun install v1.3.8", "Resolving dependencies", "openbuild: Dependency installation failed."]) {
    expect(updateStepOf(line)).toBeUndefined();
  }
});

test("a changelog line is the commit's subject without its prefix and pull request number", () => {
  expect(changeText("feat(bots): bots close their own question cards once they're settled another way (#351)")).toBe("Bots close their own question cards once they're settled another way");
  expect(changeText("fix: a steer that lands between two tool calls (#344)")).toBe("A steer that lands between two tool calls");
  expect(changeText("feat(api)!: drop the old route")).toBe("Drop the old route");
  expect(changeText("Merge the release notes (#12)")).toBe("Merge the release notes");
  // Not a prefix: a sentence with a colon in it keeps its words.
  expect(changeText("Fix the thing: properly this time")).toBe("Fix the thing: properly this time");
  expect(changeText("  chore:  ")).toBe("chore:");
});

test("a release tag reads as its channel and version", () => {
  expect(tagLabel("0.3.53-nightly")).toBe("Nightly 0.3.53");
  expect(tagLabel("0.3.53")).toBe("Stable 0.3.53");
  expect(tagLabel("0.1.8-nightly.20261111.275")).toBe("Nightly 0.1.8");
  expect(tagLabel("abc1234")).toBe("abc1234");
  expect(tagVersion("0.3.53-nightly")).toBe("0.3.53");
  expect(tagVersion("abc1234")).toBe("abc1234");
});

test("a failed update is told in `ob update`'s own words", () => {
  expect(updateError(["bun install v1.3.8", "openbuild: Your checkout has local changes. Commit or stash them before updating."]))
    .toBe("Your checkout has local changes. Commit or stash them before updating.");
  // What it printed after that belongs to the same message (a failed installation's output).
  expect(updateError(["openbuild: Dependency installation failed.", "error: lockfile had changes, but lockfile is frozen"]))
    .toBe("Dependency installation failed.\nerror: lockfile had changes, but lockfile is frozen");
  // Killed before it could say: the end of what it did print.
  expect(updateError(["one", "two"])).toBe("one\ntwo");
  expect(updateError([])).toBe("");
});

test("which button shows: a restart that is waiting before an offer, an offer before a check", () => {
  expect(updateView({ phase: "idle" })).toBe("idle");
  expect(updateView({ phase: "checking" })).toBe("checking");
  expect(updateView({ phase: "idle", info: { available: true } })).toBe("available");
  // A quiet check behind an offer doesn't take the download away.
  expect(updateView({ phase: "checking", info: { available: true } })).toBe("available");
  expect(updateView({ phase: "installing", info: { available: true } })).toBe("installing");
  expect(updateView({ phase: "idle", info: { available: false, restart: { pending: true } } })).toBe("ready");
  expect(updateView({ phase: "idle", info: { available: true, restart: { pending: true } } })).toBe("ready");
  expect(updateView({ phase: "restarting", info: { restart: { pending: true } } })).toBe("restarting");
});
