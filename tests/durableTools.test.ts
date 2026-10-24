import { expect, test } from "bun:test";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { durableCodingTools, DEFAULT_BASH_TIMEOUT_SECONDS, MAX_BASH_TIMEOUT_SECONDS } from "../server/durable/tools";

test("Durable bash advertises and enforces default, explicit and maximum timeouts", async () => {
  const bash = durableCodingTools().tools!.find(t => t.name === "bash")! as ReturnType<typeof createBashTool>;
  expect(bash.description).toContain(`Defaults to ${DEFAULT_BASH_TIMEOUT_SECONDS} seconds`);
  const timeouts: number[] = [];
  const api = {
    env: { cwd: "/tmp", async exec(_command: unknown, options: { timeout: number }) {
      timeouts.push(options.timeout);
      return { ok: true, value: { exitCode: 0 } };
    } },
    retainedOutput: () => ({ text: "", truncated: false }),
  };
  for (const timeout of [undefined, 12, 999999]) {
    await bash.execute({ command: "true", ...(timeout === undefined ? {} : { timeout }) }, api as any, BACKGROUND_CONTEXT);
  }
  expect(timeouts).toEqual([DEFAULT_BASH_TIMEOUT_SECONDS, 12, MAX_BASH_TIMEOUT_SECONDS]);
  for (const timeout of [0, -1, NaN, Infinity]) {
    await expect(bash.execute({ command: "true", timeout }, api as any, BACKGROUND_CONTEXT)).rejects.toThrow("Invalid timeout");
  }
  expect(timeouts).toHaveLength(3);
});
