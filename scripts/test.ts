// Runs each test file in a process of its own, so browser globals, module mocks and captured storage
// backends can't leak between files (this also works on Bun 1.3.8, which has no --isolate flag).
// Files run in parallel: TEST_JOBS at once (TEST_JOBS=1 runs them one after another with live
// output, as before), at most TEST_BROWSER_JOBS of them driving a headless Chrome.
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

/** Files that must have the machine to themselves: they run alone, after the others. None need it yet. */
const serial = new Set<string>([]);

// A headless Chrome is a few processes and a renderer: several at once starve each other of frames,
// and the tests that count frames or wait 5 s for one (tests/chromePage.ts) start to fail.
const usesBrowser = (source: string) => /["'.\/](chromePage|html-render)["']|\bfindBrowser\b/.test(source);

const positive = (name: string) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive whole number, not ${JSON.stringify(raw)}.`);
  return value;
};
const jobs = positive("TEST_JOBS") ?? Math.max(1, Math.floor(availableParallelism() / 2));
// Half the slots, and never more than 3: at 4 a 16-thread machine already drops animation frames.
const browserJobs = Math.min(jobs, positive("TEST_BROWSER_JOBS") ?? Math.max(1, Math.min(3, Math.floor(jobs / 2))));

const filters = process.argv.slice(2);
const files = [...new Bun.Glob("tests/**/*.test.ts").scanSync()].sort()
  .filter(file => !filters.length || filters.some(filter => file.includes(filter)));

type Result = { file: string; code: number | null; seconds: number; killed: boolean };
const results: Result[] = [];
const live = jobs === 1;
const logs = live ? "" : mkdtempSync(join(tmpdir(), "openbuild-test-logs-"));
const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: "test" };
// tests/guardSystemd.ts gives every file a data directory of its own, but only when none is set:
// one inherited from the shell would be shared by files running at the same time (or be real data).
delete env.OPENCHAT_DATA_DIR;
// Output goes to a file and is printed when the file finishes; keep the colours a terminal would get.
if (!live && process.stdout.isTTY && env.NO_COLOR === undefined) env.FORCE_COLOR ??= "1";
// Ctrl-C reaches the running files too (same process group); Bun skips `finally` on a signal.
if (logs) process.once("SIGINT", () => { rmSync(logs, { recursive: true, force: true }); process.exit(130); });

async function run(file: string, index: number): Promise<Result> {
  const log = live ? "" : join(logs, `${index}.log`);
  // One descriptor for both streams keeps stdout and stderr in the order they were written.
  const fd = live ? undefined : openSync(log, "a");
  const started = performance.now();
  // Bun's 5 s default per test is a hang guard, and several files at once is contention this runner
  // adds: a test that takes 4 s alone (a few CLI processes in a row) can take 6 under it. Tests with a
  // timeout of their own keep it, and so do the waits inside tests.
  const args = live ? [] : ["--timeout", "15000"];
  const child = Bun.spawn([process.execPath, "test", ...args, `./${file}`], {
    env,
    stdin: live ? "inherit" : "ignore",
    stdout: fd ?? "inherit",
    stderr: fd ?? "inherit",
  });
  // A file that never exits (a browser left alive) would hold the nightly until the job's own limit.
  let killed = false;
  const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, 180_000);
  const code = await child.exited;
  clearTimeout(timer);
  const result = { file, code, seconds: (performance.now() - started) / 1000, killed };
  if (fd !== undefined) {
    closeSync(fd);
    const status = code === 0 ? "passed" : killed ? "KILLED after 180 s" : "FAILED";
    const output = readFileSync(log, "utf8").trimEnd();
    rmSync(log, { force: true });
    process.stdout.write(`\n━━ ${file} · ${status} · ${result.seconds.toFixed(1)} s\n${output ? `${output}\n` : ""}`);
  } else if (killed) {
    console.log(`\n${file} was killed after 180 s.`);
  }
  results.push(result);
  return result;
}

// Run `queue` with up to `limit` files at once, at most `browserLimit` of them using a browser.
async function pool(queue: { file: string; browser: boolean; index: number }[], limit: number, browserLimit: number) {
  let running = 0, browsers = 0;
  await new Promise<void>(done => {
    const next = () => {
      if (!queue.length && !running) return done();
      while (running < limit) {
        const at = queue.findIndex(item => !item.browser || browsers < browserLimit);
        if (at < 0) break;
        const [item] = queue.splice(at, 1);
        running++;
        if (item!.browser) browsers++;
        void run(item!.file, item!.index).finally(() => {
          running--;
          if (item!.browser) browsers--;
          next();
        });
      }
    };
    next();
  });
}

const started = performance.now();
const entries = files.map((file, index) => ({ file, index, browser: usesBrowser(readFileSync(file, "utf8")) }));
// Browser files are the slow ones: start them first so they don't trail at the end on their own.
const parallel = entries.filter(entry => !serial.has(entry.file)).sort((a, b) => Number(b.browser) - Number(a.browser) || a.index - b.index);
const alone = entries.filter(entry => serial.has(entry.file));
if (!live) console.log(`Running ${files.length} test files, ${jobs} at a time (${browserJobs} with a browser). TEST_JOBS=1 runs them one by one.`);
try {
  await pool(parallel, jobs, browserJobs);
  await pool(alone, 1, 1);
} finally {
  if (logs) rmSync(logs, { recursive: true, force: true });
}

const failed = results.filter(result => result.code !== 0).sort((a, b) => a.file.localeCompare(b.file));
if (!live) {
  const wall = (performance.now() - started) / 1000;
  const total = results.reduce((sum, result) => sum + result.seconds, 0);
  console.log(`\nSlowest files:`);
  for (const result of [...results].sort((a, b) => b.seconds - a.seconds).slice(0, 10)) console.log(`  ${result.seconds.toFixed(1).padStart(6)} s  ${result.file}`);
  console.log(`\n${results.length} files in ${wall.toFixed(0)} s (${total.toFixed(0)} s of file time, ${jobs} at a time).`);
  if (failed.length) console.log(`\nFailed:\n${failed.map(result => `  ${result.file}${result.killed ? " (killed after 180 s)" : ""}`).join("\n")}`);
}
console.log(`\n${failed.length} test files failed.`);
process.exit(failed.length ? 1 : 0);
