// Reading variables from the user's login shell: a profile that leaves a background job behind
// (which inherits the shell's stdout) can neither keep the lookup reading nor outlive it.
import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellVariables } from "../server/shellEnv";

const dir = mkdtempSync(join(tmpdir(), "shell-env-"));
const savedShell = process.env.SHELL;
const children: number[] = [];
afterEach(() => {
  // Should a test fail, don't leave its job running either.
  for (const pid of children.splice(0)) try { process.kill(pid, "SIGKILL"); } catch {}
});
afterAll(() => {
  if (savedShell === undefined) delete process.env.SHELL; else process.env.SHELL = savedShell;
  rmSync(dir, { recursive: true, force: true });
});

/** A login shell whose profile prints a banner, exports a key, and runs `job` in the background. */
function shell(job: string, after = "") {
  const id = crypto.randomUUID();
  const path = join(dir, `shell-${id}`), pidFile = join(dir, `job-${id}`);
  writeFileSync(path, `#!/bin/sh\necho "Welcome back"\nexport TEST_KEY=sk-from-profile\n${job} &\necho $! > ${pidFile}\n${after}\nexec /bin/sh "$@"\n`);
  chmodSync(path, 0o700);
  process.env.SHELL = path;
  return () => {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    children.push(pid);
    return pid;
  };
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function gone(pid: number) {
  for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(10);
  return !alive(pid);
}

test("a background job holding stdout neither delays the values nor survives the lookup", async () => {
  // Quiet, it never writes and never closes the pipe: without the cleanup the read waits on it.
  const job = shell("sleep 60");
  const started = performance.now();
  expect(await shellVariables(["TEST_KEY", "UNSET_KEY"], 10_000)).toEqual({ TEST_KEY: "sk-from-profile" });
  expect(performance.now() - started).toBeLessThan(3000);
  expect(await gone(job())).toBe(true);
});

test("a shell that never finishes gives up at the deadline, its job killed with it", async () => {
  // Writing all the while, so the pipe is never quiet; the shell itself is stuck before the lookup runs.
  const job = shell("while :; do echo tick; sleep 0.01; done", "sleep 60");
  const started = performance.now();
  expect(await shellVariables(["TEST_KEY"], 300)).toEqual({});
  expect(performance.now() - started).toBeLessThan(2000);
  expect(await gone(job())).toBe(true);
});

test("a job flooding stdout stops the read at its bound, well before the deadline", async () => {
  const job = shell("yes flood", "sleep 60");
  const started = performance.now();
  expect(await shellVariables(["TEST_KEY"], 20_000)).toEqual({});
  expect(performance.now() - started).toBeLessThan(5000);
  expect(await gone(job())).toBe(true);
});

test("a name that isn't a variable name is never put in the shell's command", async () => {
  const marker = join(dir, "injected");
  shell("true");
  expect(await shellVariables([`X; touch ${marker}`, "TEST_KEY"], 5000)).toEqual({ TEST_KEY: "sk-from-profile" });
  expect(existsSync(marker)).toBe(false);
});
